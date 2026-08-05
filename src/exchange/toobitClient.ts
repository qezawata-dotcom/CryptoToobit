import { createHmac } from "node:crypto";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { Candle } from "../types.js";
import { candlesToCandles, toMarkPrice, toTicker } from "./normalize.js";
import type { PlaceOrderParams, QueryParams, ToobitResponse, TradingStopParams } from "./types.js";

/**
 * Toobit REST client — a faithful port of the transport/signing logic in
 * Toobit's own MCP server (toobit-trade-mcp/dist/index.js), so endpoints are
 * correct against spec without a live API to verify against.
 *
 * Transport summary (all verified against the reference source):
 *   - signing:   HMAC-SHA256(secret, queryString).hex where queryString =
 *                k1=v1&k2=v2&timestamp=<ms> in OBJECT INSERTION ORDER.
 *                timestamp added BEFORE signing; signature appended after.
 *   - body:      POST/PUT private → full param string as
 *                application/x-www-form-urlencoded, URL stays bare path.
 *   - query:     GET/DELETE private → params appended to path.
 *   - headers:   Accept: application/json (+ Content-Type on body methods),
 *                X-BB-APIKEY: <apiKey> on private. No recvWindow.
 *   - timeout:   15s (AbortSignal.timeout).
 *   - errors:    HTTP 429 → RateLimitError; business code -1003 → rate limit;
 *                auth codes → AuthenticationError; -1130 symbol hints; else
 *                ToobitApiError with retry suggestion.
 *   - rate limit: token bucket per (method,path) key; refill by elapsed ms.
 *
 * No caller can bypass the MARKET→(LIMIT + priceType=MARKET) conversion: it
 * lives here so a resting order can never accidentally be left unprotected.
 */

export class ToobitConfigError extends Error {
  type = "ConfigError" as const;
}

export class ToobitNetworkError extends Error {
  type = "NetworkError" as const;
  endpoint: string;
  constructor(message: string, endpoint: string, cause?: unknown) {
    super(message);
    this.endpoint = endpoint;
    if (cause) this.cause = cause;
  }
}

export class ToobitApiError extends Error {
  /** Discriminator; subclasses narrow it (RateLimitError, AuthenticationError). */
  type: string = "ApiError";
  code: string;
  endpoint: string;
  suggestion?: string;
  retryable: boolean;
  constructor(
    message: string,
    opts: {
      code: string;
      endpoint: string;
      suggestion?: string;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.code = opts.code;
    this.endpoint = opts.endpoint;
    this.suggestion = opts.suggestion;
    this.retryable = opts.retryable ?? RETRYABLE_CODES.has(opts.code);
  }
}

export class ToobitRateLimitError extends ToobitApiError {
  override readonly type = "RateLimitError";
  constructor(message: string, endpoint: string, suggestion?: string) {
    super(message, { code: "429", endpoint, suggestion, retryable: true });
  }
}

export class ToobitAuthenticationError extends ToobitApiError {
  override readonly type = "AuthenticationError";
  constructor(message: string, endpoint: string, suggestion?: string) {
    super(message, {
      code: "-1002",
      endpoint,
      suggestion: suggestion ?? "Check API key, secret key and permissions.",
      retryable: false,
    });
  }
}

/** Business codes that are safe to retry after a delay. */
const RETRYABLE_CODES = new Set([
  "-1000",
  "-1001",
  "-1003",
  "-1006",
  "-1007",
  "-1016",
]);

const AUTH_CODES = new Set(["-1002", "-1022", "-1107", "-2014", "-2015", "-2017"]);

const CODE_SUGGESTIONS: Record<string, string> = {
  "-1000": "Unknown error. Retry after a delay.",
  "-1001": "Disconnected / internal error. Retry.",
  "-1003": "Too many requests. Back off and retry.",
  "-1006": "Unexpected response. Retry later.",
  "-1007": "Timeout. Retry after a delay.",
  "-1016": "Service shutting down. Retry later.",
  "-1015": "Too many orders. Reduce order frequency.",
  "-1020": "Unsupported operation.",
  "-1021": "Invalid timestamp. Check system clock sync.",
  "-1022": "Invalid signature. Check API key and secret.",
  "-2010": "New order rejected. Check order parameters.",
  "-2011": "Cancel rejected. Order may already be filled.",
  "-2013": "Order does not exist.",
  "-2014": "Bad API key format.",
  "-2015": "Invalid API key, IP, or permission.",
  "-2017": "API key expired. Generate a new one.",
  "-1130": "A parameter value is invalid. Check the error message for the specific parameter.",
  "-1107": "API key is missing or malformed. Check X-BB-APIKEY header.",
};

const FUTURES_PATH_RE =
  /futures|fundingRate|openInterest|markPrice|contract|longShort|insurance|riskLimit/i;

function isDefined(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/** Request body payloads this client sends (no DOM lib in scope). */
type BodyPayload = string | ArrayBuffer | Uint8Array;

/** Serializes one query value: arrays comma-join, everything else String(). */
function stringifyQueryValue(value: QueryParams[string]): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value);
}

/** Builds k1=v1&k2=v2&… in object insertion order, dropping undefined/null. */
export function buildQueryString(query: QueryParams): string {
  if (!query) return "";
  const entries = Object.entries(query).filter(([, v]) => isDefined(v));
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${stringifyQueryValue(v)}`).join("&");
}

/** HMAC-SHA256(queryString, secretKey) as lowercase hex — the Toobit signature. */
export function signToobitPayload(queryString: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(queryString).digest("hex");
}

export type ClientRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  auth: "public" | "private";
  query?: QueryParams;
  body?: QueryParams | QueryParams[];
  /** Token-bucket key; omitted → no client-side throttling. */
  rateKey?: string;
  rateRps?: number;
};

export type ClientResponse<T> = {
  endpoint: string;
  data: T;
};

type TokenBucket = {
  tokens: number;
  lastRefillMs: number;
  capacity: number;
  refillPerSecond: number;
};

export type ToobitClientOptions = {
  baseUrl?: string;
  apiKey?: string;
  secretKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class ToobitClient {
  private baseUrl: string;
  private apiKey: string;
  private secretKey: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private buckets = new Map<string, TokenBucket>();
  /** Injectable clock for hermetic signature/time tests. */
  private nowFn: () => number;

  constructor(opts: ToobitClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? Config.TOOBIT_API_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? Config.TOOBIT_API_KEY;
    this.secretKey = opts.secretKey ?? Config.TOOBIT_API_SECRET;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.nowFn = Date.now;
  }

  /** Override the clock (tests). */
  _setClock(fn: () => number): void {
    this.nowFn = fn;
  }

  hasAuth(): boolean {
    return Boolean(this.apiKey && this.secretKey);
  }

  // ---------- public ----------

  publicGet<T>(path: string, query: QueryParams = {}, rateKey?: string, rateRps = 20): Promise<ClientResponse<T>> {
    return this.request<T>({
      method: "GET",
      path,
      auth: "public",
      query,
      rateKey: rateKey ? `public:${rateKey}` : undefined,
      rateRps,
    });
  }

  // ---------- private ----------

  privateGet<T>(path: string, query: QueryParams = {}, rateKey?: string, rateRps = 20): Promise<ClientResponse<T>> {
    return this.request<T>({
      method: "GET",
      path,
      auth: "private",
      query,
      rateKey: rateKey ? `private:${rateKey}` : undefined,
      rateRps,
    });
  }

  privatePost<T>(
    path: string,
    body: QueryParams | QueryParams[],
    rateKey?: string,
    rateRps = 20,
  ): Promise<ClientResponse<T>> {
    return this.request<T>({
      method: "POST",
      path,
      auth: "private",
      body,
      rateKey: rateKey ? `private:${rateKey}` : undefined,
      rateRps,
    });
  }

  privateDelete<T>(path: string, query: QueryParams = {}, rateKey?: string, rateRps = 20): Promise<ClientResponse<T>> {
    return this.request<T>({
      method: "DELETE",
      path,
      auth: "private",
      query,
      rateKey: rateKey ? `private:${rateKey}` : undefined,
      rateRps,
    });
  }

  // ---------- token bucket ----------

  private getBucket(key: string, capacity: number, refillPerSecond: number): TokenBucket {
    const existing = this.buckets.get(key);
    if (existing) {
      if (existing.capacity !== capacity || existing.refillPerSecond !== refillPerSecond) {
        existing.capacity = capacity;
        existing.refillPerSecond = refillPerSecond;
        existing.tokens = Math.min(existing.tokens, capacity);
      }
      return existing;
    }
    const bucket: TokenBucket = {
      tokens: capacity,
      lastRefillMs: this.nowFn(),
      capacity,
      refillPerSecond,
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private refill(bucket: TokenBucket): void {
    const now = this.nowFn();
    const elapsedMs = now - bucket.lastRefillMs;
    if (elapsedMs <= 0) return;
    const refillTokens = (elapsedMs / 1000) * bucket.refillPerSecond;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refillTokens);
    bucket.lastRefillMs = now;
  }

  /** Consumes one token from the bucket (blocks until available). */
  async consume(key: string, capacity: number, refillPerSecond: number): Promise<void> {
    const bucket = this.getBucket(key, capacity, refillPerSecond);
    // Simulated wait: for a bot (single process, low frequency) a short sleep
    // on the rare contended call is fine; the important property is that we
    // never exceed the per-second budget.
    this.refill(bucket);
    if (bucket.tokens < 1) {
      const deficit = 1 - bucket.tokens;
      const waitMs = Math.ceil((deficit / refillPerSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 1000)));
      this.refill(bucket);
    }
    bucket.tokens -= 1;
  }

  // ---------- request core ----------

  async request<T>(config: ClientRequest): Promise<ClientResponse<T>> {
    if (config.rateKey) {
      await this.consume(config.rateKey, config.rateRps ?? 20, config.rateRps ?? 20);
    }

    const timestamp = this.nowFn();
    const allParams: QueryParams = { ...(config.query ?? {}) };
    const isBodyMethod = config.method === "POST" || config.method === "PUT";

    if (config.body && !Array.isArray(config.body)) {
      Object.assign(allParams, config.body);
    }

    if (config.auth === "private") {
      if (!this.hasAuth()) {
        throw new ToobitConfigError(
          "Private endpoint requires API credentials. Configure TOOBIT_API_KEY and TOOBIT_API_SECRET.",
        );
      }
      allParams.timestamp = String(timestamp);
      const signPayload = buildQueryString(allParams);
      const signature = signToobitPayload(signPayload, this.secretKey);
      allParams.signature = signature;
    }

    const paramString = buildQueryString(allParams);

    let url: string;
    let fetchBody: string | undefined;
    let headers: Record<string, string>;

    if (isBodyMethod && config.auth === "private") {
      url = `${this.baseUrl}${config.path}`;
      fetchBody = paramString || undefined;
      headers = {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      };
    } else {
      const requestPath = paramString ? `${config.path}?${paramString}` : config.path;
      url = `${this.baseUrl}${requestPath}`;
      headers = { Accept: "application/json" };
    }

    if (config.auth === "private" && this.apiKey) {
      headers["X-BB-APIKEY"] = this.apiKey;
    }

    // Batch bodies are arrays (e.g. futures/batchOrders). Toobit signs the
    // query string (timestamp + signature land in the URL) and ships the JSON
    // array as the body — mirroring Toobit.Net's RequestBodyFormat.Json path.
    let rawBody: BodyPayload | undefined;
    if (Array.isArray(config.body)) {
      const queryPath = paramString ? `${config.path}?${paramString}` : config.path;
      url = `${this.baseUrl}${queryPath}`;
      rawBody = JSON.stringify(config.body);
      headers["Content-Type"] = "application/json";
      fetchBody = undefined;
    } else {
      rawBody = fetchBody;
    }

    const endpoint = `${config.method} ${config.path}`;

    if (Config.TOOBIT_DEBUG_RAW) {
      logger.info({ endpoint, url }, "toobit request");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: config.method,
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ToobitNetworkError(
        `Failed to call Toobit endpoint ${endpoint}.`,
        endpoint,
        error,
      );
    }

    const rawText = await response.text();
    let parsed: ToobitResponse<T>;
    try {
      parsed = rawText ? (JSON.parse(rawText) as ToobitResponse<T>) : ({} as ToobitResponse<T>);
    } catch (error) {
      if (!response.ok) {
        const preview = rawText.slice(0, 160).replace(/\s+/g, " ").trim();
        throw new ToobitApiError(
          `HTTP ${response.status} from Toobit: ${preview || "Non-JSON response"}`,
          { code: String(response.status), endpoint },
        );
      }
      throw new ToobitNetworkError(
        `Toobit returned non-JSON response for ${endpoint}.`,
        endpoint,
        error,
      );
    }

    if (response.status === 429) {
      throw new ToobitRateLimitError(
        "Rate limited by Toobit. Back off and retry.",
        endpoint,
        "Reduce request frequency.",
      );
    }

    const responseCode = (parsed as { code?: number }).code;
    const responseMsg = (parsed as { msg?: string }).msg;
    const hasBusinessCode =
      responseCode !== undefined && responseCode !== 0 && responseCode !== 200;

    if (hasBusinessCode) {
      const codeStr = String(responseCode);
      const message = responseMsg || "Toobit API request failed.";
      const behaviorSuggestion = CODE_SUGGESTIONS[codeStr];

      if (AUTH_CODES.has(codeStr)) {
        throw new ToobitAuthenticationError(
          message,
          endpoint,
          behaviorSuggestion ?? "Check API key, secret key and permissions.",
        );
      }
      if (codeStr === "-1003") {
        throw new ToobitRateLimitError(message, endpoint, "Too many requests. Back off.");
      }

      let suggestion = behaviorSuggestion;
      if (codeStr === "-1130" && responseMsg) {
        suggestion = this.symbolHint(config, responseMsg);
      }

      throw new ToobitApiError(message, {
        code: codeStr,
        endpoint,
        suggestion,
        retryable: RETRYABLE_CODES.has(codeStr),
      });
    }

    if (!response.ok) {
      const rawMsg = responseMsg ?? "Unknown error";
      let suggestion: string | undefined;
      if (/symbol.*not valid|invalid.*symbol|paramter.*symbol|parameter.*symbol|symbol.*format/i.test(rawMsg)) {
        suggestion = FUTURES_PATH_RE.test(config.path)
          ? "Futures endpoints require contract symbol format, e.g. BTC-SWAP-USDT instead of BTCUSDT."
          : "Spot endpoints require symbol format like BTCUSDT.";
      }
      throw new ToobitApiError(`HTTP ${response.status} from Toobit: ${rawMsg}`, {
        code: String(response.status),
        endpoint,
        suggestion,
      });
    }

    return { endpoint, data: parsed.data };
  }

  private symbolHint(config: ClientRequest, msg: string): string {
    if (/symbol/i.test(msg)) {
      return FUTURES_PATH_RE.test(config.path)
        ? "Invalid symbol format. Futures endpoints require BTC-SWAP-USDT format; spot endpoints use BTCUSDT."
        : "Invalid symbol format. Spot endpoints require symbol format like BTCUSDT.";
    }
    const paramMatch = msg.match(/paramter\s+'([^']+)'|parameter\s+'([^']+)'/i);
    if (paramMatch) {
      return `Parameter '${paramMatch[1] ?? paramMatch[2]}' has an invalid value. Check the allowed range and format.`;
    }
    return CODE_SUGGESTIONS["-1130"];
  }

  // ---------- endpoint methods (typed) ----------

  getServerTime(): Promise<ClientResponse<{ serverTime: number }>> {
    return this.publicGet<{ serverTime: number }>("/api/v1/time", {});
  }

  checkApiKey(): Promise<ClientResponse<unknown>> {
    return this.privateGet<unknown>("/api/v1/account/checkApiKey", {});
  }

  getFuturesBalance(): Promise<ClientResponse<unknown>> {
    return this.privateGet<unknown>("/api/v1/futures/balance", {});
  }

  // ---------- market data (satisfies SignalScanner's MarketDataSource) ----------

  /** Klines for a futures or spot symbol; candles normalized + arbitrary order. */
  async getKlines(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
    const res = await this.publicGet<unknown>(
      "/quote/v1/klines",
      { symbol, interval, limit: Math.min(limit, 1500) },
      `klines:${symbol}:${interval}`,
      20,
    );
    return candlesToCandles(res.data);
  }

  /** Last traded price via the 24h contract ticker, 0 if unparseable. */
  async getTickerPrice(symbol: string): Promise<number> {
    const res = await this.publicGet<unknown>(
      "/quote/v1/contract/ticker/24hr",
      { symbol },
      `ticker:${symbol}`,
      20,
    );
    return toTicker(res.data).last;
  }

  /** Mark price (futures), 0 if unparseable. */
  async getMarkPrice(symbol: string): Promise<number> {
    const res = await this.publicGet<unknown>(
      "/quote/v1/markPrice",
      { symbol },
      `mark:${symbol}`,
      20,
    );
    return toMarkPrice(res.data).markPrice;
  }

  // ---------- futures (private) — exact shapes from the MCP reference ----------

  /** Exchange info — trading rules and symbol list (public). */
  getExchangeInfo(): Promise<ClientResponse<unknown>> {
    return this.publicGet<unknown>("/api/v1/exchangeInfo", {}, "exchangeInfo", 10);
  }

  /** Risk-limit brackets for a contract symbol (public). */
  getRiskLimits(symbol: string): Promise<ClientResponse<unknown>> {
    return this.publicGet<unknown>(
      "/api/v1/futures/riskLimits",
      { symbol },
      `riskLimits:${symbol}`,
      20,
    );
  }

  /** Open futures positions for a symbol (or all). */
  async getFuturesPositions(symbol?: string): Promise<unknown[]> {
    const res = await this.privateGet<unknown>(
      "/api/v1/futures/positions",
      symbol ? { symbol } : {},
      "futures:positions",
      20,
    );
    return Array.isArray(res.data) ? (res.data as unknown[]) : [];
  }

  /** Open futures orders for a symbol (or all). */
  async getFuturesOpenOrders(symbol?: string): Promise<unknown[]> {
    const res = await this.privateGet<unknown>(
      "/api/v1/futures/openOrders",
      symbol ? { symbol } : {},
      "futures:openOrders",
      20,
    );
    return Array.isArray(res.data) ? (res.data as unknown[]) : [];
  }

  /**
   * Place a futures order. MARKET is converted here to `type=LIMIT,
   * priceType=MARKET` (the only way Toobit encodes a market order) so no caller
   * can ever leave a resting order unintentionally.
   */
  placeFuturesOrder(params: PlaceOrderParams): Promise<ClientResponse<unknown>> {
    let { type, priceType } = params;
    if (type === "MARKET") {
      type = "LIMIT";
      priceType = "MARKET";
    }
    const clientId = params.newClientOrderId
      ? params.newClientOrderId.replace(/[^a-zA-Z0-9_\-.]/g, "")
      : `ct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.privatePost<unknown>(
      "/api/v1/futures/order",
      {
        symbol: params.symbol,
        side: params.side,
        type,
        quantity: params.quantity,
        price: params.price,
        newClientOrderId: clientId,
        priceType,
        stopPrice: params.stopPrice,
        timeInForce: params.timeInForce,
      },
      "futures:order",
      20,
    );
  }

  /** Cancel one futures order (by orderId or clientOrderId). */
  cancelFuturesOrder(
    orderId?: string,
    clientOrderId?: string,
  ): Promise<ClientResponse<unknown>> {
    return this.privateDelete<unknown>(
      "/api/v1/futures/order",
      { orderId, clientOrderId },
      "futures:cancelOrder",
      20,
    );
  }

  /** Cancel all open futures orders for a symbol. */
  cancelAllFuturesOrders(symbol: string): Promise<ClientResponse<unknown>> {
    return this.privateDelete<unknown>(
      "/api/v1/futures/batchOrders",
      { symbol },
      "futures:cancelAll",
      10,
    );
  }

  /** Set leverage for a contract symbol. */
  setFuturesLeverage(symbol: string, leverage: number): Promise<ClientResponse<unknown>> {
    return this.privatePost<unknown>(
      "/api/v1/futures/leverage",
      { symbol, leverage },
      "futures:leverage",
      10,
    );
  }

  /** Switch margin mode for a contract symbol (CROSS or ISOLATED). */
  setFuturesMarginType(
    symbol: string,
    marginType: "CROSS" | "ISOLATED",
  ): Promise<ClientResponse<unknown>> {
    return this.privatePost<unknown>(
      "/api/v1/futures/marginType",
      { symbol, marginType },
      "futures:marginType",
      10,
    );
  }

  /** Create or move the TP/SL for a position (same call, keyed by symbol+side). */
  setFuturesTradingStop(params: TradingStopParams): Promise<ClientResponse<unknown>> {
    return this.privatePost<unknown>(
      "/api/v1/futures/position/trading-stop",
      {
        symbol: params.symbol,
        side: params.side,
        takeProfit: params.takeProfit,
        stopLoss: params.stopLoss,
      },
      "futures:tradingStop",
      10,
    );
  }

  /** Flash-close a position at market (whole position). */
  flashClose(symbol: string, side: "LONG" | "SHORT"): Promise<ClientResponse<unknown>> {
    return this.privatePost<unknown>(
      "/api/v1/futures/flashClose",
      { symbol, side },
      "futures:flashClose",
      10,
    );
  }
}

/** Factory for a client wired to Config. */
export function createClient(): ToobitClient {
  return new ToobitClient();
}

export default ToobitClient;
