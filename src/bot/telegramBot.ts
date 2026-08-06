import { Bot, type Context } from "grammy";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { LongTermMemory } from "./memory.js";
import type { AIChat } from "./aiChat.js";
import type { ToobitTrader } from "./trader.js";

/**
 * TelegramBot — grammY port of CryptoMind-XT/bot/telegram_bot.py.
 *
 * 17 commands + free-text AI chat, owner-only via TELEGRAM_USER_ID, messages
 * split at 4000 chars. The trader's notify callback is registered here so
 * auto-trade / TP-SL-failure events land in the owner's chat.
 *
 * grammY vs python-telegram-bot differences folded in:
 *   - command args come from ctx.match (a string for string commands).
 *   - Node is single-threaded, so the notify callback can call the bot API
 *     directly (fire-and-forget) — no run_coroutine_threadsafe needed.
 *   - bot.start() (long polling) is async and blocks until stopped.
 */

const TELEGRAM_MAX_LEN = 4000;

export function _split_message(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LEN) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_LEN) {
    chunks.push(text.slice(i, i + TELEGRAM_MAX_LEN));
  }
  return chunks;
}

const VALID_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"];

const COMMAND_NAMES = [
  "start", "pnl", "status", "balance", "autotrade_on", "autotrade_off",
  "signal", "settings", "check_ai", "timeframes", "margin_amount_pct",
  "margin_risk_pct", "close", "diag", "sync", "protect", "midmanage",
] as const;
const FREE_TEXT = "__free_text__";

export type TelegramBotOptions = {
  /** Override Config.TELEGRAM_BOT_TOKEN (required when the token is unset, e.g. tests). */
  token?: string;
  /** Override the Telegram API root (hermetic tests point at a dead port). */
  apiRoot?: string;
  /** Override Config.TELEGRAM_USER_ID (the only authorized chat). */
  userId?: number;
};

const MENU_COMMANDS: { command: string; description: string }[] = [
  { command: "pnl", description: "Profit/Loss summary" },
  { command: "status", description: "Bot status & open positions" },
  { command: "balance", description: "Account balance" },
  { command: "autotrade_on", description: "Enable auto-trading" },
  { command: "autotrade_off", description: "Disable auto-trading" },
  { command: "signal", description: "Scan for trading signals" },
  { command: "settings", description: "View current settings" },
  { command: "check_ai", description: "Test AI connection" },
  { command: "timeframes", description: "View/change timeframes" },
  { command: "margin_amount_pct", description: "Set margin %" },
  { command: "margin_risk_pct", description: "Set risk %" },
  { command: "close", description: "Close a position" },
  { command: "diag", description: "Why breakeven/trailing has not fired" },
  { command: "sync", description: "Adopt Toobit positions into the bot" },
  { command: "protect", description: "Attach a stop to unprotected positions" },
  { command: "midmanage", description: "Run breakeven + trailing now" },
];

export class TelegramBot {
  private bot: Bot;
  private trader: ToobitTrader;
  private ai: AIChat;
  private memory: LongTermMemory;
  private authorizedUserId: number;
  private registered: Set<string> = new Set();

  constructor(
    trader: ToobitTrader,
    aiChat: AIChat,
    memory: LongTermMemory,
    options: TelegramBotOptions = {},
  ) {
    this.trader = trader;
    this.ai = aiChat;
    this.memory = memory;
    this.authorizedUserId = options.userId ?? Number(Config.TELEGRAM_USER_ID);
    const token = options.token ?? Config.TELEGRAM_BOT_TOKEN;
    this.bot = options.apiRoot
      ? new Bot(token, { client: { apiRoot: options.apiRoot } })
      : new Bot(token);
    this.trader.set_notify_callback((msg) => this._notify_from_thread(msg));
  }

  /** Command names wired into grammY (plus FREE_TEXT for the chat handler). */
  get registeredHandlers(): string[] {
    return [...this.registered];
  }

  // ---------- authorization ----------

  private _is_authorized(userId: number | undefined): boolean {
    return userId !== undefined && userId === this.authorizedUserId;
  }

  private _unauthorized(ctx: Context): void {
    void ctx.reply("Unauthorized.");
  }

  // ---------- notifications (called from the auto-trade loop) ----------

  private _notify_from_thread(message: string): void {
    for (const chunk of _split_message(message)) {
      this.bot.api
        .sendMessage(this.authorizedUserId, chunk)
        .catch((err) => logger.error({ err }, "Failed to send notification"));
    }
  }

  // ---------- reply helpers ----------

  private async _replySplit(ctx: Context, text: string): Promise<void> {
    for (const chunk of _split_message(text)) {
      await ctx.reply(chunk);
    }
  }

  /** grammY command args: string for string commands; split on whitespace. */
  private _args(ctx: Context): string[] {
    const m = ctx.match;
    if (typeof m === "string" && m.trim()) return m.trim().split(/\s+/);
    return [];
  }

  // ---------- command handlers ----------

  private async cmd_start(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await ctx.reply(
      "CryptoToobit AI Trader Bot Ready!\n\n" +
        "Commands:\n" +
        "/pnl - Profit/Loss summary\n" +
        "/status - Bot status\n" +
        "/balance - Account balance\n" +
        "/autotrade_on - Enable auto-trading\n" +
        "/autotrade_off - Disable auto-trading\n" +
        "/signal - Scan for signals\n" +
        "/settings - View current settings\n" +
        "/check_ai - Test AI connection\n" +
        "/timeframes - View/change timeframes\n" +
        "/margin_amount_pct <value> - Set margin %\n" +
        "/margin_risk_pct <value> - Set risk %\n" +
        "/close [trade_id] - Close a position\n" +
        "/diag - Diagnose mid-management\n" +
        "/sync - Sync with exchange positions\n" +
        "/protect - Attach stops to unprotected positions\n" +
        "/midmanage - Run breakeven + trailing now\n\n" +
        "You can also chat with me normally to change settings!",
    );
  }

  private async cmd_pnl(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    const pnl = this.memory.get_total_pnl();
    const stats = this.memory.get_trade_count();
    const openTrades = this.memory.get_open_trades();
    let response =
      `PNL Summary\n` +
      `Total PnL: ${pnl.toFixed(4)} USDT\n` +
      `Total Trades: ${stats.total} | Open: ${stats.open} | Closed: ${stats.closed}\n` +
      `Wins: ${stats.wins} | Losses: ${stats.losses} | ` +
      `Flat/Unknown PnL: ${stats.flat_or_unknown} | Winrate: ${stats.winrate}%\n`;
    if (openTrades.length) {
      response += "\nOpen Positions:\n";
      for (const t of openTrades) {
        response +=
          `  ID:${t.id} ${t.symbol} ${t.position_side} ` +
          `Entry:${t.entry_price} Amt:${t.amount} Lev:${t.leverage}x\n`;
      }
    }
    await ctx.reply(response);
  }

  private async cmd_status(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    const report = await this.trader.get_status_report();
    await this._replySplit(ctx, report);
  }

  private async cmd_autotrade_on(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await ctx.reply(this.trader.start_auto_trade());
  }

  private async cmd_autotrade_off(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await ctx.reply(this.trader.stop_auto_trade());
  }

  private async cmd_signal(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await ctx.reply("Scanning signals...");
    const result = await this.trader.scanner.scan_and_report();
    await this._replySplit(ctx, this.trader.scanner.format_signal_report(result));
  }

  private async cmd_settings(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    const settings = this.memory.get_all_settings();
    let response = "Current Settings:\n";
    const src = Object.keys(settings).length ? settings : Config.defaultSettings();
    for (const [k, v] of Object.entries(src)) response += `  ${k}: ${v}\n`;
    await this._replySplit(ctx, response);
  }

  private async cmd_check_ai(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await ctx.reply("Checking AI connection...");
    const response = await this.ai.chat(
      "Hello, respond with a brief confirmation that you are online.",
    );
    await ctx.reply(`AI Response:\n${response}`);
  }

  private async cmd_timeframes(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    const args = this._args(ctx);
    if (args.length) {
      const tfs = args[0];
      const tfList = tfs.split(",").map((t) => t.trim().toLowerCase());
      const invalid = tfList.filter((t) => !VALID_TIMEFRAMES.includes(t));
      if (invalid.length) {
        await ctx.reply(
          `Invalid timeframes: ${invalid.join(", ")}. Valid: ${VALID_TIMEFRAMES.join(", ")}`,
        );
        return;
      }
      this.memory.set_setting("timeframes", tfList.join(","));
      await ctx.reply(`Timeframes set to: ${tfList.join(", ")}`);
    } else {
      const tfs = this.memory.get_setting("timeframes", Config.DEFAULT_TIMEFRAMES.join(","));
      await ctx.reply(
        `Current timeframes: ${tfs}\n` +
          `Change via: /timeframes 5m,15m,1h\n` +
          `Valid: ${VALID_TIMEFRAMES.join(", ")}`,
      );
    }
  }

  private async cmd_margin_amount_pct(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    const args = this._args(ctx);
    if (args.length) {
      const pct = Math.max(1.0, Math.min(Number(args[0]), 100.0));
      if (Number.isNaN(pct)) {
        await ctx.reply("Invalid value. Use a number like: /margin_amount_pct 10");
        return;
      }
      this.memory.set_setting("margin_amount_pct", pct);
      await ctx.reply(`Margin amount % set to: ${pct}%`);
    } else {
      const pct = this.memory.get_setting("margin_amount_pct", String(Config.DEFAULT_MARGIN_AMOUNT_PCT));
      await ctx.reply(
        `Current margin amount: ${pct}%\nChange via: /margin_amount_pct 15`,
      );
    }
  }

  private async cmd_margin_risk_pct(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    const args = this._args(ctx);
    if (args.length) {
      const pct = Math.max(0.1, Math.min(Number(args[0]), 10.0));
      if (Number.isNaN(pct)) {
        await ctx.reply("Invalid value. Use a number like: /margin_risk_pct 1");
        return;
      }
      this.memory.set_setting("margin_risk_pct", pct);
      await ctx.reply(`Risk % set to: ${pct}%`);
    } else {
      const pct = this.memory.get_setting("margin_risk_pct", String(Config.DEFAULT_RISK_PCT));
      await ctx.reply(`Current risk: ${pct}%\nChange via: /margin_risk_pct 1.5`);
    }
  }

  private async cmd_balance(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await ctx.reply("Fetching balance...");
    let item: Record<string, unknown>;
    try {
      item = await this.trader.risk._get_usdt_balance(true);
    } catch (error) {
      await ctx.reply(`Failed to fetch balance: ${error}`);
      return;
    }
    if (!item) {
      await ctx.reply(
        "No USDT balance returned by Toobit. Check that the API key has " +
          "futures permissions and that the futures account is opened.",
      );
      return;
    }
    const wallet = Number(item.walletBalance ?? 0);
    const available = Number(item.availableBalance ?? 0);
    const frozen = Number(item.openOrderMarginFrozen ?? item.frozen ?? 0);
    const isolated = Number(item.isolatedMargin ?? 0);
    const crossed = Number(item.crossedMargin ?? 0);
    await ctx.reply(
      `BALANCE (USDT)\n` +
        `Wallet: ${wallet.toFixed(4)}\n` +
        `Available: ${available.toFixed(4)}\n` +
        `Order Margin Frozen: ${frozen.toFixed(4)}\n` +
        `Isolated Margin: ${isolated.toFixed(4)}\n` +
        `Crossed Margin: ${crossed.toFixed(4)}\n` +
        `Recorded PnL: ${this.memory.get_total_pnl().toFixed(4)}`,
    );
  }

  private async cmd_diag(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await this._replySplit(ctx, await this.trader.diagnose());
  }

  private async cmd_midmanage(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await this._replySplit(ctx, await this.trader.run_mid_management());
  }

  private async cmd_sync(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await ctx.reply("Syncing with exchange positions...");
    await this._replySplit(ctx, await this.trader.sync_positions());
  }

  private async cmd_protect(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    await ctx.reply("Attaching stops to unprotected positions...");
    await this._replySplit(ctx, await this.trader.protect_open_positions());
  }

  private async cmd_close(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    const args = this._args(ctx);
    if (args.length) {
      const tradeId = Number(args[0]);
      if (!Number.isInteger(tradeId)) {
        await ctx.reply("Invalid trade ID.");
        return;
      }
      await this._replySplit(ctx, await this.trader.close_specific_trade(tradeId));
    } else {
      await this._replySplit(ctx, await this.trader.close_all_positions());
    }
  }

  // ---------- free text → AI ----------

  private async handle_message(ctx: Context): Promise<void> {
    if (!this._is_authorized(ctx.from?.id)) return this._unauthorized(ctx);
    const text = ctx.message?.text?.trim() ?? "";
    if (!text) return;
    if (text.startsWith("/")) {
      await ctx.reply(
        "Unknown command. Use /start for command list.\n" +
          "Or just chat with me naturally to manage your trading!",
      );
      return;
    }
    await ctx.replyWithChatAction("typing");
    const response = await this.ai.chat(text);
    await this._replySplit(ctx, response);
  }

  // ---------- wiring ----------

  private _register_handlers(): void {
    const cmd = (name: string, handler: (ctx: Context) => Promise<void>): void => {
      this.registered.add(name);
      this.bot.command(name, handler);
    };
    cmd("start", (ctx) => this.cmd_start(ctx));
    cmd("pnl", (ctx) => this.cmd_pnl(ctx));
    cmd("status", (ctx) => this.cmd_status(ctx));
    cmd("balance", (ctx) => this.cmd_balance(ctx));
    cmd("autotrade_on", (ctx) => this.cmd_autotrade_on(ctx));
    cmd("autotrade_off", (ctx) => this.cmd_autotrade_off(ctx));
    cmd("signal", (ctx) => this.cmd_signal(ctx));
    cmd("settings", (ctx) => this.cmd_settings(ctx));
    cmd("check_ai", (ctx) => this.cmd_check_ai(ctx));
    cmd("timeframes", (ctx) => this.cmd_timeframes(ctx));
    cmd("margin_amount_pct", (ctx) => this.cmd_margin_amount_pct(ctx));
    cmd("margin_risk_pct", (ctx) => this.cmd_margin_risk_pct(ctx));
    cmd("close", (ctx) => this.cmd_close(ctx));
    cmd("diag", (ctx) => this.cmd_diag(ctx));
    cmd("sync", (ctx) => this.cmd_sync(ctx));
    cmd("protect", (ctx) => this.cmd_protect(ctx));
    cmd("midmanage", (ctx) => this.cmd_midmanage(ctx));
    this.registered.add(FREE_TEXT);
    this.bot.on("message:text", (ctx) => this.handle_message(ctx));
  }

  /** Register the bot-command menu; called before polling starts. */
  async registerBotCommands(): Promise<void> {
    await this.bot.api.setMyCommands(MENU_COMMANDS);
    logger.info("Bot commands menu registered");
  }

  /** Start long polling (blocks until stopped). */
  async run(): Promise<void> {
    this._register_handlers();
    await this.registerBotCommands();
    logger.info("Telegram bot polling started");
    await this.bot.start();
  }

  /** For tests: register handlers without starting polling. */
  init(): void {
    this._register_handlers();
  }

  /** Expose the grammY bot for tests to drive updates against. */
  get botInstance(): Bot {
    return this.bot;
  }
}
