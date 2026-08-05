import { ewmSpan, rsi, momentum, rollingMean } from "../utils/indicators.js";
import type { Direction } from "../types.js";

/**
 * Signal strategies — a bit-for-bit port of CryptoMind-XT/bot/strategies.py.
 * Each strategy inspects the trailing two values of its indicator and returns
 * (direction, confidence, details). Confidence math, clamps and length gates
 * match the Python source exactly.
 *
 * One intentional deviation: Python MACDStrategy.calculate calls
 * `self._confidence(strength)` but never defines `_confidence`, so a histogram
 * crossover crashes with AttributeError in the reference. Here MACD defines
 * `_confidence` using the same formula the trend branch inlines
 * (`min(85, int(55 + strength))`), so a crossover yields a strong-but-capped
 * confidence instead of a crash.
 */

export type StrategySignal = {
  strategy: string;
  direction: Direction;
  confidence: number;
  /** Per-strategy indicator snapshot (fast/slow, macd/signal, rsi, momentum…). */
  details: Record<string, number>;
};

export type Consensus = {
  direction: Direction;
  confidence: number;
  signal_strength: number;
  strategies_used: string[];
  all_signals: StrategySignal[];
  long_count: number;
  short_count: number;
};

export interface StrategyBase {
  readonly name: string;
  calculate(closes: number[], volumes: number[]): StrategySignal;
}

function neutral(strategy: string): StrategySignal {
  return { strategy, direction: "NEUTRAL", confidence: 0, details: {} };
}

function clamp100(x: number): number {
  return Math.min(100, x);
}

/** EMA 9/21 — crossover of (ema_fast − ema_slow). */
export class EMAStrategy implements StrategyBase {
  readonly name = "EMA";
  constructor(
    public fast_period = 9,
    public slow_period = 21,
  ) {}

  calculate(closes: number[], _volumes: number[]): StrategySignal {
    if (closes.length < this.slow_period + 10) return neutral(this.name);
    const emaFast = ewmSpan(closes, this.fast_period);
    const emaSlow = ewmSpan(closes, this.slow_period);
    const last = closes.length - 1;
    const emaDiff = emaFast.map((f, i) => f - emaSlow[i]);
    const prevDiff = emaDiff[last - 1];
    const currDiff = emaDiff[last];

    if (prevDiff < 0 && currDiff > 0) {
      const strength = clamp100((Math.abs(currDiff) / closes[last]) * 10000);
      return {
        strategy: this.name,
        direction: "LONG",
        confidence: this._confidence(strength),
        details: { fast: emaFast[last], slow: emaSlow[last] },
      };
    }
    if (prevDiff > 0 && currDiff < 0) {
      const strength = clamp100((Math.abs(currDiff) / closes[last]) * 10000);
      return {
        strategy: this.name,
        direction: "SHORT",
        confidence: this._confidence(strength),
        details: { fast: emaFast[last], slow: emaSlow[last] },
      };
    }
    return neutral(this.name);
  }

  _confidence(strength: number): number {
    return Math.min(95, Math.trunc(60 + strength * 2));
  }
}

/** MACD 12/26/9 — histogram crossover + trend-following branch. */
export class MACDStrategy implements StrategyBase {
  readonly name = "MACD";
  constructor(
    public fast = 12,
    public slow = 26,
    public signal_period = 9,
  ) {}

  calculate(closes: number[], _volumes: number[]): StrategySignal {
    if (closes.length < this.slow + this.signal_period + 10) return neutral(this.name);
    const emaFast = ewmSpan(closes, this.fast);
    const emaSlow = ewmSpan(closes, this.slow);
    const last = closes.length - 1;
    const macd = emaFast.map((f, i) => f - emaSlow[i]);
    const signalLine = ewmSpan(macd, this.signal_period);
    const histogram = macd.map((m, i) => m - signalLine[i]);
    const prevHist = histogram[last - 1];
    const currHist = histogram[last];
    const close = closes[last];

    if (currHist > 0 && prevHist < 0) {
      const strength = clamp100((Math.abs(currHist) / Math.abs(close)) * 50000);
      return {
        strategy: this.name,
        direction: "LONG",
        confidence: this._confidence(strength),
        details: { macd: macd[last], signal: signalLine[last], histogram: currHist },
      };
    }
    if (currHist < 0 && prevHist > 0) {
      const strength = clamp100((Math.abs(currHist) / Math.abs(close)) * 50000);
      return {
        strategy: this.name,
        direction: "SHORT",
        confidence: this._confidence(strength),
        details: { macd: macd[last], signal: signalLine[last], histogram: currHist },
      };
    }
    // Same-sign histogram, MACD pushing in the trend direction → trend signal.
    if (currHist > 0 && prevHist > 0 && macd[last] > macd[last - 1]) {
      const trendStrength = (Math.abs(macd[last]) / Math.abs(close)) * 10000;
      return {
        strategy: this.name,
        direction: "LONG",
        confidence: Math.min(85, Math.trunc(55 + trendStrength)),
        details: {},
      };
    }
    if (currHist < 0 && prevHist < 0 && macd[last] < macd[last - 1]) {
      const trendStrength = (Math.abs(macd[last]) / Math.abs(close)) * 10000;
      return {
        strategy: this.name,
        direction: "SHORT",
        confidence: Math.min(85, Math.trunc(55 + trendStrength)),
        details: {},
      };
    }
    return neutral(this.name);
  }

  /** See module doc: Python reference omits this method (would crash). */
  _confidence(strength: number): number {
    return Math.min(85, Math.trunc(55 + strength));
  }
}

/** RSI 14 (Wilder) — 30/70 band crosses + deep overbought/oversold. */
export class RSIStrategy implements StrategyBase {
  readonly name = "RSI";
  constructor(
    public period = 14,
    public oversold = 30,
    public overbought = 70,
  ) {}

  calculate(closes: number[], _volumes: number[]): StrategySignal {
    if (closes.length < this.period + 10) return neutral(this.name);
    const values = rsi(closes, this.period);
    const last = values.length - 1;
    const prev = values[last - 1];
    const curr = values[last];

    if (prev < this.oversold && curr > this.oversold) {
      const strength = clamp100((curr - this.oversold) * 2);
      return {
        strategy: this.name,
        direction: "LONG",
        confidence: this._confidence(strength),
        details: { rsi: curr },
      };
    }
    if (prev > this.overbought && curr < this.overbought) {
      const strength = clamp100((this.overbought - curr) * 2);
      return {
        strategy: this.name,
        direction: "SHORT",
        confidence: this._confidence(strength),
        details: { rsi: curr },
      };
    }
    if (curr < this.oversold) {
      const strength = clamp100((this.oversold - curr) * 2);
      return {
        strategy: this.name,
        direction: "LONG",
        confidence: this._confidence(strength) - 10,
        details: { rsi: curr },
      };
    }
    if (curr > this.overbought) {
      const strength = clamp100((curr - this.overbought) * 2);
      return {
        strategy: this.name,
        direction: "SHORT",
        confidence: this._confidence(strength) - 10,
        details: { rsi: curr },
      };
    }
    return neutral(this.name);
  }

  _confidence(strength: number): number {
    return Math.min(90, Math.trunc(60 + strength * 1.5));
  }
}

/** Momentum 10 / 0.005 — threshold cross + 1.2× volume surge; trend branch. */
export class MomentumStrategy implements StrategyBase {
  readonly name = "MOMENTUM";
  constructor(
    public period = 10,
    public threshold = 0.005,
  ) {}

  calculate(closes: number[], volumes: number[]): StrategySignal {
    if (closes.length < this.period + 10) return neutral(this.name);
    const mom = momentum(closes, this.period);
    const volSma = rollingMean(volumes, this.period);
    const last = closes.length - 1;
    const currentVol = volumes[last];
    const avgVol = volSma[last];
    const volSurge = avgVol > 0 ? currentVol > avgVol * 1.2 : false;
    const currMom = mom[last];
    const prevMom = mom[last - 1];
    const volRatio = avgVol > 0 ? currentVol / avgVol : 1;

    if (currMom > this.threshold && prevMom < this.threshold && volSurge) {
      const strength = clamp100(Math.abs(currMom) * 1000);
      return {
        strategy: this.name,
        direction: "LONG",
        confidence: this._confidence(strength),
        details: { momentum: currMom, vol_ratio: volRatio },
      };
    }
    if (currMom < -this.threshold && prevMom > -this.threshold && volSurge) {
      const strength = clamp100(Math.abs(currMom) * 1000);
      return {
        strategy: this.name,
        direction: "SHORT",
        confidence: this._confidence(strength),
        details: { momentum: currMom, vol_ratio: volRatio },
      };
    }
    if (currMom > this.threshold) {
      const strength = clamp100(Math.abs(currMom) * 800);
      return {
        strategy: this.name,
        direction: "LONG",
        confidence: this._confidence(strength) - 15,
        details: { momentum: currMom },
      };
    }
    if (currMom < -this.threshold) {
      const strength = clamp100(Math.abs(currMom) * 800);
      return {
        strategy: this.name,
        direction: "SHORT",
        confidence: this._confidence(strength) - 15,
        details: { momentum: currMom },
      };
    }
    return neutral(this.name);
  }

  _confidence(strength: number): number {
    return Math.min(90, Math.trunc(55 + strength * 2));
  }
}

export function allStrategies(): StrategyBase[] {
  return [new EMAStrategy(), new MACDStrategy(), new RSIStrategy(), new MomentumStrategy()];
}

/** Consensus engine — direction by confidence mass, not signal count. */
export class StrategyEngine {
  constructor(public strategies: StrategyBase[] = allStrategies()) {}

  calculate_all(closes: number[], volumes: number[]): StrategySignal[] {
    return this.strategies.map((s) => s.calculate(closes, volumes));
  }

  get_consensus(closes: number[], volumes: number[], min_confidence = 80): Consensus {
    const results = this.calculate_all(closes, volumes);
    const longSignals = results.filter(
      (r) => r.direction === "LONG" && r.confidence >= min_confidence,
    );
    const shortSignals = results.filter(
      (r) => r.direction === "SHORT" && r.confidence >= min_confidence,
    );

    let direction: Direction = "NEUTRAL";
    let signalStrength = 0;
    let strategiesUsed: string[] = [];
    const longScore = longSignals.reduce((s, r) => s + r.confidence, 0);
    const shortScore = shortSignals.reduce((s, r) => s + r.confidence, 0);
    const totalScore = longScore + shortScore;

    if (longScore > shortScore) {
      direction = "LONG";
      strategiesUsed = longSignals.map((r) => r.strategy);
    } else if (shortScore > longScore) {
      direction = "SHORT";
      strategiesUsed = shortSignals.map((r) => r.strategy);
    }

    if (direction !== "NEUTRAL" && totalScore > 0) {
      signalStrength = Math.abs(longScore - shortScore) / totalScore;
    }

    let avgConfidence = 0;
    if (longSignals.length || shortSignals.length) {
      const all = [...longSignals, ...shortSignals];
      const sum = all.reduce((s, r) => s + r.confidence, 0);
      avgConfidence = Math.trunc(sum / all.length);
    }

    return {
      direction,
      confidence: avgConfidence || 0,
      signal_strength: signalStrength,
      strategies_used: strategiesUsed,
      all_signals: results,
      long_count: longSignals.length,
      short_count: shortSignals.length,
    };
  }
}
