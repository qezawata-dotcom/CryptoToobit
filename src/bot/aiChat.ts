import OpenAI from "openai";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { LongTermMemory } from "./memory.js";
import type { ToobitTrader } from "./trader.js";
import type { StrategyEngine } from "./strategies.js";
import { AI_TOOLS } from "./aiTools.js";

/**
 * AIChat — the OpenAI-compatible function-calling loop, a 1:1 port of XT's
 * ai_chat.py. The model can call the 20 tools in aiTools.ts to read state and
 * act on the bot; each round executes the tool calls and feeds the results
 * back, up to MAX_FUNCTION_ROUNDS.
 *
 * Toobit adaptations in the system prompt and context: futures symbols are
 * `BTC-SWAP-USDT`, order quantity is CONTRACTS, margin modes CROSSED/ISOLATED,
 * and TP/SL lives on the position (keyed by symbol+side), not a separate id.
 */

const SYSTEM_PROMPT = `You are an AI Trading Assistant for Toobit USDT-M Futures.

Your capabilities:
1. Manage trading settings via function calls (symbol, leverage, margin mode, timeframes, risk, etc.)
2. Analyze market conditions and provide trade recommendations
3. Monitor open positions and suggest management actions
4. Interpret signal scan results and provide clear explanations
5. Remember user preferences and past trading context

AVAILABLE FUNCTIONS:
- get_status() - Get current bot status including open positions, PnL, and settings
- get_pnl() - Get profit/loss summary
- get_balance() - Read the live USDT futures balance from Toobit
- get_contract_info(symbol) - Contract size, min order in contracts, min notional, max leverage
- set_symbol(symbol) - Change trading pair (e.g. BTC-SWAP-USDT, ETH-SWAP-USDT)
- set_leverage(leverage) - Set leverage
- set_margin_mode(mode) - Set margin mode: CROSSED or ISOLATED
- set_timeframes(timeframes) - Set timeframes for scanning (e.g. "5m,15m,1h")
- set_margin_amount_pct(pct) - Set margin percentage of balance to use per trade (1-100)
- set_margin_risk_pct(pct) - Set risk percentage for position sizing (0.1-10)
- set_min_confidence(confidence) - Set minimum confidence threshold (50-100)
- set_cooldown_minutes(minutes) - Set cooldown minutes after closing position (1-30)
- set_position_mode(mode) - margin (by margin %) or risk (by risk %)
- set_max_loss_pct(pct) / set_max_profit_pct(pct) - Software safety-net ROI limits
- scan_signals() - Run signal scan now
- open_trade(direction, order_type, time_in_force) - Open a trade based on current signals
- close_trade(trade_id) - Close a specific trade
- close_all_trades() - Close all open positions
- mid_manage() - Run mid-position management

IMPORTANT FACTS ABOUT TOOBIT FUTURES:
- Order quantity is measured in CONTRACTS, not coin amount. One BTC-SWAP-USDT
  contract is 0.0001 BTC. Use get_contract_info when the user asks how much a
  position is worth.
- Leverage is capped per symbol by a notional-value risk-limit bracket, so a
  requested leverage may be clamped down. Report the clamped value when that happens.
- Symbols are futures-style with a dash: BTC-SWAP-USDT, ETH-SWAP-USDT, SOL-SWAP-USDT.
- Every position gets an exchange-side TP/SL (Toobit's position trading-stop).
  If TP/SL creation fails the bot says so explicitly - treat that as urgent and
  tell the user.
- ROI shown is return on margin (leverage-amplified), not raw price movement.

IMPORTANT RULES:
- When the user asks to change settings, use the function calls directly.
- Only call open_trade / close_trade / close_all_trades when the user clearly
  asks for that action. Never call them to illustrate what you could do.
- Always explain what you're doing before calling functions.
- If signal strength is high, suggest wider TP and tighter SL.
- If signal strength is low, suggest tighter TP and wider SL.
- Always remind about risk management.
- Format numbers clearly with proper precision.
- Be concise but informative.`;

const MAX_FUNCTION_ROUNDS = 5;

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export class AIChat {
  private client: OpenAI;
  private model: string;
  private trader: ToobitTrader | null = null;

  constructor(private memory: LongTermMemory, private engine: StrategyEngine | null = null) {
    this.client = new OpenAI({
      apiKey: Config.AI_API_KEY,
      baseURL: Config.AI_BASE_URL,
    });
    this.model = Config.AI_MODEL;
  }

  bind_trader(trader: ToobitTrader): void {
    this.trader = trader;
  }

  /** Resolves one tool call against the live bot. Async (most handlers hit the exchange). */
  async execute_function(func_name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.trader && !["get_status", "get_pnl"].includes(func_name)) {
      return "Trader not initialized. Please start the bot first.";
    }
    const handler = this._handler_map()[func_name];
    if (handler) return handler(args);
    return `Unknown function: ${func_name}`;
  }

  private _handler_map(): Record<string, (args: Record<string, unknown>) => Promise<string>> {
    return {
      get_status: async () => {
        if (!this.trader) {
          const summary = this.memory.get_trade_summary_for_ai();
          const settings = this.memory.get_all_settings();
          return `${summary}\n\nSettings: ${JSON.stringify(settings)}`;
        }
        return this.trader.get_status_report();
      },
      get_pnl: async () => {
        const pnl = this.memory.get_total_pnl();
        const stats = this.memory.get_trade_count();
        return (
          `Total PnL: ${pnl.toFixed(4)} USDT\n` +
          `Total Trades: ${stats.total} | Open: ${stats.open} | Closed: ${stats.closed}\n` +
          `Wins: ${stats.wins} | Losses: ${stats.losses} | Flat/Unknown PnL: ${stats.flat_or_unknown} | Winrate: ${stats.winrate}%`
        );
      },
      set_symbol: async (args) => {
        const symbol = String(args.symbol ?? "").toUpperCase().trim();
        if (!this.trader) return "Trader not running. Cannot validate symbol.";
        try {
          const cfg = await this.trader.risk.get_symbol_config(symbol);
          if (!cfg.contractSize) return `Symbol '${symbol}' not found on Toobit futures. Check the format (e.g. BTC-SWAP-USDT).`;
        } catch (error) {
          return `Could not validate symbol '${symbol}': ${error}`;
        }
        this.memory.set_setting("symbol", symbol);
        return `Trading pair set to: ${symbol}`;
      },
      set_leverage: async (args) => {
        const lev = Math.trunc(Number(args.leverage) || 0);
        let maxLev = 125;
        if (this.trader) {
          const symbol = this.memory.get_setting("symbol") ?? Config.DEFAULT_SYMBOL;
          maxLev = await this.trader.risk.get_max_leverage(symbol);
          if (maxLev && lev > maxLev) {
            return `Leverage ${lev}x exceeds max ${maxLev}x for ${symbol}. Set to ${maxLev}x.`;
          }
        }
        const clamped = Math.max(1, Math.min(lev, maxLev || 125));
        this.memory.set_setting("leverage", clamped);
        return `Leverage set to: ${clamped}x`;
      },
      set_margin_mode: async (args) => {
        const mode = String(args.mode ?? "").toUpperCase();
        if (mode !== "CROSSED" && mode !== "ISOLATED") return "Invalid margin mode. Use CROSSED or ISOLATED.";
        this.memory.set_setting("margin_mode", mode);
        return `Margin mode set to: ${mode}`;
      },
      set_timeframes: async (args) => {
        const tfs = String(args.timeframes ?? "").trim();
        const valid = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"];
        const tfList = tfs.split(",").map((t) => t.trim().toLowerCase());
        const invalid = tfList.filter((t) => !valid.includes(t));
        if (invalid.length) return `Invalid timeframes: ${invalid}. Valid: ${valid.join(", ")}`;
        this.memory.set_setting("timeframes", tfList.join(","));
        return `Timeframes set to: ${tfList.join(", ")}`;
      },
      set_margin_amount_pct: async (args) => {
        const pct = Math.max(1.0, Math.min(Number(args.pct), 100.0));
        this.memory.set_setting("margin_amount_pct", pct);
        return `Margin amount percentage set to: ${pct}%`;
      },
      set_margin_risk_pct: async (args) => {
        const pct = Math.max(0.1, Math.min(Number(args.pct), 10.0));
        this.memory.set_setting("margin_risk_pct", pct);
        return `Risk percentage set to: ${pct}%`;
      },
      set_min_confidence: async (args) => {
        const conf = Math.max(50, Math.min(Math.trunc(Number(args.confidence)), 100));
        this.memory.set_setting("min_confidence", conf);
        return `Minimum confidence threshold set to: ${conf}%`;
      },
      set_cooldown_minutes: async (args) => {
        const mins = Math.max(1, Math.min(Math.trunc(Number(args.minutes)), 30));
        this.memory.set_setting("cooldown_minutes", mins);
        return `Cooldown period set to: ${mins} minutes`;
      },
      set_position_mode: async (args) => {
        const mode = String(args.mode ?? "").toLowerCase();
        if (mode !== "margin" && mode !== "risk") return "Invalid mode. Use margin or risk.";
        this.memory.set_setting("position_mode", mode);
        return `Position sizing mode set to: ${mode}`;
      },
      set_max_loss_pct: async (args) => {
        const pct = Math.max(1.0, Math.min(Number(args.pct), 100.0));
        this.memory.set_setting("max_loss_pct", pct);
        return `Software max loss (ROI on margin) set to: -${pct}%`;
      },
      set_max_profit_pct: async (args) => {
        const pct = Math.max(1.0, Math.min(Number(args.pct), 1000.0));
        this.memory.set_setting("max_profit_pct", pct);
        return `Software max profit (ROI on margin) set to: +${pct}%`;
      },
      get_balance: async () => {
        if (!this.trader) return "Trader not running. Cannot read balance.";
        try {
          const item = await this.trader.risk._get_usdt_balance(true);
          const o = item as Record<string, unknown>;
          return (
            `Wallet: ${o.walletBalance ?? 0} USDT\n` +
            `Available: ${o.availableBalance ?? 0} USDT\n` +
            `Order margin frozen: ${o.openOrderMarginFrozen ?? o.frozen ?? 0} USDT\n` +
            `Isolated margin: ${o.isolatedMargin ?? 0} USDT\n` +
            `Crossed margin: ${o.crossedMargin ?? 0} USDT`
          );
        } catch (error) {
          return `Failed to read balance from Toobit: ${error}`;
        }
      },
      get_contract_info: async (args) => {
        if (!this.trader) return "Trader not running.";
        const symbol =
          String(args.symbol ?? "") ||
          (this.memory.get_setting("symbol") ?? Config.DEFAULT_SYMBOL);
        try {
          const risk = this.trader.risk;
          const price = await this.trader.scanner.get_current_price(symbol);
          const cs = await risk.get_contract_size(symbol);
          const one = cs * price;
          return (
            `${symbol}\n` +
            `Contract size: ${cs} (${one.toFixed(4)} USDT per contract at ${price})\n` +
            `Min order: ${await risk.get_min_qty(symbol)} contracts\n` +
            `Min notional: ${await risk.get_min_notional(symbol)} USDT\n` +
            `Max leverage: ${await risk.get_max_leverage(symbol)}x\n` +
            `Price precision: ${await risk.get_price_precision(symbol)} (tick ${await risk.get_price_step(symbol)})`
          );
        } catch (error) {
          return `Failed to read contract config for ${symbol}: ${error}`;
        }
      },
      scan_signals: async () => {
        if (!this.trader) return "Trader not running. Cannot scan signals.";
        const result = await this.trader.scanner.scan_and_report();
        return this.trader.scanner.format_signal_report(result);
      },
      open_trade: async (args) => {
        if (!this.trader) return "Trader not running. Cannot open trade.";
        const direction = String(args.direction ?? "").toUpperCase();
        if (!direction) return "Direction (LONG/SHORT) is required";
        const orderType = String(args.order_type ?? "MARKET").toUpperCase();
        const tifRaw = args.time_in_force ? String(args.time_in_force).toUpperCase() : undefined;
        const timeInForce = tifRaw && ["GTC", "IOC", "FOK"].includes(tifRaw)
          ? (tifRaw as "GTC" | "IOC" | "FOK")
          : undefined;
        return this.trader.execute_trade(direction as "LONG" | "SHORT", orderType as "MARKET" | "LIMIT", timeInForce);
      },
      close_trade: async (args) => {
        if (!this.trader) return "Trader not running. Cannot close trade.";
        const tradeId = Math.trunc(Number(args.trade_id));
        return this.trader.close_specific_trade(tradeId);
      },
      close_all_trades: async () => {
        if (!this.trader) return "Trader not running. Cannot close trades.";
        return this.trader.close_all_positions();
      },
      mid_manage: async () => {
        if (!this.trader) return "Trader not running. Cannot manage positions.";
        return this.trader.run_mid_management();
      },
    };
  }

  async chat(user_message: string): Promise<string> {
    this.memory.add_chat_message("user", user_message);
    const history = this.memory.get_chat_history(30);
    const context = this.memory.get_trade_summary_for_ai();
    const aiContext = this.memory.get_ai_context() as Record<string, string>;
    let contextMsg = `Current trading context:\n${context}\n\nAI memory context:\n${JSON.stringify(aiContext, null, 2)}`;
    contextMsg += "\n\nValid symbols use futures format like BTC-SWAP-USDT, ETH-SWAP-USDT.";
    contextMsg += "\nValid timeframes: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d";
    contextMsg += "\nMargin modes: CROSSED or ISOLATED";
    contextMsg += "\nOrder types for open_trade: MARKET or LIMIT";
    contextMsg += "\nTime in force for open_trade: GTC, IOC, FOK";

    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: contextMsg },
    ];
    for (const msg of history) {
      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      } as Message);
    }

    const result = await this._call_with_functions(messages);
    this.memory.add_chat_message("assistant", result);
    return result;
  }

  private async _call_with_functions(messages: Message[], maxRounds = MAX_FUNCTION_ROUNDS): Promise<string> {
    for (let round = 0; round < maxRounds; round++) {
      let response;
      try {
        response = await this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            tools: AI_TOOLS.map((f) => ({
              type: "function" as const,
              function: f as OpenAI.Chat.Completions.ChatCompletionTool["function"],
            })),
            tool_choice: "auto",
          },
          { timeout: 30 },
        );
      } catch (error) {
        const errStr = String(error);
        if (/tool_use_failed|tool/i.test(errStr)) {
          messages.push({
            role: "user",
            content: `Your last function call failed: ${errStr}. Please respond in plain text instead of calling functions. If you need to perform an action, describe it clearly and I'll handle it.`,
          } as Message);
          continue;
        }
        return `AI API error: ${errStr}`;
      }

      const choice = response.choices[0];
      const message = choice.message;

      if (message.tool_calls && message.tool_calls.length > 0) {
        // The assistant turn must echo the tool_calls the model asked for.
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: message.tool_calls.map((tc): ToolCall => ({
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });
        for (const toolCall of message.tool_calls) {
          const funcName = toolCall.function.name ?? "";
          let args: Record<string, unknown> = {};
          try {
            args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
          } catch {
            args = {};
          }
          const result = await this.execute_function(funcName, args);
          // Each tool result is a separate `tool` message addressed by id.
          messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
          logger.info({ func: funcName, args }, "AI tool executed");
        }
      } else {
        return message.content ?? "";
      }
    }
    return "Max function call rounds exceeded. Please try a more specific request.";
  }

  remember(key: string, value: string): void {
    this.memory.set_ai_context(key, value);
  }

  recall(key?: string): Record<string, string> | string | null {
    return this.memory.get_ai_context(key);
  }
}
