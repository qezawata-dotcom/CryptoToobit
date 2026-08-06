/**
 * Toobit REST API path constants — authoritative, extracted from Toobit's own
 * installed MCP server (toobit-trade-mcp) and the agent-skills reference.
 *
 * Conventions:
 *   - futures symbols:  "BTC-SWAP-USDT"
 *   - spot symbols:     "BTCUSDT"
 *   - futures side:     BUY_OPEN | SELL_OPEN | BUY_CLOSE | SELL_CLOSE
 *   - private POST/PUT bodies are application/x-www-form-urlencoded
 *   - public endpoints need no auth
 */

export const ENDPOINTS = {
  // ----- market (public) -----
  SERVER_TIME: "/api/v1/time",
  EXCHANGE_INFO: "/api/v1/exchangeInfo",

  KLINES: "/quote/v1/klines",
  MARK_PRICE_KLINES: "/quote/v1/markPrice/klines",
  INDEX_KLINES: "/quote/v1/index/klines",

  CONTRACT_TICKER_24HR: "/quote/v1/contract/ticker/24hr",
  CONTRACT_TICKER_PRICE: "/quote/v1/contract/ticker/price",
  MARK_PRICE: "/quote/v1/markPrice",
  INDEX_PRICE: "/quote/v1/index",

  TICKER_24HR: "/quote/v1/ticker/24hr",
  TICKER_PRICE: "/quote/v1/ticker/price",
  TICKER_BOOK: "/quote/v1/ticker/bookTicker",
  DEPTH: "/quote/v1/depth",
  DEPTH_MERGED: "/quote/v1/depth/merged",
  TRADES: "/quote/v1/trades",

  OPEN_INTEREST: "/quote/v1/openInterest",
  GLOBAL_LONG_SHORT_RATIO: "/quote/v1/globalLongShortAccountRatio",

  FUNDING_RATE: "/api/v1/futures/fundingRate",
  HISTORY_FUNDING_RATE: "/api/v1/futures/historyFundingRate",
  INSURANCE_BY_SYMBOL: "/api/v1/futures/insuranceBySymbol",
  RISK_LIMITS: "/api/v1/futures/riskLimits",

  // ----- futures (private) -----
  FUTURES_ORDER: "/api/v1/futures/order",
  FUTURES_BATCH_ORDERS: "/api/v1/futures/batchOrders",
  FUTURES_CANCEL_ORDER_BY_IDS: "/api/v1/futures/cancelOrderByIds",
  FUTURES_ORDER_UPDATE: "/api/v1/futures/order/update",
  FUTURES_OPEN_ORDERS: "/api/v1/futures/openOrders",
  FUTURES_HISTORY_ORDERS: "/api/v1/futures/historyOrders",
  FUTURES_ORDER_GET: "/api/v1/futures/order",
  FUTURES_POSITIONS: "/api/v1/futures/positions",
  FUTURES_HISTORY_POSITIONS: "/api/v1/futures/historyPositions",
  FUTURES_LEVERAGE: "/api/v1/futures/leverage",
  FUTURES_ACCOUNT_LEVERAGE: "/api/v1/futures/accountLeverage",
  FUTURES_MARGIN_TYPE: "/api/v1/futures/marginType",
  FUTURES_TRADING_STOP: "/api/v1/futures/position/trading-stop",
  FUTURES_FLASH_CLOSE: "/api/v1/futures/flashClose",
  FUTURES_REVERSE_POSITION: "/api/v1/futures/reversePosition",
  FUTURES_POSITION_MARGIN: "/api/v1/futures/positionMargin",
  FUTURES_AUTO_ADD_MARGIN: "/api/v1/futures/autoAddMargin",
  FUTURES_USER_TRADES: "/api/v1/futures/userTrades",
  FUTURES_BALANCE: "/api/v1/futures/balance",
  FUTURES_BALANCE_FLOW: "/api/v1/futures/balanceFlow",
  FUTURES_TODAY_PNL: "/api/v1/futures/todayPnl",
  FUTURES_COMMISSION_RATE: "/api/v1/futures/commissionRate",

  // ----- account / spot (private) -----
  ACCOUNT: "/api/v1/account",
  ACCOUNT_CHECK_API_KEY: "/api/v1/account/checkApiKey",
  ACCOUNT_BALANCE_FLOW: "/api/v1/account/balanceFlow",
  ACCOUNT_TRADES: "/api/v1/account/trades",
  ACCOUNT_DEPOSIT_ADDRESS: "/api/v1/account/deposit/address",
  ACCOUNT_DEPOSIT_ORDERS: "/api/v1/account/depositOrders",
  ACCOUNT_WITHDRAW: "/api/v1/account/withdraw",
  ACCOUNT_WITHDRAW_ORDERS: "/api/v1/account/withdrawOrders",
  ACCOUNT_SUB_ACCOUNT: "/api/v1/account/subAccount",
  SUB_ACCOUNT_TRANSFER: "/api/v1/subAccount/transfer",
  SPOT_ORDER: "/api/v1/spot/order",
  SPOT_ORDER_TEST: "/api/v1/spot/orderTest",
  SPOT_BATCH_ORDERS: "/api/v1/spot/batchOrders",
  SPOT_OPEN_ORDERS: "/api/v1/spot/openOrders",
  SPOT_TRADE_ORDERS: "/api/v1/spot/tradeOrders",
  SPOT_CANCEL_ORDER_BY_IDS: "/api/v1/spot/cancelOrderByIds",
} as const;

export const CANDLE_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const;

export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const FUTURES_SIDE = ["BUY_OPEN", "SELL_OPEN", "BUY_CLOSE", "SELL_CLOSE"] as const;
export type FuturesSide = (typeof FUTURES_SIDE)[number];
