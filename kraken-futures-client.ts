// kraken-futures-client.ts  (Node >= 18, no dependencies)
// Client for the Kraken Futures (derivatives) REST API: public market data, account state and trading.
// Docs: https://docs.kraken.com/api/docs/guides/futures-rest  (a separate exchange from Kraken spot:
// other base URL, other API keys, other signature, other symbols).
//
// Built for a trading bot, so it errs on the safe side:
// - sendOrder() and editOrder() throw unless the client was created with { tradingEnabled: true }.
//   There is no "validate" flag on Futures, and the demo environment was shut down in July 2026.
// - sendOrder() and editOrder() are never retried: after a network error the order may or may not
//   exist. Always set cliOrdId and reconcile through openOrders()/fills() before trying again.
// - Cancels and the dead-man switch only reduce risk, so they are allowed even with trading disabled
//   and are retried like reads.
// - An HTTP 200 with result "success" can still carry a rejected order (sendStatus.status, e.g.
//   "insufficientAvailableFunds"); those become KrakenFuturesError with kind "rejected".
//
// Symbols: PF_XBTUSD, PF_ETHUSD ... (PF_ = linear multi-collateral perpetual, PI_ = inverse perpetual,
// FF_/FI_ = fixed maturity). Sizes are in contracts; for PF_ contracts 1 contract = 1 unit of the base.

import { createHash, createHmac } from "node:crypto";
import { CounterLimiter, TtlCache, isTransient, withRetry } from "./http-utils.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("kraken-futures");

const BASE_URL = "https://futures.kraken.com";
const API_PREFIX = "/derivatives/api/v3";

export const KRAKEN_FUTURES_RESOLUTIONS = ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d", "1w"] as const;
export type KrakenFuturesResolution = (typeof KRAKEN_FUTURES_RESOLUTIONS)[number];

export type KrakenFuturesErrorKind = "http" | "api" | "rejected" | "network" | "parse" | "config";

export class KrakenFuturesError extends Error {
  readonly kind: KrakenFuturesErrorKind;
  readonly status: number | undefined;
  // API error code ("apiLimitExceeded", "authenticationError", ...) or, for kind "rejected",
  // the order status ("insufficientAvailableFunds", "wouldCauseLiquidation", ...).
  readonly code: string | undefined;

  constructor(message: string, kind: KrakenFuturesErrorKind, status?: number, code?: string) {
    super(message);
    this.name = "KrakenFuturesError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

function isRetryableFuturesError(e: unknown): boolean {
  if (isTransient(e)) return true;
  const err = e as KrakenFuturesError;
  return err.kind === "api" && (err.code === "apiLimitExceeded" || err.code === "Server Error" || err.code === "Unavailable");
}

// --- public types ---

export interface FuturesInstrument {
  symbol: string;
  type: string; // "flexible_futures", "futures_inverse", ...
  tradeable: boolean;
  tickSize: number;
  contractSize: number;
  contractValueTradePrecision: number; // size decimals; may be negative (sizes in multiples of 10^-p)
  maxPositionSize?: number;
  base?: string;
  quote?: string;
  isExpired?: boolean;
  postOnly?: boolean;
}

export interface FuturesTicker {
  symbol: string;
  tag?: string; // "perpetual", "month", ...
  pair?: string;
  last: number;
  markPrice: number;
  indexPrice?: number;
  bid: number;
  ask: number;
  vol24h: number; // contracts
  volumeQuote?: number; // quote currency
  openInterest: number; // contracts
  open24h?: number;
  high24h?: number;
  low24h?: number;
  change24h?: number; // percent
  fundingRate?: number; // absolute funding per contract per hour, in quote currency
  fundingRatePrediction?: number;
  suspended: boolean;
  postOnly?: boolean;
}

export interface FuturesCandle {
  t: number; // epoch seconds, interval start
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // contracts
}

export interface FuturesFundingRate {
  t: number; // epoch seconds
  fundingRate: number; // absolute, quote currency per contract
  relativeFundingRate: number; // fraction of the price per funding period (1 h)
}

export interface FuturesOrderBook {
  symbol: string;
  bids: { price: number; size: number }[]; // best (highest) first
  asks: { price: number; size: number }[]; // best (lowest) first
}

// --- private types ---

export interface FuturesPosition {
  symbol: string;
  side: "long" | "short";
  size: number; // always positive, see `side`
  price: number; // average entry
  unrealizedPnl?: number;
  unrealizedFunding: number | null;
  pnlCurrency?: string;
}

export interface FuturesOpenOrder {
  order_id: string;
  cliOrdId?: string;
  symbol: string;
  side: "buy" | "sell";
  orderType: "lmt" | "stp" | "take_profit";
  status: "untouched" | "partiallyFilled";
  limitPrice?: number;
  stopPrice?: number;
  filledSize: number;
  unfilledSize?: number;
  reduceOnly: boolean;
  triggerSignal?: "mark" | "last" | "spot";
  receivedTime: string;
  lastUpdateTime: string;
}

export interface FuturesFill {
  fill_id: string;
  order_id: string;
  cliOrdId?: string | null;
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  fillTime: string;
  fillType: string; // "maker", "taker", "liquidation", ...
  realized_pnl?: number | null;
}

// The multi-collateral ("flex") margin account, which is what PF_ contracts trade against.
// Fields are optional because their schema has not been checked against a real account yet.
export interface FuturesFlexAccount {
  portfolioValue?: number; // collateral + unrealized PnL, USD
  balanceValue?: number;
  collateralValue?: number;
  marginEquity?: number;
  availableMargin?: number; // margin equity minus initial margin
  initialMargin?: number;
  initialMarginWithOrders?: number;
  maintenanceMargin?: number;
  pnl?: number;
  unrealizedFunding?: number;
  totalUnrealized?: number;
}

export type FuturesOrderType = "lmt" | "post" | "mkt" | "stp" | "take_profit" | "ioc" | "fok" | "trailing_stop";

export interface FuturesOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  orderType: FuturesOrderType;
  size: number; // contracts; round with roundSize() first
  limitPrice?: number;
  stopPrice?: number;
  cliOrdId?: string; // max 100 chars, unique – set it on every bot order
  reduceOnly?: boolean;
  triggerSignal?: "mark" | "index" | "last";
  trailingStopMaxDeviation?: number;
  trailingStopDeviationUnit?: "PERCENT" | "QUOTE_CURRENCY";
  processBefore?: string; // ISO 8601: reject the order if it is not processed by then
}

export interface FuturesSendStatus {
  order_id?: string;
  cliOrdId?: string | null;
  status: string; // "placed", "partiallyFilled", "filled", or a rejection reason
  receivedTime?: string;
  orderEvents?: unknown[];
}

// Statuses for which the exchange accepted the order (or edit).
const ACCEPTED = new Set(["placed", "partiallyFilled", "filled", "edited"]);

export interface KrakenFuturesClientOptions {
  apiKey?: string; // defaults to process.env.KRAKEN_FUTURES_API_KEY
  apiSecret?: string; // base64, defaults to process.env.KRAKEN_FUTURES_API_SECRET
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  tradingEnabled?: boolean; // default false: sendOrder/editOrder throw
  cacheTtlMs?: number; // memory cache for public data; 0 = always fresh (default)
  counterMax?: number; // derivatives budget: 500 ...
  counterDecayPerSec?: number; // ... replenished at 500 per 10 s
}

// Authent = base64(HMAC-SHA512(base64decode(secret), SHA256(postData + nonce + endpointPath))),
// where endpointPath is the request path without the "/derivatives" prefix, e.g. "/api/v3/sendorder".
export function krakenFuturesSignature(endpointPath: string, nonce: string, postData: string, secretBase64: string): string {
  const path = endpointPath.startsWith("/derivatives") ? endpointPath.slice("/derivatives".length) : endpointPath;
  const hash = createHash("sha256").update(postData + nonce + path).digest();
  return createHmac("sha512", Buffer.from(secretBase64, "base64")).update(hash).digest("base64");
}

// Rounds a size DOWN to the instrument's precision (never sends more than intended).
export function roundSize(instrument: FuturesInstrument, size: number): number {
  const factor = 10 ** instrument.contractValueTradePrecision;
  return Math.floor(size * factor + 1e-9) / factor;
}

// Rounds a price to the tick size: down for buys, up for sells (never a worse price than given).
export function roundPrice(instrument: FuturesInstrument, price: number, side: "buy" | "sell"): number {
  const ticks = price / instrument.tickSize;
  const rounded = side === "buy" ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
  return Number((rounded * instrument.tickSize).toPrecision(12));
}

const num = (v: unknown) => Number(v);

export class KrakenFuturesClient {
  private readonly apiKey: string | undefined;
  private readonly apiSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  readonly tradingEnabled: boolean;
  private readonly limiter: CounterLimiter;
  private readonly cache = new TtlCache();
  private lastNonce = 0;

  constructor(opts: KrakenFuturesClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.KRAKEN_FUTURES_API_KEY;
    this.apiSecret = opts.apiSecret ?? process.env.KRAKEN_FUTURES_API_SECRET;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.cacheTtlMs = opts.cacheTtlMs ?? 0;
    this.tradingEnabled = opts.tradingEnabled ?? false;
    this.limiter = new CounterLimiter(log, opts.counterMax ?? 500, opts.counterDecayPerSec ?? 50);
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  // --- public market data ---

  // Contract specs (tick size, size precision, max position). Cached for 1 hour.
  async instruments(): Promise<FuturesInstrument[]> {
    const data = await this.get<{ instruments: FuturesInstrument[] }>("/instruments", {}, { ttlMs: 60 * 60_000 });
    return data.instruments;
  }

  async instrument(symbol: string): Promise<FuturesInstrument> {
    const found = (await this.instruments()).find((i) => i.symbol.toUpperCase() === symbol.toUpperCase());
    if (!found) throw new KrakenFuturesError(`Unknown futures symbol: ${symbol}`, "api", undefined, "unknownSymbol");
    return found;
  }

  async tickers(symbols?: string[]): Promise<FuturesTicker[]> {
    const data = await this.get<{ tickers: FuturesTicker[] }>("/tickers");
    if (!symbols) return data.tickers;
    const wanted = new Set(symbols.map((s) => s.toUpperCase()));
    return data.tickers.filter((t) => wanted.has(t.symbol.toUpperCase()));
  }

  async orderBook(symbol: string, depth = 10): Promise<FuturesOrderBook> {
    const data = await this.get<{ orderBook: { bids: [number, number][]; asks: [number, number][] } }>("/orderbook", { symbol });
    const level = ([price, size]: [number, number]) => ({ price: num(price), size: num(size) });
    return {
      symbol,
      bids: data.orderBook.bids.map(level).sort((a, b) => b.price - a.price).slice(0, depth),
      asks: data.orderBook.asks.map(level).sort((a, b) => a.price - b.price).slice(0, depth),
    };
  }

  // One page of trade-price candles (max 2000). `from`/`to` are epoch seconds.
  async candles(
    symbol: string, resolution: KrakenFuturesResolution, range: { from?: number; to?: number } = {},
  ): Promise<{ candles: FuturesCandle[]; moreCandles: boolean }> {
    type Raw = { time: number; open: string; high: string; low: string; close: string; volume: string };
    const params: Record<string, string> = {};
    if (range.from !== undefined) params.from = String(range.from);
    if (range.to !== undefined) params.to = String(range.to);
    const data = await this.get<{ candles: Raw[]; more_candles: boolean }>(
      `/api/charts/v1/trade/${encodeURIComponent(symbol)}/${resolution}`, params, { raw: true },
    );
    return {
      moreCandles: data.more_candles,
      candles: data.candles.map((r) => ({
        t: Math.floor(r.time / 1000), o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume),
      })),
    };
  }

  // Hourly funding history (the whole history in one response; newest last).
  async fundingRates(symbol: string): Promise<FuturesFundingRate[]> {
    type Raw = { timestamp: string; fundingRate: number; relativeFundingRate: number };
    const data = await this.get<{ rates: Raw[] }>("/derivatives/api/v4/historicalfundingrates", { symbol }, { raw: true });
    return data.rates.map((r) => ({
      t: Math.floor(Date.parse(r.timestamp) / 1000), fundingRate: num(r.fundingRate), relativeFundingRate: num(r.relativeFundingRate),
    }));
  }

  // --- private: account (read-only) ---

  accounts() {
    return this.private<{ accounts: Record<string, Record<string, unknown>> }>("GET", "/accounts", {}, 2);
  }

  async flexAccount(): Promise<FuturesFlexAccount> {
    const flex = (await this.accounts()).accounts.flex;
    if (!flex) throw new KrakenFuturesError("No flex (multi-collateral) account in /accounts response", "parse");
    const fields: (keyof FuturesFlexAccount)[] = [
      "portfolioValue", "balanceValue", "collateralValue", "marginEquity", "availableMargin", "initialMargin",
      "initialMarginWithOrders", "maintenanceMargin", "pnl", "unrealizedFunding", "totalUnrealized",
    ];
    return Object.fromEntries(fields.filter((f) => typeof flex[f] === "number").map((f) => [f, flex[f]]));
  }

  async openPositions(): Promise<FuturesPosition[]> {
    return (await this.private<{ openPositions: FuturesPosition[] }>("GET", "/openpositions", {}, 2)).openPositions;
  }

  async openOrders(): Promise<FuturesOpenOrder[]> {
    return (await this.private<{ openOrders: FuturesOpenOrder[] }>("GET", "/openorders", {}, 2)).openOrders;
  }

  // The 100 most recent fills, or the 100 before `lastFillTime` (ISO 8601).
  async fills(lastFillTime?: string): Promise<FuturesFill[]> {
    return (await this.private<{ fills: FuturesFill[] }>("GET", "/fills", stringify({ lastFillTime }), 2)).fills;
  }

  // --- private: trading ---

  async sendOrder(order: FuturesOrderRequest): Promise<FuturesSendStatus> {
    this.assertTradingEnabled();
    log.warn("placing LIVE futures order", {
      symbol: order.symbol, side: order.side, orderType: order.orderType, size: order.size,
      limitPrice: order.limitPrice, stopPrice: order.stopPrice, reduceOnly: order.reduceOnly, cliOrdId: order.cliOrdId,
    });
    const data = await this.private<{ sendStatus: FuturesSendStatus }>("POST", "/sendorder", stringify({ ...order }), 10, false);
    return this.checkAccepted("sendorder", data.sendStatus);
  }

  // Edits size or prices of an open order, identified by orderId or cliOrdId.
  async editOrder(edit: { orderId?: string; cliOrdId?: string; size?: number; limitPrice?: number; stopPrice?: number }) {
    this.assertTradingEnabled();
    log.warn("editing LIVE futures order", { ...edit });
    const data = await this.private<{ editStatus: FuturesSendStatus }>("POST", "/editorder", stringify({ ...edit }), 10, false);
    return this.checkAccepted("editorder", data.editStatus);
  }

  // Returns "cancelled", "filled" (too late) or "notFound".
  async cancelOrder(id: { orderId?: string; cliOrdId?: string }): Promise<{ status: string; order_id?: string }> {
    log.warn("cancelling futures order", { ...id });
    const params = stringify({ order_id: id.orderId, cliOrdId: id.cliOrdId });
    return (await this.private<{ cancelStatus: { status: string; order_id?: string } }>("POST", "/cancelorder", params, 10)).cancelStatus;
  }

  // Cancels all open orders, optionally only for one symbol. Positions stay open.
  async cancelAllOrders(symbol?: string): Promise<{ status: string; cancelledOrders?: unknown[] }> {
    log.warn("cancelling ALL futures orders", { symbol });
    const params = stringify({ symbol });
    return (await this.private<{ cancelStatus: { status: string; cancelledOrders?: unknown[] } }>("POST", "/cancelallorders", params, 25)).cancelStatus;
  }

  // Dead-man switch: all orders are cancelled `timeoutSec` seconds from now unless this is called
  // again before then. 0 turns it off. Kraken recommends a 60 s timeout refreshed every 15–30 s.
  async deadMansSwitch(timeoutSec: number): Promise<{ currentTime: string; triggerTime: string }> {
    const data = await this.private<{ status: { currentTime: string; triggerTime: string } }>(
      "POST", "/cancelallordersafter", { timeout: String(Math.round(timeoutSec)) }, 25,
    );
    log.debug("dead-man switch armed", { ...data.status });
    return data.status;
  }

  // --- core ---

  private assertTradingEnabled() {
    if (!this.tradingEnabled) {
      throw new KrakenFuturesError("Trading is disabled; create the client with { tradingEnabled: true }", "config");
    }
  }

  private checkAccepted(endpoint: string, status: FuturesSendStatus): FuturesSendStatus {
    if (!status || !ACCEPTED.has(status.status)) {
      log.warn("futures order rejected", { endpoint, status: status?.status, cliOrdId: status?.cliOrdId });
      throw new KrakenFuturesError(`Order rejected: ${status?.status ?? "no status"}`, "rejected", 200, status?.status);
    }
    return status;
  }

  // Public GET. `raw` paths are used as given (charts, v4); others go under /derivatives/api/v3.
  private async get<T>(path: string, params: Record<string, string> = {}, opts: { ttlMs?: number; raw?: boolean } = {}): Promise<T> {
    const url = new URL(opts.raw ? path : API_PREFIX + path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const ttlMs = opts.ttlMs ?? this.cacheTtlMs;
    const hit = this.cache.get<T>(url.toString());
    if (hit !== undefined) {
      log.debug("memory cache hit", { path });
      return hit;
    }
    const value = await withRetry(
      () => this.limiter.run(1, () => this.send<T>(path, url, { method: "GET" })),
      { maxRetries: this.maxRetries, log, label: path, isRetryable: isRetryableFuturesError },
    );
    this.cache.set(url.toString(), value, ttlMs);
    return value;
  }

  // `cost` is the call's weight in the derivatives budget. `retry` must be false for order placement.
  private private<T>(method: "GET" | "POST", path: string, params: Record<string, string>, cost: number, retry = true): Promise<T> {
    if (!this.apiKey || !this.apiSecret) {
      return Promise.reject(new KrakenFuturesError("KRAKEN_FUTURES_API_KEY and KRAKEN_FUTURES_API_SECRET are not set", "config"));
    }
    const apiKey = this.apiKey;
    const apiSecret = this.apiSecret;
    const fullPath = API_PREFIX + path;

    const attempt = () =>
      this.limiter.run(cost, () => {
        // A fresh nonce for every attempt.
        const nonce = String((this.lastNonce = Math.max(Date.now() * 1000, this.lastNonce + 1)));
        // The signed postData is exactly the url-encoded string that is sent (query for GET, body for POST).
        const postData = new URLSearchParams(params).toString();
        const url = new URL(fullPath, this.baseUrl);
        if (method === "GET" && postData) url.search = postData;
        const headers: Record<string, string> = {
          APIKey: apiKey,
          Nonce: nonce,
          Authent: krakenFuturesSignature(fullPath, nonce, postData, apiSecret),
        };
        if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
        return this.send<T>(path, url, { method, headers, ...(method === "POST" ? { body: postData } : {}) });
      });

    return withRetry(attempt, {
      maxRetries: retry ? this.maxRetries : 0,
      log,
      label: path,
      isRetryable: isRetryableFuturesError,
    });
  }

  private async send<T>(path: string, url: URL, init: RequestInit): Promise<T> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { accept: "application/json", ...init.headers },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      log.warn("api request failed", { path, ms: Date.now() - started, error: e });
      throw new KrakenFuturesError(`Network error/timeout: ${(e as Error).message}`, "network");
    }

    let body: { result?: string; error?: string; errors?: { code?: number; message?: string }[] } & Record<string, unknown>;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      if (!res.ok) {
        log.warn("api request failed", { path, status: res.status, ms: Date.now() - started });
        throw new KrakenFuturesError(`HTTP ${res.status}`, "http", res.status);
      }
      throw new KrakenFuturesError("Invalid JSON in response", "parse");
    }

    // Errors come either as { result: "error", error: "authenticationError" } (often with HTTP 200)
    // or as { result: "error", errors: [{ code, message }] }.
    const code = body.error ?? body.errors?.[0]?.message;
    if (body.result === "error" || !res.ok) {
      log.warn("api error", { path, status: res.status, error: code, ms: Date.now() - started });
      throw new KrakenFuturesError(
        code ? `Kraken Futures error: ${code}` : `HTTP ${res.status}`, res.ok ? "api" : "http", res.status, code,
      );
    }
    log.info("api request", { path, status: res.status, ms: Date.now() - started });
    return body as T;
  }
}

// Drops undefined values and turns the rest into strings for form/query encoding.
function stringify(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
  );
}
