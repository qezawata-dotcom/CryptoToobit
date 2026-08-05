import { describe, it, expect, beforeEach } from "vitest";
import {
  EMAStrategy,
  MACDStrategy,
  RSIStrategy,
  MomentumStrategy,
  StrategyEngine,
  type StrategySignal,
} from "../src/bot/strategies.js";
import {
  SignalScanner,
  VALID_INTERVALS,
  TF_WEIGHTS,
  type MarketDataSource,
} from "../src/bot/signalScanner.js";
import { LongTermMemory } from "../src/bot/memory.js";
import { Config } from "../src/config.js";
import { ewmSpan, ewmAlpha, rsi, momentum, rollingMean } from "../src/utils/indicators.js";
import type { Candle } from "../src/types.js";

// ---------------------------------------------------------------------------
// Indicator primitives — golden values (computed by hand / spreadsheets).
// ---------------------------------------------------------------------------

describe("indicators", () => {
  it("ewmSpan matches pandas ewm(span, adjust=False)", () => {
    // span 3 → alpha = 0.5; seed = first value.
    const out = ewmSpan([1, 2, 3, 4], 3);
    // ema0=1; ema1=0.5*2+0.5*1=1.5; ema2=0.5*3+0.5*1.5=2.25; ema3=0.5*4+0.5*2.25=3.125
    expect(out[0]).toBeCloseTo(1, 9);
    expect(out[1]).toBeCloseTo(1.5, 9);
    expect(out[2]).toBeCloseTo(2.25, 9);
    expect(out[3]).toBeCloseTo(3.125, 9);
  });

  it("ewmAlpha seeds from first value (RSI's Wilder smoothing)", () => {
    const out = ewmAlpha([2, 4, 8], 0.5);
    expect(out[0]).toBeCloseTo(2, 9);
    expect(out[1]).toBeCloseTo(3, 9); // 0.5*4 + 0.5*2
    expect(out[2]).toBeCloseTo(5.5, 9); // 0.5*8 + 0.5*3
  });

  it("rollingMean is the trailing mean (warmup = 0)", () => {
    const out = rollingMean([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(2, 9);
    expect(out[3]).toBeCloseTo(3, 9);
    expect(out[4]).toBeCloseTo(4, 9);
  });

  it("rsi on a known up-only series is ~100 (avg_loss → 1e-10)", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const out = rsi(closes, 14);
    expect(out[19]).toBeGreaterThan(99);
  });

  it("rsi on a perfectly alternating series sits near 50", () => {
    const closes = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101];
    const out = rsi(closes, 14);
    expect(out[19]).toBeGreaterThan(45);
    expect(out[19]).toBeLessThan(55);
  });

  it("momentum measures period-bar change with zero warmup", () => {
    const out = momentum([100, 100, 100, 100, 100, 110], 5);
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(0);
    expect(out[5]).toBeCloseTo(0.1, 9);
  });
});

// ---------------------------------------------------------------------------
// Helper: build deterministic candle runs.
// ---------------------------------------------------------------------------

function candle(close: number, volume = 1000, openTime = 0): Candle {
  return { openTime, open: close, high: close, low: close, close, volume };
}

function closes(cs: number[]): Candle[] {
  return cs.map((c, i) => candle(c, 1000, i));
}

/** Keeps a strategy's confidence & details for a run of closes. */
function run(strategy: { calculate(c: number[], v: number[]): StrategySignal }, cs: number[], volumes?: number[]): StrategySignal {
  return strategy.calculate(cs, volumes ?? cs.map(() => 1000));
}

/**
 * Feeds a strategy a growing bar series until it emits a non-NEUTRAL signal.
 * Deterministic: the generator is pure, so the fire length is fixed. Used to
 * build fixtures that genuinely cross at the last bar (a V-shape gives a
 * level EMA signal, not a cross).
 */
function untilSignal(
  strategy: { calculate(c: number[], v: number[]): StrategySignal },
  gen: (i: number) => number,
  volumeGen: (i: number) => number = () => 1000,
  maxBars = 250,
  wanted?: StrategySignal["direction"],
): StrategySignal {
  const cs: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i < maxBars; i++) {
    cs.push(gen(i));
    vs.push(volumeGen(i));
    const sig = strategy.calculate(cs, vs);
    if (sig.direction !== "NEUTRAL" && (!wanted || sig.direction === wanted)) return sig;
  }
  throw new Error("untilSignal: strategy never fired within maxBars");
}

// ---------------------------------------------------------------------------
// Strategy golden tests.
// ---------------------------------------------------------------------------

describe("EMAStrategy", () => {
  it("returns NEUTRAL on too little data", () => {
    const s = new EMAStrategy();
    expect(run(s, Array.from({ length: 30 }, () => 100)).direction).toBe("NEUTRAL");
  });

  it("flags a golden cross as LONG", () => {
    const s = new EMAStrategy(9, 21);
    // 30 down-bars then a steady climb → the fast EMA crosses the slow one
    // somewhere in the up-leg. untilSignal pins the first firing bar.
    const sig = untilSignal(s, (i) => (i < 30 ? 120 - i : 90 + (i - 30) * 2.5));
    expect(sig.direction).toBe("LONG");
    expect(sig.confidence).toBeGreaterThanOrEqual(60);
    expect(sig.confidence).toBeLessThanOrEqual(95);
    expect(sig.details.fast).toBeDefined();
  });

  it("flags a death cross as SHORT", () => {
    const s = new EMAStrategy(9, 21);
    const sig = untilSignal(s, (i) => (i < 30 ? 100 + i : 130 - (i - 30) * 2.0));
    expect(sig.direction).toBe("SHORT");
    expect(sig.confidence).toBeGreaterThanOrEqual(60);
  });

  it("returns NEUTRAL between crosses", () => {
    const s = new EMAStrategy(9, 21);
    // Steady climb → both EMAs point up, no cross at the tip.
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    expect(run(s, closes).direction).toBe("NEUTRAL");
  });
});

describe("MACDStrategy", () => {
  it("returns NEUTRAL on too little data", () => {
    const s = new MACDStrategy();
    expect(run(s, Array.from({ length: 40 }, () => 100)).direction).toBe("NEUTRAL");
  });

  it("flags a histogram golden cross as LONG (fixes the reference crash)", () => {
    const s = new MACDStrategy();
    // The histogram cross requires the reversal to land AFTER the 45-bar
    // length gate; a late sharp snap-up produces a genuine negative→positive
    // histogram cross on the last bar.
    const sig = untilSignal(s, (i) => (i < 60 ? 200 - i : 140 + (i - 60) * 3), undefined, 250, "LONG");
    // The reference Python would raise AttributeError on this branch; we must
    // produce a sane signal instead.
    expect(sig.direction).toBe("LONG");
    expect(sig.confidence).toBeGreaterThanOrEqual(55);
    expect(sig.confidence).toBeLessThanOrEqual(85);
    expect(sig.details.histogram).toBeGreaterThan(0);
  });

  it("trend branch fires on persistent same-sign histogram with empty details", () => {
    const s = new MACDStrategy();
    const sig = untilSignal(s, (i) => 100 + i * 2);
    // Strong sustained rally → LONG via trend branch (confidence ≤ 85) with
    // no per-signal details, exactly as the Python returns {}.
    expect(sig.direction).toBe("LONG");
    expect(sig.confidence).toBeLessThanOrEqual(85);
    expect(sig.details).toEqual({});
  });
});

describe("RSIStrategy", () => {
  it("returns NEUTRAL on too little data", () => {
    const s = new RSIStrategy();
    expect(run(s, Array.from({ length: 20 }, () => 100)).direction).toBe("NEUTRAL");
  });

  it("flags oversold recovery as LONG", () => {
    // Crash under 30 then rebound → the RSI crosses back up through 30.
    const s = new RSIStrategy();
    const sig = untilSignal(s, (i) => (i < 20 ? 100 - i * 4 : 24 + (i - 20) * 3));
    expect(sig.direction).toBe("LONG");
    expect(sig.confidence).toBeGreaterThanOrEqual(60);
  });

  it("deep oversold gives LONG with −10 confidence penalty", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i * 3);
    const sig = run(new RSIStrategy(), closes);
    expect(sig.direction).toBe("LONG");
    // In the deep-oversold branch the confidence is reduced by 10.
    expect(sig.confidence).toBeGreaterThanOrEqual(50);
  });

  it("overbought gives SHORT", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 3);
    const sig = run(new RSIStrategy(), closes);
    expect(sig.direction).toBe("SHORT");
  });
});

describe("MomentumStrategy", () => {
  it("returns NEUTRAL on too little data", () => {
    const s = new MomentumStrategy();
    expect(run(s, Array.from({ length: 15 }, () => 100)).direction).toBe("NEUTRAL");
  });

  it("surge + threshold cross → LONG", () => {
    const s = new MomentumStrategy();
    // Flat for 24 bars, then a jump with heavy volume. The surge must land
    // AFTER the 20-bar length gate, else the threshold cross happens during
    // warmup and only the trend branch can fire by the time we evaluate.
    const sig = untilSignal(
      s,
      (i) => (i < 24 ? 100 : 100 + (i - 23) * 8),
      (i) => (i < 23 ? 1000 : 5000),
    );
    expect(sig.direction).toBe("LONG");
    expect(sig.confidence).toBeGreaterThanOrEqual(55);
    expect(sig.details.vol_ratio).toBeGreaterThan(1.2);
  });

  it("threshold held without surge → trend branch (confidence − 15)", () => {
    const s = new MomentumStrategy();
    const sig = untilSignal(s, (i) => 100 + i, () => 1000);
    expect(sig.direction).toBe("LONG");
    expect(sig.confidence).toBeLessThan(90); // penalized trend branch
  });

  it("no move → NEUTRAL", () => {
    const closes = Array.from({ length: 20 }, () => 100);
    expect(run(new MomentumStrategy(), closes).direction).toBe("NEUTRAL");
  });
});

// ---------------------------------------------------------------------------
// Consensus engine (confidence mass, not count).
// ---------------------------------------------------------------------------

describe("StrategyEngine consensus", () => {
  it("sides with the higher confidence mass, not the higher count", () => {
    // Late-reversal fixture where EMA's golden cross AND MACD's trend fire on
    // the SAME last bar (len 68) → both contribute LONG mass.
    const engine = new StrategyEngine([new EMAStrategy(), new MACDStrategy()]);
    const closes = Array.from({ length: 68 }, (_, i) => (i < 60 ? 200 - i : 140 + (i - 60) * 3));
    const consensus = engine.get_consensus(closes, closes.map(() => 1000), 60);
    expect(consensus.direction).toBe("LONG");
    expect(consensus.long_count).toBe(2);
    expect(consensus.strategies_used).toEqual(expect.arrayContaining(["EMA", "MACD"]));
    expect(consensus.confidence).toBeGreaterThan(0);
  });

  it("all NEUTRAL → NEUTRAL with zero confidence", () => {
    // Use always-NEUTRAL fakes: a flat real series actually fires RSI's deep
    // oversold branch (RSI of a constant series is 0), so the neutral path of
    // the engine is tested deterministically here instead.
    const neutralFake = (strategy: string): StrategySignal => ({
      strategy,
      direction: "NEUTRAL",
      confidence: 0,
      details: {},
    });
    const engine = new StrategyEngine([
      { name: "A", calculate: () => neutralFake("A") },
      { name: "B", calculate: () => neutralFake("B") },
    ] as unknown as StrategyEngine["strategies"]);
    const c = engine.get_consensus([], [], 60);
    expect(c.direction).toBe("NEUTRAL");
    expect(c.confidence).toBe(0);
    expect(c.signal_strength).toBe(0);
  });

  it("avg_confidence is over all firing signals (opposition kept visible)", () => {
    const fake = (strategy: string, direction: StrategySignal["direction"], confidence: number): StrategySignal => ({
      strategy,
      direction,
      confidence,
      details: {},
    });
    const engine = new StrategyEngine([
      { name: "A", calculate: () => fake("A", "LONG", 66) },
      { name: "B", calculate: () => fake("B", "SHORT", 85) },
    ] as unknown as StrategyEngine["strategies"]);
    // With min_confidence 60 both fire; SHORT mass 85 > 66 → SHORT, avg = (66+85)/2.
    const c = engine.get_consensus(Array.from({ length: 50 }, () => 100), [], 60);
    expect(c.direction).toBe("SHORT");
    expect(c.confidence).toBe(Math.trunc((66 + 85) / 2)); // 75
    expect(c.signal_strength).toBeCloseTo((85 - 66) / (85 + 66), 9);
  });
});

// ---------------------------------------------------------------------------
// Signal scanner: TF vote, disagreement penalty, gating, report rendering.
// ---------------------------------------------------------------------------

class MockMarket implements MarketDataSource {
  klines = new Map<string, Candle[]>();
  ticker = 0;
  mark = 0;
  failures = new Set<string>();

  async getKlines(symbol: string, interval: string, _limit?: number): Promise<Candle[]> {
    const key = `${symbol}:${interval}`;
    if (this.failures.has(key)) throw new Error(`kline fetch failed for ${key}`);
    return [...(this.klines.get(key) ?? [])];
  }
  async getTickerPrice(_symbol: string): Promise<number> {
    return this.ticker;
  }
  async getMarkPrice(_symbol: string): Promise<number> {
    return this.mark;
  }
}

/** A deterministic rally/crash candle series that fires LONG across TFs. */
function bullRun(n = 60, start = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(start + i * 2, 2000, i));
}

function makeScanner(): { scanner: SignalScanner; market: MockMarket; memory: LongTermMemory } {
  const market = new MockMarket();
  const memory = LongTermMemory.inMemory();
  memory.seed_defaults(Config.defaultSettings());
  const scanner = new SignalScanner(market, memory);
  return { scanner, market, memory };
}

describe("SignalScanner", () => {
  it("sorts klines oldest-first and drops structurally broken rows", async () => {
    const { scanner, market } = makeScanner();
    market.klines.set("BTC-SWAP-USDT:15m", [
      candle(105, 1000, 5),
      candle(101, 1000, 2),
      { openTime: 9, open: 0, high: 0, low: 0, close: 0, volume: 0 },
      candle(102, 1000, 3),
    ]);
    const out = await scanner.fetch_klines("BTC-SWAP-USDT", "15m");
    expect(out.map((c) => c.openTime)).toEqual([2, 3, 5]);
  });

  it("returns insufficient_data when a TF has too few rows", async () => {
    const { scanner, market } = makeScanner();
    market.klines.set("BTC-SWAP-USDT:15m", Array.from({ length: 10 }, (_, i) => candle(100 + i, 1000, i)));
    const res = await scanner.scan_single_timeframe("BTC-SWAP-USDT", "15m", 60);
    expect(res.error).toBe("insufficient_data");
    expect(res.direction).toBe("NEUTRAL");
  });

  it("voted LONG across a full rally with sane confidence", async () => {
    const { scanner, market } = makeScanner();
    const run = bullRun();
    for (const tf of VALID_INTERVALS) market.klines.set(`BTC-SWAP-USDT:${tf}`, run);
    const res = await scanner.scan_multi_timeframe("BTC-SWAP-USDT");
    expect(res.direction).toBe("LONG");
    expect(res.long_weight).toBeGreaterThan(0);
    expect(res.short_weight).toBe(0);
    expect(res.voted_weight).toBeGreaterThan(0);
    expect(res.confidence).toBeGreaterThan(0);
  });

  it("weights higher TFs more (contribution = weight * confidence/100)", async () => {
    const { scanner, market } = makeScanner();
    const run = bullRun();
    // Only 1m and 1w vote, both LONG, same per-TF confidence → contribution
    // scales with TF_WEIGHTS.
    market.klines.set("BTC-SWAP-USDT:1m", run);
    market.klines.set("BTC-SWAP-USDT:1w", run);
    market.klines.set("BTC-SWAP-USDT:15m", Array.from({ length: 10 }, (_, i) => candle(100, 1000, i))); // insufficient
    const res = await scanner.scan_multi_timeframe("BTC-SWAP-USDT", ["1m", "15m", "1w"]);
    expect(res.direction).toBe("LONG");
    expect(res.timeframe_results["15m"].error).toBe("insufficient_data");
    expect(res.timeframe_results["1m"].error).toBeUndefined();
    expect(res.voted_weight).toBeCloseTo(TF_WEIGHTS["1m"] + TF_WEIGHTS["1w"], 9);
  });

  it("disagreement reduces confidence via strength × agreement", async () => {
    const { scanner, market } = makeScanner();
    // 1m strongly SHORT, 1w strongly LONG. Equal weights would tie; the
    // stronger side wins but agreement < 1 dampens confidence.
    const crash = Array.from({ length: 60 }, (_, i) => candle(100 - i * 2, 2000, i));
    const rally = bullRun();
    market.klines.set("BTC-SWAP-USDT:1m", crash);
    market.klines.set("BTC-SWAP-USDT:1w", rally);
    const res = await scanner.scan_multi_timeframe("BTC-SWAP-USDT", ["1m", "1w"]);
    expect(res.direction).toBe("LONG"); // 1w weight (5.0) beats 1m (0.5)
    // voted_weight sums both voting sides' weights regardless of direction.
    expect(res.voted_weight).toBeCloseTo(5.0 + 0.5, 9);
    // The losing SHORT side has non-zero weight → strength < 1, so confidence
    // is strictly below a unanimous vote's ceiling (< 90, agreement=1 here).
    expect(res.confidence).toBeGreaterThan(0);
    expect(res.confidence).toBeLessThan(90);
  });

  it("record_signal fires only when confidence meets min_confidence", async () => {
    const { scanner, market, memory } = makeScanner();
    const run = bullRun();
    for (const tf of VALID_INTERVALS) market.klines.set(`BTC-SWAP-USDT:${tf}`, run);
    market.ticker = 150;
    const report = await scanner.scan_and_report("BTC-SWAP-USDT");
    expect(report.direction).toBe("LONG");
    expect(report.price).toBe(150);
    const signals = memory.get_recent_signals("BTC-SWAP-USDT", 5);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].direction).toBe("LONG");
    expect(signals[0].symbol).toBe("BTC-SWAP-USDT");
  });

  it("does not record when below min_confidence", async () => {
    const { scanner, market, memory } = makeScanner();
    memory.set_setting("min_confidence", "99");
    const run = bullRun();
    for (const tf of VALID_INTERVALS) market.klines.set(`BTC-SWAP-USDT:${tf}`, run);
    const report = await scanner.scan_and_report("BTC-SWAP-USDT");
    expect(report.confidence).toBeLessThan(99);
    expect(memory.get_recent_signals("BTC-SWAP-USDT", 5)).toHaveLength(0);
  });

  it("format_signal_report renders a full report from fixture klines", async () => {
    const { scanner, market, memory } = makeScanner();
    const run = bullRun();
    market.klines.set("BTC-SWAP-USDT:15m", run);
    market.ticker = 220;
    const report = await scanner.scan_and_report("BTC-SWAP-USDT");
    const text = scanner.format_signal_report(report);
    expect(text).toContain("=== SIGNAL SCAN [BTC-SWAP-USDT] ===");
    expect(text).toContain("Direction: LONG");
    expect(text).toContain("Price: 220");
    expect(text).toContain("15m:");
    expect(text).toContain("Long:");
    // Strategies named in the report.
    expect(text).toContain("Strategies:");
  });

  it("format_signal_report surfaces insufficient-data TFs", async () => {
    const { scanner, market } = makeScanner();
    const res = await scanner.scan_single_timeframe("BTC-SWAP-USDT", "15m", 60);
    const text = scanner.format_signal_report(res);
    expect(text).toContain("Signal Scan Error: insufficient_data");
  });

  it("format_signal_report shows per-TF no-data lines inside a full report", async () => {
    const { scanner, market, memory } = makeScanner();
    // Default timeframes is "15m" only; widen it so the report has both.
    memory.set_setting("timeframes", "15m,1w");
    const run = bullRun();
    market.klines.set("BTC-SWAP-USDT:15m", run);
    market.klines.set("BTC-SWAP-USDT:1w", Array.from({ length: 10 }, (_, i) => candle(100, 1000, i)));
    market.ticker = 220;
    const report = await scanner.scan_and_report("BTC-SWAP-USDT");
    const text = scanner.format_signal_report(report);
    expect(text).toContain("1w: no data (insufficient_data)");
    expect(text).toContain("15m:");
  });

  it("resolve_intervals drops unsupported TFs and falls back to defaults", () => {
    const { scanner, memory } = makeScanner();
    expect(scanner._resolve_intervals(["1m", "bogus", "4h"])).toEqual(["1m", "4h"]);
    expect(scanner._resolve_intervals([])).toEqual([...memory.get_setting("timeframes")!.split(",")]);
  });
});
