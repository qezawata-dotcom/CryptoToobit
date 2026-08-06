/**
 * Formatting helpers. `splitMessage` is a port of CryptoMind-XT's
 * `_split_message` (Telegram caps ~4096 chars/msg); `fmtNumber` renders
 * numbers the way the Python bot did without the trailing ".0".
 */

export const TELEGRAM_MAX_LEN = 4000;

/** Splits text into ≤TELEGRAM_MAX_LEN chunks (Telegram message limit). */
export function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LEN) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_LEN) {
    chunks.push(text.slice(i, i + TELEGRAM_MAX_LEN));
  }
  return chunks;
}

/**
 * Renders a number compactly: integers without decimals, floats trimmed to
 * `maxDecimals` significant digits with trailing zeros stripped.
 */
export function fmtNumber(n: number, maxDecimals = 6): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(maxDecimals).replace(/\.?0+$/, "");
}

/** Percent with 1 decimal, e.g. "12.5%". */
export function fmtPct(n: number): string {
  return `${fmtNumber(n, 1)}%`;
}
