import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { FuturesExchange } from "../exchange/futuresExchange.js";
import type { MartingaleState, PositionSide } from "../types.js";
import type { LongTermMemory } from "./memory.js";
import type { RiskManager } from "./riskManager.js";
import type { PositionManager, PositionPnl } from "./positionManager.js";
import type { SignalScanner } from "./signalScanner.js";
import { sleep } from "./positionManager.js";

/**
 * MartingaleManager — a port of CryptoMind-XT's WIP martingale engine
 * (bot/martingale.py) onto Toobit's USDT-M futures model.
 *
 * A martingale *basket* is a sequence of same-direction fills on one symbol:
 *   - an initial position is opened (from an AI signal, or manually);
 *   - when the price moves against it by `add_interval_pct` it adds more
 *     contracts (LONG adds on a drop, SHORT adds on a rise), each add larger
 *     than the last by `size_multiplier`;
 *   - every add drags the average entry toward the market, so a small
 *     favourable move (`tp_pct`) brings the *whole* basket back into profit;
 *   - the basket is then closed by the exchange TP (or the software check
 *     below when the exchange order failed).
 *
 * The hard basket stop-loss sits inside the liquidation price (`sl_pct`
 * clamped by `sl_liquidation_safety`) so a one-sided trend can't run the
 * position into liquidation before the stop fires.
 *
 * Toobit adaptations vs the Python reference:
 *   - MARKET fills via the client's LIMIT+priceType=MARKET encoding (same path
 *     as trader.execute_trade); sides are BUY_OPEN/SELL_OPEN.
 *   - Leverage is per-symbol (no side); margin mode is CROSS/ISOLATED.
 *   - Moving TP/SL after an add is a re-call of the position trading-stop
 *     (position-keyed), replacing XT's profit-entrust id + update_tpsl.
 *   - The Python reference never wired persistence (its memory.py has no
 *     martingale methods); this port stores every basket in the
 *     martingale_states table so baskets survive restarts and a stale RUNNING
 *     basket is closed on boot by close_stale_martingale_states.
 *
 * The Python WIP's `leverage()` helper is omitted: callers read
 * state.leverage directly.
 */

export const MARTINGALE_STRATEGY_PREFIX = "MARTINGALE";

/** "AI Parameters" risk profiles from the XT Futures Martingale Bot docs. */
export const RISK_PROFILES: Record<
  string,
  { add_interval_pct: number; size_multiplier: number; max_adds: number; tp_pct: number }
> = {
  aggressive: { add_interval_pct: 1.5, size_multiplier: 2.5, max_adds: 8, tp_pct: 1.0 },
  balanced: { add_interval_pct: 2.5, size_multiplier: 2.0, max_adds: 5, tp_pct: 1.5 },
  conservative: { add_interval_pct: 4.0, size_multiplier: 1.5, max_adds: 3, tp_pct: 2.0 },
};

/** Keys a user/AI may set directly. Manual mode uses these; AI mode derives them from the profile. */
export const MANUAL_KEYS = [
  "martingale_add_interval_pct",
  "martingale_size_multiplier",
  "martingale_max_adds",
  "martingale_tp_pct",
];
export const CONFIG_KEYS = [
  "martingale_enabled", "martingale_direction", "martingale_mode",
  "martingale_risk_profile", "martingale_sl_pct",
  "martingale_margin_pct", "martingale_max_margin_pct",
  "martingale_leverage",
  ...MANUAL_KEYS,
];

export type BasketAction = {
  symbol: string;
  position_side: PositionSide;
  action: string;
  details: string;
};

export type StartResult = {
  started: boolean;
  message: string;
  trade_id?: number;
};

export class MartingaleManager {
  constructor(
    private exchange: FuturesExchange,
    private memory: LongTermMemory,
    private risk: RiskManager,
    private scanner: SignalScanner,
    private positionMgr: PositionManager,
    private _notify: (message: string) => void = () => {},
  ) {}

  set_notify_callback(callback: (message: string) => void): void {
    this._notify = callback;
  }

  // ---------- settings ----------

  private _get(key: string, fallback?: string): string | null {
    return this.memory.get_setting(key, fallback ?? undefined);
  }

  /** Resolve the active add/tp parameters (AI profile or manual overrides). */
  _resolve_params(): {
    add_interval_pct: number;
    size_multiplier: number;
    max_adds: number;
    tp_pct: number;
    profile: string;
  } {
    const mode = this._get("martingale_mode", "ai");
    if (mode === "ai") {
      const profile = this._get("martingale_risk_profile", "balanced") ?? "balanced";
      const params = RISK_PROFILES[profile] ?? RISK_PROFILES.balanced;
      return { ...params, profile };
    }
    return {
      add_interval_pct: Number(this._get("martingale_add_interval_pct", "2.0") ?? 2.0),
      size_multiplier: Number(this._get("martingale_size_multiplier", "2.0") ?? 2.0),
      max_adds: Number(this._get("martingale_max_adds", "5") ?? 5),
      tp_pct: Number(this._get("martingale_tp_pct", "1.5") ?? 1.5),
      profile: "manual",
    };
  }

  set_param(key: string, value: string): string {
    const k = key.trim().toLowerCase();
    if (!CONFIG_KEYS.includes(k)) {
      return `Unknown martingale setting '${k}'. Valid keys: ${CONFIG_KEYS.join(", ")}`;
    }
    let v: string | number | boolean = value;
    try {
      if (k === "martingale_enabled") {
        v = ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
      } else if (k === "martingale_direction") {
        v = String(value).trim().toUpperCase();
        if (!["AUTO", "LONG", "SHORT"].includes(String(v))) {
          return "martingale_direction must be AUTO, LONG or SHORT";
        }
      } else if (k === "martingale_mode") {
        v = String(value).trim().toLowerCase();
        if (!["ai", "manual"].includes(String(v))) {
          return "martingale_mode must be 'ai' or 'manual'";
        }
      } else if (k === "martingale_risk_profile") {
        v = String(value).trim().toLowerCase();
        if (!(String(v) in RISK_PROFILES)) {
          return `martingale_risk_profile must be one of ${Object.keys(RISK_PROFILES).join(", ")}`;
        }
      } else if (k === "martingale_max_adds") {
        v = Math.max(1, Math.min(parseInt(String(value), 10), 25)); // XT docs cap additions at 25
      } else if (
        k === "martingale_add_interval_pct" || k === "martingale_tp_pct" ||
        k === "martingale_sl_pct" || k === "martingale_margin_pct" ||
        k === "martingale_max_margin_pct"
      ) {
        v = parseFloat(String(value));
        if (Number(v) <= 0) return `${k} must be > 0`;
      } else if (k === "martingale_size_multiplier") {
        v = parseFloat(String(value));
        if (Number(v) < 1.0) return "martingale_size_multiplier must be >= 1.0";
      } else if (k === "martingale_leverage") {
        v = Math.max(1, Math.min(parseInt(String(value), 10), 125));
      }
    } catch {
      return `Invalid value '${value}' for ${k}`;
    }
    this.memory.set_setting(k, String(v));
    return `Martingale ${k} set to: ${v}`;
  }

  // ---------- status ----------

  is_enabled(): boolean {
    return ["1", "true", "yes", "on"].includes(
      (this._get("martingale_enabled", "false") ?? "false").toLowerCase(),
    );
  }

  get_running_basket(symbol: string, side: PositionSide): MartingaleState | null {
    const state = this.memory.get_martingale_state(symbol, side);
    return state && state.status === "RUNNING" ? state : null;
  }

  running_baskets(): MartingaleState[] {
    return this.memory.get_active_martingale_states();
  }

  async status_report(symbol?: string): Promise<string> {
    const mode = this._get("martingale_mode", "ai") ?? "ai";
    const profile = this._get("martingale_risk_profile", "balanced") ?? "balanced";
    const enabled = this.is_enabled() ? "ON" : "OFF";
    const direction = this._get("martingale_direction", "auto") ?? "auto";
    const out = ["=== MARTINGALE BOT ==="];
    out.push(`Enabled: ${enabled} | Mode: ${mode} | Direction: ${direction}`);
    if (mode === "ai") {
      out.push(`Risk Profile: ${profile}`);
      const p = RISK_PROFILES[profile];
      if (p) {
        out.push(
          `  interval ${p.add_interval_pct}% | multiplier ${p.size_multiplier}x | ` +
            `max adds ${p.max_adds} | TP ${p.tp_pct}%`,
        );
      }
    } else {
      out.push(
        `  interval ${this._get("martingale_add_interval_pct", "2.0")}% | ` +
          `multiplier ${this._get("martingale_size_multiplier", "2.0")}x | ` +
          `max adds ${this._get("martingale_max_adds", "5")} | ` +
          `TP ${this._get("martingale_tp_pct", "1.5")}%`,
      );
    }
    out.push(
      `  basket SL ${this._get("martingale_sl_pct", "15.0")}% | ` +
        `margin ${this._get("martingale_margin_pct", "10.0")}% | ` +
        `max margin ${this._get("martingale_max_margin_pct", "60.0")}% | ` +
        `leverage ${this._get("martingale_leverage", "5")}x`,
    );

    const baskets = this.running_baskets();
    if (!baskets.length) {
      out.push("\nNo running martingale basket.");
      return out.join("\n");
    }
    out.push("\n--- RUNNING BASKETS ---");
    for (const state of baskets) out.push(await this._basket_line(state));
    return out.join("\n");
  }

  private async _basket_line(state: MartingaleState): Promise<string> {
    const symbol = state.symbol;
    const side = state.position_side;
    let line =
      `${symbol} ${side} | adds ${state.adds_done}/${state.max_adds} | ` +
      `avg ${state.avg_entry} size ${state.current_size}c`;
    const pos = await this.positionMgr.get_position_pnl(symbol, side);
    if (pos.exists) {
      line +=
        ` | mark ${pos.mark_price} ROI ${pos.roi.toFixed(2)}% ` +
        `PnL ${pos.unrealized_pnl.toFixed(4)}`;
    }
    line +=
      `\n  next add @ ${state.next_add_trigger} | TP ${state.tp_price} | ` +
      `SL ${state.sl_price} (${state.profile})`;
    return line;
  }

  // ---------- start ----------

  async start_basket(
    symbol: string,
    side: PositionSide,
    source = "manual",
    confidence = 0,
    signal_strength = 0.0,
  ): Promise<StartResult> {
    if (side !== "LONG" && side !== "SHORT") {
      return { started: false, message: `Invalid direction: ${side}` };
    }
    if (this.get_running_basket(symbol, side)) {
      return {
        started: false,
        message: `A martingale basket is already running for ${symbol} ${side}. Stop it first.`,
      };
    }
    for (const trade of this.memory.get_open_trades(symbol)) {
      if (trade.position_side === side) {
        return {
          started: false,
          message: `An open ${side} position already exists for ${symbol}.`,
        };
      }
    }
    if (this.memory.is_in_cooldown(symbol, side)) {
      return { started: false, message: `Cooldown active for ${symbol} ${side}.` };
    }

    const params = this._resolve_params();
    const leverage = Number(this._get("martingale_leverage", String(Config.MARTINGALE_LEVERAGE)) ?? Config.MARTINGALE_LEVERAGE);
    const marginPct = Number(this._get("martingale_margin_pct", String(Config.MARTINGALE_MARGIN_PCT)) ?? Config.MARTINGALE_MARGIN_PCT);
    const marginMode = this._get("margin_mode", Config.DEFAULT_MARGIN_MODE) ?? Config.DEFAULT_MARGIN_MODE;

    const price = await this.scanner.get_current_price(symbol);
    if (price <= 0) {
      return { started: false, message: "Could not get current price from Toobit." };
    }

    const validatedLeverage = await this.risk.validate_leverage(symbol, leverage);
    const baseQty = await this.risk.size_by_margin_pct(symbol, price, validatedLeverage, marginPct);
    const sized = await this.risk.validate_size(symbol, baseQty, price, "martingale_margin", "MARKET");
    if (sized.qty <= 0) {
      return { started: false, message: `Cannot size base position: ${sized.reason}` };
    }
    const baseSize = sized.qty;

    if (marginMode === "CROSSED" || marginMode === "ISOLATED") {
      try {
        await this.exchange.setFuturesMarginType(symbol, marginMode === "CROSSED" ? "CROSS" : "ISOLATED");
      } catch (error) {
        logger.info(`Margin mode unchanged for ${symbol} ${side}: ${error}`);
      }
    }
    try {
      await this.exchange.setFuturesLeverage(symbol, validatedLeverage);
    } catch (error) {
      return { started: false, message: `Could not set leverage to ${validatedLeverage}x: ${error}` };
    }

    let orderData: { data?: unknown } | null = null;
    try {
      orderData = await this.exchange.placeFuturesOrder({
        symbol,
        side: side === "LONG" ? "BUY_OPEN" : "SELL_OPEN",
        type: "MARKET",
        quantity: String(baseSize),
        timeInForce: "IOC",
      });
    } catch (error) {
      return { started: false, message: `Order rejected by Toobit: ${error}` };
    }

    this.risk.invalidate_balance_cache();
    const { entryPrice, filledQty } = await this._wait_for_position(symbol, side);
    if (filledQty <= 0) {
      return {
        started: false,
        message: `Initial ${side} ${symbol} order did not fill (${baseSize} contracts requested). No position opened.`,
      };
    }

    const avgEntry = entryPrice;
    const currentSize = filledQty;
    const interval = params.add_interval_pct;
    const multiplier = params.size_multiplier;
    const maxAdds = params.max_adds;
    const tpPct = params.tp_pct;
    const slPct = Number(this._get("martingale_sl_pct", String(Config.MARTINGALE_SL_PCT)) ?? Config.MARTINGALE_SL_PCT);

    let nextAdd: number;
    let tpPrice: number;
    let slPrice: number;
    if (side === "LONG") {
      nextAdd = avgEntry * (1 - interval / 100);
      tpPrice = avgEntry * (1 + tpPct / 100);
      slPrice = avgEntry * (1 - slPct / 100);
    } else {
      nextAdd = avgEntry * (1 + interval / 100);
      tpPrice = avgEntry * (1 - tpPct / 100);
      slPrice = avgEntry * (1 + slPct / 100);
    }
    slPrice = await this._safe_stop(symbol, side, avgEntry, slPrice, validatedLeverage);

    // The basket's first trade is a normal trade row so the existing guards
    // (TP/SL recovery, reconcile, status, pnl) all work unchanged.
    const strategy =
      `${MARTINGALE_STRATEGY_PREFIX}-${params.profile}` +
      (source !== "manual" ? `-${source}` : "");
    const tradeId = this.memory.record_trade({
      symbol,
      position_side: side,
      order_id: this._extract_order_id(orderData?.data),
      entry_price: avgEntry,
      amount: currentSize,
      leverage: validatedLeverage,
      confidence: confidence || 70,
      strategy,
      signal_strength: signal_strength,
      timeframe: this._get("timeframes", Config.DEFAULT_TIMEFRAMES.join(",")) ?? Config.DEFAULT_TIMEFRAMES.join(","),
    });

    const attached = await this.positionMgr.attach_tpsl_to_position(symbol, side, tpPrice, slPrice);

    const now = Date.now() / 1000;
    const state: MartingaleState = {
      symbol,
      position_side: side,
      status: "RUNNING",
      trade_id: tradeId,
      profile: params.profile,
      source,
      mode: this._get("martingale_mode", "ai") ?? "ai",
      leverage: validatedLeverage,
      base_size: baseSize,
      entry_price: avgEntry,
      avg_entry: avgEntry,
      current_size: currentSize,
      adds_done: 0,
      max_adds: maxAdds,
      add_interval_pct: interval,
      size_multiplier: multiplier,
      tp_pct: tpPct,
      sl_pct: slPct,
      next_add_trigger: nextAdd,
      tp_price: tpPrice,
      sl_price: slPrice,
      capped: false,
      started_at: now,
      updated_at: now,
    };
    this.memory.save_martingale_state(symbol, side, state);

    const tpslNote = attached.ok
      ? `TP/SL on ${attached.protectedQty} contracts`
      : `TP/SL FAILED: ${attached.error}`;
    const notional = await this.risk.contracts_to_notional(symbol, currentSize, avgEntry);
    const msg =
      `MARTINGALE STARTED ${side} ${symbol} (${state.profile})\n` +
      `Initial: ${currentSize}c @ ${avgEntry} lev=${validatedLeverage}x (~${notional.toFixed(2)} USDT)\n` +
      `Add every ${interval}% (${multiplier}x) up to ${maxAdds} adds\n` +
      `Next add @ ${nextAdd} | Basket TP @ ${tpPrice} | SL @ ${slPrice}\n` +
      tpslNote;
    this._notify(msg);
    return { started: true, message: msg, trade_id: tradeId };
  }

  private async _safe_stop(
    symbol: string,
    side: PositionSide,
    entry: number,
    slPrice: number,
    leverage: number,
  ): Promise<number> {
    const safety = Number(this._get("sl_liquidation_safety", "0.5") ?? 0.5);
    const maxDist = this.positionMgr.liquidation_distance(entry, leverage) * safety;
    if (side === "LONG") {
      const safe = entry - maxDist;
      if (slPrice < safe) return safe;
    } else {
      const safe = entry + maxDist;
      if (slPrice > safe) return safe;
    }
    return this.risk.round_price(symbol, slPrice);
  }

  private async _wait_for_position(
    symbol: string,
    side: PositionSide,
  ): Promise<{ entryPrice: number; filledQty: number }> {
    for (let i = 0; i < 3; i++) {
      const pos = await this.positionMgr.get_position_pnl(symbol, side);
      if (pos.exists && pos.position_size !== 0) {
        return { entryPrice: pos.entry_price, filledQty: Math.trunc(Math.abs(pos.position_size)) };
      }
      if (i < 2) await sleep(1000);
    }
    return { entryPrice: 0, filledQty: 0 };
  }

  private _extract_order_id(orderData: unknown): string | null {
    if (orderData && typeof orderData === "object" && !Array.isArray(orderData)) {
      const o = orderData as Record<string, unknown>;
      const id = o.orderId ?? o.order_id ?? o.id;
      return typeof id === "string" && id ? id : null;
    }
    if (Array.isArray(orderData) && orderData.length && typeof orderData[0] === "object") {
      return this._extract_order_id(orderData[0]);
    }
    return null;
  }

  // ---------- monitoring ----------

  async check_all(): Promise<BasketAction[]> {
    const actions: BasketAction[] = [];
    for (const state of this.running_baskets()) {
      try {
        actions.push(...(await this.check_basket(state)));
      } catch (error) {
        logger.error(
          { symbol: state.symbol, side: state.position_side, err: String(error) },
          "Martingale check failed",
        );
      }
    }
    return actions;
  }

  async check_basket(state: MartingaleState): Promise<BasketAction[]> {
    const actions: BasketAction[] = [];
    const symbol = state.symbol;
    const side = state.position_side;
    if (state.status !== "RUNNING") return actions;

    const pos = await this.positionMgr.get_position_pnl(symbol, side);
    if (!pos.exists) {
      // The exchange TP/SL (or a liquidation / manual close) already ended the
      // basket. reconcile_open_trades handles the trade row + cooldown.
      state.status = "CLOSED";
      state.updated_at = Date.now() / 1000;
      this.memory.save_martingale_state(symbol, side, state);
      actions.push({
        symbol,
        position_side: side,
        action: "basket_finished",
        details:
          "basket position is gone from the exchange (TP/SL fill, liquidation or manual close)",
      });
      return actions;
    }

    let mark = pos.mark_price;
    if (mark <= 0) mark = await this.scanner.get_mark_price(symbol);
    if (mark <= 0) return actions;

    // Software TP/SL: the exchange orders are primary, but if they never got
    // attached (or were cancelled) this closes the basket instead of holding
    // an unprotected position.
    const slPrice = state.sl_price;
    const tpPrice = state.tp_price;
    let hit: string | null = null;
    if (side === "LONG") {
      if (slPrice && mark <= slPrice) hit = "basket_sl";
      else if (tpPrice && mark >= tpPrice) hit = "basket_tp";
    } else {
      if (slPrice && mark >= slPrice) hit = "basket_sl";
      else if (tpPrice && mark <= tpPrice) hit = "basket_tp";
    }
    if (hit) return this._close_basket(state, hit, mark);

    // Add when the price crosses the next trigger, up to max_adds.
    const addsDone = Number(state.adds_done || 0);
    const maxAdds = Number(state.max_adds || 5);
    if (addsDone < maxAdds && !state.capped) {
      const triggered = side === "LONG"
        ? mark <= state.next_add_trigger
        : mark >= state.next_add_trigger;
      if (triggered) {
        const action = await this._perform_add(state, mark);
        if (action) actions.push(action);
      }
    }
    return actions;
  }

  private async _perform_add(state: MartingaleState, mark: number): Promise<BasketAction | null> {
    const symbol = state.symbol;
    const side = state.position_side;
    const addsDone = Number(state.adds_done || 0);
    const multiplier = Number(state.size_multiplier || 2.0);
    const baseSize = Number(state.base_size || 0);
    const qty = Math.trunc(baseSize * Math.pow(multiplier, addsDone + 1));

    // Refuse an add that would blow the total margin budget.
    const capPct = Number(this._get("martingale_max_margin_pct", String(Config.MARTINGALE_MAX_MARGIN_PCT)) ?? Config.MARTINGALE_MAX_MARGIN_PCT);
    const pos = await this.positionMgr.get_position_pnl(symbol, side);
    const currentNotional = pos.position_value;
    const addNotional = await this.risk.contracts_to_notional(symbol, qty, mark);
    const totalNotional = currentNotional + addNotional;
    const basketLeverage = Math.max(1, Number(state.leverage || 1));
    const balance = await this.risk.get_tradable_balance();
    if (balance > 0 && totalNotional / basketLeverage > (balance * capPct) / 100) {
      state.capped = true;
      state.updated_at = Date.now() / 1000;
      this.memory.save_martingale_state(symbol, side, state);
      const msg =
        `Martingale add blocked for ${symbol} ${side}: total basket margin would ` +
        `exceed ${capPct}% of balance. No more adds.`;
      this._notify(msg);
      return { symbol, position_side: side, action: "add_blocked_capped", details: msg };
    }

    try {
      await this.exchange.placeFuturesOrder({
        symbol,
        side: side === "LONG" ? "BUY_OPEN" : "SELL_OPEN",
        type: "MARKET",
        quantity: String(qty),
        timeInForce: "IOC",
      });
    } catch (error) {
      const msg = `Martingale add rejected for ${symbol} ${side} (${qty}c @ ${mark}): ${error}`;
      logger.warn(msg);
      this._notify(msg);
      return { symbol, position_side: side, action: "add_rejected", details: msg };
    }

    this.risk.invalidate_balance_cache();
    const filled = await this._wait_for_position(symbol, side);
    const size = filled.filledQty;
    if (size <= 0) {
      const msg = `Martingale add ${qty}c for ${symbol} ${side} did not fill.`;
      this._notify(msg);
      return { symbol, position_side: side, action: "add_not_filled", details: msg };
    }

    const avg = filled.entryPrice;
    const addsDoneNew = addsDone + 1;
    const interval = Number(state.add_interval_pct || 2.0);
    const tpPct = Number(state.tp_pct || 1.5);
    let nextTrigger: number;
    let tpPrice: number;
    if (side === "LONG") {
      nextTrigger = state.next_add_trigger * (1 - interval / 100);
      tpPrice = avg * (1 + tpPct / 100);
    } else {
      nextTrigger = state.next_add_trigger * (1 + interval / 100);
      tpPrice = avg * (1 - tpPct / 100);
    }
    const slPrice = await this._safe_stop(symbol, side, avg, state.sl_price, Number(state.leverage || 1));
    state.avg_entry = avg;
    state.current_size = size;
    state.adds_done = addsDoneNew;
    state.tp_price = tpPrice;
    state.sl_price = slPrice;
    state.next_add_trigger = nextTrigger;
    state.updated_at = Date.now() / 1000;
    this.memory.save_martingale_state(symbol, side, state);

    // Move the exchange TP to the new (lower) average so the shallowest rebound
    // takes the whole basket out. The SL stays where it was. On Toobit this is
    // a re-call of the position trading-stop (no profit-entrust id).
    const attached = await this.positionMgr.attach_tpsl_to_position(symbol, side, tpPrice, slPrice);
    if (!attached.ok) {
      logger.warn(
        { symbol, side, err: attached.error },
        "TP update after martingale add failed",
      );
    }

    const msg =
      `MARTINGALE ADD #${addsDoneNew} ${side} ${symbol}: +${size} contracts ` +
      `avg ${state.avg_entry} | next add @ ${state.next_add_trigger} | TP @ ${tpPrice}`;
    this._notify(msg);
    return { symbol, position_side: side, action: "add_filled", details: msg };
  }

  private async _close_basket(
    state: MartingaleState,
    reason: string,
    mark: number,
  ): Promise<BasketAction[]> {
    const symbol = state.symbol;
    const side = state.position_side;
    const tradeId = state.trade_id;
    if (tradeId) {
      const closed = await this.positionMgr.close_position(symbol, side, tradeId);
      if (!closed.ok) {
        const msg = `Martingale basket close failed for ${symbol} ${side} (${reason}): ${closed.error}`;
        this._notify(msg);
        return [{ symbol, position_side: side, action: "basket_close_failed", details: msg }];
      }
    }
    state.status = "CLOSED";
    state.updated_at = Date.now() / 1000;
    this.memory.save_martingale_state(symbol, side, state);
    const msg =
      `MARTINGALE BASKET CLOSED ${side} ${symbol} (${reason}) at ${mark} after ${state.adds_done} adds`;
    this._notify(msg);
    return [{ symbol, position_side: side, action: "basket_closed", details: msg }];
  }

  // ---------- stop ----------

  async stop_basket(symbol?: string, side?: PositionSide): Promise<string> {
    if (!symbol) symbol = this._get("symbol", Config.DEFAULT_SYMBOL) ?? Config.DEFAULT_SYMBOL;
    if (!side) {
      const baskets = this.running_baskets();
      if (!baskets.length) return "No running martingale basket to stop.";
      const lines: string[] = [];
      for (const b of baskets) {
        lines.push(await this.stop_basket(b.symbol, b.position_side));
      }
      return lines.join("\n");
    }
    const state = this.get_running_basket(symbol, side);
    if (!state) return `No running martingale basket for ${symbol} ${side}.`;
    const tradeId = state.trade_id;
    if (tradeId) {
      const closed = await this.positionMgr.close_position(symbol, side, tradeId);
      if (!closed.ok) return `Failed to stop ${symbol} ${side} basket: ${closed.error}`;
    }
    state.status = "CLOSED";
    state.updated_at = Date.now() / 1000;
    this.memory.save_martingale_state(symbol, side, state);
    return `Martingale basket stopped for ${symbol} ${side}.`;
  }
}
