import type { FuturesSide } from "./endpoints.js";

/**
 * Toobit wire types. Field names are the raw JSON names the exchange returns
 * (unverified against a live API — see normalize.ts for the alias layer that
 * maps these onto the bot's canonical types).
 */

export type QueryValue = string | number | boolean | string[] | undefined | null;

export type QueryParams = Record<string, QueryValue>;

/** Raw envelope: { code, msg, data } (success code 0 or 200). */
export type ToobitResponse<T> = {
  code: number;
  msg: string;
  data: T;
};

export type OrderType = "LIMIT" | "MARKET" | "STOP";
export type PriceType = "INPUT" | "OPPONENT" | "QUEUE" | "OVER" | "MARKET";
export type TimeInForce = "GTC" | "IOC" | "FOK";

export type PlaceOrderParams = {
  symbol: string;
  side: FuturesSide;
  type: OrderType;
  quantity: string;
  price?: string;
  newClientOrderId?: string;
  priceType?: PriceType;
  stopPrice?: string;
  timeInForce?: TimeInForce;
};

export type TradingStopParams = {
  symbol: string;
  side: "LONG" | "SHORT";
  takeProfit?: string;
  stopLoss?: string;
};

export type BatchOrderItem = {
  symbol: string;
  side: FuturesSide;
  type: OrderType;
  quantity: string;
  price?: string;
  newClientOrderId?: string;
  priceType?: PriceType;
  stopPrice?: string;
  timeInForce?: TimeInForce;
};

// ----- market payload shapes (public) -----

/** Candle as returned by /quote/v1/klines. */
export type RawCandle = {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime?: number;
};

/** 24h ticker for a futures contract (also used for the price feed). */
export type RawContractTicker = {
  symbol?: string;
  priceChange?: string;
  priceChangePercent?: string;
  highPrice?: string;
  lowPrice?: string;
  lastPrice?: string;
  volume?: string;
  quoteVolume?: string;
  openPrice?: string;
  closeTime?: number;
  // Toobit contract ticker often uses short aliases (c/o/h/l/v), verified
  // live via TOOBIT_DEBUG_RAW — the "c" field is the last price.
  c?: string;
  o?: string;
  h?: string;
  l?: string;
  v?: string;
  [key: string]: unknown;
};

export type RawMarkPrice = {
  symbol?: string;
  markPrice?: string;
  indexPrice?: string;
  fundingRate?: string;
  time?: number;
  [key: string]: unknown;
};

export type RawExchangeInfoSymbol = {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  contractSize?: string | number;
  minQty?: string | number;
  maxQty?: string | number;
  stepSize?: string | number;
  tickSize?: string | number;
  minNotional?: string | number;
  maxNotional?: string | number;
  maxLeverage?: string | number;
  [key: string]: unknown;
};

// ----- private payload shapes -----

export type RawPosition = {
  symbol?: string;
  side?: string;
  positionSide?: string;
  positionAmt?: string | number;
  entryPrice?: string | number;
  markPrice?: string | number;
  unrealizedProfit?: string | number;
  unrealizedPnl?: string | number;
  leverage?: string | number;
  liquidationPrice?: string | number;
  marginType?: string;
  [key: string]: unknown;
};

export type RawBalance = {
  asset?: string;
  walletBalance?: string | number;
  availableBalance?: string | number;
  marginBalance?: string | number;
  unrealizedProfit?: string | number;
  frozen?: string | number;
  [key: string]: unknown;
};

export type RawOpenOrder = {
  orderId?: string;
  clientOrderId?: string;
  symbol?: string;
  side?: string;
  type?: string;
  price?: string;
  quantity?: string;
  origQty?: string;
  executedQty?: string;
  status?: string;
  timeInForce?: string;
  stopPrice?: string;
  [key: string]: unknown;
};

export type RawRiskLimit = {
  symbol?: string;
  level?: string | number;
  maxLeverage?: string | number;
  maxNotional?: string | number;
  maintMarginRate?: string | number;
  [key: string]: unknown;
};

export type RawExchangeInfo = {
  timezone?: string;
  serverTime?: number;
  rateLimits?: unknown[];
  symbols?: RawExchangeInfoSymbol[];
  [key: string]: unknown;
};
