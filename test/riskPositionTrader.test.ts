import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LongTermMemory } from "../src/bot/memory.js";
import { Config } from "../src/config.js";
import { RiskManager } from "../src/bot/riskManager.js";
import { PositionManager } from "../src/bot/positionManager.js";
import { ToobitTrader } from "../src/bot/trader.js";
import { SignalScanner } from "../src/bot/signalScanner.js";
import { StrategyEngine } from "../src/bot/strategies.js";
import { MockToobitClient, SYMBOL } from "./helpers/mockToobit.js";
import type { Candle } from "../src/types.js";

/**
 * M4: Risk + positions + trader core. Everything runs against MockToobitClient
 * (no network — api.toobit.com is TLS-blocked from this host). Coverage:
 *   - risk sizing math, validation, round_price, leverage tiers, balance cache
 *   - breakeven/trailing monotonicity, ensure_tpsl clamping + past-safe-stop block
 *   - adopt/reconcile, close-reads-PnL-before-close
 *   - full manual trade lifecycle: open → attach TP/SL → mid-manage → close
 */

let mem: LongTermMemory;
let mock: MockToobitClient;
let risk: RiskManager;
let posMgr: PositionManager;
let trader: ToobitTrader;
let scanner: SignalScanner;

function candle(close: number, openTime: number, open = close, high = close, low = close, volume = 1000): Candle {
  return { openTime, open, high, low, close, volume };
}

/** Simple constant-price klines: enough for ATR, no signal. */
function flatKlines(n: number, price = 60000, intervalMs = 5 * 60 * 1000): Candle[] {
  return Array.from({ length: n }, (_, i) =>
    candle(price, i * intervalMs, price, price + 1, price - 1),
  );
}

/** Joint EMA+MACD LONG fixture at the default confidence gate (see M3 notes). */
function longKlines(n = 68): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = i < 60 ? 200 - i : 140 + (i - 60) * 3;
    return candle(close, i * 5 * 60 * 1000, close - 1, close + 2, close - 2, 1000 + i * 5);
  });
}

function fresh(options?: { seed?: boolean }): void {
  mem = LongTermMemory.inMemory();
  if (options?.seed !== false) mem.seed_defaults(Config.defaultSettings());
  mock = new MockToobitClient();
  risk = new RiskManager(mock, mem);
  posMgr = new PositionManager(mock, mem, risk);
  scanner = new SignalScanner(mock, mem);
  trader = new ToobitTrader(mock, mem, scanner, new StrategyEngine(), risk, posMgr);
}

/** Open a mock position directly (as if placed outside the bot or in a prior test). */
function openMockPosition(side: "LONG" | "SHORT", qty: number, entry: number, leverage = 10, mark = entry): number {
  const cs = Number(mock.contractConfig.contractSize);
  const move = side === "LONG" ? mark - entry : entry - mark;
  mock.positions.push({
    symbol: SYMBOL,
    positionSide: side,
    positionAmt: side === "LONG" ? qty : -qty,
    entryPrice: entry,
    markPrice: mark,
    floatingPL: move * qty * cs,
    isolatedMargin: qty * cs * entry / leverage,
    leverage,
    availableCloseSize: qty,
  });
  return qty * cs * entry;
}

beforeEach(() => fresh());
afterEach(() => mem?.close());

describe("RiskManager", () => {
  it("reads contract config from exchangeInfo and rounds prices to tick", async () => {
    const cfg = await risk.get_symbol_config(SYMBOL);
    expect(cfg.contractSize).toBe(0.0001);
    expect(cfg.minQty).toBe(1);
    expect(cfg.minNotional).toBe(5);
    expect(cfg.pricePrecision).toBe(1); // tickSize 0.1
    expect(await risk.round_price(SYMBOL, 60000.19)).toBe(60000.1);
    expect(await risk.round_price(SYMBOL, 60000.05)).toBe(60000.0);
  });

  it("sizes by margin % and caps at max qty", async () => {
    // 10000 USDT tradable, 25% margin, 10x lev, price 60000, cs 0.0001
    // qty = int(10000 * 0.25 * 10 / (60000 * 0.0001)) = int(10000*2.5/6) = int(4166.66) = 4166
    const qty = await risk.size_by_margin_pct(SYMBOL, 60000, 10);
    expect(qty).toBe(4166);
    const { qty: validated } = await risk.calculate_position_size(SYMBOL, 60000, 10, undefined, "MARKET");
    expect(validated).toBe(4166);
  });

  it("sizes by risk % using the distance to stop", async () => {
    // 10000 USDT, 1% risk, |60000-59500|=500, cs 0.0001
    // qty = int(10000 * 0.01 / (500 * 0.0001)) = int(100 / 0.05) = int(2000) = 2000
    mem.set_setting("position_mode", "risk");
    const qty = await risk.calculate_position_size(SYMBOL, 60000, 10, 59500, "MARKET");
    expect(qty.qty).toBe(2000);
    expect(qty.mode).toBe("risk_based");
  });

  it("rejects sizes below min qty and below min notional", async () => {
    // Balance so small that margin sizing computes 0 contracts.
    mock.balance = { asset: "USDT", walletBalance: "0.05", availableBalance: "0.05", openOrderMarginFrozen: "0" };
    const low = await risk.calculate_position_size(SYMBOL, 60000, 10, undefined, "MARKET");
    expect(low.qty).toBe(0);
    expect(low.reason).toMatch(/0 contracts|below/);
  });

  it("clamps leverage to the riskLimits tier", async () => {
    // Default request 50x with no notional -> max tier allows 100x, so unchanged.
    expect(await risk.validate_leverage(SYMBOL, 50)).toBe(50);
    // At notional 200k USDT the 25x tier applies.
    expect(await risk.validate_leverage(SYMBOL, 50, 200000)).toBe(25);
    // Requesting more than the max for a tier clamps down.
    expect(await risk.validate_leverage(SYMBOL, 200, 200000)).toBe(25);
    // Reference parity: notional above the top bracket falls through to
    // max(maxLeverage) — the 1:1 port of XT's get_max_leverage, so 50x stays 50x.
    expect(await risk.validate_leverage(SYMBOL, 50, 5_000_000)).toBe(50);
  });

  it("caches the balance for BALANCE_CACHE_TTL and invalidates", async () => {
    await risk.get_total_balance();
    mock.balance.walletBalance = "999";
    // Still cached.
    expect(await risk.get_total_balance()).toBe(10000);
    risk.invalidate_balance_cache();
    expect(await risk.get_total_balance()).toBe(999);
  });
});

describe("PositionManager: TP/SL and breakeven/trailing", () => {
  it("attach_tpsl sets triggers on the position and marks it protected", async () => {
    openMockPosition("LONG", 100, 60000, 10);
    const res = await posMgr.attach_tpsl_to_position(SYMBOL, "LONG", 61500, 59500);
    expect(res.ok).toBe(true);
    expect(res.protectedQty).toBe(100);
    const pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(pos.profit_id).toBe("position-tpsl");
    expect(pos.trigger_profit_price).toBe(61500);
    expect(pos.trigger_stop_price).toBe(59500);
  });

  it("breakeven only tightens the stop (never drags it toward entry)", async () => {
    // Seed default threshold is 30%; set one that a 25% ROI position clears.
    mem.set_setting("breakeven_threshold_pct", "1.5");
    openMockPosition("LONG", 100, 60000, 10, 61500); // mark up -> ROI 25%
    await posMgr.attach_tpsl_to_position(SYMBOL, "LONG", 62000, 59000);
    let pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(pos.roi).toBeGreaterThanOrEqual(1.5);
    const moved = await posMgr.check_tpsl_breakeven(SYMBOL, "LONG");
    expect(moved).toBe(true);
    pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    // SL must be at entry*1.0005 = 60030, not below the current (wider) SL.
    expect(pos.trigger_stop_price).toBeGreaterThan(60000);
    expect(pos.trigger_stop_price).toBeCloseTo(60030, 1);
    // Running again must not move it (monotonic).
    expect(await posMgr.check_tpsl_breakeven(SYMBOL, "LONG")).toBe(false);
  });

  it("trailing only improves the stop", async () => {
    openMockPosition("LONG", 100, 60000, 10, 61500);
    await posMgr.attach_tpsl_to_position(SYMBOL, "LONG", 62000, 60500);
    // Configure trailing: trigger ROI 2%, distance 1%. Seed default trigger is 50%.
    mem.set_setting("trailing_trigger_roi_pct", "2");
    mem.set_setting("trailing_distance_pct", "1");
    let pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(pos.roi).toBeGreaterThanOrEqual(2);
    const trailed = await posMgr.trail_stop_loss(SYMBOL, "LONG");
    expect(trailed.ok).toBe(true);
    pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(pos.trigger_stop_price).toBeCloseTo(61500 * 0.99, 1);
    // Mark moves up further -> still improves.
    mock.setMarkPrice(SYMBOL, 62000);
    const trailed2 = await posMgr.trail_stop_loss(SYMBOL, "LONG");
    expect(trailed2.ok).toBe(true);
    pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(pos.trigger_stop_price).toBeCloseTo(62000 * 0.99, 1);
    // Mark drops below -> must not move the stop down.
    mock.setMarkPrice(SYMBOL, 61000);
    expect((await posMgr.trail_stop_loss(SYMBOL, "LONG")).ok).toBe(false);
  });

  it("ensure_tpsl clamps a stop beyond liquidation to the safe level", async () => {
    openMockPosition("LONG", 100, 60000, 50, 60000); // 50x: liquidation at ~1200 away
    // A wildly wide stop (entry - 5000) would be beyond liquidation.
    const res = await posMgr.ensure_tpsl(SYMBOL, "LONG", {
      triggerStopPrice: 55000,
      triggerProfitPrice: 62000,
      signalStrength: 0.6,
      confidence: 70,
    });
    expect(res.profit_id).toBe("position-tpsl");
    const pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    // Liquidation distance = entry/lev = 60000/50 = 1200; safety 0.5 -> max 600 below.
    expect(pos.trigger_stop_price).toBeGreaterThan(60000 - 601);
    expect(pos.trigger_stop_price).toBeLessThan(60000);
  });

  it("ensure_tpsl blocks when mark is already past the safe stop level", async () => {
    // SHORT position whose mark has risen far above entry: a stop above it would
    // trigger instantly, so the manager must refuse and say so.
    openMockPosition("SHORT", 100, 60000, 50, 66000);
    const res = await posMgr.ensure_tpsl(SYMBOL, "SHORT", {
      triggerStopPrice: 62000,
      triggerProfitPrice: 58000,
    });
    expect(res.profit_id).toBeNull();
    expect(res.note).toMatch(/past the safe stop level/);
  });
});

describe("PositionManager: adopt, reconcile, close", () => {
  it("adopts exchange positions absent from the local DB", async () => {
    openMockPosition("LONG", 200, 60000, 10);
    const adopted = await posMgr.adopt_exchange_positions();
    expect(adopted).toHaveLength(1);
    expect(adopted[0].symbol).toBe(SYMBOL);
    expect(adopted[0].position_side).toBe("LONG");
    expect(adopted[0].size).toBe(200);
    const trades = mem.get_open_trades();
    expect(trades).toHaveLength(1);
    expect(trades[0].strategy).toBe("ADOPTED");
    // Second run must not double-adopt.
    expect(await posMgr.adopt_exchange_positions()).toHaveLength(0);
  });

  it("reconciles positions that vanished from the exchange", async () => {
    const tradeId = mem.record_trade({
      symbol: SYMBOL, position_side: "LONG", order_id: "o1",
      entry_price: 60000, amount: 100, leverage: 10, confidence: 90,
      strategy: "TEST", signal_strength: 0.8, timeframe: "15m",
    });
    const closed = await posMgr.reconcile_open_trades();
    expect(closed).toHaveLength(1);
    expect(closed[0].trade_id).toBe(tradeId);
    expect(closed[0].reason).toBe("closed_externally");
    expect(mem.get_open_trades()).toHaveLength(0);
  });

  it("close_position reads PnL BEFORE closing and sets cooldown on both sides", async () => {
    openMockPosition("LONG", 100, 60000, 10, 61500); // unrealized = +1500 price × 100c × 0.0001 cs = 15 USDT
    // openMockPosition computes floatingPL at creation; the manager reads it.
    const posBefore = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(posBefore.unrealized_pnl).toBeCloseTo(15, 0);
    await posMgr.attach_tpsl_to_position(SYMBOL, "LONG", 62000, 59500);
    const tradeId = mem.record_trade({
      symbol: SYMBOL, position_side: "LONG", order_id: "o2",
      entry_price: 60000, amount: 100, leverage: 10, confidence: 90,
      strategy: "TEST", signal_strength: 0.8, timeframe: "15m",
    });
    const result = await posMgr.close_position(SYMBOL, "LONG", tradeId);
    expect(result.ok).toBe(true);
    // PnL was captured from the position before it vanished.
    expect(mem.get_trade(tradeId)?.pnl).toBeGreaterThan(0);
    expect(mem.get_trade(tradeId)?.pnl).toBeCloseTo(15, 0);
    expect(mem.get_open_trades()).toHaveLength(0);
    expect(mem.is_in_cooldown(SYMBOL, "LONG")).toBe(true);
    expect(mem.is_in_cooldown(SYMBOL, "SHORT")).toBe(true);
  });

  it("close_position cancels only THIS side's protective order (hedged stops survive)", async () => {
    openMockPosition("LONG", 100, 60000, 10);
    openMockPosition("SHORT", 50, 60000, 10);
    // Attach stops to both sides.
    await posMgr.attach_tpsl_to_position(SYMBOL, "LONG", 62000, 59500);
    mock.positions.forEach((p) => {
      if (p.positionSide === "SHORT") {
        p.triggerProfitPrice = 58000;
        p.triggerStopPrice = 60500;
      }
    });
    // Re-sync open orders to mirror the two protective orders.
    mock.openOrders = mock.openOrders.filter((o) => o.side !== "SELL_OPEN");
    mock.attachStop(mock.positions.find((p) => p.positionSide === "SHORT")!, "mock-short-stop");
    const tradeId = mem.record_trade({
      symbol: SYMBOL, position_side: "LONG", order_id: "o3",
      entry_price: 60000, amount: 100, leverage: 10, confidence: 90,
      strategy: "TEST", signal_strength: 0.8, timeframe: "15m",
    });
    const result = await posMgr.close_position(SYMBOL, "LONG", tradeId);
    expect(result.ok).toBe(true);
    // The SHORT position + its protective stop must still exist.
    const shortPos = mock.positions.find((p) => p.positionSide === "SHORT");
    expect(shortPos).toBeDefined();
    expect(mock.openOrders.some((o) => o.orderId === "mock-short-stop")).toBe(true);
  });
});

describe("ToobitTrader: execute_trade lifecycle", () => {
  it("opens, protects, mid-manages, and closes a LONG trade end-to-end", async () => {
    // Feed 5m klines that produce a LONG consensus >= the default gate, plus
    // enough rows for ATR(14).
    mock.klines[`${SYMBOL}:5m`] = longKlines(68);
    mem.set_setting("timeframes", "5m");

    const scan = await trader.scan_and_execute();
    expect(scan.action).toBe("signal");
    expect(scan.direction).toBe("LONG");
    expect(scan.result.price).toBeGreaterThan(0);
    expect(scan.report).toMatch(/LONG/);

    const outcome = await trader.execute_trade("LONG");
    expect(outcome).not.toMatch(/Cannot|rejected|does not support|could not/);
    expect(outcome).toMatch(/TRADE|OPENED|Trade ID/);

    // Position is on the exchange.
    const trades = mem.get_open_trades();
    expect(trades).toHaveLength(1);
    expect(trades[0].position_side).toBe("LONG");
    const pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(pos.exists).toBe(true);
    expect(pos.entry_price).toBeGreaterThan(0);
    expect(pos.profit_id).toBeTruthy();
    expect(pos.trigger_stop_price).toBeGreaterThan(0);
    expect(pos.trigger_profit_price).toBeGreaterThan(pos.entry_price);

    // Mid-management does not error and reports a reason per open trade.
    const mgmt = await trader.run_mid_management();
    expect(mgmt).toMatch(/LONG|no|management/i);

    // Move the mark up to trigger breakeven, then close.
    mock.setMarkPrice(SYMBOL, pos.entry_price * 1.02);
    const closed = await trader.close_specific_trade(trades[0].id);
    expect(closed).toMatch(/Closed trade/);
    expect(mem.get_open_trades()).toHaveLength(0);
  }, 15000);

  it("closes immediately (not leaving a position unprotected) when TP/SL attach fails", async () => {
    mock.klines[`${SYMBOL}:5m`] = longKlines(68);
    mem.set_setting("timeframes", "5m");
    mem.set_setting("on_tpsl_failure", "close");
    mock.fail("setFuturesTradingStop");

    const outcome = await trader.execute_trade("LONG");
    expect(outcome).toMatch(/CLOSED|unprotected/);
    // Nothing left open on the exchange.
    expect(mock.positions).toHaveLength(0);
    expect(mem.get_open_trades()).toHaveLength(0);
  }, 15000);

  it("honours the cooldown gate after a close", async () => {
    openMockPosition("LONG", 100, 60000, 10);
    const tradeId = mem.record_trade({
      symbol: SYMBOL, position_side: "LONG", order_id: "o4",
      entry_price: 60000, amount: 100, leverage: 10, confidence: 90,
      strategy: "TEST", signal_strength: 0.8, timeframe: "15m",
    });
    await posMgr.close_position(SYMBOL, "LONG", tradeId);
    // Cooldown is set for BOTH sides by close_position.
    expect(mem.is_in_cooldown(SYMBOL, "LONG")).toBe(true);
    expect(mem.is_in_cooldown(SYMBOL, "SHORT")).toBe(true);
    const gate = trader._gate_checks(SYMBOL, "LONG");
    expect(gate).toMatch(/cooldown/);
    // Even the opposite side is gated until the cooldown lapses.
    expect(trader._gate_checks(SYMBOL, "SHORT")).toMatch(/cooldown/);
  });
});
