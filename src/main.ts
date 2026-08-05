import http from "node:http";
import { Config } from "./config.js";
import { logger } from "./logger.js";
import { LongTermMemory } from "./bot/memory.js";
import { ToobitClient } from "./exchange/toobitClient.js";
import { StrategyEngine } from "./bot/strategies.js";
import { SignalScanner } from "./bot/signalScanner.js";
import { RiskManager } from "./bot/riskManager.js";
import { PositionManager } from "./bot/positionManager.js";
import { ToobitTrader } from "./bot/trader.js";
import { AIChat } from "./bot/aiChat.js";
import { TelegramBot } from "./bot/telegramBot.js";

/**
 * CryptoToobit entry point.
 *
 * M5 wiring: memory → exchange client → strategies/scanner/risk/positions →
 * trader → AI assistant → Telegram bot. The health server on PORT gives
 * Railway its liveness probe; the bot long-polls in the background.
 */

function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", bot: "cryptotoobit" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  server.listen(Config.PORT, () => {
    logger.info({ port: Config.PORT }, "health server listening");
  });
  return server;
}

export async function main(): Promise<void> {
  // 1. Required credentials must be present. Missing vars are reported
  //    together and the process refuses to start (same as Config.validate()).
  const missing = Config.validate();
  if (missing.length > 0) {
    logger.error(
      { missing },
      "Missing required environment variables — refusing to start. See .env.example.",
    );
    process.exitCode = 1;
    return;
  }

  // 2. Persistence. Seeding is no-clobber: user settings survive restarts.
  const memory = new LongTermMemory();
  const seeded = memory.seed_defaults(Config.defaultSettings());
  if (seeded > 0) {
    logger.info({ seeded }, "settings table seeded with defaults");
  }
  // Crash recovery: baskets abandoned by a previous run are closed.
  const stale = memory.close_stale_martingale_states();
  if (stale > 0) logger.info({ stale }, "stale martingale states closed");

  // 3. Exchange client + bot core.
  const exchange = new ToobitClient();
  const engine = new StrategyEngine();
  const scanner = new SignalScanner(exchange, memory);
  const risk = new RiskManager(exchange, memory);
  const positions = new PositionManager(exchange, memory, risk);
  const trader = new ToobitTrader(exchange, memory, scanner, engine, risk, positions);

  // 4. AI assistant (function-calling loop bound to the trader).
  const ai = new AIChat(memory, engine);
  ai.bind_trader(trader);

  // 5. Telegram bot: commands + free-text AI + trader notifications.
  const bot = new TelegramBot(trader, ai, memory);
  void bot.run().catch((err) => {
    logger.error({ err }, "Telegram bot stopped");
    process.exitCode = 1;
  });

  // 6. Health server (also gives Railway its liveness probe).
  startHealthServer();

  logger.info(
    { symbol: Config.DEFAULT_SYMBOL, db: Config.DATABASE_PATH },
    "CryptoToobit booted — trading, Telegram and AI online",
  );
}

// Run only when executed directly (not when imported by tests).
const isMain =
  typeof process !== "undefined" &&
  (process.argv[1] === new URL(import.meta.url).pathname ||
    process.argv[1]?.endsWith("/dist/main.js"));

if (isMain) {
  main();
}

export { Config, logger, LongTermMemory };
