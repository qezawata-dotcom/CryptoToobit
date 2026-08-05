import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

/**
 * Environment surface for CryptoToobit — a 1:1 port of CryptoMind-XT's
 * config.py (symbols/sides swapped from XT to Toobit) plus the martingale
 * defaults the Python reference never wired up.
 *
 * Validation mirrors Config.validate(): five required vars; TELEGRAM_USER_ID
 * must be numeric.
 */

const REDACTED_KEYS = new Set([
  "TOOBIT_API_KEY",
  "TOOBIT_API_SECRET",
  "AI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
]);

function env(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === null ? fallback : v;
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(env(key, ""), 10);
  return Number.isFinite(v) ? v : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = parseFloat(env(key, ""));
  return Number.isFinite(v) ? v : fallback;
}

/** Resolve the SQLite file path, honouring both DATABASE_PATH and the legacy
 * DATABASE_URL (sqlite:///…) used by CryptoMind-XT. */
function resolveDatabasePath(): string {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith("sqlite:///")) {
    // sqlite:///data/memory.db → /data/memory.db
    return url.replace("sqlite:///", "/").replace("^/+", "");
  }
  return "./data/memory.db";
}

export const Config = {
  // Toobit exchange
  TOOBIT_API_KEY: env("TOOBIT_API_KEY"),
  TOOBIT_API_SECRET: env("TOOBIT_API_SECRET"),
  TOOBIT_API_BASE_URL: env("TOOBIT_API_BASE_URL", "https://api.toobit.com"),
  TOOBIT_DEBUG_RAW: env("TOOBIT_DEBUG_RAW", "") === "1",

  // AI (OpenAI-compatible)
  AI_API_KEY: env("AI_API_KEY"),
  AI_BASE_URL: env("AI_BASE_URL", "https://api.openai.com/v1"),
  AI_MODEL: env("AI_MODEL", "gpt-4o"),

  // Telegram
  TELEGRAM_BOT_TOKEN: env("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_USER_ID: env("TELEGRAM_USER_ID"),

  // Persistence
  DATABASE_PATH: resolveDatabasePath(),

  // Web / health
  PORT: envInt("PORT", 3000),

  // Defaults (mirrors Config.default_settings() + config.py constants)
  DEFAULT_SYMBOL: "BTC-SWAP-USDT",
  DEFAULT_LEVERAGE: 50,
  DEFAULT_MARGIN_MODE: "CROSSED",
  DEFAULT_TIMEFRAMES: ["15m"],
  DEFAULT_MARGIN_AMOUNT_PCT: 25.0,
  DEFAULT_RISK_PCT: 1.0,
  SIGNAL_COOLDOWN_MINUTES: 5,
  MAX_POSITIONS: 3,
  MIN_CONFIDENCE: 80,
  TF_MIN_CONFIDENCE: 60,
  SCAN_INTERVAL_SEC: 60,
  GUARD_INTERVAL_SEC: 15,
  MAX_LOSS_PCT: 40.0,
  MAX_PROFIT_PCT: 500.0,
  BREAKEVEN_THRESHOLD_PCT: 30.0,
  TRAILING_STOP_PCT: 50.0,
  TRAILING_TRIGGER_ROI_PCT: 50.0,
  TRAILING_DISTANCE_PCT: 0.8,
  SL_LIQUIDATION_SAFETY: 0.5,
  ON_TPSL_FAILURE: "close",

  // Martingale — defaults the Python martingale engine referenced via
  // Config.MARTINGALE_* but that config.py never defined. Values mirror the
  // _get() fallbacks in the reference martingale.py.
  MARTINGALE_MODE: "ai",
  MARTINGALE_RISK_PROFILE: "balanced",
  MARTINGALE_LEVERAGE: 5,
  MARTINGALE_MARGIN_PCT: 10.0,
  MARTINGALE_MAX_MARGIN_PCT: 60.0,
  MARTINGALE_SL_PCT: 15.0,

  /** Five required vars; returns list of missing names. */
  validate(): string[] {
    const missing: string[] = [];
    const required = [
      "TOOBIT_API_KEY",
      "TOOBIT_API_SECRET",
      "AI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_USER_ID",
    ];
    for (const key of required) {
      if (!env(key)) missing.push(key);
    }
    if (this.TELEGRAM_USER_ID && !/^\d+$/.test(this.TELEGRAM_USER_ID.trim())) {
      missing.push("TELEGRAM_USER_ID (must be a numeric Telegram user id)");
    }
    return missing;
  },

  /** Values written into the settings table on first boot (no-clobber). */
  defaultSettings(): Record<string, string> {
    return {
      symbol: this.DEFAULT_SYMBOL,
      leverage: String(this.DEFAULT_LEVERAGE),
      margin_mode: this.DEFAULT_MARGIN_MODE,
      timeframes: this.DEFAULT_TIMEFRAMES.join(","),
      margin_amount_pct: String(this.DEFAULT_MARGIN_AMOUNT_PCT),
      margin_risk_pct: String(this.DEFAULT_RISK_PCT),
      min_confidence: String(this.MIN_CONFIDENCE),
      tf_min_confidence: String(this.TF_MIN_CONFIDENCE),
      cooldown_minutes: String(this.SIGNAL_COOLDOWN_MINUTES),
      max_positions: String(this.MAX_POSITIONS),
      position_mode: "margin",
      scan_interval_sec: String(this.SCAN_INTERVAL_SEC),
      guard_interval_sec: String(this.GUARD_INTERVAL_SEC),
      max_loss_pct: String(this.MAX_LOSS_PCT),
      max_profit_pct: String(this.MAX_PROFIT_PCT),
      breakeven_threshold_pct: String(this.BREAKEVEN_THRESHOLD_PCT),
      trailing_stop_pct: String(this.TRAILING_STOP_PCT),
      trailing_trigger_roi_pct: String(this.TRAILING_TRIGGER_ROI_PCT),
      trailing_distance_pct: String(this.TRAILING_DISTANCE_PCT),
      sl_liquidation_safety: String(this.SL_LIQUIDATION_SAFETY),
      on_tpsl_failure: this.ON_TPSL_FAILURE,
      martingale_enabled: "false",
      martingale_direction: "AUTO",
      martingale_mode: this.MARTINGALE_MODE,
      martingale_risk_profile: this.MARTINGALE_RISK_PROFILE,
      martingale_sl_pct: String(this.MARTINGALE_SL_PCT),
      martingale_margin_pct: String(this.MARTINGALE_MARGIN_PCT),
      martingale_max_margin_pct: String(this.MARTINGALE_MAX_MARGIN_PCT),
      martingale_leverage: String(this.MARTINGALE_LEVERAGE),
    };
  },

  /** Non-secret config, for status logging. */
  toDict(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (REDACTED_KEYS.has(key)) continue;
      out[key] = String(value);
    }
    return out;
  },

  /** mkdir -p on the DB directory so better-sqlite3 can open the file. */
  ensureDataDir(): void {
    const dir = path.dirname(this.DATABASE_PATH);
    fs.mkdirSync(dir, { recursive: true });
  },
};

export type AppConfig = typeof Config;
