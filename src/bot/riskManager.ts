import { Config } from "../config.js";
import { logger } from "../logger.js";
import { toBalance, toRiskLimit, findContractInfo } from "../exchange/normalize.js";
import type { FuturesExchange } from "../exchange/futuresExchange.js";
import type { RawExchangeInfo } from "../exchange/types.js";
import type { LongTermMemory } from "./memory.js";

/**
 * RiskManager — a port of CryptoMind-XT/bot/risk_manager.py onto Toobit.
 *
 * Everything that needs symbol metadata reads it from the exchange (exchangeInfo
 * for contract size / qty / notional / tick, riskLimits for leverage tiers),
 * cached per symbol. Balance is cached for BALANCE_CACHE_TTL seconds because the
 * account endpoints are rate-limited; sizing follows the reference exactly:
 *
 *   size_by_margin_pct = int(balance × (margin_pct/100) × leverage / (price × contractSize))
 *   size_by_risk_pct   = int(balance × (risk_pct/100) / (|price − stop| × contractSize))
 *   tradable balance   = walletBalance − openOrderMarginFrozen
 */

const BALANCE_CACHE_TTL = 3.0;

/** Normalised per-symbol trading rules (Toobit exchangeInfo + riskLimits). */
export type SymbolConfig = {
  symbol: string;
  /** Coins per contract (e.g. 0.0001 BTC per contract for BTC-SWAP-USDT). */
  contractSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
  maxNotional: number;
  /** Decimal places derived from tick size. */
  pricePrecision: number;
  /** Minimum price step (tick size). */
  minStepPrice: number;
  supportOrderType: string[];
  supportTimeInForce: string[];
};

function precisionOf(tick: number): number {
  if (!tick || tick <= 0) return 2;
  const p = Math.round(-Math.log10(tick));
  return p < 0 ? 0 : p;
}

export class RiskManager {
  private _symbolConfigs = new Map<string, SymbolConfig>();
  private _balanceCache: Record<string, unknown> | null = null;
  private _balanceCacheAt = 0;
  private _leverageBrackets = new Map<string, { maxLeverage: number; maxNotional: number }[]>();

  constructor(
    private exchange: FuturesExchange,
    private memory: LongTermMemory,
  ) {}

  // ---------- symbol metadata ----------

  async get_symbol_config(symbol: string): Promise<SymbolConfig> {
    const cached = this._symbolConfigs.get(symbol);
    if (cached) return cached;
    const cfg = await this._build_symbol_config(symbol);
    this._symbolConfigs.set(symbol, cfg);
    return cfg;
  }

  private async _build_symbol_config(symbol: string): Promise<SymbolConfig> {
    let ci = { contract_size: 0, min_qty: 0, max_qty: 0, min_notional: 0, max_notional: 0, tick_size: 0, max_leverage: 0 };
    try {
      const res = await this.exchange.getExchangeInfo();
      const found = findContractInfo(res.data as unknown as RawExchangeInfo, symbol);
      if (found) ci = found;
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "exchangeInfo fetch failed; using defaults");
    }
    const contractSize = ci.contract_size || 1;
    const tick = ci.tick_size || 0;
    return {
      symbol,
      contractSize,
      minQty: ci.min_qty || 1,
      maxQty: ci.max_qty || 0,
      minNotional: ci.min_notional || 0,
      maxNotional: ci.max_notional || 0,
      pricePrecision: precisionOf(tick),
      minStepPrice: tick,
      supportOrderType: ["LIMIT", "MARKET", "STOP"],
      supportTimeInForce: ["GTC", "IOC", "FOK"],
    };
  }

  async get_contract_size(symbol: string): Promise<number> {
    return (await this.get_symbol_config(symbol)).contractSize;
  }

  async get_min_qty(symbol: string): Promise<number> {
    return (await this.get_symbol_config(symbol)).minQty;
  }

  async get_min_notional(symbol: string): Promise<number> {
    return (await this.get_symbol_config(symbol)).minNotional;
  }

  async get_max_notional(symbol: string): Promise<number> {
    return (await this.get_symbol_config(symbol)).maxNotional;
  }

  async get_max_order_qty(symbol: string): Promise<number> {
    // Toobit has a single per-order max (maxQty); no MARKET/LIMIT split.
    return (await this.get_symbol_config(symbol)).maxQty;
  }

  async get_price_precision(symbol: string): Promise<number> {
    return (await this.get_symbol_config(symbol)).pricePrecision;
  }

  async get_price_step(symbol: string): Promise<number> {
    return (await this.get_symbol_config(symbol)).minStepPrice;
  }

  async round_price(symbol: string, price: number): Promise<number> {
    const cfg = await this.get_symbol_config(symbol);
    if (cfg.minStepPrice > 0) {
      price = Math.floor(price / cfg.minStepPrice) * cfg.minStepPrice;
    }
    return Number(price.toFixed(cfg.pricePrecision));
  }

  async supports_order_type(symbol: string, orderType: string): Promise<boolean> {
    const cfg = await this.get_symbol_config(symbol);
    return cfg.supportOrderType.includes(orderType);
  }

  async supports_time_in_force(symbol: string, tif: string): Promise<boolean> {
    const cfg = await this.get_symbol_config(symbol);
    return cfg.supportTimeInForce.includes(tif);
  }

  // ---------- balance (rate limited: account endpoints are 20 req/s) ----------

  async _get_usdt_balance(force = false): Promise<Record<string, unknown>> {
    const now = Date.now() / 1000;
    if (!force && this._balanceCache && now - this._balanceCacheAt < BALANCE_CACHE_TTL) {
      return this._balanceCache;
    }
    let item: Record<string, unknown> = {};
    try {
      const res = await this.exchange.getFuturesBalance();
      const data = res?.data;
      if (Array.isArray(data)) {
        const found = (data as Record<string, unknown>[]).find(
          (row) => String(row?.asset ?? row?.coin ?? "").toUpperCase() === "USDT",
        );
        item = found ?? {};
      } else if (data && typeof data === "object") {
        item = data as Record<string, unknown>;
      }
    } catch (error) {
      logger.warn({ err: String(error) }, "futures balance fetch failed");
    }
    this._balanceCache = item;
    this._balanceCacheAt = now;
    return item;
  }

  invalidate_balance_cache(): void {
    this._balanceCache = null;
  }

  async get_total_balance(): Promise<number> {
    return toBalance(await this._get_usdt_balance()).wallet;
  }

  async get_available_balance(): Promise<number> {
    return toBalance(await this._get_usdt_balance()).available;
  }

  /** Balance term from the XT sizing formula: walletBalance − openOrderMarginFrozen. */
  async get_tradable_balance(): Promise<number> {
    const b = toBalance(await this._get_usdt_balance());
    return Math.max(0, b.wallet - b.frozen);
  }

  // ---------- position sizing (in contracts) ----------

  async contracts_from_coin_qty(symbol: string, coinQty: number): Promise<number> {
    const cs = await this.get_contract_size(symbol);
    if (cs <= 0) return 0;
    return Math.trunc(coinQty / cs);
  }

  async contracts_to_notional(symbol: string, contracts: number, price: number): Promise<number> {
    return contracts * (await this.get_contract_size(symbol)) * price;
  }

  async size_by_margin_pct(
    symbol: string,
    price: number,
    leverage: number,
    marginPct?: number,
  ): Promise<number> {
    if (marginPct === undefined) {
      marginPct = Number(this.memory.get_setting("margin_amount_pct") ?? Config.DEFAULT_MARGIN_AMOUNT_PCT);
    }
    const balance = await this.get_tradable_balance();
    const cs = await this.get_contract_size(symbol);
    if (balance <= 0 || price <= 0 || cs <= 0) return 0;
    return Math.trunc((balance * (marginPct / 100) * leverage) / (price * cs));
  }

  async size_by_risk_pct(
    symbol: string,
    price: number,
    stopLoss: number,
    riskPct?: number,
  ): Promise<number> {
    if (riskPct === undefined) {
      riskPct = Number(this.memory.get_setting("margin_risk_pct") ?? Config.DEFAULT_RISK_PCT);
    }
    const balance = await this.get_tradable_balance();
    const cs = await this.get_contract_size(symbol);
    const priceDiff = Math.abs(price - stopLoss);
    if (balance <= 0 || priceDiff <= 0 || cs <= 0) return 0;
    return Math.trunc((balance * (riskPct / 100)) / (priceDiff * cs));
  }

  /**
   * Returns { qty, mode, reason }. qty == 0 means the trade must be skipped.
   */
  async calculate_position_size(
    symbol: string,
    price: number,
    leverage: number,
    stopLossPrice?: number,
    orderType = "MARKET",
  ): Promise<{ qty: number; mode: string; reason: string }> {
    const useRisk = this.memory.get_setting("position_mode", "margin") === "risk";
    let qty: number;
    let mode: string;
    if (useRisk && stopLossPrice) {
      qty = await this.size_by_risk_pct(symbol, price, stopLossPrice);
      mode = "risk_based";
    } else {
      qty = await this.size_by_margin_pct(symbol, price, leverage);
      mode = "margin_based";
    }
    return this._validate_size(symbol, qty, price, mode, orderType);
  }

  private async _validate_size(
    symbol: string,
    qty: number,
    price: number,
    mode: string,
    orderType: string,
  ): Promise<{ qty: number; mode: string; reason: string }> {
    if (qty <= 0) {
      return { qty: 0, mode, reason: "computed size is 0 contracts (balance too small for one contract)" };
    }
    const minQty = await this.get_min_qty(symbol);
    if (qty < minQty) {
      return { qty: 0, mode, reason: `size ${qty} below exchange minimum ${minQty} contracts` };
    }
    const maxQty = await this.get_max_order_qty(symbol);
    let reason = "ok";
    if (maxQty && qty > maxQty) {
      logger.info(`Capping ${symbol} size ${qty} -> ${maxQty} (${orderType} limit)`);
      reason = `size capped from ${qty} to ${maxQty} (${orderType} max)`;
      qty = maxQty;
    }
    const notional = await this.contracts_to_notional(symbol, qty, price);
    const minNotional = await this.get_min_notional(symbol);
    if (minNotional && notional < minNotional) {
      return {
        qty: 0,
        mode,
        reason: `notional ${notional.toFixed(2)} USDT below minimum ${minNotional} USDT (size ${qty} contracts)`,
      };
    }
    const maxNotional = await this.get_max_notional(symbol);
    if (maxNotional && notional > maxNotional) {
      const cs = await this.get_contract_size(symbol);
      qty = Math.trunc(maxNotional / (price * cs));
      logger.info(`Capping ${symbol} to ${qty} contracts (max notional ${maxNotional})`);
      if (qty < minQty) {
        return { qty: 0, mode, reason: "max notional cap pushes size below minimum" };
      }
    }
    return { qty, mode, reason };
  }

  // ---------- leverage ----------

  private async _get_leverage_brackets(symbol: string): Promise<{ maxLeverage: number; maxNotional: number }[]> {
    const cached = this._leverageBrackets.get(symbol);
    if (cached) return cached;
    let brackets: { maxLeverage: number; maxNotional: number }[] = [];
    try {
      const res = await this.exchange.getRiskLimits(symbol);
      const data = res?.data;
      if (Array.isArray(data)) {
        brackets = (data as Record<string, unknown>[]).map((r) => {
          const t = toRiskLimit(r as never);
          return { maxLeverage: t.maxLeverage, maxNotional: t.maxNotional };
        });
      }
    } catch (error) {
      logger.warn({ symbol, err: String(error) }, "riskLimits fetch failed");
    }
    this._leverageBrackets.set(symbol, brackets);
    return brackets;
  }

  /** Max leverage allowed at a notional (or the top tier when notional unknown). */
  async get_max_leverage(symbol: string, notional?: number): Promise<number> {
    const brackets = await this._get_leverage_brackets(symbol);
    if (!brackets.length) return 1;
    const sorted = [...brackets].sort((a, b) => a.maxNotional - b.maxNotional);
    if (notional !== undefined) {
      for (const b of sorted) {
        if (notional <= b.maxNotional) return b.maxLeverage;
      }
    }
    return Math.max(...sorted.map((b) => b.maxLeverage));
  }

  async validate_leverage(symbol: string, leverage: number, notional?: number): Promise<number> {
    const maxLev = await this.get_max_leverage(symbol, notional);
    const clamped = Math.max(1, Math.min(leverage, maxLev));
    if (clamped !== leverage) {
      logger.info(`Leverage ${leverage}x clamped to ${clamped}x for ${symbol}`);
    }
    return clamped;
  }
}
