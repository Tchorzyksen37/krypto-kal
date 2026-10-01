// kraken-client.ts  (Node >= 18, no dependencies)
// Client for the Kraken spot REST API: public market data and private account/trading endpoints.
// Docs: https://docs.kraken.com/api/
//
// Built as the base for a trading bot, so it errs on the safe side:
// - addOrder() only VALIDATES by default (validate=true); pass { validate: false } to place a real order.
// - Calls that change state (addOrder, cancelOrder, cancelAll) are never retried automatically –
//   a retry after a network error could place or cancel twice.
// - Private calls respect Kraken's API counter (tier "Starter": max 15, decays 0.33/s).
//
// Pairs: XBTUSD, ETHEUR, XBTPLN ... (Kraken uses XBT for bitcoin). Result keys may use Kraken's
// internal names (e.g. XXBTZUSD), which is why ticker() returns the key as `pair`.

import { createHash, createHmac } from "node:crypto";
import { CounterLimiter, RequestQueue, TtlCache, isTransient, withRetry } from "./http-utils.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("kraken");

const BASE_URL = "https://api.kraken.com";

export const KRAKEN_OHLC_INTERVALS = [1, 5, 15, 30, 60, 240, 1440, 10080, 21600] as const; // minutes
export type KrakenOhlcInterval = (typeof KRAKEN_OHLC_INTERVALS)[number];

export class KrakenError extends Error {
  readonly kind: "http" | "api" | "network" | "parse";
  readonly status: number | undefined;
  readonly errors: string[]; // Kraken error codes, e.g. ["EOrder:Insufficient funds"]

  constructor(message: string, kind: "http" | "api" | "network" | "parse", status?: number, errors: string[] = []) {
    super(message);
    this.name = "KrakenError";
    this.kind = kind;
    this.status = status;
    this.errors = errors;
  }
}

// Kraken errors that are worth retrying for idempotent calls.
function isRetryableKrakenError(e: unknown): boolean {
  if (isTransient(e)) return true;
  const err = e as KrakenError;
  return err.kind === "api" && err.errors.some((c) => c.startsWith("EService:") || c === "EAPI:Rate limit exceeded");
}

export interface KrakenTicker {
  pair: string;
  ask: number;
  bid: number;
  last: number;
  open: number; // today's opening price (UTC)
  high24h: number;
  low24h: number;
  volume24h: number;
  vwap24h: number;
  trades24h: number;
}

export interface KrakenCandle {
  t: number; // epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  vwap: number;
  v: number;
  count: number;
}

export interface KrakenOrderBook {
  pair: string;
  asks: { price: number; volume: number; t: number }[];
  bids: { price: number; volume: number; t: number }[];
}

export interface KrakenTrade {
  price: number;
  volume: number;
  t: number; // epoch seconds (fractional)
  side: "buy" | "sell";
  type: "market" | "limit";
  id: number;
}

export interface KrakenOrderRequest {
  pair: string;
  type: "buy" | "sell";
  ordertype: "market" | "limit" | "stop-loss" | "take-profit" | "stop-loss-limit" | "take-profit-limit" | "trailing-stop" | "trailing-stop-limit";
  volume: string; // strings avoid float rounding surprises
  price?: string;
  price2?: string;
  leverage?: string;
  oflags?: string; // e.g. "post,fciq"
  timeinforce?: "GTC" | "IOC" | "GTD";
  cl_ord_id?: string; // client order id, handy for idempotent bots
  reduce_only?: boolean;
}

export interface KrakenAddOrderResult {
  descr: { order: string; close?: string };
  txid?: string[]; // absent when validate=true
}

export interface KrakenClientOptions {
  apiKey?: string; // defaults to process.env.KRAKEN_API_KEY
  apiSecret?: string; // base64, defaults to process.env.KRAKEN_API_SECRET
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  publicMsPerCall?: number; // Kraken asks for ~1 public request per second
  cacheTtlMs?: number; // memory cache for public market data; 0 = always fresh (default, bot-friendly)
  counterMax?: number; // private API counter limit (Starter 15, Intermediate 20, Pro 20)
  counterDecayPerSec?: number; // counter decay (Starter 0.33, Intermediate 0.5, Pro 1)
}

// API-Sign = base64(HMAC-SHA512(base64decode(secret), path + SHA256(nonce + postData)))
export function krakenSignature(path: string, nonce: string, postData: string, secretBase64: string): string {
  const hash = createHash("sha256").update(nonce + postData).digest();
  return createHmac("sha512", Buffer.from(secretBase64, "base64"))
    .update(Buffer.concat([Buffer.from(path), hash]))
    .digest("base64");
}

const num = (s: string | number) => Number(s);

export class KrakenClient {
  private readonly apiKey: string | undefined;
  private readonly apiSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  private readonly publicQueue: RequestQueue;
  private readonly privateLimiter: CounterLimiter;
  private readonly cache = new TtlCache();
  private lastNonce = 0;

  constructor(opts: KrakenClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.KRAKEN_API_KEY;
    this.apiSecret = opts.apiSecret ?? process.env.KRAKEN_API_SECRET;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.cacheTtlMs = opts.cacheTtlMs ?? 0;
    this.publicQueue = new RequestQueue(log, opts.publicMsPerCall ?? 1000);
    this.privateLimiter = new CounterLimiter(log, opts.counterMax ?? 15, opts.counterDecayPerSec ?? 0.33);
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  // --- public market data ---

  serverTime() {
    return this.public<{ unixtime: number; rfc1123: string }>("Time");
  }

  systemStatus() {
    return this.public<{ status: "online" | "maintenance" | "cancel_only" | "post_only"; timestamp: string }>("SystemStatus");
  }

  // Trading rules per pair (decimals, minimum order size, ...). Cached for 1 hour.
  assetPairs(pairs?: string[]) {
    return this.public<Record<string, Record<string, unknown>>>(
      "AssetPairs", pairs ? { pair: pairs.join(",") } : {}, 60 * 60_000,
    );
  }

  async ticker(pairs: string[]): Promise<KrakenTicker[]> {
    type Raw = { a: string[]; b: string[]; c: string[]; v: string[]; p: string[]; t: number[]; l: string[]; h: string[]; o: string };
    const data = await this.public<Record<string, Raw>>("Ticker", { pair: pairs.join(",") });
    return Object.entries(data).map(([pair, r]) => ({
      pair,
      ask: num(r.a[0]!),
      bid: num(r.b[0]!),
      last: num(r.c[0]!),
      open: num(r.o),
      high24h: num(r.h[1]!),
      low24h: num(r.l[1]!),
      volume24h: num(r.v[1]!),
      vwap24h: num(r.p[1]!),
      trades24h: r.t[1]!,
    }));
  }

  // Up to 720 most recent candles; `since` (epoch seconds) returns candles after that time.
  async ohlc(pair: string, interval: KrakenOhlcInterval, since?: number): Promise<{ pair: string; candles: KrakenCandle[]; last: number }> {
    const data = await this.public<Record<string, unknown>>("OHLC", {
      pair, interval: String(interval), ...(since !== undefined ? { since: String(since) } : {}),
    });
    const [name, rows] = Object.entries(data).find(([k]) => k !== "last") as [string, (string | number)[][]];
    return {
      pair: name,
      last: Number(data.last),
      candles: rows.map((r) => ({
        t: num(r[0]!), o: num(r[1]!), h: num(r[2]!), l: num(r[3]!), c: num(r[4]!),
        vwap: num(r[5]!), v: num(r[6]!), count: num(r[7]!),
      })),
    };
  }

  async orderBook(pair: string, count = 10): Promise<KrakenOrderBook> {
    type Level = [string, string, number];
    const data = await this.public<Record<string, { asks: Level[]; bids: Level[] }>>("Depth", { pair, count: String(count) });
    const [name, book] = Object.entries(data)[0]!;
    const level = ([price, volume, t]: Level) => ({ price: num(price), volume: num(volume), t });
    return { pair: name, asks: book.asks.map(level), bids: book.bids.map(level) };
  }

  async recentTrades(pair: string, since?: string, count = 100): Promise<{ trades: KrakenTrade[]; last: string }> {
    type Raw = [string, string, number, "b" | "s", "m" | "l", string, number];
    const data = await this.public<Record<string, unknown>>("Trades", {
      pair, count: String(count), ...(since !== undefined ? { since } : {}),
    });
    const rows = Object.entries(data).find(([k]) => k !== "last")![1] as Raw[];
    return {
      last: String(data.last),
      trades: rows.map((r) => ({
        price: num(r[0]), volume: num(r[1]), t: r[2],
        side: r[3] === "b" ? "buy" : "sell", type: r[4] === "m" ? "market" : "limit", id: r[6],
      })),
    };
  }

  // --- private: account (read-only) ---

  balance() {
    return this.private<Record<string, string>>("Balance");
  }

  tradeBalance(asset = "ZUSD") {
    return this.private<Record<string, string>>("TradeBalance", { asset });
  }

  openOrders() {
    return this.private<{ open: Record<string, unknown> }>("OpenOrders");
  }

  closedOrders(params: { start?: number; end?: number; ofs?: number } = {}) {
    return this.private<{ closed: Record<string, unknown>; count: number }>("ClosedOrders", stringify(params));
  }

  queryOrders(txids: string[]) {
    return this.private<Record<string, unknown>>("QueryOrders", { txid: txids.join(",") });
  }

  tradesHistory(params: { start?: number; end?: number; ofs?: number } = {}) {
    return this.private<{ trades: Record<string, unknown>; count: number }>("TradesHistory", stringify(params), 2);
  }

  // --- private: trading (never retried) ---

  // Validates by default. Pass { validate: false } to place a REAL order.
  addOrder(order: KrakenOrderRequest, opts: { validate?: boolean } = {}): Promise<KrakenAddOrderResult> {
    const validate = opts.validate ?? true;
    if (!validate) log.warn("placing LIVE order", { pair: order.pair, type: order.type, ordertype: order.ordertype, volume: order.volume, price: order.price });
    return this.private<KrakenAddOrderResult>(
      "AddOrder", { ...stringify({ ...order }), ...(validate ? { validate: "true" } : {}) }, 0, false,
    );
  }

  // `id` is a txid or a cl_ord_id.
  cancelOrder(id: string) {
    log.warn("cancelling order", { id });
    return this.private<{ count: number }>("CancelOrder", { txid: id }, 0, false);
  }

  cancelAll() {
    log.warn("cancelling ALL orders");
    return this.private<{ count: number }>("CancelAll", {}, 0, false);
  }

  // --- core ---

  private async public<T>(method: string, params: Record<string, string> = {}, ttlMs = this.cacheTtlMs): Promise<T> {
    const url = new URL(`/0/public/${method}`, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const hit = this.cache.get<T>(url.toString());
    if (hit !== undefined) {
      log.debug("memory cache hit", { method });
      return hit;
    }
    const value = await withRetry(
      () => this.publicQueue.run(1, () => this.send<T>(method, url, { method: "GET" })),
      { maxRetries: this.maxRetries, log, label: method, isRetryable: isRetryableKrakenError },
    );
    this.cache.set(url.toString(), value, ttlMs);
    return value;
  }

  // `cost` is the call's weight on the API counter (history calls cost 2; trading calls 0 – they have
  // a separate per-pair limit). `retry` must be false for anything that changes state.
  private private<T>(method: string, params: Record<string, string> = {}, cost = 1, retry = true): Promise<T> {
    if (!this.apiKey || !this.apiSecret) {
      return Promise.reject(new KrakenError("KRAKEN_API_KEY and KRAKEN_API_SECRET are not set", "api"));
    }
    const apiKey = this.apiKey;
    const apiSecret = this.apiSecret;
    const path = `/0/private/${method}`;

    const attempt = () =>
      this.privateLimiter.run(cost, () => {
        // A fresh nonce for every attempt; it must strictly increase per API key.
        const nonce = String((this.lastNonce = Math.max(Date.now() * 1000, this.lastNonce + 1)));
        const body = new URLSearchParams({ nonce, ...params }).toString();
        return this.send<T>(method, new URL(path, this.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
            "API-Key": apiKey,
            "API-Sign": krakenSignature(path, nonce, body, apiSecret),
          },
          body,
        });
      });

    return withRetry(attempt, {
      maxRetries: retry ? this.maxRetries : 0,
      log,
      label: method,
      isRetryable: isRetryableKrakenError,
    });
  }

  private async send<T>(method: string, url: URL, init: RequestInit): Promise<T> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { accept: "application/json", ...init.headers },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      log.warn("api request failed", { method, ms: Date.now() - started, error: e });
      throw new KrakenError(`Network error/timeout: ${(e as Error).message}`, "network");
    }

    if (!res.ok) {
      log.warn("api request failed", { method, status: res.status, ms: Date.now() - started });
      throw new KrakenError(`HTTP ${res.status}`, "http", res.status);
    }

    let body: { error?: string[]; result?: T };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new KrakenError("Invalid JSON in response", "parse");
    }

    // Kraken reports errors with HTTP 200 and a non-empty `error` array.
    if (body.error && body.error.length > 0) {
      log.warn("api error", { method, errors: body.error.join(","), ms: Date.now() - started });
      throw new KrakenError(body.error.join(", "), "api", res.status, body.error);
    }
    log.info("api request", { method, status: res.status, ms: Date.now() - started });
    return body.result as T;
  }
}

// Drops undefined values and turns the rest into strings for form/query encoding.
function stringify(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
  );
}
