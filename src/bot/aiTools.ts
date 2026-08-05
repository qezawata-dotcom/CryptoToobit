/**
 * The 20 AI function-calling tools (port of XT's ai_chat.py FUNCTIONS, adapted
 * to Toobit: futures symbols are `BTC-SWAP-USDT`, margin modes CROSSED/
 * ISOLATED on the wire). The schemas are fed verbatim to the OpenAI-compatible
 * chat.completions.create(tools=...) call.
 */

export type AiTool = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

const noParams: AiTool["parameters"] = { type: "object", properties: {} };

export const AI_TOOLS: AiTool[] = [
  { name: "get_status", description: "Get the current status of the trading bot including open positions, PnL, and settings", parameters: noParams },
  { name: "get_pnl", description: "Get profit/loss summary for all trades", parameters: noParams },
  {
    name: "set_symbol",
    description: "Change the trading pair symbol",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Futures symbol, e.g. BTC-SWAP-USDT, ETH-SWAP-USDT" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "set_leverage",
    description: "Set the trading leverage multiplier",
    parameters: {
      type: "object",
      properties: {
        leverage: { type: "integer", description: "Leverage value, 1-100 (clamped to the symbol's risk-limit bracket)" },
      },
      required: ["leverage"],
    },
  },
  {
    name: "set_margin_mode",
    description: "Set margin mode for positions",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["CROSSED", "ISOLATED"], description: "Margin mode (CROSSED = cross margin)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "set_timeframes",
    description: "Set timeframes for signal scanning",
    parameters: {
      type: "object",
      properties: {
        timeframes: { type: "string", description: "Comma-separated timeframes, e.g. 5m,15m,1h,4h" },
      },
      required: ["timeframes"],
    },
  },
  {
    name: "set_margin_amount_pct",
    description: "Set what percentage of your balance to use as margin per trade",
    parameters: {
      type: "object",
      properties: {
        pct: { type: "number", description: "Percentage 1-100" },
      },
      required: ["pct"],
    },
  },
  {
    name: "set_margin_risk_pct",
    description: "Set what percentage of your balance to risk per trade for position sizing",
    parameters: {
      type: "object",
      properties: {
        pct: { type: "number", description: "Risk percentage 0.1-10" },
      },
      required: ["pct"],
    },
  },
  {
    name: "set_min_confidence",
    description: "Set the minimum confidence threshold for signals to execute",
    parameters: {
      type: "object",
      properties: {
        confidence: { type: "integer", description: "Confidence threshold 50-100" },
      },
      required: ["confidence"],
    },
  },
  {
    name: "set_cooldown_minutes",
    description: "Set cooldown period after closing a position before new signals are accepted",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "integer", description: "Cooldown minutes 1-30" },
      },
      required: ["minutes"],
    },
  },
  {
    name: "set_position_mode",
    description: "Set position sizing mode: margin (by margin %) or risk (by risk %)",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["margin", "risk"], description: "Position sizing mode" },
      },
      required: ["mode"],
    },
  },
  {
    name: "set_max_loss_pct",
    description: "Set the software safety-net max loss as ROI on margin. The exchange stop loss is primary; this is the backup.",
    parameters: {
      type: "object",
      properties: {
        pct: { type: "number", description: "Loss ROI percentage, 1-100" },
      },
      required: ["pct"],
    },
  },
  {
    name: "set_max_profit_pct",
    description: "Set the software safety-net max profit as ROI on margin",
    parameters: {
      type: "object",
      properties: {
        pct: { type: "number", description: "Profit ROI percentage, 1-1000" },
      },
      required: ["pct"],
    },
  },
  { name: "get_balance", description: "Read the live USDT futures balance from Toobit", parameters: noParams },
  {
    name: "get_contract_info",
    description: "Read contract specs for a symbol: contract size, minimum order in contracts, minimum notional, max leverage, price tick",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Optional futures symbol, e.g. BTC-SWAP-USDT. Defaults to the active symbol." },
      },
    },
  },
  { name: "scan_signals", description: "Run a signal scan now and return results", parameters: noParams },
  {
    name: "open_trade",
    description: "Open a new trade based on current signal scan results",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["LONG", "SHORT"], description: "Trade direction" },
        order_type: { type: "string", enum: ["MARKET", "LIMIT"], description: "Order type" },
        time_in_force: { type: "string", enum: ["GTC", "IOC", "FOK"], description: "Time in force" },
      },
      required: ["direction"],
    },
  },
  {
    name: "close_trade",
    description: "Close a specific trade by ID",
    parameters: {
      type: "object",
      properties: {
        trade_id: { type: "integer", description: "Trade ID to close" },
      },
      required: ["trade_id"],
    },
  },
  { name: "close_all_trades", description: "Close all currently open positions", parameters: noParams },
  { name: "mid_manage", description: "Run mid-position management on all open positions (breakeven, trailing stop)", parameters: noParams },
];

export const AI_TOOL_NAMES = new Set(AI_TOOLS.map((t) => t.name));
