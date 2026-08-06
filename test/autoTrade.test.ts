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
 * M6: Auto-trade loop + software stops (already folded into trader.ts during
 * M4; this file proves the wiring end to end against the mock exchange):
 *   - check_positions_for_close closes on the max_loss / max_profit ROI stops
 *   - start/stop/is_auto_trading lifecycle with idempotent guards
 *   - a full _auto_trade_tick: adopt → reconcile → software stops → scan →
 *     execute → mid-manage opens a trade from a LONG consensus signal
 *   - a neutral market produces no trade
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

/**
 * Choppy/oscillating klines that produce a genuinely NEUTRAL consensus.
 *
 * NOT a flat series: RSI of a constant series is 0, which fires the deep
 * oversold branch (RSIStrategy LONG at confidence 80 — faithful to the Python
 * reference, documented in test/strategies.test.ts). The alternating ±2 keeps
 * RSI mid-band (~50), the last two candles move together so EMA sees no
 * crossover at the final candle, constant volume means no momentum surge, and
 * the only fire (MACD trend, confidence 55) sits below tf_min_confidence 60.
 */
function neutralKlines(n = 80, price = 60000): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = i < n - 2 ? price + (i % 2 === 0 ? 2 : -2) : price + 2;
    return candle(close, i * 5 * 60 * 1000, close - 1, close + 2, close - 2, 1000);
  });
}

/** Joint EMA+MACD LONG fixture at the default 80% confidence gate. */
function longKlines(n = 68): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = i < 60 ? 200 - i : 140 + (i - 60) * 3;
    return candle(close, i * 5 * 60 * 1000, close - 1, close + 2, close - 2, 1000 + i * 5);
  });
}

function fresh(): void {
  mem = LongTermMemory.inMemory();
  mem.seed_defaults(Config.defaultSettings());
  mock = new MockToobitClient();
  risk = new RiskManager(mock, mem);
  posMgr = new PositionManager(mock, mem, risk);
  scanner = new SignalScanner(mock, mem);
  trader = new ToobitTrader(mock, mem, scanner, new StrategyEngine(), risk, posMgr);
}

/** Open a position directly on the mock exchange + record the matching trade. */
function openPositionAndTrade(
  side: "LONG" | "SHORT",
  qty: number,
  entry: number,
  leverage = 10,
  mark = entry,
): number {
  const cs = Number(mock.contractConfig.contractSize);
  const move = side === "LONG" ? mark - entry : entry - mark;
  mock.positions.push({
    symbol: SYMBOL,
    positionSide: side,
    positionAmt: side === "LONG" ? qty : -qty,
    entryPrice: entry,
    markPrice: mark,
    floatingPL: move * qty * cs,
    isolatedMargin: (qty * cs * entry) / leverage,
    leverage,
    availableCloseSize: qty,
  });
  return mem.record_trade({
    symbol: SYMBOL,
    position_side: side,
    order_id: `mock-${side}-${qty}`,
    entry_price: entry,
    amount: qty,
    leverage,
    confidence: 90,
    strategy: "TEST",
    signal_strength: 0.8,
    timeframe: "15m",
  });
}

beforeEach(() => fresh());
afterEach(() => mem?.close());

describe("software stops (check_positions_for_close)", () => {
  it("closes a position whose ROI breaches max_loss", async () => {
    // entry 60000, 10x, mark 57000 → ROI = (-3000/60000)×10×100 = -50% ≤ -40%.
    const tradeId = openPositionAndTrade("LONG", 100, 60000, 10, 57000);
    const closed = await trader.check_positions_for_close();
    expect(closed).toHaveLength(1);
    expect(closed[0].trade_id).toBe(tradeId);
    expect(closed[0].reason).toBe("max_loss");
    expect(closed[0].roi).toBeLessThanOrEqual(-40);
    expect(mem.get_open_trades()).toHaveLength(0);
    expect(mock.positions).toHaveLength(0);
  });

  it("closes a position whose ROI breaches max_profit", async () => {
    // entry 60000, 10x, mark 91000 → ROI = (31000/60000)×10×100 = 516% ≥ 500%.
    const tradeId = openPositionAndTrade("LONG", 100, 60000, 10, 91000);
    const closed = await trader.check_positions_for_close();
    expect(closed).toHaveLength(1);
    expect(closed[0].trade_id).toBe(tradeId);
    expect(closed[0].reason).toBe("max_profit");
    expect(mem.get_open_trades()).toHaveLength(0);
  });

  it("is a no-op when ROI is inside the bounds", async () => {
    openPositionAndTrade("LONG", 100, 60000, 10, 61000); // ROI +16.7%
    openPositionAndTrade("SHORT", 50, 60000, 10, 59000); // ROI +16.7%
    expect(await trader.check_positions_for_close()).toHaveLength(0);
    expect(mem.get_open_trades()).toHaveLength(2);
  });

  it("leaves an OPEN trade alone when the position is missing on the exchange", async () => {
    // No mock position, but the trade is OPEN: the software stop must skip it
    // (reconcile is the component that handles missing positions).
    const tradeId = mem.record_trade({
      symbol: SYMBOL, position_side: "LONG", order_id: "orphan",
      entry_price: 60000, amount: 100, leverage: 10, confidence: 90,
      strategy: "TEST", signal_strength: 0.8, timeframe: "15m",
    });
    const closed = await trader.check_positions_for_close();
    expect(closed).toHaveLength(0);
    expect(mem.get_open_trades().map((t) => t.id)).toEqual([tradeId]);
  });
});

describe("auto-trade lifecycle", () => {
  it("start / stop / is_auto_trading are idempotent", () => {
    expect(trader.is_auto_trading()).toBe(false);
    expect(trader.start_auto_trade()).toMatch(/started/);
    expect(trader.is_auto_trading()).toBe(true);
    // Already running → refuses to double-start.
    expect(trader.start_auto_trade()).toMatch(/already running/);
    expect(trader.stop_auto_trade()).toMatch(/stopped/);
    expect(trader.is_auto_trading()).toBe(false);
    // Already stopped → refuses to double-stop.
    expect(trader.stop_auto_trade()).toMatch(/not running/);
  });
});

describe("auto-trade tick", () => {
  const tick = (): Promise<void> =>
    (trader as unknown as { _auto_trade_tick(): Promise<void> })._auto_trade_tick.call(trader);

  it("opens a trade from a LONG consensus during a full tick cycle", async () => {
    mock.klines[`${SYMBOL}:5m`] = longKlines(68);
    mem.set_setting("timeframes", "5m");
    trader.start_auto_trade();

    await tick();

    const trades = mem.get_open_trades();
    expect(trades).toHaveLength(1);
    expect(trades[0].position_side).toBe("LONG");
    // The position exists on the exchange with a protective stop attached.
    const pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(pos.exists).toBe(true);
    expect(pos.profit_id).toBeTruthy();
    expect(pos.trigger_stop_price).toBeGreaterThan(0);

    trader.stop_auto_trade();
  }, 15000);

  it("does not open a trade on a neutral market", async () => {
    mock.klines[`${SYMBOL}:5m`] = neutralKlines(80, 60000);
    mem.set_setting("timeframes", "5m");
    trader.start_auto_trade();

    await tick();

    expect(mem.get_open_trades()).toHaveLength(0);
    expect(mock.positions).toHaveLength(0);

    trader.stop_auto_trade();
  }, 15000);
});
