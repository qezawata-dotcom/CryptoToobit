import { describe, it, expect, afterEach } from "vitest";
import { LongTermMemory } from "../src/bot/memory.js";
import { Config } from "../src/config.js";

let mem: LongTermMemory | null = null;

function fresh(): LongTermMemory {
  mem = LongTermMemory.inMemory();
  return mem;
}

afterEach(() => {
  mem?.close();
  mem = null;
});

describe("LongTermMemory", () => {
  it("seeds defaults without clobbering existing settings", () => {
    const m = fresh();
    const seeded = m.seed_defaults(Config.defaultSettings());
    expect(seeded).toBeGreaterThan(0);
    expect(m.get_setting("symbol")).toBe("BTC-SWAP-USDT");
    expect(m.get_setting("leverage")).toBe("50");

    // Second seed writes nothing.
    expect(m.seed_defaults(Config.defaultSettings())).toBe(0);

    // User changes a setting; re-seed must not revert it.
    m.set_setting("leverage", "10");
    m.seed_defaults(Config.defaultSettings());
    expect(m.get_setting("leverage")).toBe("10");
  });

  it("records and closes trades, computing winrate", () => {
    const m = fresh();
    const id1 = m.record_trade({
      symbol: "BTC-SWAP-USDT",
      position_side: "LONG",
      order_id: "o1",
      entry_price: 60000,
      amount: 100,
      leverage: 10,
      confidence: 90,
      strategy: "EMA,RSI",
      signal_strength: 1.2,
      timeframe: "15m",
    });
    const id2 = m.record_trade({
      symbol: "BTC-SWAP-USDT",
      position_side: "SHORT",
      order_id: "o2",
      entry_price: 61000,
      amount: 50,
      leverage: 5,
      confidence: 70,
      strategy: "MACD",
      signal_strength: 0.8,
      timeframe: "15m",
    });

    expect(m.get_open_trades()).toHaveLength(2);
    expect(m.get_trade_count()).toMatchObject({ total: 2, open: 2, closed: 0 });

    m.close_trade(id1, 60500, 50);
    m.close_trade(id2, 61500, -25);

    const stats = m.get_trade_count();
    expect(stats).toMatchObject({ total: 2, open: 0, closed: 2, wins: 1, losses: 1 });
    expect(stats.winrate).toBe(50);
    expect(m.get_total_pnl()).toBe(25);
    expect(m.get_open_trades()).toHaveLength(0);
  });

  it("enforces per-(symbol,side) cooldowns", () => {
    const m = fresh();
    expect(m.is_in_cooldown("BTC-SWAP-USDT", "LONG")).toBe(false);
    m.set_cooldown("BTC-SWAP-USDT", "LONG", 5);
    expect(m.is_in_cooldown("BTC-SWAP-USDT", "LONG")).toBe(true);
    expect(m.get_cooldown_remaining("BTC-SWAP-USDT", "LONG")).toBeGreaterThan(0);
    // Different side is unaffected.
    expect(m.is_in_cooldown("BTC-SWAP-USDT", "SHORT")).toBe(false);
  });

  it("persists chat history and ai context", () => {
    const m = fresh();
    m.add_chat_message("user", "hello");
    m.add_chat_message("assistant", "hi there");
    const history = m.get_chat_history();
    expect(history).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);

    m.set_ai_context("chosen_symbol", "BTC-SWAP-USDT");
    expect(m.get_ai_context("chosen_symbol")).toBe("BTC-SWAP-USDT");
    const all = m.get_ai_context() as Record<string, string>;
    expect(all["chosen_symbol"]).toBe("BTC-SWAP-USDT");
  });

  it("saves and reads martingale states, marking stale ones closed", () => {
    const m = fresh();
    const state = {
      symbol: "BTC-SWAP-USDT",
      position_side: "LONG" as const,
      status: "RUNNING" as const,
      trade_id: 7,
      profile: "balanced",
      source: "ai",
      mode: "ai",
      leverage: 5,
      base_size: 100,
      entry_price: 60000,
      avg_entry: 60000,
      current_size: 100,
      adds_done: 0,
      max_adds: 5,
      add_interval_pct: 2.5,
      size_multiplier: 2.0,
      tp_pct: 1.5,
      sl_pct: 15.0,
      next_add_trigger: 58500,
      tp_price: 60900,
      sl_price: 51000,
      capped: false,
      started_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    m.save_martingale_state(state.symbol, state.position_side, state);
    const read = m.get_martingale_state("BTC-SWAP-USDT", "LONG");
    expect(read).not.toBeNull();
    expect(read?.profile).toBe("balanced");
    expect(read?.next_add_trigger).toBe(58500);
    expect(m.get_active_martingale_states()).toHaveLength(1);

    // Overwrite upserts rather than duplicating.
    m.save_martingale_state("BTC-SWAP-USDT", "LONG", {
      ...state,
      current_size: 200,
      updated_at: Date.now() / 1000,
    });
    expect(m.get_active_martingale_states()).toHaveLength(1);
    expect(m.get_martingale_state("BTC-SWAP-USDT", "LONG")?.current_size).toBe(200);

    // Stale recovery closes baskets whose last update is old.
    const old = {
      ...state,
      position_side: "SHORT" as const,
      updated_at: Date.now() / 1000 - 7200,
    };
    m.save_martingale_state("BTC-SWAP-USDT", "SHORT", old);
    expect(m.close_stale_martingale_states(3600)).toBe(1);
    expect(m.get_martingale_state("BTC-SWAP-USDT", "SHORT")?.status).toBe("CLOSED");
  });

  it("builds a trade summary for the AI", () => {
    const m = fresh();
    m.seed_defaults(Config.defaultSettings());
    m.record_trade({
      symbol: "BTC-SWAP-USDT",
      position_side: "LONG",
      order_id: null,
      entry_price: 60000,
      amount: 100,
      leverage: 10,
      confidence: 90,
      strategy: "EMA",
      signal_strength: 1.0,
      timeframe: "15m",
    });
    const summary = m.get_trade_summary_for_ai();
    expect(summary).toContain("=== TRADE SUMMARY ===");
    expect(summary).toContain("BTC-SWAP-USDT");
    expect(summary).toContain("leverage");
  });
});
