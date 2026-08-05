import http from "node:http";
import { Config } from "./config.js";
import { logger } from "./logger.js";
import { LongTermMemory } from "./bot/memory.js";

/**
 * CryptoToobit entry point.
 *
 * M1 scope: boot the memory layer (seed default settings), validate required
 * env vars, and serve a health endpoint on PORT so Railway's healthcheck and
 * the user can confirm the process is alive. Trading, Telegram and the AI loop
 * land in later milestones; this file is the single bootstrap seam they plug
 * into.
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

export function main(): void {
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

  // 3. Health server (also gives Railway its liveness probe).
  startHealthServer();

  logger.info(
    { symbol: Config.DEFAULT_SYMBOL, db: Config.DATABASE_PATH },
    "CryptoToobit booted (scaffold) — exchange client, Telegram and AI arrive in later milestones",
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
