import type { Candle } from "../types.js";

/**
 * Pure-TS indicator primitives — no TA library. Each function must match the
 * pandas computation in CryptoMind-XT's strategies.py bit-for-bit:
 *
 *   ewm(span=N, adjust=False)   → EWMA with alpha = 2/(N+1), seeded from the
 *                                 first value (adjust=False = "recurrence form").
 *   ewm(alpha=a, adjust=False)  → same recurrence, custom alpha (used by RSI).
 *   rolling(N).mean()           → simple trailing mean of the prior N values.
 *   diff()                      → close[i] - close[i-1].
 *
 * Arrays are ordered OLDEST → NEWEST (same as the pandas DataFrame after the
 * scanner sorts by timestamp).
 */

export type Series = number[];

/** EMA with adjust=False: ema[0] = x[0]; ema[i] = alpha*x[i] + (1-alpha)*ema[i-1]. */
export function ewmSpan(values: Series, span: number): Series {
  const alpha = 2 / (span + 1);
  return ewmAlpha(values, alpha);
}

/** EMA with a custom alpha (used for RSI's Wilder smoothing: alpha = 1/period). */
export function ewmAlpha(values: Series, alpha: number): Series {
  const out: Series = new Array(values.length);
  if (values.length === 0) return out;
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

/** Simple trailing mean over the previous `period` values (rolling().mean()). */
export function rollingMean(values: Series, period: number): Series {
  const out: Series = new Array(values.length).fill(0);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out[i] = i >= period - 1 ? sum / period : 0;
  }
  return out;
}

/** close[i] - close[i-1] (pandas .diff()); out[0] = NaN→0 for parity. */
export function diff(values: Series): Series {
  const out: Series = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i++) out[i] = values[i] - values[i - 1];
  return out;
}

/** Wilder RSI (period=14). Returns a series of RSI values in [0,100]. */
export function rsi(values: Series, period = 14): Series {
  const n = values.length;
  const out: Series = new Array(n).fill(50);
  if (n < period + 1) return out;
  const delta = diff(values);
  const gains: Series = new Array(n).fill(0);
  const losses: Series = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (delta[i] > 0) gains[i] = delta[i];
    else if (delta[i] < 0) losses[i] = -delta[i];
  }
  const avgGain = ewmAlpha(gains, 1 / period);
  const avgLoss = ewmAlpha(losses, 1 / period);
  for (let i = 0; i < n; i++) {
    const denom = avgLoss[i] === 0 ? 1e-10 : avgLoss[i];
    const rs = avgGain[i] / denom;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

/** momentum = close/close[period-1] - 1 (pandas shift(period)); out[0..period-1] = 0. */
export function momentum(values: Series, period = 10): Series {
  const n = values.length;
  const out: Series = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    out[i] = values[i] / values[i - period] - 1;
  }
  return out;
}

export function closesOf(candles: Candle[]): Series {
  return candles.map((c) => c.close);
}

export function volumesOf(candles: Candle[]): Series {
  return candles.map((c) => c.volume);
}
