import { Config } from "../config.js";
import { logger } from "../logger.js";
import { toOpenOrder, toPositionDetail, positionSideOf, positionSizeOf } from "../exchange/normalize.js";
import type { FuturesExchange } from "../exchange/futuresExchange.js";
import type { PositionSide } from "../types.js";
import type { LongTermMemory } from "./memory.js";
import type { RiskManager } from "./riskManager.js";

/**
 * PositionManager — a port of CryptoMind-XT/bot/position_manager.py onto
 * Toobit's position-keyed TP/SL model.
 *
 * XT protected positions with a separate profit-entrust (profitId). Toobit sets
 * TP/SL directly on the position via POST /futures/position/trading-stop, keyed
 * by (symbol, side); creating and moving are the same call. So:
 *   - profit_id is a truthy sentinel meaning "the position carries trigger
 *     prices" (never used as a cancel target).
 *   - "cancelling" a stop means removing the matching STOP_PROFIT_LOSS open
 *     order (or leaving the position to shed it when closed).
 *   - close_position only ever targets the closing side's stop, never
 *     cancel_all_tpsl (which would destroy a hedged opposite position's stop).
 *
 * Everything else — breakeven/trailing monotonicity, the ATR dynamic TP/SL,
 * adopt/reconcile, and close-reads-PnL-before-close — is ported exactly.
 */

const TPSL_STOP_ORDER_RE = /profit_loss|tpsl|stop/i;

export type CloseResult = { ok: boolean; data: unknown; error: string | null };

/** The rich per-position view get_position_pnl() returns (Python dict parity). */
export type PositionPnl = {
  exists: boolean;
  position_side: PositionSide | null;
  unrealized_pnl: number;
  roi: number;
  entry_price: number;
  mark_price: number;
  leverage: number;
  position_size: number;
  position_value: number;
  margin: number;
  profit_id: string | null;
  trigger_profit_price: number;
  trigger_stop_price: number;
  position_type: string;
  available_close_size: number;
};

export class PositionManager {
  constructor(
    private exchange: FuturesExchange,
    private memory: LongTermMemory,
    private risk: RiskManager,
  ) {}

  // ---------- positions ----------

  async get_positions(symbol?: string): Promise<unknown[]> {
    try {
      return await this.exchange.getFuturesPositions(symbol);
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "Position fetch failed");
      return [];
    }
  }

  /** Returns the raw position for a side, or {} when absent/flat. */
  async get_position(symbol: string, side: PositionSide): Promise<Record<string, unknown>> {
    const positions = await this.get_positions(symbol);
    for (const raw of positions) {
      if (positionSideOf(raw) !== side) continue;
      if (Math.abs(positionSizeOf(raw)) <= 0) continue;
      return (raw ?? {}) as Record<string, unknown>;
    }
    return {};
  }

  /**
   * Records any position open on the exchange but missing from the local DB.
   * Everything else keys off memory.get_open_trades(), so a wiped database or a
   * manually opened position would otherwise be completely unmanaged.
   */
  async adopt_exchange_positions(): Promise<
    { trade_id: number; symbol: string; position_side: PositionSide; size: number; entry_price: number; leverage: number; has_stop: boolean }[]
  > {
    const adopted: { trade_id: number; symbol: string; position_side: PositionSide; size: number; entry_price: number; leverage: number; has_stop: boolean }[] = [];
    let positions: unknown[];
    try {
      positions = await this.exchange.getFuturesPositions();
    } catch (error) {
      logger.warn({ err: String(error) }, "Could not enumerate exchange positions");
      return adopted;
    }
    const known = new Set(
      this.memory.get_open_trades().map((t) => `${t.symbol}:${t.position_side}`),
    );
    for (const raw of positions) {
      const size = positionSizeOf(raw);
      if (Math.abs(size) <= 0) continue;
      const side = positionSideOf(raw);
      const symbol = String((raw as Record<string, unknown>)?.symbol ?? "");
      if (!symbol || !side) continue;
      if (known.has(`${symbol}:${side}`)) continue;
      const entry = Number((raw as Record<string, unknown>)?.entryPrice ?? (raw as Record<string, unknown>)?.avgPrice ?? 0);
      const leverage = Number((raw as Record<string, unknown>)?.leverage ?? 1) || 1;
      const trade_id = this.memory.record_trade({
        symbol,
        position_side: side,
        order_id: null,
        entry_price: entry,
        amount: Math.abs(size),
        leverage,
        confidence: 0,
        strategy: "ADOPTED",
        signal_strength: 0,
        timeframe: "",
      });
      const detail = toPositionDetail(raw);
      logger.warn(`Adopted untracked position ${symbol} ${side} ${Math.abs(size)}c @ ${entry} as trade ${trade_id}`);
      adopted.push({
        trade_id,
        symbol,
        position_side: side,
        size: Math.abs(size),
        entry_price: entry,
        leverage,
        has_stop: Boolean(detail.profit_id),
      });
    }
    return adopted;
  }

  private async _public_mark_price(symbol: string): Promise<number> {
    try {
      return await this.exchange.getMarkPrice(symbol);
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "Mark price fallback failed");
      return 0;
    }
  }

  async get_position_pnl(symbol: string, side: PositionSide): Promise<PositionPnl> {
    const raw = await this.get_position(symbol, side);
    return this._build_pnl(raw, symbol, side);
  }

  private async _build_pnl(
    raw: Record<string, unknown>,
    symbol: string,
    side: PositionSide,
  ): Promise<PositionPnl> {
    const empty: PositionPnl = {
      exists: false,
      position_side: null,
      unrealized_pnl: 0,
      roi: 0,
      entry_price: 0,
      mark_price: 0,
      leverage: 1,
      position_size: 0,
      position_value: 0,
      margin: 0,
      profit_id: null,
      trigger_profit_price: 0,
      trigger_stop_price: 0,
      position_type: "",
      available_close_size: 0,
    };
    if (Object.keys(raw).length === 0) return empty;

    const d = toPositionDetail(raw);
    let mark = d.mark_price;
    if (mark <= 0) {
      // Without a mark price every ROI is 0, which silently disables breakeven
      // and trailing regardless of their thresholds.
      mark = await this._public_mark_price(symbol);
    }
    const size = Math.abs(d.position_size);
    const cs = await this.risk.get_contract_size(symbol);
    // ROI on margin: price move as a fraction of entry, amplified by leverage.
    let roi = 0;
    if (d.entry_price > 0 && mark > 0) {
      let move = (mark - d.entry_price) / d.entry_price;
      if (side === "SHORT") move = -move;
      roi = move * d.leverage * 100;
    }
    return {
      exists: true,
      position_side: side,
      unrealized_pnl: d.unrealized_pnl,
      roi,
      entry_price: d.entry_price,
      mark_price: mark,
      leverage: d.leverage,
      position_size: d.position_size,
      position_value: size * cs * mark,
      margin: d.margin,
      profit_id: d.profit_id,
      trigger_profit_price: d.trigger_profit_price,
      trigger_stop_price: d.trigger_stop_price,
      position_type: d.position_type,
      available_close_size: d.available_close_size,
    };
  }

  // ---------- take profit / stop loss ----------

  async set_stop_loss_take_profit(
    symbol: string,
    side: PositionSide,
    triggerProfitPrice: number,
    triggerStopPrice: number,
  ): Promise<{ ok: boolean; data: unknown; error: string | null }> {
    try {
      const res = await this.exchange.setFuturesTradingStop({
        symbol,
        side,
        takeProfit: triggerProfitPrice > 0 ? String(triggerProfitPrice) : undefined,
        stopLoss: triggerStopPrice > 0 ? String(triggerStopPrice) : undefined,
      });
      return { ok: true, data: res?.data, error: null };
    } catch (error) {
      logger.error({ symbol, side, err: String(error) }, "TP/SL creation failed");
      return { ok: false, data: null, error: String(error) };
    }
  }

  /**
   * Attaches TP/SL sized from the live position (Toobit's trading-stop applies
   * to the whole position). A partially filled order otherwise produces
   * 'more than available'.
   */
  async attach_tpsl_to_position(
    symbol: string,
    side: PositionSide,
    triggerProfitPrice: number,
    triggerStopPrice: number,
    attempts = 3,
    delayMs = 1000,
  ): Promise<{ ok: boolean; protectedQty: number; error: string | null }> {
    let lastError = "no position to protect";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const pos = await this.get_position_pnl(symbol, side);
      let available = Math.trunc(pos.available_close_size || 0);
      if (available <= 0) available = Math.trunc(Math.abs(pos.position_size) || 0);
      if (available > 0) {
        const res = await this.set_stop_loss_take_profit(symbol, side, triggerProfitPrice, triggerStopPrice);
        if (res.ok) return { ok: true, protectedQty: available, error: null };
        lastError = res.error ?? "unknown";
      } else {
        lastError = "position not filled yet";
      }
      if (attempt < attempts) await sleep(delayMs);
    }
    return { ok: false, protectedQty: 0, error: lastError };
  }

  /**
   * Guarantees the position has a live TP/SL, creating one when the original
   * order was rejected. Returns { profit_id, note }.
   */
  async ensure_tpsl(
    symbol: string,
    side: PositionSide,
    opts: { triggerStopPrice?: number; triggerProfitPrice?: number; signalStrength?: number; confidence?: number } = {},
  ): Promise<{ profit_id: string | null; note: string }> {
    const signalStrength = opts.signalStrength ?? 0.6;
    const confidence = opts.confidence ?? 70;
    const pos = await this.get_position_pnl(symbol, side);
    if (!pos.exists) return { profit_id: null, note: "no open position" };
    if (pos.profit_id) return { profit_id: pos.profit_id, note: "already protected" };

    const entry = pos.entry_price;
    const leverage = pos.leverage;
    if (entry <= 0) return { profit_id: null, note: "position has no entry price" };

    const auto = await this.calculate_dynamic_tpsl(symbol, side, entry, signalStrength, confidence, leverage);
    const tp = opts.triggerProfitPrice ?? auto.tp;
    const sl = opts.triggerStopPrice ?? auto.sl;

    // A stop already beyond the mark price would trigger instantly; pull it to
    // the safe side of the current price instead of letting Toobit reject it.
    const mark = pos.mark_price || entry;
    const safety = Number(this.memory.get_setting("sl_liquidation_safety", "0.5"));
    const maxDist = this.liquidation_distance(entry, leverage) * safety;
    const safeSl = await this.risk.round_price(symbol, side === "LONG" ? entry - maxDist : entry + maxDist);
    let finalSl = sl;
    let finalTp = tp;
    if (side === "LONG") {
      const safeSlPrice = await this.risk.round_price(symbol, mark * 0.999);
      if (mark <= safeSl || safeSlPrice <= safeSl) {
        return {
          profit_id: null,
          note: `position is already past the safe stop level (mark ${mark}, safe_sl ${safeSl}); a stop here would trigger instantly. Close it or widen sl_liquidation_safety.`,
        };
      }
      finalSl = Math.min(Math.max(sl, safeSl), safeSlPrice);
      finalTp = Math.max(tp, await this.risk.round_price(symbol, mark * 1.001));
    } else {
      const safeSlPrice = await this.risk.round_price(symbol, mark * 1.001);
      if (mark >= safeSl || safeSlPrice >= safeSl) {
        return {
          profit_id: null,
          note: `position is already past the safe stop level (mark ${mark}, safe_sl ${safeSl}); a stop here would trigger instantly. Close it or widen sl_liquidation_safety.`,
        };
      }
      finalSl = Math.max(Math.min(sl, safeSl), safeSlPrice);
      finalTp = Math.min(tp, await this.risk.round_price(symbol, mark * 0.999));
    }

    const attached = await this.attach_tpsl_to_position(symbol, side, finalTp, finalSl);
    if (!attached.ok) {
      return { profit_id: null, note: `could not create TP/SL: ${attached.error}` };
    }
    // Toobit may take a moment to propagate the trigger prices onto the
    // position after creation.
    let refreshed = pos;
    for (let attempt = 0; attempt < 3; attempt++) {
      refreshed = await this.get_position_pnl(symbol, side);
      if (refreshed.profit_id) break;
      if (attempt < 2) await sleep(1000);
    }
    logger.info(`Attached TP/SL to existing ${symbol} ${side}: ${attached.protectedQty}c TP=${finalTp} SL=${finalSl} profit_id=${refreshed.profit_id}`);
    return { profit_id: refreshed.profit_id, note: `created TP=${finalTp} SL=${finalSl} on ${attached.protectedQty} contracts` };
  }

  /** Protective (STOP_PROFIT_LOSS-style) open orders for a symbol. */
  async get_active_tpsl(symbol: string): Promise<unknown[]> {
    try {
      const orders = await this.exchange.getFuturesOpenOrders(symbol);
      return orders.filter((o) => isProtectiveOrder(o));
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "TP/SL list failed");
      return [];
    }
  }

  async find_tpsl(symbol: string, side: PositionSide): Promise<Record<string, unknown>> {
    for (const order of await this.get_active_tpsl(symbol)) {
      const o = order as Record<string, unknown>;
      const orderSide = String(o?.side ?? "").toUpperCase();
      // A STOP_PROFIT_LOSS order's side names the position it protects.
      const protects = orderSide === (side === "LONG" ? "BUY_OPEN" : "SELL_OPEN");
      if (protects) return o;
    }
    return {};
  }

  async cancel_all_tpsl(symbol: string): Promise<boolean> {
    try {
      const orders = await this.get_active_tpsl(symbol);
      for (const raw of orders) {
        const o = toOpenOrder(raw);
        if (o.orderId) await this.exchange.cancelFuturesOrder(o.orderId);
      }
      return true;
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "Cancel TP/SL failed");
      return false;
    }
  }

  /** Move the stop (and keep the take-profit) via the position trading-stop. */
  private async _move_stop(
    symbol: string,
    side: PositionSide,
    newSl: number,
    keepTp: number,
  ): Promise<boolean> {
    try {
      await this.exchange.setFuturesTradingStop({
        symbol,
        side,
        takeProfit: keepTp > 0 ? String(keepTp) : undefined,
        stopLoss: String(newSl),
      });
      return true;
    } catch (error) {
      logger.warn({ symbol, side, err: String(error) }, "Stop update failed");
      return false;
    }
  }

  async check_tpsl_breakeven(symbol: string, side: PositionSide): Promise<boolean> {
    const pos = await this.get_position_pnl(symbol, side);
    if (!pos.exists) return false;
    const threshold = Number(this.memory.get_setting("breakeven_threshold_pct", "1.5"));
    if (pos.roi < threshold) {
      logger.debug(`Breakeven skipped ${symbol} ${side}: ROI ${pos.roi.toFixed(2)}% < ${threshold}%`);
      return false;
    }
    const entry = pos.entry_price;
    if (entry <= 0) return false;
    if (!pos.profit_id) {
      logger.warn(`Breakeven blocked for ${symbol} ${side}: position has no exchange TP/SL attached`);
      return false;
    }
    const currentSl = pos.trigger_stop_price;
    // Only ever tighten. A manually placed stop that is already better than
    // breakeven must not be dragged back toward entry.
    let newSl: number;
    if (side === "LONG") {
      newSl = await this.risk.round_price(symbol, entry * 1.0005);
      if (currentSl >= newSl) return false;
    } else {
      newSl = await this.risk.round_price(symbol, entry * 0.9995);
      if (0 < currentSl && currentSl <= newSl) return false;
    }
    if (await this._move_stop(symbol, side, newSl, pos.trigger_profit_price)) {
      logger.info(`Breakeven: ${symbol} ${side} ROI ${pos.roi.toFixed(2)}% SL ${currentSl} -> ${newSl}`);
      return true;
    }
    return false;
  }

  async trail_stop_loss(symbol: string, side: PositionSide): Promise<{ ok: boolean; msg: string; newSl: number | null }> {
    const pos = await this.get_position_pnl(symbol, side);
    if (!pos.exists) return { ok: false, msg: "no open position", newSl: null };
    // Trigger is ROI on margin; distance is a raw price percentage. They were
    // previously the same setting, which made "trailing 2%" mean two things.
    let triggerRoi = Number(this.memory.get_setting("trailing_trigger_roi_pct", "0") || 0);
    let distancePct = Number(this.memory.get_setting("trailing_distance_pct", "0") || 0);
    const legacy = Number(this.memory.get_setting("trailing_stop_pct", "2.0"));
    if (triggerRoi <= 0) triggerRoi = legacy;
    if (distancePct <= 0) distancePct = legacy;
    if (pos.roi < triggerRoi) {
      return { ok: false, msg: `ROI ${pos.roi.toFixed(2)}% below trailing trigger ${triggerRoi}%`, newSl: null };
    }
    if (!pos.profit_id) {
      return { ok: false, msg: "no exchange TP/SL attached to position", newSl: null };
    }
    const mark = pos.mark_price;
    if (mark <= 0) return { ok: false, msg: "no mark price available", newSl: null };
    const currentSl = pos.trigger_stop_price;
    let newSl: number;
    let improved: boolean;
    if (side === "LONG") {
      newSl = await this.risk.round_price(symbol, mark * (1 - distancePct / 100));
      improved = newSl > currentSl;
    } else {
      newSl = await this.risk.round_price(symbol, mark * (1 + distancePct / 100));
      improved = currentSl <= 0 || newSl < currentSl;
    }
    if (!improved) return { ok: false, msg: `no improvement (SL already ${currentSl})`, newSl: null };
    if (await this._move_stop(symbol, side, newSl, pos.trigger_profit_price)) {
      logger.info(`Trailing: ${symbol} ${side} ROI ${pos.roi.toFixed(2)}% SL ${currentSl} -> ${newSl}`);
      return { ok: true, msg: `Trailing SL ${currentSl} -> ${newSl}`, newSl };
    }
    return { ok: false, msg: "stop update rejected by exchange", newSl: null };
  }

  async explain_mid_management(symbol: string, side: PositionSide): Promise<string> {
    const pos = await this.get_position_pnl(symbol, side);
    if (!pos.exists) return `${symbol} ${side}: no open position on the exchange.`;
    const beThreshold = Number(this.memory.get_setting("breakeven_threshold_pct", "1.5"));
    const legacy = Number(this.memory.get_setting("trailing_stop_pct", "2.0"));
    const triggerRoi = Number(this.memory.get_setting("trailing_trigger_roi_pct", "0") || 0) || legacy;
    const distancePct = Number(this.memory.get_setting("trailing_distance_pct", "0") || 0) || legacy;
    const lines = [
      `${symbol} ${side}`,
      `  entry=${pos.entry_price} mark=${pos.mark_price} lev=${pos.leverage}x size=${Math.trunc(Math.abs(pos.position_size))}c`,
      `  ROI on margin = ${pos.roi.toFixed(2)}%`,
      `  exchange SL=${pos.trigger_stop_price} TP=${pos.trigger_profit_price} profitId=${pos.profit_id}`,
      `  breakeven fires at ROI >= ${beThreshold}% -> ${pos.roi >= beThreshold ? "READY" : "not yet"}`,
      `  trailing fires at ROI >= ${triggerRoi}% (distance ${distancePct}% of price) -> ${pos.roi >= triggerRoi ? "READY" : "not yet"}`,
    ];
    if (!pos.profit_id) {
      lines.push("  BLOCKED: no TP/SL attached, so no stop can be moved.");
    }
    if (pos.mark_price <= 0) {
      lines.push("  BLOCKED: exchange returned no mark price, so ROI reads 0.");
    }
    return lines.join("\n");
  }

  async mid_manage_positions(): Promise<
    { trade_id: number; symbol: string; action: string; details: string }[]
  > {
    const actions: { trade_id: number; symbol: string; action: string; details: string }[] = [];
    for (const event of await this.adopt_exchange_positions()) {
      actions.push({
        trade_id: event.trade_id,
        symbol: event.symbol,
        action: "position_adopted",
        details: `${event.position_side} ${event.size}c @ ${event.entry_price} ${event.leverage}x was open on the exchange but untracked; now managed${event.has_stop ? "" : " (NO exchange stop)"}`,
      });
    }
    for (const trade of this.memory.get_open_trades()) {
      const symbol = trade.symbol;
      const side = trade.position_side;
      // Breakeven and trailing can only move an existing stop, so a position
      // whose TP/SL order was rejected must get one first.
      const { profit_id, note } = await this.ensure_tpsl(symbol, side, {
        signalStrength: trade.signal_strength || 0.6,
        confidence: trade.confidence || 70,
      });
      if (profit_id && note.startsWith("created")) {
        actions.push({ trade_id: trade.id, symbol, action: "tpsl_recovered", details: note });
      } else if (!profit_id && note !== "no open position") {
        actions.push({ trade_id: trade.id, symbol, action: "tpsl_missing", details: note });
      }
      if (await this.check_tpsl_breakeven(symbol, side)) {
        actions.push({ trade_id: trade.id, symbol, action: "breakeven_activated", details: "Stop loss moved to entry" });
      }
      const trailed = await this.trail_stop_loss(symbol, side);
      if (trailed.ok) {
        actions.push({ trade_id: trade.id, symbol, action: "trailing_updated", details: trailed.msg });
      }
    }
    return actions;
  }

  // ---------- dynamic TP/SL ----------

  /** Approximate adverse price move that wipes the margin. */
  liquidation_distance(entryPrice: number, leverage: number): number {
    return entryPrice / Math.max(1, leverage);
  }

  async calculate_dynamic_tpsl(
    symbol: string,
    side: PositionSide,
    entryPrice: number,
    signalStrength: number,
    confidence: number,
    leverage = 1,
  ): Promise<{ tp: number; sl: number }> {
    let atr = await this._calculate_atr(symbol, "5m");
    if (atr <= 0) atr = entryPrice * 0.01;
    const strengthFactor = 0.5 + Math.max(0, Math.min(1, signalStrength));
    const tpMultiplier = 1.5 + (confidence / 100) * 2.0;
    const slMultiplier = 1.0 + ((100 - confidence) / 100) * 1.5;
    let tpDistance = Math.min(atr * tpMultiplier * strengthFactor, entryPrice * 0.15);
    let slDistance = Math.max(atr * slMultiplier / strengthFactor, entryPrice * 0.005);

    // A pure ATR stop can sit beyond the liquidation price at high leverage, in
    // which case the position is liquidated before the stop ever fires.
    const safety = Number(this.memory.get_setting("sl_liquidation_safety", "0.5"));
    const maxSl = this.liquidation_distance(entryPrice, leverage) * safety;
    if (slDistance > maxSl) {
      logger.info(`Clamping ${symbol} SL distance ${slDistance.toFixed(8)} -> ${maxSl.toFixed(8)} to stay inside liquidation at ${leverage}x`);
      slDistance = maxSl;
    }

    const tp = await this.risk.round_price(symbol, side === "LONG" ? entryPrice + tpDistance : entryPrice - tpDistance);
    const sl = await this.risk.round_price(symbol, side === "LONG" ? entryPrice - slDistance : entryPrice + slDistance);
    return { tp, sl };
  }

  private async _calculate_atr(symbol: string, interval: string, period = 14): Promise<number> {
    let rows;
    try {
      rows = await this.exchange.getKlines(symbol, interval, period + 10);
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "ATR kline fetch failed");
      return 0;
    }
    if (!rows || !rows.length) return 0;
    const sorted = [...rows].sort((a, b) => a.openTime - b.openTime);
    if (sorted.length < period) return 0;
    const trs: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const high = sorted[i].high;
      const low = sorted[i].low;
      const prevClose = sorted[i - 1].close;
      trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    if (trs.length < period) return 0;
    const tail = trs.slice(trs.length - period);
    return tail.reduce((s, v) => s + v, 0) / tail.length;
  }

  // ---------- closing ----------

  /** Cancel only THIS side's protective open order (never the whole symbol). */
  private async _cancel_position_stop(symbol: string, side: PositionSide): Promise<string | null> {
    try {
      const mark = (await this.get_position_pnl(symbol, side)).mark_price;
      const orders = await this.exchange.getFuturesOpenOrders(symbol);
      for (const raw of orders) {
        const o = toOpenOrder(raw);
        if (!isProtectiveOrder(raw)) continue;
        if (mark > 0 && o.stopPrice > 0) {
          // LONG stop sits below mark; SHORT stop above. Only cancel this side's.
          if (side === "LONG" && o.stopPrice < mark) {
            await this.exchange.cancelFuturesOrder(o.orderId);
            return o.orderId;
          }
          if (side === "SHORT" && o.stopPrice > mark) {
            await this.exchange.cancelFuturesOrder(o.orderId);
            return o.orderId;
          }
        }
      }
    } catch (error) {
      logger.warn({ symbol, side, err: String(error) }, "Could not cancel TP/SL");
    }
    return null;
  }

  /**
   * Closes a position. Reads PnL BEFORE closing since the position disappears
   * afterwards; cooldown covers BOTH sides so a signal flip can't re-open the
   * opposite side instantly.
   */
  async close_position(
    symbol: string,
    side: PositionSide,
    tradeId: number,
    contracts?: number,
  ): Promise<CloseResult> {
    const pos = await this.get_position_pnl(symbol, side);
    if (!pos.exists) {
      logger.info(`${symbol} ${side} already gone on exchange; marking trade ${tradeId} closed`);
      this.memory.close_trade(tradeId, pos.mark_price, 0, "position not found on exchange");
      return { ok: false, data: null, error: "position not found on exchange" };
    }

    const realizedPnl = pos.unrealized_pnl;
    const exitPrice = pos.mark_price;
    const qty = Math.trunc(contracts || pos.available_close_size || Math.abs(pos.position_size));
    if (qty <= 0) return { ok: false, data: null, error: "nothing available to close" };

    // Cancel only THIS position's stop — cancel_all_tpsl destroys the hedged
    // opposite side's stop on the same symbol.
    await this._cancel_position_stop(symbol, side);

    try {
      const res = await this.exchange.placeFuturesOrder({
        symbol,
        side: side === "LONG" ? "SELL_CLOSE" : "BUY_CLOSE",
        type: "MARKET",
        quantity: String(qty),
        timeInForce: "IOC",
      });
      this.risk.invalidate_balance_cache();
      this.memory.close_trade(tradeId, exitPrice, realizedPnl);
      const cooldownMin = Number(this.memory.get_setting("cooldown_minutes", "5"));
      this.memory.set_cooldown(symbol, "LONG", cooldownMin);
      this.memory.set_cooldown(symbol, "SHORT", cooldownMin);
      return { ok: true, data: res?.data, error: null };
    } catch (error) {
      logger.error({ symbol, side, err: String(error) }, "Close order failed");
      return { ok: false, data: null, error: String(error) };
    }
  }

  /** Detects positions closed outside the bot (liquidation, ADL, manual, TP/SL hit). */
  async reconcile_open_trades(): Promise<
    { trade_id: number; symbol: string; position_side: PositionSide; reason: string }[]
  > {
    const closed: { trade_id: number; symbol: string; position_side: PositionSide; reason: string }[] = [];
    for (const trade of this.memory.get_open_trades()) {
      const symbol = trade.symbol;
      const side = trade.position_side;
      const pos = await this.get_position_pnl(symbol, side);
      if (pos.exists) continue;
      logger.warn(`Trade ${trade.id} (${symbol} ${side}) has no matching exchange position - closed externally`);
      // For bot-opened trades the entry price is known, so we can estimate PnL.
      // For adopted trades (entry=0) we cannot.
      let estPnl = 0;
      let estExit = 0;
      const entry = trade.entry_price || 0;
      const amount = trade.amount || 0;
      if (entry > 0 && amount > 0) {
        try {
          estExit = await this.exchange.getTickerPrice(symbol);
          if (estExit > 0) {
            const cs = await this.risk.get_contract_size(symbol);
            const priceDiff = side === "LONG" ? estExit - entry : entry - estExit;
            estPnl = priceDiff * amount * cs;
          }
        } catch {
          /* keep est values as-is */
        }
      }
      this.memory.close_trade(trade.id, estExit, estPnl, "closed externally (liquidation/TPSL/manual)");
      const cooldownMin = Number(this.memory.get_setting("cooldown_minutes", "5"));
      this.memory.set_cooldown(symbol, "LONG", cooldownMin);
      this.memory.set_cooldown(symbol, "SHORT", cooldownMin);
      closed.push({ trade_id: trade.id, symbol, position_side: side, reason: "closed_externally" });
    }
    return closed;
  }
}

// ---------- helpers ----------

function isProtectiveOrder(raw: unknown): boolean {
  const o = toOpenOrder(raw);
  if (TPSL_STOP_ORDER_RE.test(o.type)) return true;
  return o.stopPrice > 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
