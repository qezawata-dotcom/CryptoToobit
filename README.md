# CryptoToobit

AI-powered Telegram trading bot for **Toobit USDT-M futures** — a from-scratch
TypeScript port of [CryptoMind-XT](https://github.com/Qezawat/CryptoMind-XT),
a Python bot for XT.com futures. Same feature set, different exchange.

- **Language**: TypeScript, Node.js ≥ 20 (no TA library — indicators are plain TS)
- **Exchange**: Toobit USDT-M futures (`BTC-SWAP-USDT` symbols)
- **Chat**: Telegram via [grammY](https://grammy.dev) — 17 commands + free-text AI
- **AI**: OpenAI-compatible function-calling assistant (20 tools)
- **Strategy**: EMA/MACD/RSI/Momentum consensus across multiple timeframes
- **Risk**: margin%/risk% sizing, leverage tiers from `riskLimits`, TP/SL
  automation with breakeven + trailing
- **Martingale**: optional basket engine (aggressive/balanced/conservative
  profiles, AI or manual mode) — see below

## Feature set

| Area | What it does |
|---|---|
| **Telegram** | `/start /pnl /status /balance /autotrade_on /autotrade_off /signal /settings /check_ai /timeframes /margin_amount_pct /margin_risk_pct /close [id] /diag /sync /protect /midmanage` + free text → AI |
| **AI assistant** | 20 function-calling tools: open/close trades, set leverage/margin/timeframes, scan signals, mid-manage, status, PnL, balance … ~30-message window, max 5 function-call rounds |
| **Strategies** | EMA 9/21 crossover, MACD 12/26/9 histogram, RSI-14 (Wilder), Momentum 10/0.005 with 1.2× volume surge. Consensus = confidence mass per side, not vote count |
| **Multi-timeframe scan** | Per-timeframe gate at `tf_min_confidence`, weighted vote (`TF_WEIGHTS`), `confidence = int(strength × agreement × 100)` |
| **Risk** | Margin% and risk% position sizing, min/max qty + notional validation, `round_price` to tick size, balance cache (3 s), `get_tradable_balance` = wallet − frozen |
| **Positions** | TP/SL attach (3 retries), breakeven at ROI threshold, trailing stop, dynamic ATR TP/SL, adopt/reconcile against the exchange, close reads PnL before closing + cooldown |
| **Auto-trade** | Guard loop (15 s) → scan (60 s) → mid-manage (300 s). Software max-loss/max-profit stops as a safety net |
| **Martingale** | Basket engine: adds on adverse moves (`qty = base × multiplier^(adds+1)`), average entry drags to the market, shallow-rebound TP exits the whole basket, SL clamped inside the liquidation price |

## Architecture

```
src/
├── main.ts               bootstrap: env validation, checkApiKey sanity check,
│                         health server, memory seed, crash recovery
├── config.ts             env surface + seeded settings defaults
├── logger.ts             pino with sensitive-field redaction
├── types.ts
├── exchange/
│   ├── toobitClient.ts   HMAC signing, transport, error mapping, retry/token bucket
│   ├── endpoints.ts      path constants
│   ├── normalize.ts      response-field aliasing → canonical
│   └── futuresExchange.ts
└── bot/
    ├── memory.ts         better-sqlite3, 7 tables
    ├── strategies.ts     EMA/MACD/RSI/Momentum + consensus
    ├── signalScanner.ts
    ├── riskManager.ts
    ├── positionManager.ts
    ├── trader.ts         gates, execute_trade, auto-trade loop
    ├── martingale.ts     basket state machine
    ├── aiChat.ts / aiTools.ts
    └── telegramBot.ts    grammY: 17 commands + free-text AI
```

Data lives in a single SQLite file (`DATABASE_PATH`): chat history, trades,
signals, settings, cooldowns, AI context, and martingale baskets.

## Setup

### Requirements

- Node.js ≥ 20 (better-sqlite3 needs a version with prebuilt binaries)
- A Toobit account + API key with **futures trade** (write) and read permissions
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenAI-compatible API key (any provider; set `AI_BASE_URL`/`AI_MODEL`)

### Local

```bash
npm install
cp .env.example .env        # fill in TOOBIT_API_KEY, TOOBIT_API_SECRET,
                            # AI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID
npm run build
npm start
```

`npm run dev` runs with `tsx watch` for development.

On boot the bot:
1. validates the required environment variables,
2. calls Toobit's `checkApiKey` as a sanity check (fatal on auth failure),
3. seeds default settings into SQLite (no-clobber),
4. recovers any martingale baskets a previous run left behind,
5. starts the health server (for Railway) and long-polls Telegram.

### Railway

1. Create a new service from this repo (Railway detects Node.js via Nixpacks).
2. Set the environment variables from `.env.example`.
3. **Attach a Volume** with mount path `/data` (persistence).
4. Set `DATABASE_PATH=/data/memory.db`.
5. Deploy — `railway.toml` sets the health check to `/health`.

Without a volume the SQLite file is ephemeral and resets on every redeploy.

## Safety

- The bot **only acts on your command or an explicit signal** — autotrade is off
  by default and must be turned on with `/autotrade_on`.
- Every trade carries a TP/SL. If the exchange rejects the protective order,
  the trader's default behavior is to close the position rather than leave it
  unprotected (`on_tpsl_failure`).
- Software max-loss / max-profit stops run as a second safety net on top of the
  exchange orders.
- Leverage is validated against Toobit's risk limits per symbol.
- **Futures trading is high-risk.** Test with small size and understand the
  martingale engine before enabling it. There is no guaranteed profit.

## Martingale

The martingale engine is off by default. Turn it on with:

```
/settings   # or ask the AI: "enable martingale"
```

- **Risk profiles** (AI mode): `aggressive` (add every 1.5%, 2.5×, 8 adds),
  `balanced` (2.5%, 2.0×, 5 adds), `conservative` (4.0%, 1.5×, 3 adds).
- **Manual mode**: override `add_interval_pct`, `size_multiplier`, `max_adds`,
  `tp_pct` directly.
- A basket opens a position, then adds on adverse moves, dragging the average
  entry toward the market so a small rebound takes the whole basket out at the
  TP. The SL is clamped to stay inside the liquidation price.
- A `max_margin_pct` cap blocks further adds once the basket's notional would
  exceed the configured share of your balance.
- `MARTINGALE` trades appear in `/status` and `/pnl` like any other trade.

## Testing

Tests are hermetic — `api.toobit.com` is unreachable from the dev environment,
so they run against an in-memory mock exchange with golden fixtures, and an
accidental live call would fail loudly (`TOOBIT_API_BASE_URL` points at a dead
port in CI).

```bash
npm test        # 122 tests: client, strategies, risk, positions, trader,
                # martingale state machine, memory, Telegram/AI routing
```

## Repository

- Source: [github.com/Qezawat/CryptoToobit](https://github.com/Qezawat/CryptoToobit)
- Original Python reference: [CryptoMind-XT](https://github.com/Qezawat/CryptoMind-XT)

_Not financial advice. Trade at your own risk._
