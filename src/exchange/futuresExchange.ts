import type { Candle } from "../types.js";
import type { PlaceOrderParams, TradingStopParams } from "./types.js";

/**
 * The futures-exchange surface the bot's managers and trader depend on.
 *
 * ToobitClient implements this structurally; tests provide a MockToobitClient
 * with the same shape, so the whole trade lifecycle (open → TP/SL → mid-manage
 * → close) can be exercised hermetically without touching api.toobit.com.
 *
 * Raw-wire methods return `unknown` / `unknown[]` — the normalize layer maps
 * them onto canonical shapes where the managers need typed access.
 */

/** A successful private write returns an envelope with `.data` (client parity). */
export type ExchangeResponse<T = unknown> = {
  data: T;
  endpoint?: string;
};

export interface FuturesExchange {
  // positions
  getFuturesPositions(symbol?: string): Promise<unknown[]>;
  // orders
  placeFuturesOrder(params: PlaceOrderParams): Promise<ExchangeResponse<unknown>>;
  cancelFuturesOrder(orderId: string, clientOrderId?: string): Promise<ExchangeResponse<unknown>>;
  cancelAllFuturesOrders(symbol: string): Promise<ExchangeResponse<unknown>>;
  getFuturesOpenOrders(symbol?: string): Promise<unknown[]>;
  // leverage / margin mode
  setFuturesLeverage(symbol: string, leverage: number): Promise<ExchangeResponse<unknown>>;
  setFuturesMarginType(symbol: string, marginType: "CROSS" | "ISOLATED"): Promise<ExchangeResponse<unknown>>;
  // TP/SL (position trading-stop)
  setFuturesTradingStop(params: TradingStopParams): Promise<ExchangeResponse<unknown>>;
  // close
  flashClose(symbol: string, side: "LONG" | "SHORT"): Promise<ExchangeResponse<unknown>>;
  // balance
  getFuturesBalance(): Promise<ExchangeResponse<unknown>>;
  // market data
  getExchangeInfo(): Promise<ExchangeResponse<unknown>>;
  getRiskLimits(symbol: string): Promise<ExchangeResponse<unknown>>;
  getKlines(symbol: string, interval: string, limit?: number): Promise<Candle[]>;
  getTickerPrice(symbol: string): Promise<number>;
  getMarkPrice(symbol: string): Promise<number>;
}
