import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { Candle, Direction } from "../types.js";
import { LongTermMemory } from "./memory.js";
import { StrategyEngine, type Consensus } from "./strategies.js";
import { fmtNumber } from "../utils/format.js";

/**
 * Multi-timeframe signal scanner — a port of CryptoMind-XT/bot/signal_scanner.py.
 *
 * Pipeline: fetch klines per timeframe → per-TF consensus (confidence mass,
 * gated at tf_min_confidence) → weighted vote across timeframes where
 *   contribution = TF_WEIGHT[tf] * (confidence/100)
 *   strength     = (winner − loser) / voted_weight
 *   agreement    = voted_weight / Σ TF_WEIGHT[all configured TFs]
 *   confidence   = int(strength × agreement × 100)
 *
 * Note the per-TF gate (tf_min_confidence) differs from the overall trade gate
 * (min_confidence) — mirroring the Python comment that reusing one value
 * "double-penalised every signal".
 */

export const VALID_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"];

export const TF_WEIGHTS: Record<string, number> = {
  "1m": 0.5,
  "3m": 0.8,
  "5m": 1.0,
  "15m": 1.5,
  "30m": 2.0,
  "1h": 2.5,
  "2h": 2.8,
  "4h": 3.0,
  "1d": 4.0,
  "1w": 5.0,
};

/** Data access the scanner needs. ToobitClient implements this; tests mock it. */
export interface MarketDataSource {
  /** Klines for an interval, arbitrary order — the scanner sorts ascending. */
  getKlines(symbol: string, interval: string, limit?: number): Promise<Candle[]>;
  /** Last traded price, 0 if unavailable. */
  getTickerPrice(symbol: string): Promise<number>;
  /** Mark price, 0 if unavailable. */
  getMarkPrice(symbol: string): Promise<number>;
}

export type TimeframeResult = Consensus & { error?: string };

export type MultiTimeframeResult = {
  direction: Direction;
  confidence: number;
  signal_strength: number;
  strategies_used: string[];
  timeframe_results: Record<string, TimeframeResult>;
  long_weight: number;
  short_weight: number;
  voted_weight: number;
};

export type ScanReport = MultiTimeframeResult & {
  symbol: string;
  price: number;
  timestamp: number;
};

const MIN_ROWS_PER_TIMEFRAME = 40;

export class SignalScanner {
  private engine = new StrategyEngine();

  constructor(
    private market: MarketDataSource,
    private memory: LongTermMemory,
  ) {}

  async fetch_klines(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
    let rows: Candle[];
    try {
      rows = await this.market.getKlines(symbol, interval, Math.min(limit, 1500));
    } catch (error) {
      logger.warn({ symbol, interval, err: String(error) }, "Kline fetch failed");
      return [];
    }
    if (!rows || rows.length === 0) return [];
    // Strategies assume oldest-first (Toobit may return newest-first).
    const sorted = [...rows].sort((a, b) => a.openTime - b.openTime);
    // Drop rows missing OHLC (defensive — normalize fills 0, so this only
    // trips on structurally broken payloads).
    const valid = sorted.filter(
      (c) => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0,
    );
    return valid;
  }

  async get_current_price(symbol: string): Promise<number> {
    try {
      const price = await this.market.getTickerPrice(symbol);
      if (price > 0) return price;
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "ticker failed");
    }
    try {
      return await this.market.getMarkPrice(symbol);
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "mark-price failed");
    }
    return 0;
  }

  async get_mark_price(symbol: string): Promise<number> {
    try {
      return await this.market.getMarkPrice(symbol);
    } catch {
      return 0;
    }
  }

  async scan_single_timeframe(symbol: string, interval: string, min_confidence: number): Promise<TimeframeResult> {
    const candles = await this.fetch_klines(symbol, interval);
    if (candles.length < MIN_ROWS_PER_TIMEFRAME) {
      return {
        direction: "NEUTRAL",
        confidence: 0,
        signal_strength: 0,
        strategies_used: [],
        all_signals: [],
        long_count: 0,
        short_count: 0,
        error: "insufficient_data",
      };
    }
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    return this.engine.get_consensus(closes, volumes, min_confidence);
  }

  _resolve_intervals(intervals?: string | string[]): string[] {
    let list: string[];
    if (intervals) {
      list = Array.isArray(intervals) ? intervals : intervals.split(",");
    } else {
      const stored = this.memory.get_setting("timeframes");
      list = stored ? stored.split(",") : Config.DEFAULT_TIMEFRAMES;
    }
    const out: string[] = [];
    for (const tf of list) {
      const t = tf.trim().toLowerCase();
      if (VALID_INTERVALS.includes(t)) {
        out.push(t);
      } else if (t) {
        logger.warn(`Dropping unsupported timeframe: ${t}`);
      }
    }
    return out.length ? out : [...Config.DEFAULT_TIMEFRAMES];
  }

  async scan_multi_timeframe(
    symbol: string,
    intervals?: string[],
    min_confidence?: number,
  ): Promise<MultiTimeframeResult> {
    if (min_confidence === undefined) {
      min_confidence = Number(this.memory.get_setting("min_confidence") ?? Config.MIN_CONFIDENCE);
    }
    const resolved = this._resolve_intervals(intervals);
    const tfMinConf = Number(this.memory.get_setting("tf_min_confidence") ?? Config.TF_MIN_CONFIDENCE);

    const timeframeResults: Record<string, TimeframeResult> = {};
    let longWeight = 0;
    let shortWeight = 0;
    let votedWeight = 0;
    const strategiesUsed = new Set<string>();

    for (const tf of resolved) {
      const result = await this.scan_single_timeframe(symbol, tf, tfMinConf);
      timeframeResults[tf] = result;
      const weight = TF_WEIGHTS[tf] ?? 1.0;
      if (result.direction === "NEUTRAL") continue;
      votedWeight += weight;
      const contribution = weight * (result.confidence / 100.0);
      if (result.direction === "LONG") longWeight += contribution;
      else shortWeight += contribution;
      for (const s of result.strategies_used ?? []) strategiesUsed.add(s);
    }

    let overall: Direction = "NEUTRAL";
    let strength = 0;
    let confidence = 0;
    // Normalise against the timeframes that produced a signal; penalise
    // disagreement instead of ignoring the losing side.
    if (votedWeight > 0 && longWeight !== shortWeight) {
      let winner: number, loser: number;
      if (longWeight > shortWeight) {
        overall = "LONG";
        winner = longWeight;
        loser = shortWeight;
      } else {
        overall = "SHORT";
        winner = shortWeight;
        loser = longWeight;
      }
      strength = (winner - loser) / votedWeight;
      const totalWeight = resolved.reduce((s, t) => s + (TF_WEIGHTS[t] ?? 1.0), 0);
      const agreement = totalWeight > 0 ? votedWeight / totalWeight : 0;
      confidence = Math.trunc(strength * agreement * 100);
    }

    return {
      direction: overall,
      confidence,
      signal_strength: strength,
      strategies_used: [...strategiesUsed].sort(),
      timeframe_results: timeframeResults,
      long_weight: longWeight,
      short_weight: shortWeight,
      voted_weight: votedWeight,
    };
  }

  async scan_and_report(symbol?: string): Promise<ScanReport> {
    const sym = symbol ?? this.memory.get_setting("symbol") ?? Config.DEFAULT_SYMBOL;
    const minConf = Number(this.memory.get_setting("min_confidence") ?? Config.MIN_CONFIDENCE);
    const intervals = this._resolve_intervals();
    const result = await this.scan_multi_timeframe(sym, intervals, minConf);
    const report: ScanReport = {
      ...result,
      symbol: sym,
      price: await this.get_current_price(sym),
      timestamp: Date.now() / 1000,
    };
    if (report.direction !== "NEUTRAL" && report.confidence >= minConf) {
      this.memory.record_signal({
        symbol: sym,
        direction: report.direction,
        strategy: report.strategies_used.join(",") || "MULTI",
        timeframe: intervals.join(","),
        confidence: report.confidence,
        signal_strength: report.signal_strength,
        price: report.price,
      });
    }
    return report;
  }

  format_signal_report(result: ScanReport | TimeframeResult): string {
    // A bare per-TF result that errored (insufficient data) renders as an
    // error line; a full ScanReport has timeframe_results and renders as a
    // multi-TF report. (The Python reference's `"direction" not in result`
    // guard was dead — insufficient_data results always carry a direction.)
    if ("error" in result && !("timeframe_results" in result)) {
      return `Signal Scan Error: ${result.error}`;
    }
    const any = result as Partial<ScanReport>;
    let report = `=== SIGNAL SCAN [${any.symbol ?? "N/A"}] ===\n`;
    report += `Direction: ${any.direction}\n`;
    report += `Confidence: ${any.confidence}%\n`;
    report += `Signal Strength: ${(any.signal_strength ?? 0).toFixed(2)}\n`;
    report += `Price: ${fmtNumber(any.price ?? 0)}\n`;
    if (any.strategies_used?.length) {
      report += `Strategies: ${any.strategies_used.join(", ")}\n`;
    }
    const gate = Number(this.memory.get_setting("tf_min_confidence") ?? Config.TF_MIN_CONFIDENCE);
    for (const [tf, r] of Object.entries(any.timeframe_results ?? {})) {
      if (r.error) {
        report += `  ${tf}: no data (${r.error})\n`;
        continue;
      }
      const fired: string[] = [];
      const belowGate: string[] = [];
      for (const s of r.all_signals ?? []) {
        if (s.direction === "NEUTRAL") continue;
        const entry = `${s.strategy}=${s.direction}(${s.confidence}%)`;
        (s.confidence < gate ? belowGate : fired).push(entry);
      }
      const parts: string[] = [];
      if (fired.length) parts.push(fired.join(", "));
      if (belowGate.length) parts.push(`below ${gate}% gate: ${belowGate.join(", ")}`);
      if (!parts.length) parts.push("no strategy fired");
      report += `  ${tf}: ${r.direction} (${r.confidence}%) [${parts.join(" | ")}]\n`;
    }
    report += `\nLong: ${(any.long_weight ?? 0).toFixed(2)} | Short: ${(any.short_weight ?? 0).toFixed(2)} | Voted: ${(any.voted_weight ?? 0).toFixed(2)}`;
    return report;
  }
}
