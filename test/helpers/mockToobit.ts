import type {
  FuturesExchange,
  ExchangeResponse,
} from "../../src/exchange/futuresExchange.js";
import type { PlaceOrderParams, TradingStopParams } from "../../src/exchange/types.js";
import type { Candle } from "../../src/types.js";
import { positionSideOf, positionSizeOf, toPositionDetail } from "../../src/exchange/normalize.js";

/**
 * MockToobitClient — an in-memory stand-in for api.toobit.com implementing the
 * exact FuturesExchange surface the managers/trader depend on. No network.
 *
 * Every method records its arguments on `calls` for assertions. `fail()` marks
 * an endpoint to throw (simulating a Toobit rejection like a trading-stop
 * failure or a price tick); `failClear()` removes the marker.
 *
 * Positions/orders are stored as raw Toobit-shaped records (positionAmt,
 * entryPrice, markPrice, floatingPL, isolatedMargin, availableCloseSize,
 * profitId/triggerProfitPrice/triggerStopPrice, leverage), so the normalize
 * layer exercises its real aliasing against them.
 */

export type MockPosition = {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  positionAmt: number; // signed contracts
  entryPrice: number;
  markPrice: number;
  floatingPL: number;
  isolatedMargin: number;
  leverage: number;
  availableCloseSize: number;
  profitId?: string;
  triggerProfitPrice?: number;
  triggerStopPrice?: number;
};

export type MockOrder = {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: "BUY_OPEN" | "SELL_OPEN" | "BUY_CLOSE" | "SELL_CLOSE";
  type: "LIMIT" | "MARKET" | "STOP" | "STOP_PROFIT_LOSS";
  price: number;
  stopPrice: number;
  quantity: number;
  status: string;
};

const SYMBOL = "BTC-SWAP-USDT";

export class MockToobitClient implements FuturesExchange {
  positions: MockPosition[] = [];
  openOrders: MockOrder[] = [];
  balance: Record<string, unknown> = { asset: "USDT", walletBalance: "10000", availableBalance: "10000", openOrderMarginFrozen: "0", unrealizedProfit: "0", marginBalance: "10000" };
  contractConfig: Record<string, unknown> = {
    symbol: SYMBOL,
    contractSize: "0.0001",
    minQty: "1",
    maxQty: "1000000",
    minNotional: "5",
    maxNotional: "1000000",
    tickSize: "0.1",
  };
  riskLimits: Record<string, unknown>[] = [
    { symbol: SYMBOL, maxLeverage: 100, maxNotional: 50000, maintMarginRate: 0.005 },
    { symbol: SYMBOL, maxLeverage: 50, maxNotional: 100000, maintMarginRate: 0.01 },
    { symbol: SYMBOL, maxLeverage: 25, maxNotional: 500000, maintMarginRate: 0.02 },
    { symbol: SYMBOL, maxLeverage: 20, maxNotional: 1000000, maintMarginRate: 0.03 },
  ];
  klines: Record<string, Candle[]> = {};

  calls: Record<string, unknown[]> = {};
  private _fail: Set<string> = new Set();

  record(method: string, args: unknown[]): void {
    (this.calls[method] ??= []).push(args);
  }

  fail(method: string): void {
    this._fail.add(method);
  }

  failClear(method: string): void {
    this._fail.delete(method);
  }

  private _throwIf(method: string): void {
    if (this._fail.has(method)) {
      throw new Error(`${method} rejected by mock exchange`);
    }
  }

  /** Convenience: reflect a position's trigger prices onto a STOP_PROFIT_LOSS order. */
  attachStop(position: MockPosition, orderId: string): void {
    position.profitId = "mock-tpsl";
    this.openOrders.push({
      orderId,
      symbol: position.symbol,
      side: position.positionSide === "LONG" ? "BUY_OPEN" : "SELL_OPEN",
      type: "STOP_PROFIT_LOSS",
      price: 0,
      stopPrice: position.triggerStopPrice ?? 0,
      quantity: position.availableCloseSize,
      status: "NEW",
    });
  }

  setMarkPrice(symbol: string, price: number): void {
    for (const p of this.positions) {
      if (p.symbol === symbol) {
        p.markPrice = price;
        const move = p.positionAmt > 0 ? price - p.entryPrice : p.entryPrice - price;
        p.floatingPL = move * Math.abs(p.positionAmt) * Number(this.contractConfig.contractSize);
      }
    }
  }

  // ---------- FuturesExchange surface ----------

  async getFuturesPositions(symbol?: string): Promise<unknown[]> {
    this.record("getFuturesPositions", [symbol]);
    const all = this.positions
      .filter((p) => Math.abs(p.positionAmt) > 0)
      .map((p) => this._toRawPosition(p));
    return symbol ? all.filter((p) => (p as Record<string, unknown>).symbol === symbol) : all;
  }

  async placeFuturesOrder(params: PlaceOrderParams): Promise<ExchangeResponse<unknown>> {
    this.record("placeFuturesOrder", [params]);
    this._throwIf("placeFuturesOrder");
    const orderId = `mock-${Math.floor(Math.random() * 1e9)}`;
    const isMarket = params.priceType === "MARKET" || params.type === "MARKET";
    const price = isMarket ? this._lastPrice(params.symbol) : Number(params.price ?? 0);
    this.openOrders.push({
      orderId,
      clientOrderId: params.newClientOrderId,
      symbol: params.symbol,
      side: params.side,
      type: isMarket ? "LIMIT" : (params.type as MockOrder["type"]),
      price,
      stopPrice: params.stopPrice ? Number(params.stopPrice) : 0,
      quantity: Number(params.quantity),
      status: "NEW",
    });
    // A priceType=MARKET (the client's MARKET encoding) or explicit MARKET order
    // fills immediately against the current mark.
    if (isMarket) {
      this._fillOrder(orderId);
    }
    return { data: { orderId, symbol: params.symbol, type: params.type, side: params.side }, endpoint: "POST /api/v1/futures/order" };
  }

  async cancelFuturesOrder(orderId: string, clientOrderId?: string): Promise<ExchangeResponse<unknown>> {
    this.record("cancelFuturesOrder", [orderId, clientOrderId]);
    this._throwIf("cancelFuturesOrder");
    this.openOrders = this.openOrders.filter(
      (o) => o.orderId !== orderId && (!clientOrderId || o.clientOrderId !== clientOrderId),
    );
    return { data: { orderId }, endpoint: "DELETE /api/v1/futures/order" };
  }

  async cancelAllFuturesOrders(symbol: string): Promise<ExchangeResponse<unknown>> {
    this.record("cancelAllFuturesOrders", [symbol]);
    this._throwIf("cancelAllFuturesOrders");
    this.openOrders = this.openOrders.filter((o) => o.symbol !== symbol);
    return { data: { symbol }, endpoint: "DELETE /api/v1/futures/batchOrders" };
  }

  async getFuturesOpenOrders(symbol?: string): Promise<unknown[]> {
    this.record("getFuturesOpenOrders", [symbol]);
    return symbol
      ? this.openOrders.filter((o) => o.symbol === symbol)
      : this.openOrders;
  }

  async setFuturesLeverage(symbol: string, leverage: number): Promise<ExchangeResponse<unknown>> {
    this.record("setFuturesLeverage", [symbol, leverage]);
    this._throwIf("setFuturesLeverage");
    return { data: { symbol, leverage: String(leverage) }, endpoint: "POST /api/v1/futures/leverage" };
  }

  async setFuturesMarginType(symbol: string, marginType: "CROSS" | "ISOLATED"): Promise<ExchangeResponse<unknown>> {
    this.record("setFuturesMarginType", [symbol, marginType]);
    this._throwIf("setFuturesMarginType");
    return { data: { symbol, marginType }, endpoint: "POST /api/v1/futures/marginType" };
  }

  async setFuturesTradingStop(params: TradingStopParams): Promise<ExchangeResponse<unknown>> {
    this.record("setFuturesTradingStop", [params]);
    this._throwIf("setFuturesTradingStop");
    const pos = this.positions.find(
      (p) => p.symbol === params.symbol && p.positionSide === params.side,
    );
    if (pos) {
      if (params.takeProfit !== undefined) pos.triggerProfitPrice = Number(params.takeProfit);
      if (params.stopLoss !== undefined) pos.triggerStopPrice = Number(params.stopLoss);
      // If the stop was removed (empty stopLoss), drop the sentinel.
      pos.profitId = pos.triggerStopPrice > 0 ? "position-tpsl" : undefined;
    }
    return { data: { symbol: params.symbol, side: params.side }, endpoint: "POST /api/v1/futures/position/trading-stop" };
  }

  async flashClose(symbol: string, side: "LONG" | "SHORT"): Promise<ExchangeResponse<unknown>> {
    this.record("flashClose", [symbol, side]);
    this._throwIf("flashClose");
    this.positions = this.positions.filter((p) => !(p.symbol === symbol && p.positionSide === side));
    return { data: { symbol, side }, endpoint: "POST /api/v1/futures/flashClose" };
  }

  async getFuturesBalance(): Promise<ExchangeResponse<unknown>> {
    this.record("getFuturesBalance", []);
    this._throwIf("getFuturesBalance");
    // Return a copy: the risk manager caches the object reference for 3s, and a
    // live alias would let later mutations leak through the cache.
    return { data: [{ ...this.balance }], endpoint: "GET /api/v1/futures/balance" };
  }

  async getExchangeInfo(): Promise<ExchangeResponse<unknown>> {
    this.record("getExchangeInfo", []);
    return {
      data: { symbols: [this.contractConfig] },
      endpoint: "GET /api/v1/exchangeInfo",
    };
  }

  async getRiskLimits(symbol: string): Promise<ExchangeResponse<unknown>> {
    this.record("getRiskLimits", [symbol]);
    return { data: this.riskLimits, endpoint: "GET /api/v1/futures/riskLimits" };
  }

  async getKlines(symbol: string, interval: string, limit?: number): Promise<Candle[]> {
    this.record("getKlines", [symbol, interval, limit]);
    const rows = this.klines[`${symbol}:${interval}`] ?? [];
    return limit ? rows.slice(-limit) : rows;
  }

  async getTickerPrice(symbol: string): Promise<number> {
    this.record("getTickerPrice", [symbol]);
    return this._lastPrice(symbol);
  }

  async getMarkPrice(symbol: string): Promise<number> {
    this.record("getMarkPrice", [symbol]);
    const pos = this.positions.find((p) => p.symbol === symbol && Math.abs(p.positionAmt) > 0);
    return pos ? pos.markPrice : this._lastPrice(symbol);
  }

  // ---------- internals ----------

  private _lastPrice(symbol: string): number {
    const pos = this.positions.find((p) => p.symbol === symbol && Math.abs(p.positionAmt) > 0);
    if (pos) return pos.markPrice;
    const row = this.klines[`${symbol}:5m`];
    if (row && row.length) return row[row.length - 1].close;
    return 0;
  }

  private _fillOrder(orderId: string): void {
    const order = this.openOrders.find((o) => o.orderId === orderId);
    if (!order) return;
    const price = order.price > 0 ? order.price : this._lastPrice(order.symbol);
    const cs = Number(this.contractConfig.contractSize) || 1;
    const openSide = order.side === "BUY_OPEN" ? "LONG" : order.side === "SELL_OPEN" ? "SHORT" : null;
    if (openSide) {
      const existing = this.positions.find((p) => p.symbol === order.symbol && p.positionSide === openSide);
      if (existing) {
        existing.positionAmt += order.side === "BUY_OPEN" ? order.quantity : -order.quantity;
        existing.markPrice = price;
        existing.availableCloseSize = Math.abs(existing.positionAmt);
      } else {
        this.positions.push({
          symbol: order.symbol,
          positionSide: openSide,
          positionAmt: order.side === "BUY_OPEN" ? order.quantity : -order.quantity,
          entryPrice: price,
          markPrice: price,
          floatingPL: 0,
          isolatedMargin: order.quantity * cs * price / 10,
          leverage: 10,
          availableCloseSize: order.quantity,
        });
      }
    } else {
      // Close side: reduce the matching position.
      const pos = this.positions.find(
        (p) => p.symbol === order.symbol && p.positionSide === (order.side === "SELL_CLOSE" ? "LONG" : "SHORT"),
      );
      if (pos) {
        pos.positionAmt = Math.max(0, pos.positionAmt - (order.side === "SELL_CLOSE" ? order.quantity : -order.quantity));
        pos.availableCloseSize = Math.abs(pos.positionAmt);
        if (pos.positionAmt === 0) this.positions = this.positions.filter((p) => p !== pos);
      }
    }
    this.openOrders = this.openOrders.filter((o) => o.orderId !== orderId);
  }

  private _toRawPosition(p: MockPosition): Record<string, unknown> {
    return {
      symbol: p.symbol,
      positionSide: p.positionSide,
      positionAmt: p.positionAmt,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      floatingPL: p.floatingPL,
      isolatedMargin: p.isolatedMargin,
      leverage: p.leverage,
      availableCloseSize: p.availableCloseSize,
      profitId: p.profitId,
      takeProfitPrice: p.triggerProfitPrice,
      stopLossPrice: p.triggerStopPrice,
    };
  }
}

export { SYMBOL, positionSideOf, positionSizeOf, toPositionDetail };
