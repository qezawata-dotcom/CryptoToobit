import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LongTermMemory } from "../src/bot/memory.js";
import { Config } from "../src/config.js";
import { RiskManager } from "../src/bot/riskManager.js";
import { PositionManager } from "../src/bot/positionManager.js";
import { SignalScanner } from "../src/bot/signalScanner.js";
import { StrategyEngine } from "../src/bot/strategies.js";
import {
  MartingaleManager,
  RISK_PROFILES,
  CONFIG_KEYS,
  MARTINGALE_STRATEGY_PREFIX,
} from "../src/bot/martingale.js";
import { MockToobitClient, SYMBOL } from "./helpers/mockToobit.js";
import type { Candle } from "../src/types.js";

/**
 * M7: Martingale state machine against the mock exchange.
 *
 * A basket is a sequence of same-direction fills: start → add on adverse move
 * (qty = base × multiplier^(adds+1), average entry dragged toward the market,
 * TP moved down so a shallow rebound exits the whole basket) → TP/SL close or
 * basket finish when the position disappears. Covers:
 *   - set_param validation + the config surface
 *   - _resolve_params (AI profile vs manual)
 *   - start_basket: sizing, order, trade row, RUNNING state, exchange TP/SL
 *   - check_basket add path (weighted-average entry recompute in the mock)
 *   - margin-cap → capped (no more adds)
 *   - software TP / SL closes the basket + trade
 *   - basket_finished when the position disappears
 *   - stop_basket closes position + state
 */

const ENTRY = 60000;

let mem: LongTermMemory;
let mock: MockToobitClient;
let risk: RiskManager;
let posMgr: PositionManager;
let scanner: SignalScanner;
let mgr: MartingaleManager;
const notified: string[] = [];

function seedKline(price: number): void {
  const k: Candle[] = [{
    openTime: 0, open: price, high: price + 1, low: price - 1, close: price, volume: 1000,
  }];
  mock.klines[`${SYMBOL}:5m`] = k;
}

function fresh(): void {
  mem = LongTermMemory.inMemory();
  mem.seed_defaults(Config.defaultSettings());
  mock = new MockToobitClient();
  risk = new RiskManager(mock, mem);
  posMgr = new PositionManager(mock, mem, risk);
  scanner = new SignalScanner(mock, mem);
  mgr = new MartingaleManager(mock, mem, risk, scanner, posMgr);
  notified.length = 0;
  mgr.set_notify_callback((msg) => notified.push(msg));
  seedKline(ENTRY);
}

async function startLONG(source = "manual"): Promise<number> {
  const res = await mgr.start_basket(SYMBOL, "LONG", source, 85, 0.8);
  expect(res.started).toBe(true);
  return res.trade_id!;
}

beforeEach(() => fresh());
afterEach(() => mem?.close());

describe("config surface (set_param)", () => {
  it("rejects unknown keys and lists valid ones", () => {
    const out = mgr.set_param("martingale_not_a_key", "1");
    expect(out).toMatch(/Unknown martingale setting/);
    for (const k of CONFIG_KEYS) expect(out).toContain(k);
  });

  it("validates direction / mode / risk-profile enums", () => {
    expect(mgr.set_param("martingale_direction", "diagonal")).toMatch(/must be AUTO, LONG or SHORT/);
    expect(mgr.set_param("martingale_direction", "LONG")).toMatch(/set to: LONG/);
    expect(mem.get_setting("martingale_direction")).toBe("LONG");

    expect(mgr.set_param("martingale_mode", "quantum")).toMatch(/must be 'ai' or 'manual'/);
    expect(mgr.set_param("martingale_mode", "manual")).toMatch(/set to: manual/);

    expect(mgr.set_param("martingale_risk_profile", "extreme")).toMatch(/must be one of/);
    expect(mgr.set_param("martingale_risk_profile", "aggressive")).toMatch(/set to: aggressive/);
  });

  it("clamps numbers and enforces sign constraints", () => {
    expect(mgr.set_param("martingale_max_adds", "99")).toMatch(/set to: 25/);
    expect(mgr.set_param("martingale_max_adds", "0")).toMatch(/set to: 1/);
    expect(mgr.set_param("martingale_size_multiplier", "0.5")).toMatch(/must be >= 1.0/);
    expect(mgr.set_param("martingale_tp_pct", "-2")).toMatch(/must be > 0/);
    expect(mgr.set_param("martingale_leverage", "500")).toMatch(/set to: 125/);
    expect(mgr.set_param("martingale_enabled", "1")).toMatch(/set to: true/);
    expect(mgr.is_enabled()).toBe(true);
    expect(mgr.set_param("martingale_enabled", "off")).toMatch(/set to: false/);
    expect(mgr.is_enabled()).toBe(false);
  });
});

describe("_resolve_params", () => {
  it("AI mode derives the balanced profile by default", () => {
    const p = mgr._resolve_params();
    expect(p).toEqual({ ...RISK_PROFILES.balanced, profile: "balanced" });
  });

  it("manual mode uses the explicit manual keys", () => {
    mgr.set_param("martingale_mode", "manual");
    mgr.set_param("martingale_add_interval_pct", "3.5");
    mgr.set_param("martingale_size_multiplier", "1.8");
    mgr.set_param("martingale_max_adds", "7");
    mgr.set_param("martingale_tp_pct", "2.2");
    const p = mgr._resolve_params();
    expect(p).toEqual({
      add_interval_pct: 3.5,
      size_multiplier: 1.8,
      max_adds: 7,
      tp_pct: 2.2,
      profile: "manual",
    });
  });
});

describe("start_basket", () => {
  it("opens a position, records a MARTINGALE trade and a RUNNING state", async () => {
    const tradeId = await startLONG();

    // Order placed + filled on the exchange.
    const pos = await posMgr.get_position_pnl(SYMBOL, "LONG");
    expect(pos.exists).toBe(true);
    expect(Math.abs(pos.position_size)).toBeGreaterThan(0);

    // Trade row with the martingale strategy marker.
    const trade = mem.get_trade(tradeId);
    expect(trade).not.toBeNull();
    expect(trade!.strategy).toBe(`${MARTINGALE_STRATEGY_PREFIX}-balanced`);
    expect(trade!.position_side).toBe("LONG");
    expect(mem.get_open_trades(SYMBOL)).toHaveLength(1);

    // State is RUNNING with balanced-profile numbers.
    const state = mem.get_martingale_state(SYMBOL, "LONG");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("RUNNING");
    expect(state!.adds_done).toBe(0);
    expect(state!.max_adds).toBe(RISK_PROFILES.balanced.max_adds);
    expect(state!.size_multiplier).toBe(RISK_PROFILES.balanced.size_multiplier);
    // LONG: next add at entry × (1 − 2.5%), TP at entry × 1.015.
    expect(state!.next_add_trigger).toBeCloseTo(ENTRY * 0.975, 5);
    expect(state!.tp_price).toBeCloseTo(ENTRY * 1.015, 5);
    // SL clamped inside liquidation: 15% raw → 0.5 × (entry/5).
    expect(state!.sl_price).toBeCloseTo(ENTRY - ENTRY / 5 * 0.5, 5);

    // Exchange TP/SL attached.
    expect(pos.profit_id).toBeTruthy();
    expect(pos.trigger_profit_price).toBeCloseTo(state!.tp_price, 3);
    expect(pos.trigger_stop_price).toBeCloseTo(state!.sl_price, 3);
  });

  it("refuses a second basket for the same side", async () => {
    await startLONG();
    const res = await mgr.start_basket(SYMBOL, "LONG", "manual", 80, 0.5);
    expect(res.started).toBe(false);
    expect(res.message).toMatch(/already running/);
  });

  it("refuses when an open trade already exists on the same side", async () => {
    // Open a normal (non-martingale) LONG trade directly.
    mem.record_trade({
      symbol: SYMBOL, position_side: "LONG", order_id: "x",
      entry_price: ENTRY, amount: 10, leverage: 5, confidence: 80,
      strategy: "TEST", signal_strength: 0.6, timeframe: "15m",
    });
    const res = await mgr.start_basket(SYMBOL, "LONG", "manual", 80, 0.5);
    expect(res.started).toBe(false);
    expect(res.message).toMatch(/already exists/);
  });

  it("honours the cooldown gate", async () => {
    mem.set_cooldown(SYMBOL, "LONG", 5);
    const res = await mgr.start_basket(SYMBOL, "LONG", "manual", 80, 0.5);
    expect(res.started).toBe(false);
    expect(res.message).toMatch(/Cooldown active/);
  });

  it("strategy marker carries the source", async () => {
    const tradeId = await startLONG("ai");
    expect(mem.get_trade(tradeId)!.strategy).toBe(`${MARTINGALE_STRATEGY_PREFIX}-balanced-ai`);
  });
});

describe("check_basket — add path", () => {
  it("adds when the price crosses the next trigger and drags the average down", async () => {
    const tradeId = await startLONG();
    const state0 = mem.get_martingale_state(SYMBOL, "LONG")!;
    const baseSize = state0.base_size;
    // First add: qty = base × 2^1.
    const expectedAdd = baseSize * 2;

    // Move the price below the trigger (LONG adds on a drop).
    const mark = state0.next_add_trigger - 100;
    mock.setMarkPrice(SYMBOL, mark);

    const actions = await mgr.check_basket(mem.get_martingale_state(SYMBOL, "LONG")!);
    expect(actions.map((a) => a.action)).toEqual(["add_filled"]);

    const state = mem.get_martingale_state(SYMBOL, "LONG")!;
    expect(state.adds_done).toBe(1);
    expect(state.current_size).toBe(baseSize + expectedAdd);
    // Weighted average of base@60000 and add@mark.
    const avg =
      (baseSize * ENTRY + expectedAdd * mark) / (baseSize + expectedAdd);
    expect(state.avg_entry).toBeCloseTo(avg, 3);
    // TP moved to the new average (shallow rebound exits the whole basket).
    expect(state.tp_price).toBeCloseTo(avg * (1 + state.tp_pct / 100), 3);
    // Next add steps the same interval below the previous trigger.
    expect(state.next_add_trigger).toBeCloseTo(state0.next_add_trigger * 0.975, 3);
    // The SL stays put: _safe_stop only clamps UP into the liquidation-safety
    // line, and the old SL (54000) is already inside the new safe boundary
    // (avg/5 × 0.5 below the new average ≈ 53040).
    expect(state.sl_price).toBe(state0.sl_price);

    // The trade row is untouched by adds.
    expect(mem.get_trade(tradeId)!.amount).toBe(baseSize);
    // Notifications went out for the add.
    expect(notified.some((m) => m.includes("MARTINGALE ADD #1"))).toBe(true);
  });

  it("caps adds when the basket margin would exceed max_margin_pct", async () => {
    await startLONG();
    mgr.set_param("martingale_max_margin_pct", "1");
    const state0 = mem.get_martingale_state(SYMBOL, "LONG")!;

    mock.setMarkPrice(SYMBOL, state0.next_add_trigger - 100);
    const ordersBefore = (mock.calls.placeFuturesOrder ?? []).length;
    const actions = await mgr.check_basket(mem.get_martingale_state(SYMBOL, "LONG")!);
    expect(actions.map((a) => a.action)).toEqual(["add_blocked_capped"]);

    const state = mem.get_martingale_state(SYMBOL, "LONG")!;
    expect(state.capped).toBe(true);
    expect(state.adds_done).toBe(0);
    // No add order was placed.
    expect((mock.calls.placeFuturesOrder ?? []).length).toBe(ordersBefore);
    expect(notified.some((m) => m.includes("No more adds"))).toBe(true);
  });
});

describe("check_basket — closes", () => {
  it("closes the whole basket on the software TP", async () => {
    const tradeId = await startLONG();
    const state0 = mem.get_martingale_state(SYMBOL, "LONG")!;
    mock.setMarkPrice(SYMBOL, state0.tp_price + 10);

    const actions = await mgr.check_basket(mem.get_martingale_state(SYMBOL, "LONG")!);
    expect(actions.map((a) => a.action)).toEqual(["basket_closed"]);

    // Position gone, trade closed, state CLOSED.
    expect((await posMgr.get_position_pnl(SYMBOL, "LONG")).exists).toBe(false);
    expect(mem.get_trade(tradeId)!.status).toBe("CLOSED");
    expect(mem.get_martingale_state(SYMBOL, "LONG")!.status).toBe("CLOSED");
    expect(notified.some((m) => m.includes("BASKET CLOSED"))).toBe(true);
  });

  it("closes the whole basket on the software SL", async () => {
    await startLONG();
    const state0 = mem.get_martingale_state(SYMBOL, "LONG")!;
    mock.setMarkPrice(SYMBOL, state0.sl_price - 10);

    const actions = await mgr.check_basket(mem.get_martingale_state(SYMBOL, "LONG")!);
    expect(actions.map((a) => a.action)).toEqual(["basket_closed"]);
    expect(mem.get_martingale_state(SYMBOL, "LONG")!.status).toBe("CLOSED");
  });

  it("marks the basket finished when the position disappears on the exchange", async () => {
    await startLONG();
    // Simulate an external close / liquidation: the position is simply gone.
    mock.positions = [];
    // And clear any open protective orders so getFuturesOpenOrders is empty.
    mock.openOrders = [];

    const actions = await mgr.check_basket(mem.get_martingale_state(SYMBOL, "LONG")!);
    expect(actions.map((a) => a.action)).toEqual(["basket_finished"]);
    const state = mem.get_martingale_state(SYMBOL, "LONG")!;
    expect(state.status).toBe("CLOSED");
    // The trade row is left OPEN — reconcile_open_trades owns closing it.
    expect(mem.get_open_trades(SYMBOL)).toHaveLength(1);
  });
});

describe("stop_basket", () => {
  it("closes the position and marks the state CLOSED", async () => {
    const tradeId = await startLONG();
    const out = await mgr.stop_basket(SYMBOL, "LONG");
    expect(out).toMatch(/stopped for/);

    expect((await posMgr.get_position_pnl(SYMBOL, "LONG")).exists).toBe(false);
    expect(mem.get_trade(tradeId)!.status).toBe("CLOSED");
    expect(mem.get_martingale_state(SYMBOL, "LONG")!.status).toBe("CLOSED");
  });

  it("stops all baskets when no side is given", async () => {
    await startLONG();
    const out = await mgr.stop_basket(SYMBOL);
    expect(out).toMatch(/stopped for/);
    expect(mem.get_martingale_state(SYMBOL, "LONG")!.status).toBe("CLOSED");
  });

  it("is a no-op with no running basket", async () => {
    expect(await mgr.stop_basket()).toMatch(/No running martingale basket to stop/);
  });
});

describe("status_report", () => {
  it("renders configuration and running baskets", async () => {
    await startLONG();
    mgr.set_param("martingale_enabled", "1");
    const report = await mgr.status_report();
    expect(report).toContain("=== MARTINGALE BOT ===");
    expect(report).toContain("Enabled: ON");
    expect(report).toContain("Risk Profile: balanced");
    expect(report).toContain("BTC-SWAP-USDT LONG");
    expect(report).toContain("adds 0/5");
    expect(report).toContain("next add @");
  });

  it("renders manual-mode parameters", async () => {
    mgr.set_param("martingale_mode", "manual");
    const report = await mgr.status_report();
    expect(report).toContain("Mode: manual");
    expect(report).toContain("interval 2.0% | multiplier 2.0x");
  });

  it("reports no basket when none is running", async () => {
    expect(await mgr.status_report()).toContain("No running martingale basket");
  });
});
