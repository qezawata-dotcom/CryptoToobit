import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LongTermMemory } from "../src/bot/memory.js";
import { Config } from "../src/config.js";
import { RiskManager } from "../src/bot/riskManager.js";
import { PositionManager } from "../src/bot/positionManager.js";
import { ToobitTrader } from "../src/bot/trader.js";
import { SignalScanner } from "../src/bot/signalScanner.js";
import { StrategyEngine } from "../src/bot/strategies.js";
import { AIChat } from "../src/bot/aiChat.js";
import { AI_TOOLS, AI_TOOL_NAMES } from "../src/bot/aiTools.js";
import { TelegramBot, _split_message } from "../src/bot/telegramBot.js";
import { MockToobitClient, SYMBOL } from "./helpers/mockToobit.js";
import type { Candle } from "../src/types.js";

/**
 * M5: Telegram + AI. Coverage:
 *   - 20 tool schemas declared and enumerable
 *   - the AI loop resolves tools against a mock trader (function → execute_function)
 *   - every handler in aiChat's handler map routes to a trader/scanner/risk call
 *   - TelegramBot wires all 17 command handlers + free text + notify callback
 *   - _split_message chunks at 4000 chars
 *
 * The OpenAI HTTP round-trip is NOT exercised here (api.openai.com is not
 * reachable and we don't want live calls in tests): the tool-execution path is
 * tested directly via AIChat.execute_function, which is the seam the model
 * drives. Command routing is asserted structurally via the grammY middleware
 * count and the handler-map surface.
 */

let mem: LongTermMemory;
let mock: MockToobitClient;
let risk: RiskManager;
let posMgr: PositionManager;
let trader: ToobitTrader;
let scanner: SignalScanner;
let ai: AIChat;
let bot: TelegramBot;

function candle(close: number, openTime: number, open = close, high = close, low = close, volume = 1000): Candle {
  return { openTime, open, high, low, close, volume };
}

function fresh(options?: { seed?: boolean }): void {
  mem = LongTermMemory.inMemory();
  if (options?.seed !== false) mem.seed_defaults(Config.defaultSettings());
  mock = new MockToobitClient();
  risk = new RiskManager(mock, mem);
  posMgr = new PositionManager(mock, mem, risk);
  scanner = new SignalScanner(mock, mem);
  trader = new ToobitTrader(mock, mem, scanner, new StrategyEngine(), risk, posMgr);
  ai = new AIChat(mem, new StrategyEngine());
  ai.bind_trader(trader);
  bot = new TelegramBot(trader, ai, mem, {
    token: "123456:test-token",      // Config has no token in tests
    apiRoot: "http://127.0.0.1:9",   // dead port → notify API calls fail fast
    userId: 999,                     // the only authorized chat id
  });
  bot.init();
}

/** Minimal grammY-like context the handlers touch: reply/from/match/message. */
function fakeCtx(overrides?: {
  fromId?: number;
  match?: string;
  text?: string;
}): {
  from: { id: number };
  reply: ReturnType<typeof vi.fn>;
  replyWithChatAction: ReturnType<typeof vi.fn>;
  match: string | undefined;
  message: { text: string };
} {
  return {
    from: { id: overrides?.fromId ?? 999 },
    reply: vi.fn(async () => undefined),
    replyWithChatAction: vi.fn(async () => undefined),
    match: overrides?.match,
    message: { text: overrides?.text ?? "" },
  };
}

/** Access a private command handler on the bot, bound so `this` resolves. */
function handler(name: string): (c: unknown) => Promise<void> {
  const b = bot as unknown as Record<string, (c: unknown) => Promise<void>>;
  return b[name].bind(bot);
}

beforeEach(() => fresh());
afterEach(() => mem?.close());

describe("AI_TOOLS", () => {
  it("declares the 20 tools with unique names", () => {
    expect(AI_TOOLS).toHaveLength(20);
    const names = AI_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(20);
    for (const n of names) expect(AI_TOOL_NAMES.has(n)).toBe(true);
    // The XT reference tool set, in order.
    expect(names).toEqual([
      "get_status", "get_pnl", "set_symbol", "set_leverage", "set_margin_mode",
      "set_timeframes", "set_margin_amount_pct", "set_margin_risk_pct",
      "set_min_confidence", "set_cooldown_minutes", "set_position_mode",
      "set_max_loss_pct", "set_max_profit_pct", "get_balance",
      "get_contract_info", "scan_signals", "open_trade", "close_trade",
      "close_all_trades", "mid_manage",
    ]);
  });

  it("every tool schema carries Toobit futures conventions", () => {
    const symbol = AI_TOOLS.find((t) => t.name === "set_symbol")!;
    const props = symbol.parameters.properties as Record<string, { description?: string }>;
    expect(props.symbol?.description).toContain("BTC-SWAP-USDT");
    const margin = AI_TOOLS.find((t) => t.name === "set_margin_mode")!;
    expect(JSON.stringify(margin.parameters)).toContain("CROSSED");
    expect(JSON.stringify(margin.parameters)).toContain("ISOLATED");
  });
});

describe("AIChat tool execution (the function-calling seam)", () => {
  it("routes every handler name to a trader/scanner/risk call", async () => {
    // get_status + get_pnl read memory/trader.
    const status = await ai.execute_function("get_status", {});
    expect(status).toMatch(/settings|Leverage|symbol/i);
    const pnl = await ai.execute_function("get_pnl", {});
    expect(pnl).toMatch(/Total PnL|Total Trades/);

    // Settings writes persist to memory.
    const r = await ai.execute_function("set_timeframes", { timeframes: "5m,15m" });
    expect(r).toMatch(/Timeframes set/);
    expect(mem.get_setting("timeframes")).toBe("5m,15m");
    await ai.execute_function("set_leverage", { leverage: 20 });
    expect(mem.get_setting("leverage")).toBe("20");
    await ai.execute_function("set_margin_mode", { mode: "ISOLATED" });
    expect(mem.get_setting("margin_mode")).toBe("ISOLATED");
    await ai.execute_function("set_position_mode", { mode: "risk" });
    expect(mem.get_setting("position_mode")).toBe("risk");

    // Validation paths.
    expect(await ai.execute_function("set_margin_mode", { mode: "nope" })).toMatch(/Invalid margin mode/);
    expect(await ai.execute_function("set_timeframes", { timeframes: "7m" })).toMatch(/Invalid timeframes/);

    // Balance + contract info hit the mock exchange through the risk manager.
    const balance = await ai.execute_function("get_balance", {});
    expect(balance).toMatch(/Wallet: 10000/);
    const info = await ai.execute_function("get_contract_info", {});
    expect(info).toContain(SYMBOL);
    expect(info).toMatch(/Contract size/);

    // scan_signals returns a formatted report.
    const sig = await ai.execute_function("scan_signals", {});
    expect(sig).toMatch(/No signal|SIGNAL|Scan/i);
  });

  it("open_trade resolves through the full mock trade lifecycle", async () => {
    // Feed 5m klines that produce a LONG consensus at the default confidence gate.
    mock.klines[`${SYMBOL}:5m`] = Array.from({ length: 68 }, (_, i) => {
      const close = i < 60 ? 200 - i : 140 + (i - 60) * 3;
      return candle(close, i * 5 * 60 * 1000, close - 1, close + 2, close - 2, 1000 + i * 5);
    });
    mem.set_setting("timeframes", "5m");

    const out = await ai.execute_function("open_trade", { direction: "LONG" });
    expect(out).not.toMatch(/Cannot|rejected|does not support/i);
    expect(mem.get_open_trades()).toHaveLength(1);
    expect(mem.get_open_trades()[0].position_side).toBe("LONG");

    // close_trade then close_all_trades clean up.
    const id = mem.get_open_trades()[0].id;
    const closed = await ai.execute_function("close_trade", { trade_id: id });
    expect(closed).toMatch(/Closed trade|closed/i);
    expect(mem.get_open_trades()).toHaveLength(0);
  }, 15000);

  it("executes every handler in the map without throwing", async () => {
    const calls: Record<string, unknown[]> = {};
    const names = Object.keys((ai as unknown as { _handler_map(): Record<string, unknown> })._handler_map());
    // All 20 names are present in the map.
    expect(names).toHaveLength(20);
    for (const name of AI_TOOLS.map((t) => t.name)) {
      const args: Record<string, unknown> =
        name === "set_symbol" ? { symbol: SYMBOL } :
        name === "set_leverage" ? { leverage: 10 } :
        name === "set_margin_mode" ? { mode: "CROSSED" } :
        name === "set_timeframes" ? { timeframes: "15m" } :
        name === "set_margin_amount_pct" ? { pct: 20 } :
        name === "set_margin_risk_pct" ? { pct: 1 } :
        name === "set_min_confidence" ? { confidence: 80 } :
        name === "set_cooldown_minutes" ? { minutes: 5 } :
        name === "set_position_mode" ? { mode: "margin" } :
        name === "set_max_loss_pct" ? { pct: 40 } :
        name === "set_max_profit_pct" ? { pct: 500 } :
        name === "get_contract_info" ? {} :
        name === "open_trade" ? { direction: "LONG" } :
        name === "close_trade" ? { trade_id: 1 } :
        {};
      const out = await ai.execute_function(name, args);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
      calls[name] = [out];
    }
    expect(Object.keys(calls).sort()).toEqual(names.sort());
  }, 15000);
});

describe("TelegramBot command routing", () => {
  it("wires all 17 command handlers plus free-text into grammY", () => {
    const registered = bot.registeredHandlers;
    const expected = [
      "start", "pnl", "status", "balance", "autotrade_on", "autotrade_off",
      "signal", "settings", "check_ai", "timeframes", "margin_amount_pct",
      "margin_risk_pct", "close", "diag", "sync", "protect", "midmanage",
      "__free_text__",
    ];
    expect([...registered].sort()).toEqual([...expected].sort());
    expect(registered).toHaveLength(18);
  });

  it("rejects unauthorized users on every gated command", async () => {
    const ctx = fakeCtx({ fromId: 111 });
    for (const name of [
      "cmd_start", "cmd_pnl", "cmd_status", "cmd_timeframes", "cmd_balance", "cmd_close",
    ]) {
      const reply = vi.fn(async () => undefined);
      await handler(name)({ ...ctx, reply });
      expect(reply).toHaveBeenCalledWith("Unauthorized.");
    }
    // Nothing was changed in memory by the unauthorized calls.
    expect(mem.get_all_settings().timeframes).toBe("15m");
  });

  it("timeframes handler validates and persists", async () => {
    // No args → shows current.
    const show = fakeCtx();
    await handler("cmd_timeframes")(show);
    expect(show.reply).toHaveBeenCalledWith(expect.stringContaining("Current timeframes: 15m"));

    // Valid comma list → persists.
    const set = fakeCtx({ match: "5m,15m,1h" });
    await handler("cmd_timeframes")(set);
    expect(mem.get_setting("timeframes")).toBe("5m,15m,1h");
    expect(set.reply).toHaveBeenCalledWith("Timeframes set to: 5m, 15m, 1h");

    // Invalid → rejected, nothing persisted.
    const bad = fakeCtx({ match: "7m" });
    await handler("cmd_timeframes")(bad);
    expect(bad.reply).toHaveBeenCalledWith(expect.stringContaining("Invalid timeframes"));
    expect(mem.get_setting("timeframes")).toBe("5m,15m,1h");
  });

  it("margin handlers clamp and persist", async () => {
    const amount = fakeCtx({ match: "10" });
    await handler("cmd_margin_amount_pct")(amount);
    expect(mem.get_setting("margin_amount_pct")).toBe("10");

    // Out-of-range clamps to the [1,100] bound.
    const huge = fakeCtx({ match: "500" });
    await handler("cmd_margin_amount_pct")(huge);
    expect(mem.get_setting("margin_amount_pct")).toBe("100");

    const riskSet = fakeCtx({ match: "1.5" });
    await handler("cmd_margin_risk_pct")(riskSet);
    expect(mem.get_setting("margin_risk_pct")).toBe("1.5");
  });

  it("pnl, balance and close route to memory/exchange", async () => {
    const pnl = fakeCtx();
    await handler("cmd_pnl")(pnl);
    expect(pnl.reply).toHaveBeenCalledWith(expect.stringContaining("PNL Summary"));
    expect(pnl.reply).toHaveBeenCalledWith(expect.stringContaining("Total PnL: 0.0000"));

    const bal = fakeCtx();
    await handler("cmd_balance")(bal);
    expect(bal.reply).toHaveBeenCalledWith(expect.stringContaining("BALANCE (USDT)"));
    expect(bal.reply).toHaveBeenCalledWith(expect.stringContaining("Wallet: 10000.0000"));

    // /close with no args → close_all_positions (nothing open).
    const closeAll = fakeCtx();
    await handler("cmd_close")(closeAll);
    expect(closeAll.reply).toHaveBeenCalledWith("No open positions to close.");

    // /close with an unknown id → clear message, no crash.
    const closeOne = fakeCtx({ match: "999" });
    await handler("cmd_close")(closeOne);
    expect(closeOne.reply).toHaveBeenCalledWith("Trade ID 999 not found.");
  });

  it("splits long messages at 4000 chars", () => {
    const text = "x".repeat(9500);
    const chunks = _split_message(text);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(4000);
    expect(chunks[2].length).toBe(1500);
    expect(chunks.join("")).toBe(text);
    expect(_split_message("short")).toEqual(["short"]);
  });

  it("wires the trader notify callback to the bot API (hermetic dead port)", async () => {
    const cb = (trader as unknown as { _notifyCallback: ((m: string) => void) | null })._notifyCallback;
    expect(cb).not.toBeNull();
    // Firing it must not throw; the API call goes to the dead apiRoot and is
    // swallowed by the .catch handler. Give the rejection a tick to land.
    expect(() => trader._notify("test notification")).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("memory-backed AI context", () => {
  it("remember/recall round-trips through ai_context", () => {
    ai.remember("fav_symbol", "ETH-SWAP-USDT");
    expect(ai.recall("fav_symbol")).toBe("ETH-SWAP-USDT");
    const all = ai.recall() as Record<string, string>;
    expect(all.fav_symbol).toBe("ETH-SWAP-USDT");
  });
});
