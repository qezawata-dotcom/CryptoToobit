/**
 * Core domain types for CryptoToobit. These mirror the Python reference
 * (CryptoMind-XT) 1:1 with XT concepts swapped for Toobit:
 *   - symbols: futures "BTC-SWAP-USDT" (spot "BTCUSDT")
 *   - sides:   single side "BUY_OPEN" | "SELL_OPEN" | "BUY_CLOSE" | "SELL_CLOSE"
 *   - margin mode: CROSSED/ISOLATED in settings, CROSS/ISOLATED on the wire
 */

export type PositionSide = "LONG" | "SHORT";
export type Direction = PositionSide | "NEUTRAL";
export type OrderSide = "BUY_OPEN" | "SELL_OPEN" | "BUY_CLOSE" | "SELL_CLOSE";
export type MarginMode = "CROSSED" | "ISOLATED";
export type TradeStatus = "OPEN" | "CLOSED";

export type Candle = {
  /** ms epoch open time */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SignalResult = {
  direction: Direction;
  confidence: number;
  signal_strength: number;
  price: number;
  strategies_used: string[];
  details: string;
};

export type TradeRecord = {
  id: number;
  symbol: string;
  position_side: PositionSide;
  order_id: string | null;
  entry_price: number | null;
  exit_price: number | null;
  amount: number | null;
  leverage: number | null;
  pnl: number | null;
  confidence: number | null;
  strategy: string | null;
  signal_strength: number | null;
  timeframe: string | null;
  opened_at: number | null;
  closed_at: number | null;
  status: TradeStatus;
  notes: string | null;
};

export type SignalRecord = {
  id: number;
  symbol: string;
  direction: Direction;
  strategy: string;
  timeframe: string;
  confidence: number;
  signal_strength: number;
  price: number;
  timestamp: number;
  acted: boolean;
};

export type MartingaleState = {
  symbol: string;
  position_side: PositionSide;
  status: "RUNNING" | "CLOSED";
  trade_id: number;
  profile: string;
  source: string;
  mode: string;
  leverage: number;
  base_size: number;
  entry_price: number;
  avg_entry: number;
  current_size: number;
  adds_done: number;
  max_adds: number;
  add_interval_pct: number;
  size_multiplier: number;
  tp_pct: number;
  sl_pct: number;
  next_add_trigger: number;
  tp_price: number;
  sl_price: number;
  capped: boolean;
  started_at: number;
  updated_at: number;
};

export type PositionInfo = {
  exists: boolean;
  entry_price: number;
  mark_price: number;
  position_size: number;
  unrealized_pnl: number;
  roi: number;
  leverage: number;
  liquidation_price: number | null;
};

/**
 * Rich position view used by PositionManager — a 1:1 port of the dict the
 * Python get_position_pnl() returns. `position_size` keeps the exchange's sign
 * (positive LONG, negative SHORT); callers use Math.abs where quantity is meant.
 */
export type PositionDetail = {
  exists: boolean;
  position_side: PositionSide | null;
  unrealized_pnl: number;
  roi: number;
  entry_price: number;
  mark_price: number;
  leverage: number;
  position_size: number;
  position_value: number;
  margin: number;
  /** TP/SL identifier. Toobit has no profitId; a truthy sentinel means the
   * position carries trigger prices (protection exists). */
  profit_id: string | null;
  trigger_profit_price: number;
  trigger_stop_price: number;
  position_type: string;
  available_close_size: number;
};

export type ContractInfo = {
  symbol: string;
  contract_size: number; // e.g. 0.0001 BTC per contract
  min_qty: number;
  max_qty: number;
  min_notional: number;
  max_notional: number;
  tick_size: number;
  max_leverage: number;
};

export type TradeCounts = {
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  flat_or_unknown: number;
  winrate: number;
};

/** Cooldown tuple keyed by (symbol, side). */
export type CooldownRow = {
  symbol: string;
  side: PositionSide;
  cooldown_until: number;
};
