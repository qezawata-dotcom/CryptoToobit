import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildQueryString,
  signToobitPayload,
  ToobitClient,
  ToobitApiError,
  ToobitRateLimitError,
  ToobitAuthenticationError,
} from "../src/exchange/toobitClient.js";
import { toCandle, toTicker, toPositionInfo, toBalance } from "../src/exchange/normalize.js";

// ---------- signature vectors ----------

describe("signToobitPayload", () => {
  it("produces the exact HMAC-SHA256 hex for a fixed secret and payload", () => {
    const secret = "0123456789abcdef";
    const payload = "symbol=BTC-SWAP-USDT&side=BUY_OPEN&quantity=10&timestamp=1722825600000";
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    expect(signToobitPayload(payload, secret)).toBe(expected);
    // Known-answer: lowercase hex, 64 chars.
    expect(signToobitPayload("a=1", "k")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildQueryString", () => {
  it("keeps object insertion order (not sorted)", () => {
    const qs = buildQueryString({ b: "2", a: "1", symbol: "BTC-SWAP-USDT", timestamp: "123" });
    expect(qs).toBe("b=2&a=1&symbol=BTC-SWAP-USDT&timestamp=123");
  });

  it("drops undefined and null values", () => {
    const qs = buildQueryString({ a: "1", b: undefined, c: null, d: "4" });
    expect(qs).toBe("a=1&d=4");
  });

  it("comma-joins array values", () => {
    const qs = buildQueryString({ ids: ["1", "2", "3"] });
    expect(qs).toBe("ids=1,2,3");
  });

  it("String()-coerces numbers and booleans", () => {
    const qs = buildQueryString({ n: 5, b: true });
    expect(qs).toBe("n=5&b=true");
  });

  it("returns empty string for empty/absent params", () => {
    expect(buildQueryString({})).toBe("");
    expect(buildQueryString(undefined as unknown as Record<string, unknown>)).toBe("");
    expect(buildQueryString({ a: undefined })).toBe("");
  });
});

// ---------- transport (hermetic fetch stub) ----------

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(handler);
  const client = new ToobitClient({
    baseUrl: "https://api.toobit.com",
    apiKey: "test-api-key",
    secretKey: "test-secret-key",
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToobitClient transport", () => {
  it("signs GET/DELETE private requests and appends signature to the URL", async () => {
    const { client, fetchMock } = stubFetch((url) => {
      return jsonResponse({ code: 200, msg: "", data: { ok: true } });
    });
    const fixedTime = 1722825600000;
    client._setClock(() => fixedTime);

    await client.privateGet("/api/v1/futures/positions", { symbol: "BTC-SWAP-USDT" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/futures/positions");
    expect(url).toContain(`symbol=BTC-SWAP-USDT`);
    expect(url).toContain(`timestamp=${fixedTime}`);
    const signedQs = buildQueryString({
      symbol: "BTC-SWAP-USDT",
      timestamp: String(fixedTime),
    });
    const expectedSig = signToobitPayload(signedQs, "test-secret-key");
    expect(url).toContain(`signature=${expectedSig}`);
    expect(init.headers).toMatchObject({ "X-BB-APIKEY": "test-api-key" });
    expect(init.method).toBe("GET");
  });

  it("form-encodes POST private bodies with timestamp+signature in the body", async () => {
    const { client, fetchMock } = stubFetch(() => jsonResponse({ code: 200, msg: "", data: {} }));
    const fixedTime = 1722825600000;
    client._setClock(() => fixedTime);

    await client.privatePost("/api/v1/futures/order", {
      symbol: "BTC-SWAP-USDT",
      side: "BUY_OPEN",
      type: "LIMIT",
      quantity: "10",
      price: "60000",
      priceType: "MARKET",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.toobit.com/api/v1/futures/order"); // bare path
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = String(init.body);
    expect(body).toContain("symbol=BTC-SWAP-USDT");
    expect(body).toContain("side=BUY_OPEN");
    expect(body).toContain("priceType=MARKET");
    expect(body).toContain(`timestamp=${fixedTime}`);
    // Signature is over symbol..timestamp in insertion order.
    const signedQs = buildQueryString({
      symbol: "BTC-SWAP-USDT",
      side: "BUY_OPEN",
      type: "LIMIT",
      quantity: "10",
      price: "60000",
      priceType: "MARKET",
      timestamp: String(fixedTime),
    });
    const expectedSig = signToobitPayload(signedQs, "test-secret-key");
    expect(body).toContain(`signature=${expectedSig}`);
    // Insertion order preserved: symbol (first param) precedes timestamp (last).
    expect(body.indexOf("symbol=")).toBeLessThan(body.indexOf("timestamp="));
    expect(body.indexOf("priceType=")).toBeGreaterThan(body.indexOf("quantity="));
  });

  it("JSON-encodes array bodies with signature in the query string", async () => {
    const { client, fetchMock } = stubFetch(() => jsonResponse({ code: 200, msg: "", data: [] }));
    const fixedTime = 1722825600000;
    client._setClock(() => fixedTime);

    await client.privatePost(
      "/api/v1/futures/batchOrders",
      [{ symbol: "BTC-SWAP-USDT", side: "BUY_OPEN", type: "LIMIT", quantity: "10" }],
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(
      JSON.stringify([{ symbol: "BTC-SWAP-USDT", side: "BUY_OPEN", type: "LIMIT", quantity: "10" }]),
    );
    expect(url).toContain(`timestamp=${fixedTime}`);
    const signedQs = buildQueryString({ timestamp: String(fixedTime) });
    expect(url).toContain(`signature=${signToobitPayload(signedQs, "test-secret-key")}`);
  });

  it("throws ConfigError on private calls without credentials", async () => {
    const client = new ToobitClient({
      baseUrl: "https://api.toobit.com",
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    await expect(client.privateGet("/api/v1/futures/balance")).rejects.toThrow(
      /API credentials/,
    );
  });

  it("wraps network failures as ToobitNetworkError", async () => {
    const { client } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      client.publicGet("/api/v1/time"),
    ).rejects.toMatchObject({ type: "NetworkError", endpoint: "GET /api/v1/time" });
  });
});

// ---------- error mapping ----------

describe("ToobitClient error mapping", () => {
  it("maps HTTP 429 to RateLimitError", async () => {
    const { client } = stubFetch(() => jsonResponse({}, 429));
    await expect(client.publicGet("/api/v1/time")).rejects.toBeInstanceOf(
      ToobitRateLimitError,
    );
  });

  it("maps business code -1003 to RateLimitError", async () => {
    const { client } = stubFetch(() =>
      jsonResponse({ code: -1003, msg: "too many requests" }),
    );
    await expect(client.privateGet("/api/v1/futures/balance")).rejects.toBeInstanceOf(
      ToobitRateLimitError,
    );
  });

  it("maps auth codes (-1022, -2014) to AuthenticationError with suggestions", async () => {
    const { client } = stubFetch(() =>
      jsonResponse({ code: -1022, msg: "Invalid signature" }),
    );
    await expect(client.privateGet("/api/v1/futures/balance")).rejects.toBeInstanceOf(
      ToobitAuthenticationError,
    );
  });

  it("marks -1000 as retryable and -1130 as not", async () => {
    const retryable = new ToobitApiError("boom", { code: "-1000", endpoint: "x" });
    expect(retryable.retryable).toBe(true);
    const param = new ToobitApiError("bad param", { code: "-1130", endpoint: "x" });
    expect(param.retryable).toBe(false);
  });

  it("gives a futures-symbol hint for -1130 with symbol in the message", async () => {
    const { client } = stubFetch(() =>
      jsonResponse({ code: -1130, msg: "Invalid parameter: symbol" }),
    );
    const err = (await client
      .publicGet("/api/v1/futures/riskLimits", { symbol: "BTCUSDT" })
      .catch((e) => e)) as ToobitApiError;
    expect(err).toBeInstanceOf(ToobitApiError);
    expect(err.retryable).toBe(false);
    expect(err.suggestion).toContain("BTC-SWAP-USDT");
  });

  it("returns data on success code 0 and 200", async () => {
    for (const code of [0, 200]) {
      const { client } = stubFetch(() =>
        jsonResponse({ code, msg: "", data: { serverTime: 1 } }),
      );
      const res = await client.publicGet("/api/v1/time");
      expect(res.data).toMatchObject({ serverTime: 1 });
    }
  });
});

// ---------- normalize ----------

describe("normalize aliases", () => {
  it("parses klines with both long and short field names", () => {
    const long = toCandle({ openTime: 1, open: "100", high: "101", low: "99", close: "100.5", volume: "10" });
    expect(long).toMatchObject({ openTime: 1, open: 100, close: 100.5, volume: 10 });
    const short = toCandle({ t: 2, o: "10", h: "11", l: "9", c: "10.5", v: "5" });
    expect(short).toMatchObject({ openTime: 2, open: 10, close: 10.5, volume: 5 });
  });

  it("extracts last price from contract ticker aliases", () => {
    const ticker = toTicker({ symbol: "BTC-SWAP-USDT", lastPrice: "60000", highPrice: "61000", lowPrice: "59000", volume: "1000" });
    expect(ticker.last).toBe(60000);
    expect(ticker.high).toBe(61000);
    const aliased = toTicker({ c: "60500", h: "61500", l: "59500", v: "999" });
    expect(aliased.last).toBe(60500);
    expect(aliased.volume).toBe(999);
  });

  it("computes ROI from entry vs mark with leverage", () => {
    const pos = toPositionInfo({ positionAmt: "100", entryPrice: "60000", markPrice: "61500", leverage: "10" });
    expect(pos.exists).toBe(true);
    expect(pos.position_size).toBe(100);
    // LONG: (61500-60000)/60000 * 10 * 100 = 25% (ROI on margin, per reference)
    expect(pos.roi).toBeCloseTo(25, 5);
  });

  it("treats negative size as SHORT and zero size as no position", () => {
    const short = toPositionInfo({ positionAmt: "-50", entryPrice: "60000", markPrice: "59000", leverage: "5" });
    expect(short.exists).toBe(true);
    expect(short.position_size).toBe(50);
    // SHORT: -1 * (59000-60000)/60000 * 5 * 100 = +8.3333%
    expect(short.roi).toBeCloseTo(8.3333, 3);
    const flat = toPositionInfo({ positionAmt: "0" });
    expect(flat.exists).toBe(false);
  });

  it("parses balance with several aliases", () => {
    const b = toBalance({ walletBalance: "1000", availableBalance: "900", marginBalance: "950", frozen: "50" });
    expect(b.wallet).toBe(1000);
    expect(b.available).toBe(900);
    expect(b.frozen).toBe(50);
  });
});
