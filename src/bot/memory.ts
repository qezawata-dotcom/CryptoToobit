import Database from "better-sqlite3";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import type {
  CooldownRow,
  Direction,
  MartingaleState,
  PositionSide,
  SignalRecord,
  TradeCounts,
  TradeRecord,
  TradeStatus,
} from "../types.js";

/**
 * LongTermMemory — synchronous SQLite persistence, a 1:1 port of CryptoMind-XT's
 * bot/memory.py (SQLAlchemy) onto better-sqlite3. 7 tables:
 *
 *   chat_history       AI conversation window
 *   trades             every trade, open and closed
 *   signals            scanner emissions
 *   settings           key/value bot configuration
 *   cooldowns          per-(symbol,side) trade cooldowns
 *   ai_context         long-lived AI state (keys, chosen symbol, ...)
 *   martingale_states  running martingale baskets (UNIQUE symbol+position_side)
 *
 * All methods are synchronous (better-sqlite3). Settings values are stored as
 * TEXT exactly like the Python port (str(value)); callers cast on read.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  position_side TEXT NOT NULL,
  order_id TEXT,
  entry_price REAL,
  exit_price REAL,
  amount REAL,
  leverage INTEGER,
  pnl REAL DEFAULT 0,
  confidence INTEGER,
  strategy TEXT,
  signal_strength REAL,
  timeframe TEXT,
  opened_at REAL,
  closed_at REAL,
  status TEXT DEFAULT 'OPEN',
  notes TEXT
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  strategy TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  signal_strength REAL NOT NULL,
  price REAL NOT NULL,
  timestamp REAL NOT NULL,
  acted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldowns (
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  cooldown_until REAL NOT NULL,
  PRIMARY KEY (symbol, side)
);
CREATE TABLE IF NOT EXISTS ai_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS martingale_states (
  symbol TEXT NOT NULL,
  position_side TEXT NOT NULL,
  status TEXT NOT NULL,
  trade_id INTEGER,
  profile TEXT,
  source TEXT,
  mode TEXT,
  leverage INTEGER,
  base_size REAL,
  entry_price REAL,
  avg_entry REAL,
  current_size REAL,
  adds_done INTEGER,
  max_adds INTEGER,
  add_interval_pct REAL,
  size_multiplier REAL,
  tp_pct REAL,
  sl_pct REAL,
  next_add_trigger REAL,
  tp_price REAL,
  sl_price REAL,
  capped INTEGER DEFAULT 0,
  started_at REAL,
  updated_at REAL,
  PRIMARY KEY (symbol, position_side)
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(timestamp);
`;

const STALE_STATES_SQL = `
UPDATE martingale_states SET status = 'CLOSED', updated_at = ?
WHERE status = 'RUNNING' AND (updated_at IS NULL OR updated_at < ?)
`;

export class LongTermMemory {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || Config.DATABASE_PATH;
    Config.ensureDataDir();
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    logger.info({ path }, "SQLite memory ready");
  }

  /** In-memory database for tests. */
  static inMemory(): LongTermMemory {
    const mem = new LongTermMemory();
    mem.db.close();
    mem.db = new Database(":memory:");
    mem.db.pragma("journal_mode = MEMORY");
    mem.db.exec(SCHEMA);
    return mem;
  }

  close(): void {
    this.db.close();
  }

  // ---------- chat history ----------

  add_chat_message(role: string, content: string): void {
    this.db
      .prepare("INSERT INTO chat_history (role, content, timestamp) VALUES (?, ?, ?)")
      .run(role, content, Date.now() / 1000);
  }

  /** Returns [{role, content}] oldest-first, capped at `limit`. */
  get_chat_history(limit = 50): { role: string; content: string }[] {
    const rows = this.db
      .prepare(
        "SELECT role, content FROM (SELECT role, content, id FROM chat_history ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
      )
      .all(limit) as { role: string; content: string }[];
    return rows;
  }

  // ---------- trades ----------

  record_trade(params: {
    symbol: string;
    position_side: PositionSide;
    order_id: string | null;
    entry_price: number;
    amount: number;
    leverage: number;
    confidence: number;
    strategy: string;
    signal_strength: number;
    timeframe: string;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO trades
         (symbol, position_side, order_id, entry_price, amount, leverage,
          confidence, strategy, signal_strength, timeframe, opened_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
      )
      .run(
        params.symbol,
        params.position_side,
        params.order_id ?? null,
        params.entry_price,
        params.amount,
        params.leverage,
        params.confidence,
        params.strategy,
        params.signal_strength,
        params.timeframe,
        Date.now() / 1000,
      );
    return Number(res.lastInsertRowid);
  }

  close_trade(
    trade_id: number,
    exit_price: number,
    pnl = 0,
    notes?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE trades SET exit_price = ?, pnl = ?, closed_at = ?, status = 'CLOSED',
         notes = COALESCE(?, notes) WHERE id = ?`,
      )
      .run(exit_price, pnl, Date.now() / 1000, notes ?? null, trade_id);
  }

  get_open_trades(symbol?: string): TradeRecord[] {
    const q = symbol
      ? this.db.prepare(
          "SELECT * FROM trades WHERE status = 'OPEN' AND symbol = ? ORDER BY id",
        )
      : this.db.prepare("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY id");
    return (symbol ? q.all(symbol) : q.all()) as TradeRecord[];
  }

  get_trade(trade_id: number): TradeRecord | null {
    const row = this.db
      .prepare("SELECT * FROM trades WHERE id = ?")
      .get(trade_id) as TradeRecord | undefined;
    return row ?? null;
  }

  get_trade_history(limit = 20): TradeRecord[] {
    return this.db
      .prepare("SELECT * FROM trades ORDER BY id DESC LIMIT ?")
      .all(limit) as TradeRecord[];
  }

  get_total_pnl(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(pnl), 0) AS s FROM trades WHERE status = 'CLOSED'")
      .get() as { s: number };
    return row.s;
  }

  get_trade_count(): TradeCounts {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) AS closed,
           SUM(CASE WHEN status = 'CLOSED' AND pnl > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN status = 'CLOSED' AND pnl < 0 THEN 1 ELSE 0 END) AS losses
         FROM trades`,
      )
      .get() as { total: number; open: number; closed: number; wins: number; losses: number };
    const flatOrUnknown = (row.closed ?? 0) - (row.wins ?? 0) - (row.losses ?? 0);
    const decided = (row.wins ?? 0) + (row.losses ?? 0);
    return {
      total: row.total ?? 0,
      open: row.open ?? 0,
      closed: row.closed ?? 0,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      flat_or_unknown: flatOrUnknown,
      winrate: decided > 0 ? Math.round((row.wins! / decided) * 10000) / 100 : 0,
    };
  }

  // ---------- signals ----------

  record_signal(params: {
    symbol: string;
    direction: Direction;
    strategy: string;
    timeframe: string;
    confidence: number;
    signal_strength: number;
    price: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO signals
         (symbol, direction, strategy, timeframe, confidence, signal_strength, price, timestamp, acted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        params.symbol,
        params.direction,
        params.strategy,
        params.timeframe,
        params.confidence,
        params.signal_strength,
        params.price,
        Date.now() / 1000,
      );
  }

  get_recent_signals(symbol?: string, limit = 50): SignalRecord[] {
    const q = symbol
      ? this.db.prepare(
          "SELECT * FROM signals WHERE symbol = ? ORDER BY id DESC LIMIT ?",
        )
      : this.db.prepare("SELECT * FROM signals ORDER BY id DESC LIMIT ?");
    return (symbol ? q.all(symbol, limit) : q.all(limit)) as SignalRecord[];
  }

  // ---------- cooldowns ----------

  set_cooldown(symbol: string, side: PositionSide, duration_minutes: number): void {
    const cooldownUntil = Date.now() / 1000 + duration_minutes * 60;
    this.db
      .prepare(
        `INSERT INTO cooldowns (symbol, side, cooldown_until) VALUES (?, ?, ?)
         ON CONFLICT(symbol, side) DO UPDATE SET cooldown_until = excluded.cooldown_until`,
      )
      .run(symbol, side, cooldownUntil);
  }

  is_in_cooldown(symbol: string, side: PositionSide): boolean {
    const row = this.db
      .prepare(
        "SELECT cooldown_until FROM cooldowns WHERE symbol = ? AND side = ?",
      )
      .get(symbol, side) as CooldownRow | undefined;
    return row !== undefined && row.cooldown_until > Date.now() / 1000;
  }

  get_cooldown_remaining(symbol: string, side: PositionSide): number {
    const row = this.db
      .prepare(
        "SELECT cooldown_until FROM cooldowns WHERE symbol = ? AND side = ?",
      )
      .get(symbol, side) as CooldownRow | undefined;
    if (row && row.cooldown_until > Date.now() / 1000) {
      return Math.max(0, row.cooldown_until - Date.now() / 1000);
    }
    return 0;
  }

  // ---------- settings ----------

  set_setting(key: string, value: string | number | boolean): void {
    const ts = Date.now() / 1000;
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value), ts);
  }

  /** Writes only when the key is absent, so restarts don't clobber user settings. */
  set_setting_default(key: string, value: string | number | boolean): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, String(value), Date.now() / 1000);
    return res.changes > 0;
  }

  get_setting(key: string, fallback?: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? row.value : (fallback ?? null);
  }

  get_all_settings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  /** Seed defaults for absent keys. Returns number of keys written. */
  seed_defaults(settings: Record<string, string>): number {
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        if (this.set_setting_default(key, value)) n++;
      }
    });
    tx();
    return n;
  }

  // ---------- ai context ----------

  set_ai_context(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO ai_context (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now() / 1000);
  }

  get_ai_context(key?: string): Record<string, string> | string | null {
    if (key) {
      const row = this.db
        .prepare("SELECT value FROM ai_context WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row ? row.value : null;
    }
    const rows = this.db
      .prepare("SELECT key, value FROM ai_context ORDER BY updated_at DESC")
      .all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ---------- trade summary for AI ----------

  get_trade_summary_for_ai(): string {
    const trades = this.get_trade_history(30);
    const stats = this.get_trade_count();
    const pnl = this.get_total_pnl();
    const open = this.get_open_trades();
    const settings = this.get_all_settings();

    let summary = "=== TRADE SUMMARY ===\n";
    summary += `Total PnL: ${pnl.toFixed(4)} USDT\n`;
    summary += `Total Trades: ${stats.total} | Open: ${stats.open} | Closed: ${stats.closed}\n`;
    summary +=
      `Wins: ${stats.wins} | Losses: ${stats.losses} | ` +
      `Flat/Unknown PnL: ${stats.flat_or_unknown} | Winrate: ${stats.winrate}%\n\n`;

    if (open.length) {
      summary += "--- OPEN POSITIONS ---\n";
      for (const t of open) {
        summary +=
          `ID:${t.id} ${t.symbol} ${t.position_side} Entry:${t.entry_price} ` +
          `Amt:${t.amount} Lev:${t.leverage}x | ${t.strategy} Conf:${t.confidence}%\n`;
      }
    }

    if (trades.length) {
      summary += "\n--- RECENT TRADES ---\n";
      for (const t of trades.slice(0, 5)) {
        summary +=
          `${t.symbol} ${t.position_side} Entry:${t.entry_price} ` +
          `Exit:${t.exit_price} PnL:${(t.pnl ?? 0).toFixed(4)} | ${t.strategy}\n`;
      }
    }

    if (Object.keys(settings).length) {
      summary += "\n--- ACTIVE SETTINGS ---\n";
      for (const [k, v] of Object.entries(settings)) summary += `${k}: ${v}\n`;
    }

    return summary;
  }

  // ---------- martingale states ----------

  get_martingale_state(symbol: string, side: PositionSide): MartingaleState | null {
    const row = this.db
      .prepare(
        "SELECT * FROM martingale_states WHERE symbol = ? AND position_side = ?",
      )
      .get(symbol, side) as RowToMartingale | undefined;
    return row ? rowToMartingale(row) : null;
  }

  get_active_martingale_states(): MartingaleState[] {
    const rows = this.db
      .prepare("SELECT * FROM martingale_states WHERE status = 'RUNNING'")
      .all() as RowToMartingale[];
    return rows.map(rowToMartingale);
  }

  save_martingale_state(symbol: string, side: PositionSide, state: MartingaleState): void {
    this.db
      .prepare(
        `INSERT INTO martingale_states (
           symbol, position_side, status, trade_id, profile, source, mode,
           leverage, base_size, entry_price, avg_entry, current_size,
           adds_done, max_adds, add_interval_pct, size_multiplier, tp_pct,
           sl_pct, next_add_trigger, tp_price, sl_price, capped,
           started_at, updated_at
         ) VALUES (
           @symbol, @position_side, @status, @trade_id, @profile, @source, @mode,
           @leverage, @base_size, @entry_price, @avg_entry, @current_size,
           @adds_done, @max_adds, @add_interval_pct, @size_multiplier, @tp_pct,
           @sl_pct, @next_add_trigger, @tp_price, @sl_price, @capped,
           @started_at, @updated_at
         )
         ON CONFLICT(symbol, position_side) DO UPDATE SET
           status = excluded.status,
           trade_id = excluded.trade_id,
           profile = excluded.profile,
           source = excluded.source,
           mode = excluded.mode,
           leverage = excluded.leverage,
           base_size = excluded.base_size,
           entry_price = excluded.entry_price,
           avg_entry = excluded.avg_entry,
           current_size = excluded.current_size,
           adds_done = excluded.adds_done,
           max_adds = excluded.max_adds,
           add_interval_pct = excluded.add_interval_pct,
           size_multiplier = excluded.size_multiplier,
           tp_pct = excluded.tp_pct,
           sl_pct = excluded.sl_pct,
           next_add_trigger = excluded.next_add_trigger,
           tp_price = excluded.tp_price,
           sl_price = excluded.sl_price,
           capped = excluded.capped,
           started_at = excluded.started_at,
           updated_at = excluded.updated_at`,
      )
      .run(toRow(state));
  }

  /** Close any baskets whose last update is older than `staleAfterSec` (crash recovery). */
  close_stale_martingale_states(staleAfterSec = 3600): number {
    const cutoff = Date.now() / 1000 - staleAfterSec;
    const res = this.db.prepare(STALE_STATES_SQL).run(Date.now() / 1000, cutoff);
    return res.changes;
  }

  close_martingale_state(symbol: string, side: PositionSide): void {
    this.db
      .prepare(
        "UPDATE martingale_states SET status = 'CLOSED', updated_at = ? WHERE symbol = ? AND position_side = ?",
      )
      .run(Date.now() / 1000, symbol, side);
  }
}

// ---------- martingale row mapping ----------

type RowToMartingale = {
  symbol: string;
  position_side: PositionSide;
  status: "RUNNING" | "CLOSED";
  trade_id: number | null;
  profile: string | null;
  source: string | null;
  mode: string | null;
  leverage: number | null;
  base_size: number | null;
  entry_price: number | null;
  avg_entry: number | null;
  current_size: number | null;
  adds_done: number | null;
  max_adds: number | null;
  add_interval_pct: number | null;
  size_multiplier: number | null;
  tp_pct: number | null;
  sl_pct: number | null;
  next_add_trigger: number | null;
  tp_price: number | null;
  sl_price: number | null;
  capped: number | boolean;
  started_at: number | null;
  updated_at: number | null;
};

function rowToMartingale(row: RowToMartingale): MartingaleState {
  return {
    symbol: row.symbol,
    position_side: row.position_side,
    status: row.status,
    trade_id: row.trade_id ?? 0,
    profile: row.profile ?? "manual",
    source: row.source ?? "manual",
    mode: row.mode ?? "ai",
    leverage: row.leverage ?? 1,
    base_size: row.base_size ?? 0,
    entry_price: row.entry_price ?? 0,
    avg_entry: row.avg_entry ?? 0,
    current_size: row.current_size ?? 0,
    adds_done: row.adds_done ?? 0,
    max_adds: row.max_adds ?? 0,
    add_interval_pct: row.add_interval_pct ?? 0,
    size_multiplier: row.size_multiplier ?? 0,
    tp_pct: row.tp_pct ?? 0,
    sl_pct: row.sl_pct ?? 0,
    next_add_trigger: row.next_add_trigger ?? 0,
    tp_price: row.tp_price ?? 0,
    sl_price: row.sl_price ?? 0,
    capped: Boolean(row.capped),
    started_at: row.started_at ?? 0,
    updated_at: row.updated_at ?? 0,
  };
}

function toRow(state: MartingaleState): RowToMartingale {
  return {
    symbol: state.symbol,
    position_side: state.position_side,
    status: state.status,
    trade_id: state.trade_id,
    profile: state.profile,
    source: state.source,
    mode: state.mode,
    leverage: state.leverage,
    base_size: state.base_size,
    entry_price: state.entry_price,
    avg_entry: state.avg_entry,
    current_size: state.current_size,
    adds_done: state.adds_done,
    max_adds: state.max_adds,
    add_interval_pct: state.add_interval_pct,
    size_multiplier: state.size_multiplier,
    tp_pct: state.tp_pct,
    sl_pct: state.sl_pct,
    next_add_trigger: state.next_add_trigger,
    tp_price: state.tp_price,
    sl_price: state.sl_price,
    capped: state.capped ? 1 : 0,
    started_at: state.started_at,
    updated_at: state.updated_at,
  };
}

export { TradeStatus };
