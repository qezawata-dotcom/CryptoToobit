import type {
  RawBalance,
  RawContractTicker,
  RawCandle,
  RawExchangeInfo,
  RawExchangeInfoSymbol,
  RawMarkPrice,
  RawOpenOrder,
  RawPosition,
  RawRiskLimit,
} from "./types.js";
import type { Candle, ContractInfo, PositionInfo } from "../types.js";

/**
 * Response normalisation layer. Toobit's exact response field names cannot be
 * verified from this host (api.toobit.com is TLS-blocked), so every mapping
 * accepts the aliases found in Toobit's public docs + MCP server and falls
 * back to the first non-empty candidate. Each alias name the docs are known to
 * use is listed; the live field is printed once behind TOOBIT_DEBUG_RAW.
 *
 * Every function here is pure and unit-tested against canned fixtures.
 */

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) {
      return num(v);
    }
  }
  return 0;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v) !== "") return String(v);
  }
  return "";
}

/** /quote/v1/klines item → Candle. Accepts string and number payloads. */
export function toCandle(item: unknown): Candle {
  const obj = (item ?? {}) as Record<string, unknown>;
  return {
    openTime: num(obj.openTime ?? obj.t ?? obj[0]),
    open: num(obj.open ?? obj.o ?? obj[1]),
    high: num(obj.high ?? obj.h ?? obj[2]),
    low: num(obj.low ?? obj.l ?? obj[3]),
    close: num(obj.close ?? obj.c ?? obj[4]),
    volume: num(obj.volume ?? obj.v ?? obj[5]),
  };
}

export function candlesToCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(toCandle);
}

/** 24h contract ticker → { last, high, low, volume, changePercent }. */
export function toTicker(raw: unknown): {
  symbol: string;
  last: number;
  high: number;
  low: number;
  open: number;
  volume: number;
  changePercent: number;
} {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const last = pickNum(obj, ["lastPrice", "c", "close", "price"]);
  const high = pickNum(obj, ["highPrice", "h"]);
  const low = pickNum(obj, ["lowPrice", "l"]);
  const open = pickNum(obj, ["openPrice", "o"]);
  const volume = pickNum(obj, ["volume", "v", "baseVolume"]);
  const changePercent = pickNum(obj, ["priceChangePercent", "changePercent", "pc"]);
  return {
    symbol: pickStr(obj, ["symbol", "s"]),
    last,
    high,
    low,
    open,
    volume,
    changePercent,
  };
}

/** mark price → { symbol, markPrice, indexPrice, fundingRate }. */
export function toMarkPrice(raw: unknown): {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  time: number;
} {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    symbol: pickStr(obj, ["symbol", "s"]),
    markPrice: pickNum(obj, ["markPrice", "p"]),
    indexPrice: pickNum(obj, ["indexPrice", "i"]),
    fundingRate: pickNum(obj, ["fundingRate", "r"]),
    time: pickNum(obj, ["time", "ts"]),
  };
}

/** /api/v1/exchangeInfo symbol entry → ContractInfo (with safe defaults). */
export function toContractInfo(symbol: string, raw: RawExchangeInfoSymbol | undefined): ContractInfo {
  if (!raw) {
    return {
      symbol,
      contract_size: 0,
      min_qty: 0,
      max_qty: 0,
      min_notional: 0,
      max_notional: 0,
      tick_size: 0,
      max_leverage: 0,
    };
  }
  const o = raw as unknown as Record<string, unknown>;
  return {
    symbol: symbol || pickStr(o, ["symbol"]),
    contract_size: pickNum(o, ["contractSize", "contract_size", "pricePrecision"]) || 1,
    min_qty: pickNum(o, ["minQty", "min_qty"]),
    max_qty: pickNum(o, ["maxQty", "max_qty"]),
    min_notional: pickNum(o, ["minNotional", "min_notional"]),
    max_notional: pickNum(o, ["maxNotional", "max_notional"]),
    tick_size: pickNum(o, ["tickSize", "tick_size", "pricePrecision"]),
    max_leverage: pickNum(o, ["maxLeverage", "max_leverage"]),
  };
}

/** Parse the symbols array from exchangeInfo for a specific contract symbol. */
export function findContractInfo(rawExchangeInfo: RawExchangeInfo, symbol: string): ContractInfo | null {
  const symbols = rawExchangeInfo.symbols;
  if (!Array.isArray(symbols)) return null;
  const found = symbols.find(
    (s) => pickStr(s as unknown as Record<string, unknown>, ["symbol", "s"]) === symbol,
  );
  return found ? toContractInfo(symbol, found) : null;
}

/**
 * Position → PositionInfo. Position size is in contracts; sign encodes side
 * (LONG positive, SHORT negative). ROI is computed from entry vs mark to avoid
 * trusting the exchange's own (possibly absent) roi field.
 */
export function toPositionInfo(raw: unknown): PositionInfo {
  const o = (raw ?? {}) as Record<string, unknown>;
  const size = pickNum(o, ["positionAmt", "amount", "positionSize", "size", "position"]);
  const entryPrice = pickNum(o, ["entryPrice", "avgPrice", "price"]);
  const markPrice = pickNum(o, ["markPrice", "mark"]);
  const leverage = pickNum(o, ["leverage"]) || 1;

  const exists = size !== 0;
  const unrealizedPnl = pickNum(o, ["unrealizedProfit", "unrealizedPnl", "pnl", "uPnl"]);
  let roi = 0;
  if (exists && entryPrice > 0 && markPrice > 0) {
    roi = (size > 0 ? 1 : -1) * ((markPrice - entryPrice) / entryPrice) * leverage * 100;
  }

  return {
    exists,
    entry_price: entryPrice,
    mark_price: markPrice,
    position_size: Math.abs(size),
    unrealized_pnl: unrealizedPnl,
    roi,
    leverage,
    liquidation_price: pickNum(o, ["liquidationPrice", "liquidation"]) || null,
  };
}

/** Raw futures balance → { wallet, available, margin, frozen }. */
export function toBalance(raw: unknown): {
  wallet: number;
  available: number;
  margin: number;
  unrealized: number;
  frozen: number;
} {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    wallet: pickNum(o, ["walletBalance", "totalWalletBalance", "balance"]),
    available: pickNum(o, ["availableBalance", "available", "maxTransferOut", "free"]),
    margin: pickNum(o, ["marginBalance", "margin", "positionMargin"]),
    unrealized: pickNum(o, ["unrealizedProfit", "unrealizedPnl"]),
    // openOrderMarginFrozen is the term the XT sizing formula subtracts from
    // the wallet balance (get_tradable_balance). Toobit's equivalent may be
    // plain `frozen`/`locked` — accept all three.
    frozen: pickNum(o, ["openOrderMarginFrozen", "frozen", "frozenBalance", "locked"]),
  };
}

/**
 * Resolve the position side a raw position belongs to. Toobit may report
 * `positionSide`/`side`, or `BOTH` in one-way mode (where the sign of the size
 * encodes the side); when neither is present, fall back to the size sign.
 */
export function positionSideOf(raw: unknown): "LONG" | "SHORT" | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const explicit = pickStr(o, ["positionSide", "side"]);
  if (explicit === "LONG" || explicit === "SHORT") return explicit;
  if (explicit && explicit.toUpperCase() === "BOTH") {
    const size = pickNum(o, ["positionSize", "positionAmt", "position", "size"]);
    return size >= 0 ? "LONG" : "SHORT";
  }
  const size = pickNum(o, ["positionSize", "positionAmt", "position", "size"]);
  if (size > 0) return "LONG";
  if (size < 0) return "SHORT";
  return null;
}

/** Signed position size in contracts (positive LONG, negative SHORT). */
export function positionSizeOf(raw: unknown): number {
  return pickNum(o(raw), ["positionSize", "positionAmt", "position", "size"]);
}

function o(raw: unknown): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>;
}

/**
 * Raw position → the rich view PositionManager needs. Mirrors the Python
 * get_position_pnl() field read with Toobit alias candidates.
 *
 * `profit_id` is a truthy sentinel ("position-tpsl") whenever the position
 * carries trigger prices but no explicit id — Toobit's trading-stop is keyed by
 * (symbol, side), so the id is only used as an "is protected" gate.
 */
export function toPositionDetail(raw: unknown): {
  position_side: "LONG" | "SHORT" | null;
  unrealized_pnl: number;
  entry_price: number;
  mark_price: number;
  leverage: number;
  position_size: number;
  margin: number;
  profit_id: string | null;
  trigger_profit_price: number;
  trigger_stop_price: number;
  position_type: string;
  available_close_size: number;
} {
  const obj = o(raw);
  const size = positionSizeOf(raw);
  const entry = pickNum(obj, ["entryPrice", "avgPrice", "price"]);
  const mark = pickNum(obj, ["calMarkPrice", "markPrice", "mark"]);
  const leverage = pickNum(obj, ["leverage"]) || 1;
  const explicitId = pickStr(obj, ["profitId", "takeProfitId", "stopLossId"]);
  const tp = pickNum(obj, ["takeProfitPrice", "triggerProfitPrice"]);
  const sl = pickNum(obj, ["stopLossPrice", "triggerStopPrice"]);
  return {
    position_side: positionSideOf(raw),
    unrealized_pnl: pickNum(obj, ["floatingPL", "unrealizedProfit", "unrealizedPnl", "pnl"]),
    entry_price: entry,
    mark_price: mark,
    leverage,
    position_size: size,
    margin: pickNum(obj, ["isolatedMargin", "margin", "positionMargin"]),
    profit_id: explicitId || (tp > 0 || sl > 0 ? "position-tpsl" : null),
    trigger_profit_price: tp,
    trigger_stop_price: sl,
    position_type: pickStr(obj, ["positionType", "marginType"]),
    available_close_size: pickNum(obj, ["availableCloseSize", "availableClose", "closeSize"]),
  };
}

/** Open order → whether it is a protective STOP_PROFIT_LOSS-style order. */
export function toOpenOrder(raw: unknown): {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  type: string;
  price: number;
  stopPrice: number;
  quantity: number;
  status: string;
} {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    orderId: pickStr(o, ["orderId", "id"]),
    clientOrderId: pickStr(o, ["clientOrderId", "clientOrder"]),
    symbol: pickStr(o, ["symbol"]),
    type: pickStr(o, ["type", "orderType"]),
    price: pickNum(o, ["price"]),
    stopPrice: pickNum(o, ["stopPrice", "triggerPrice"]),
    quantity: pickNum(o, ["quantity", "origQty", "qty"]),
    status: pickStr(o, ["status", "state"]),
  };
}

export { toRiskLimit };

/** Risk limit tier → { maxLeverage, maxNotional, maintMarginRate }. */
function toRiskLimit(raw: unknown): { maxLeverage: number; maxNotional: number; maintMarginRate: number } {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    maxLeverage: pickNum(o, ["maxLeverage", "leverage"]),
    maxNotional: pickNum(o, ["maxNotional", "notionalCap"]),
    maintMarginRate: pickNum(o, ["maintMarginRate", "maintMargin"]),
  };
}

// Re-export the raw types for callers that need them.
export type { RawBalance, RawContractTicker, RawCandle, RawExchangeInfo, RawExchangeInfoSymbol, RawMarkPrice, RawOpenOrder, RawPosition, RawRiskLimit };
