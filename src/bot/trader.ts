import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { FuturesExchange } from "../exchange/futuresExchange.js";
import type { PositionSide } from "../types.js";
import type { LongTermMemory } from "./memory.js";
import { RiskManager } from "./riskManager.js";
import { PositionManager } from "./positionManager.js";
import type { CloseResult } from "./positionManager.js";
import type { SignalScanner, ScanReport } from "./signalScanner.js";
import type { StrategyEngine } from "./strategies.js";
import { sleep } from "./positionManager.js";
import type { OrderType, TimeInForce } from "../exchange/types.js";

/**
 * XTTrader → ToobitTrader: gates, the full execute_trade flow, software stops,
 * and the auto-trade loop — a port of CryptoMind-XT/bot/trader.py.
 *
 * Toobit adaptations:
 *   - one `side` field: LONG → BUY_OPEN, SHORT → SELL_OPEN (close: BUY_CLOSE /
 *     SELL_CLOSE on the matching side).
 *   - margin mode: settings store CROSSED/ISOLATED; the wire wants CROSS/ISOLATED.
 *   - leverage is per-symbol (no side).
 *   - the MARKET order is converted to LIMIT+priceType=MARKET inside the client.
 */

export type GateResult = string | null;

export type ScanExecuteResult = {
  action: "none" | "blocked" | "signal";
  reason?: string;
  report: string;
  result: ScanReport;
  direction?: PositionSide;
};

export class ToobitTrader {
  private _autoTradeEnabled = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastScan = 0;
  private _lastMid = 0;
  private _notifyCallback: ((message: string) => void) | null = null;

  public readonly risk: RiskManager;
  public readonly positionMgr: PositionManager;

  constructor(
    private exchange: FuturesExchange,
    public readonly memory: LongTermMemory,
    public readonly scanner: SignalScanner,
    public readonly engine: StrategyEngine,
    risk?: RiskManager,
    positionMgr?: PositionManager,
  ) {
    this.risk = risk ?? new RiskManager(exchange, memory);
    this.positionMgr = positionMgr ?? new PositionManager(exchange, memory, this.risk);
  }

  set_notify_callback(callback: (message: string) => void): void {
    this._notifyCallback = callback;
  }

  _notify(message: string): void {
    logger.info(`NOTIFY: ${message}`);
    if (this._notifyCallback) {
      try {
        this._notifyCallback(message);
      } catch (error) {
        logger.error(`Notification dispatch failed: ${error}`);
      }
    }
  }

  // ---------- status ----------

  async get_status_report(): Promise<string> {
    const symbol = this.memory.get_setting("symbol") ?? Config.DEFAULT_SYMBOL;
    let balanceLine: string;
    try {
      const balance = await this.risk.get_total_balance();
      const available = await this.risk.get_available_balance();
      balanceLine = `Balance: ${balance.toFixed(2)} USDT | Available: ${available.toFixed(2)} USDT\n`;
    } catch (error) {
      balanceLine = `Balance: unavailable (${error})\n`;
    }

    const pnl = this.memory.get_total_pnl();
    const stats = this.memory.get_trade_count();
    const settings = this.memory.get_all_settings();

    let report = "=== TOOBIT AI TRADER STATUS ===\n";
    report += `Symbol: ${symbol}\n`;
    report += balanceLine;
    report += `Total PnL: ${pnl.toFixed(4)} USDT\n`;
    report += `Trades: ${stats.total} total | ${stats.open} open | ${stats.closed} closed | ${stats.winrate}% WR\n`;
    report += `Auto-Trade: ${this._autoTradeEnabled ? "ON" : "OFF"}\n`;
    report += `Cooldowns: ${this._get_cooldown_status(symbol)}\n\n`;

    report += "--- SETTINGS ---\n";
    report += `Leverage: ${settings.leverage ?? Config.DEFAULT_LEVERAGE}x\n`;
    report += `Margin Mode: ${settings.margin_mode ?? Config.DEFAULT_MARGIN_MODE}\n`;
    report += `Timeframes: ${settings.timeframes ?? Config.DEFAULT_TIMEFRAMES.join(",")}\n`;
    report += `Margin Amount: ${settings.margin_amount_pct ?? Config.DEFAULT_MARGIN_AMOUNT_PCT}%\n`;
    report += `Risk: ${settings.margin_risk_pct ?? Config.DEFAULT_RISK_PCT}%\n`;
    report += `Min Confidence: ${settings.min_confidence ?? Config.MIN_CONFIDENCE}%\n`;
    report += `Position Mode: ${settings.position_mode ?? "margin"}\n`;

    try {
      report += await this._format_contract_info(symbol);
    } catch (error) {
      report += `Contract info unavailable: ${error}\n`;
    }

    const openTrades = this.memory.get_open_trades();
    if (openTrades.length) {
      report += "\n--- OPEN POSITIONS ---\n";
      for (const t of openTrades) {
        const pos = await this.positionMgr.get_position_pnl(t.symbol, t.position_side);
        if (!pos.exists) {
          report += `ID:${t.id} ${t.symbol} ${t.position_side} NOT FOUND ON EXCHANGE (stale)\n`;
          continue;
        }
        report += `ID:${t.id} ${t.symbol} ${t.position_side} Entry:${pos.entry_price} Mark:${pos.mark_price} Size:${Math.trunc(Math.abs(pos.position_size))}c PnL:${pos.unrealized_pnl.toFixed(4)} ROI:${pos.roi.toFixed(2)}% Lev:${pos.leverage}x | ${t.strategy} Conf:${t.confidence}%\n`;
      }
    }
    return report;
  }

  private async _format_contract_info(symbol: string): Promise<string> {
    const cs = await this.risk.get_contract_size(symbol);
    const minQty = await this.risk.get_min_qty(symbol);
    const minNotional = await this.risk.get_min_notional(symbol);
    const maxLev = await this.risk.get_max_leverage(symbol);
    return `\n--- CONTRACT (${symbol}) ---\nContract Size: ${cs} | Min Qty: ${minQty} contracts\nMin Notional: ${minNotional} USDT | Max Leverage: ${maxLev}x\n`;
  }

  private _get_cooldown_status(symbol: string): string {
    const status: string[] = [];
    for (const side of ["LONG", "SHORT"] as PositionSide[]) {
      if (this.memory.is_in_cooldown(symbol, side)) {
        const rem = this.memory.get_cooldown_remaining(symbol, side);
        status.push(`${side}: ${rem.toFixed(0)}s remaining`);
      }
    }
    return status.length ? status.join(", ") : "none";
  }

  // ---------- signal gate ----------

  _gate_checks(symbol: string, direction: PositionSide): GateResult {
    const maxPositions = Number(this.memory.get_setting("max_positions") ?? Config.MAX_POSITIONS);
    const openTrades = this.memory.get_open_trades(symbol);
    if (openTrades.length >= maxPositions) {
      return `max positions (${maxPositions}) reached for ${symbol}`;
    }
    if (this.memory.is_in_cooldown(symbol, direction)) {
      const rem = this.memory.get_cooldown_remaining(symbol, direction);
      return `cooldown active - ${rem.toFixed(0)}s remaining`;
    }
    for (const trade of openTrades) {
      if (trade.position_side === direction) {
        return `already have an open ${direction} position for ${symbol}`;
      }
    }
    return null;
  }

  async scan_and_execute(): Promise<ScanExecuteResult> {
    const symbol = this.memory.get_setting("symbol") ?? Config.DEFAULT_SYMBOL;
    const minConf = Number(this.memory.get_setting("min_confidence") ?? Config.MIN_CONFIDENCE);
    const result = await this.scanner.scan_and_report(symbol);
    const report = this.scanner.format_signal_report(result);
    const direction = result.direction;
    const confidence = result.confidence;

    if (direction === "NEUTRAL" || confidence < minConf) {
      logger.info(`No actionable signal for ${symbol}: ${direction} at ${confidence}%`);
      return { action: "none", report, result };
    }

    const reason = this._gate_checks(symbol, direction);
    if (reason) {
      logger.info(`Signal suppressed for ${symbol}: ${reason}`);
      return { action: "blocked", reason, report, result };
    }

    logger.info(`Signal to ${direction} ${symbol} at ${confidence}% confidence`);
    this._notify(`Signal: ${direction} ${symbol} at ${confidence}% [strength ${result.signal_strength.toFixed(2)}]`);
    return { action: "signal", direction, report, result };
  }

  // ---------- execution ----------

  async execute_trade(direction: PositionSide, orderType: OrderType = "MARKET", timeInForce?: TimeInForce): Promise<string> {
    const symbol = this.memory.get_setting("symbol") ?? Config.DEFAULT_SYMBOL;
    const minConf = Number(this.memory.get_setting("min_confidence") ?? Config.MIN_CONFIDENCE);
    const requestedLeverage = Number(this.memory.get_setting("leverage") ?? Config.DEFAULT_LEVERAGE);
    const marginMode = this.memory.get_setting("margin_mode") ?? Config.DEFAULT_MARGIN_MODE;

    if (direction !== "LONG" && direction !== "SHORT") {
      return `Invalid direction: ${direction}`;
    }

    const reason = this._gate_checks(symbol, direction);
    if (reason) return `Cannot open trade: ${reason}`;

    try {
      if (!(await this.risk.supports_order_type(symbol, orderType))) {
        return `${symbol} does not support ${orderType} orders`;
      }
    } catch (error) {
      return `Could not read contract config for ${symbol}: ${error}`;
    }

    const scan = await this.scanner.scan_and_report(symbol);
    if (scan.confidence < minConf) {
      return `Confidence ${scan.confidence}% is below threshold ${minConf}%.\n${this.scanner.format_signal_report(scan)}`;
    }
    if (scan.direction !== direction) {
      return `Current signal direction is ${scan.direction}, not ${direction}.\nCheck /signal`;
    }

    const price = scan.price;
    if (price <= 0) return "Could not get current price from Toobit. Aborting.";

    const confidence = scan.confidence;
    const strength = scan.signal_strength;
    const provisionalLeverage = await this.risk.validate_leverage(symbol, requestedLeverage);
    const { tp: tpPrice, sl: slPrice } = await this.positionMgr.calculate_dynamic_tpsl(
      symbol, direction, price, strength, confidence, provisionalLeverage,
    );

    const sizing = await this.risk.calculate_position_size(symbol, price, requestedLeverage, slPrice, orderType);
    const qty = sizing.qty;
    if (qty <= 0) return `Cannot size position: ${sizing.reason}`;

    const notional = await this.risk.contracts_to_notional(symbol, qty, price);
    const leverage = await this.risk.validate_leverage(symbol, requestedLeverage, notional);

    if (marginMode === "CROSSED" || marginMode === "ISOLATED") {
      try {
        await this.exchange.setFuturesMarginType(symbol, marginMode === "CROSSED" ? "CROSS" : "ISOLATED");
      } catch (error) {
        logger.info(`Margin mode unchanged for ${symbol} ${direction}: ${error}`);
      }
    }

    try {
      await this.exchange.setFuturesLeverage(symbol, leverage);
    } catch (error) {
      return `Could not set leverage to ${leverage}x: ${error}`;
    }

    if (timeInForce === undefined) {
      timeInForce = orderType === "MARKET" ? "IOC" : "GTC";
    }
    if (!(await this.risk.supports_time_in_force(symbol, timeInForce))) {
      return `${symbol} does not support timeInForce=${timeInForce}`;
    }
    const effectiveTif: TimeInForce | undefined = timeInForce;

    const limitPrice = orderType === "LIMIT" ? await this.risk.round_price(symbol, price) : undefined;

    logger.info(`Opening ${direction} ${symbol}: ${qty} contracts (~${notional.toFixed(2)} USDT) at ${price} lev=${leverage}x tp=${tpPrice} sl=${slPrice} conf=${confidence}% mode=${sizing.mode}`);

    let orderData: { data?: unknown } | null = null;
    try {
      orderData = await this.exchange.placeFuturesOrder({
        symbol,
        side: direction === "LONG" ? "BUY_OPEN" : "SELL_OPEN",
        type: orderType,
        quantity: String(qty),
        price: limitPrice !== undefined ? String(limitPrice) : undefined,
        timeInForce: effectiveTif,
      });
    } catch (error) {
      return `Order rejected by Toobit: ${error}`;
    }

    this.risk.invalidate_balance_cache();
    const orderId = this._extract_order_id(orderData?.data);

    // Toobit's create-order response carries no fill price, so read it back from
    // the position rather than recording the pre-trade quote as the entry.
    let entryPrice = price;
    let filledQty = 0;
    for (let i = 0; i < 3; i++) {
      const pos = await this.positionMgr.get_position_pnl(symbol, direction);
      if (pos.exists && Math.abs(pos.position_size) > 0) {
        if (pos.entry_price > 0) entryPrice = pos.entry_price;
        filledQty = Math.trunc(Math.round(Math.abs(pos.position_size)));
        break;
      }
      if (i < 2) await sleep(1000);
    }

    if (filledQty <= 0) {
      // A LIMIT order can rest unfilled. Leaving it open with no stop is the
      // exact situation that produced an unprotected position before.
      let cancelNote = "unfilled order cancelled";
      try {
        if (orderId) {
          await this.exchange.cancelFuturesOrder(orderId);
        } else {
          await this.exchange.cancelAllFuturesOrders(symbol);
          cancelNote = "open orders cancelled";
        }
      } catch (error) {
        cancelNote = `could not cancel order: ${error}`;
      }
      const msg = `${orderType} ${direction} ${symbol} did not fill (${qty} contracts requested). ${cancelNote}. No position opened.`;
      this._notify(msg);
      return msg;
    }

    // Recompute TP/SL against the real fill if it drifted from the quote.
    let finalTp = tpPrice;
    let finalSl = slPrice;
    if (Math.abs(entryPrice - price) / price > 0.001) {
      const recomputed = await this.positionMgr.calculate_dynamic_tpsl(
        symbol, direction, entryPrice, strength, confidence, leverage,
      );
      finalTp = recomputed.tp;
      finalSl = recomputed.sl;
    }

    const strategiesUsed = scan.strategies_used.join(",");
    const tradeId = this.memory.record_trade({
      symbol,
      position_side: direction,
      order_id: orderId,
      entry_price: entryPrice,
      amount: filledQty,
      leverage,
      confidence,
      strategy: strategiesUsed,
      signal_strength: strength,
      timeframe: this.memory.get_setting("timeframes") ?? Config.DEFAULT_TIMEFRAMES.join(","),
    });

    const attached = await this.positionMgr.attach_tpsl_to_position(
      symbol, direction, finalTp, finalSl,
    );
    const tpslStatus = attached.ok
      ? `set on ${attached.protectedQty} contracts`
      : `FAILED: ${attached.error}`;

    const liqDistance = this.positionMgr.liquidation_distance(entryPrice, leverage);
    const slDistance = Math.abs(entryPrice - finalSl);

    const summary = [
      `Trade ID:${tradeId} OPENED ${direction} ${symbol}`,
      `Entry: ${entryPrice} | Size: ${filledQty} contracts (~${(await this.risk.contracts_to_notional(symbol, filledQty, entryPrice)).toFixed(2)} USDT)`,
      `Leverage: ${leverage}x | TP: ${finalTp} | SL: ${finalSl}`,
      `SL is ${(slDistance / entryPrice * 100).toFixed(2)}% away | liquidation ~${(liqDistance / entryPrice * 100).toFixed(2)}% away`,
      `Confidence: ${confidence}% | Strength: ${strength.toFixed(2)}`,
      `Strategy: ${strategiesUsed || "n/a"}`,
      `TP/SL: ${tpslStatus} | Sizing: ${sizing.mode}`,
      `Margin Mode: ${marginMode}`,
    ].join("\n");
    this._notify(summary);

    if (!attached.ok) {
      const failAction = this.memory.get_setting("on_tpsl_failure", "close");
      if (failAction === "close") {
        this._notify(`No stop loss could be placed on ${direction} ${symbol}. Closing the position immediately rather than leaving ${leverage}x exposure unprotected.`);
        const closed = await this.positionMgr.close_position(symbol, direction, tradeId);
        if (closed.ok) {
          return `${summary}\n\nPOSITION CLOSED: no stop loss could be placed (${attached.error}).`;
        }
        this._notify(`URGENT: ${symbol} ${direction} has no stop loss AND could not be closed (${closed.error}). Close it manually on Toobit now.`);
        return `${summary}\n\nURGENT: unprotected and could not close: ${closed.error}`;
      }
      this._notify(`WARNING: ${symbol} ${direction} has NO exchange stop loss. The software stop (max_loss_pct) is the only protection, and it only checks every ${this.memory.get_setting("guard_interval_sec", "15")}s.`);
    }
    return summary;
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

  // ---------- closing ----------

  async close_specific_trade(tradeId: number): Promise<string> {
    const target = this.memory.get_trade(tradeId);
    if (!target) return `Trade ID ${tradeId} not found.`;
    if (target.status === "CLOSED") return `Trade ID ${tradeId} is already closed.`;

    const closed = await this.positionMgr.close_position(target.symbol, target.position_side, tradeId);
    if (!closed.ok) return `Failed to close trade ${tradeId}: ${closed.error}`;

    const record = this.memory.get_trade(tradeId);
    const pnl = record?.pnl ?? 0;
    this._notify(`CLOSED ${target.position_side} ${target.symbol}\nEntry: ${target.entry_price} | Exit: ${record?.exit_price}\nRealized PnL: ${pnl.toFixed(4)} USDT | Total: ${this.memory.get_total_pnl().toFixed(4)} USDT`);
    return `Closed trade ID:${tradeId} ${target.position_side} ${target.symbol} | PnL: ${pnl.toFixed(4)} USDT`;
  }

  async close_all_positions(): Promise<string> {
    const openTrades = this.memory.get_open_trades();
    if (!openTrades.length) return "No open positions to close.";
    const lines: string[] = [];
    for (const t of openTrades) {
      lines.push(await this.close_specific_trade(t.id));
    }
    return lines.join("\n");
  }

  async run_mid_management(): Promise<string> {
    const actions = await this.positionMgr.mid_manage_positions();
    if (!actions.length) return "No mid-position management actions needed.\n\n" + (await this.diagnose());
    let report = "MID-POSITION MANAGEMENT:\n";
    for (const a of actions) {
      report += `Trade ${a.trade_id} ${a.symbol}: ${a.details}\n`;
    }
    return report;
  }

  /** Attaches an exchange TP/SL to any open position that lacks one. */
  async protect_open_positions(): Promise<string> {
    const openTrades = this.memory.get_open_trades();
    if (!openTrades.length) return "No open trades recorded.";
    const lines: string[] = [];
    for (const t of openTrades) {
      const { profit_id, note } = await this.positionMgr.ensure_tpsl(t.symbol, t.position_side, {
        signalStrength: t.signal_strength ?? 0.6,
        confidence: t.confidence ?? 70,
      });
      const status = profit_id ? "OK" : "FAILED";
      lines.push(`${status} trade ${t.id} ${t.symbol} ${t.position_side}: ${note}`);
    }
    return lines.join("\n");
  }

  /** Pulls open Toobit positions into the local DB and drops stale rows. */
  async sync_positions(): Promise<string> {
    const lines: string[] = [];
    for (const a of await this.positionMgr.adopt_exchange_positions()) {
      const stop = a.has_stop ? "has stop" : "NO STOP";
      lines.push(`adopted trade ${a.trade_id}: ${a.symbol} ${a.position_side} ${a.size}c @ ${a.entry_price} ${a.leverage}x (${stop})`);
    }
    for (const c of await this.positionMgr.reconcile_open_trades()) {
      lines.push(`closed stale trade ${c.trade_id}: ${c.symbol} ${c.position_side} no longer on the exchange`);
    }
    if (!lines.length) return "In sync: no untracked exchange positions, no stale local trades.";
    return lines.join("\n");
  }

  /** Explains, per open position, why breakeven/trailing has not acted. */
  async diagnose(): Promise<string> {
    const out = ["=== MID-MANAGEMENT DIAGNOSTIC ==="];
    try {
      const live = await this.exchange.getFuturesPositions();
      const liveOpen = live.filter((p) => Math.abs(Number((p as Record<string, unknown>)?.positionSize ?? (p as Record<string, unknown>)?.positionAmt ?? 0)) > 0);
      out.push(`Exchange reports ${liveOpen.length} open position(s).`);
      for (const p of liveOpen) {
        const o = p as Record<string, unknown>;
        out.push(`  Toobit: ${o.symbol} ${o.side ?? o.positionSide} ${Math.trunc(Math.abs(Number(o.positionSize ?? o.positionAmt ?? 0)))}c profitId=${o.profitId ?? o.takeProfitId ?? "none"}`);
      }
    } catch (error) {
      out.push(`Could not read exchange positions: ${error}`);
    }

    const openTrades = this.memory.get_open_trades();
    out.push(`Local DB tracks ${openTrades.length} open trade(s).`);
    if (!openTrades.length) {
      out.push("Nothing is managed, because every guard iterates the local DB. Run /sync to adopt exchange positions.");
      return out.join("\n");
    }
    for (const t of openTrades) {
      out.push(await this.positionMgr.explain_mid_management(t.symbol, t.position_side));
    }
    return out.join("\n");
  }

  // ---------- safety net ----------

  /** Software stop. The exchange TP/SL is primary; this catches TP/SL failures. */
  async check_positions_for_close(): Promise<{ trade_id: number; reason: string; roi: number }[]> {
    const closed: { trade_id: number; reason: string; roi: number }[] = [];
    const slPct = Number(this.memory.get_setting("max_loss_pct") ?? Config.MAX_LOSS_PCT);
    const tpPct = Number(this.memory.get_setting("max_profit_pct") ?? Config.MAX_PROFIT_PCT);
    for (const trade of this.memory.get_open_trades()) {
      const symbol = trade.symbol;
      const side = trade.position_side;
      const pos = await this.positionMgr.get_position_pnl(symbol, side);
      if (!pos.exists) continue;
      const roi = pos.roi;
      let reason: string | null = null;
      if (roi <= -slPct) reason = "max_loss";
      else if (roi >= tpPct) reason = "max_profit";
      if (!reason) continue;
      logger.info(`${reason} triggered for trade ${trade.id}: ROI ${roi.toFixed(2)}%`);
      const result = await this.positionMgr.close_position(symbol, side, trade.id);
      if (result.ok) {
        closed.push({ trade_id: trade.id, reason, roi });
        this._notify(`${reason.toUpperCase().replace("_", " ")} triggered - closed ${side} ${symbol} at ROI ${roi.toFixed(2)}%`);
      } else {
        this._notify(`Failed to close ${side} ${symbol} on ${reason}: ${result.error}`);
      }
    }
    return closed;
  }

  // ---------- auto trade loop ----------

  start_auto_trade(): string {
    if (this._autoTradeEnabled) return "Auto-trade is already running.";
    this._autoTradeEnabled = true;
    this._lastScan = 0;
    this._lastMid = 0;
    const guard = Math.max(1, Number(this.memory.get_setting("guard_interval_sec") ?? Config.GUARD_INTERVAL_SEC));
    this._timer = setInterval(() => {
      void this._auto_trade_tick();
    }, guard * 1000);
    this._notify("Auto-Trade ENABLED");
    return "Auto-trade started. Bot will scan signals and execute trades automatically.";
  }

  stop_auto_trade(): string {
    if (!this._autoTradeEnabled) return "Auto-trade is not running.";
    this._autoTradeEnabled = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._notify("Auto-Trade DISABLED");
    return "Auto-trade stopped.";
  }

  is_auto_trading(): boolean {
    return this._autoTradeEnabled;
  }

  private async _auto_trade_tick(): Promise<void> {
    const guardInterval = Number(this.memory.get_setting("guard_interval_sec") ?? Config.GUARD_INTERVAL_SEC);
    const scanInterval = Number(this.memory.get_setting("scan_interval_sec") ?? Config.SCAN_INTERVAL_SEC);
    const now = Date.now() / 1000;
    try {
      // Adoption runs first: everything below keys off the local DB, so an
      // untracked position would otherwise be invisible to the guard.
      for (const event of await this.positionMgr.adopt_exchange_positions()) {
        const warn = event.has_stop ? "" : " It has NO exchange stop loss.";
        this._notify(`Found untracked position on Toobit: ${event.symbol} ${event.position_side} ${event.size}c @ ${event.entry_price} ${event.leverage}x. Now managed as trade ${event.trade_id}.${warn}`);
      }

      // Runs every guard tick: cheap, and it is what protects capital.
      for (const event of await this.positionMgr.reconcile_open_trades()) {
        this._notify(`Position ${event.symbol} ${event.position_side} disappeared from the exchange (trade ${event.trade_id}). Likely liquidation, external close, or TP/SL fill. Marked closed locally.`);
      }
      await this.check_positions_for_close();

      if (now - this._lastScan >= scanInterval) {
        this._lastScan = now;
        const result = await this.scan_and_execute();
        if (result.action === "signal" && result.direction) {
          const outcome = await this.execute_trade(
            result.direction,
            this._decide_order_type(),
            this._decide_time_in_force(),
          );
          logger.info(`Auto-trade result: ${outcome}`);
          // Notify the user if the trade was rejected after the signal was sent.
          if (outcome && /Cannot|rejected|does not support|could not|not fill/i.test(outcome)) {
            this._notify(`Trade execution failed: ${outcome}`);
          }
        }
      }

      if (now - this._lastMid >= 300) {
        this._lastMid = now;
        for (const action of await this.positionMgr.mid_manage_positions()) {
          if (action.action === "tpsl_recovered" || action.action === "tpsl_missing") {
            this._notify(`${action.symbol} trade ${action.trade_id}: ${action.details}`);
          }
        }
      }
    } catch (error) {
      logger.error(`Auto-trade loop error: ${error}`);
    }
    void guardInterval;
  }

  private _decide_order_type(): OrderType {
    const configured = this.memory.get_setting("ai_order_type", "auto");
    if (configured === "always_market") return "MARKET";
    if (configured === "always_limit") return "LIMIT";
    // Auto mode stays on MARKET. A resting LIMIT order leaves the bot unable to
    // attach a stop loss until it fills, which is how a 50x position ended up
    // with no protection.
    return "MARKET";
  }

  private _decide_time_in_force(): TimeInForce | undefined {
    const configured = this.memory.get_setting("ai_time_in_force", "auto");
    const value = configured === "auto" ? undefined : (configured as TimeInForce | undefined);
    return value && ["GTC", "IOC", "FOK"].includes(value) ? value : undefined;
  }
}

export type { CloseResult };
