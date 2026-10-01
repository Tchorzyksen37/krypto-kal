// coinalyze-client.ts  (Node >= 18, no dependencies)
// Client for the free Coinalyze API: https://api.coinalyze.net/v1/doc/
// Rate limit: 40 calls/min per key; every symbol in a request counts as one call.

import type { HistoryStore, Range } from "./history-store.ts";
import { RequestQueue, TtlCache, withRetry } from "./http-utils.ts";
import { createLogger } from "./logger.ts";
import { cachedSeries } from "./series-cache.ts";

const log = createLogger("coinalyze");

const BASE_URL = "https://api.coinalyze.net/v1/";

export type CoinalyzeInterval =
  | "1min" | "5min" | "15min" | "30min"
  | "1hour" | "2hour" | "4hour" | "6hour" | "12hour"
  | "daily";

export const INTERVAL_SECONDS: Record<CoinalyzeInterval, number> = {
  "1min": 60, "5min": 300, "15min": 900, "30min": 1800,
  "1hour": 3600, "2hour": 7200, "4hour": 14400, "6hour": 21600, "12hour": 43200,
  daily: 86400,
};

export class CoinalyzeError extends Error {
  readonly kind: "http" | "network" | "parse";
  readonly status: number | undefined;

  constructor(message: string, kind: "http" | "network" | "parse", status?: number) {
    super(message);
    this.name = "CoinalyzeError";
    this.kind = kind;
    this.status = status;
  }
}

export interface Exchange {
  name: string;
  code: string; // e.g. "A" = Binance; symbols look like BTCUSDT_PERP.A
}

export interface FutureMarket {
  symbol: string;
  exchange: string;
  symbol_on_exchange: string;
  base_asset: string;
  quote_asset: string;
  is_perpetual: boolean;
  margined: "STABLE" | "COIN";
  expire_at: number | null;
  oi_lq_vol_denominated_in: "BASE_ASSET" | "QUOTE_ASSET" | "CONTRACTS";
  has_long_short_ratio_data: boolean;
  has_ohlcv_data: boolean;
  has_buy_sell_data: boolean;
}

export interface CurrentValue {
  symbol: string;
  value: number;
  update: number; // ms epoch
}

// All histories: t = interval start in epoch seconds, ascending.
export interface OhlcPoint { t: number; o: number; h: number; l: number; c: number }
export interface LiquidationPoint { t: number; l: number; s: number } // longs / shorts
export interface LongShortPoint { t: number; r: number; l: number; s: number }
export interface OhlcvPoint extends OhlcPoint { v: number; bv: number; tx: number; btx: number }

export interface SymbolHistory<P> {
  symbol: string;
  history: P[];
}

export interface HistoryParams {
  symbols: string[]; // max 20
  interval: CoinalyzeInterval;
  from: number; // epoch seconds, inclusive
  to: number; // epoch seconds, inclusive
}

export interface ClientOptions {
  apiKey?: string; // defaults to process.env.COINALYZE_API_KEY
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  msPerCall?: number; // spacing per call (symbol); 60s / 40 = 1500ms
  cacheTtlMs?: number;
  store?: HistoryStore; // persistent history cache; without it every history request hits the API
  settleSeconds?: number; // how long after an interval closes its data is treated as final
}

const MARKETS_TTL_MS = 60 * 60_000; // exchange/market lists rarely change
const MAX_SYMBOLS = 20;

export class CoinalyzeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  private readonly store: HistoryStore | undefined;
  private readonly settleSeconds: number;
  private readonly queue: RequestQueue;
  private readonly cache = new TtlCache();

  constructor(opts: ClientOptions = {}) {
    const key = opts.apiKey ?? process.env.COINALYZE_API_KEY;
    if (!key) throw new Error("COINALYZE_API_KEY is not set");
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.cacheTtlMs = opts.cacheTtlMs ?? 20_000;
    this.store = opts.store;
    this.settleSeconds = opts.settleSeconds ?? 300;
    this.queue = new RequestQueue(log, opts.msPerCall ?? 1500);
  }

  // Last second up to which intervals are closed and settled – points with t <= this won't change.
  closedUntil(interval: CoinalyzeInterval, nowMs = Date.now()): number {
    const sec = INTERVAL_SECONDS[interval];
    return Math.floor((nowMs / 1000 - this.settleSeconds) / sec) * sec - 1;
  }

  // --- public methods ---

  exchanges() {
    return this.get<Exchange[]>("exchanges", {}, 1, MARKETS_TTL_MS);
  }

  futureMarkets() {
    return this.get<FutureMarket[]>("future-markets", {}, 1, MARKETS_TTL_MS);
  }

  openInterest(symbols: string[], convertToUsd = false) {
    return this.get<CurrentValue[]>("open-interest", {
      symbols: symbols.join(","),
      convert_to_usd: String(convertToUsd),
    }, symbols.length);
  }

  fundingRate(symbols: string[]) {
    return this.get<CurrentValue[]>("funding-rate", { symbols: symbols.join(",") }, symbols.length);
  }

  predictedFundingRate(symbols: string[]) {
    return this.get<CurrentValue[]>("predicted-funding-rate", { symbols: symbols.join(",") }, symbols.length);
  }

  openInterestHistory(p: HistoryParams & { convertToUsd?: boolean }) {
    return this.history<OhlcPoint>("open-interest-history", p, { convert_to_usd: String(p.convertToUsd ?? false) });
  }

  fundingRateHistory(p: HistoryParams) {
    return this.history<OhlcPoint>("funding-rate-history", p);
  }

  predictedFundingRateHistory(p: HistoryParams) {
    return this.history<OhlcPoint>("predicted-funding-rate-history", p);
  }

  liquidationHistory(p: HistoryParams & { convertToUsd?: boolean }) {
    return this.history<LiquidationPoint>("liquidation-history", p, { convert_to_usd: String(p.convertToUsd ?? false) });
  }

  longShortRatioHistory(p: HistoryParams) {
    return this.history<LongShortPoint>("long-short-ratio-history", p);
  }

  ohlcvHistory(p: HistoryParams) {
    return this.history<OhlcvPoint>("ohlcv-history", p);
  }

  // --- core ---

  private async history<P extends { t: number }>(
    path: string,
    p: HistoryParams,
    extra: Record<string, string> = {},
  ): Promise<SymbolHistory<P>[]> {
    if (p.symbols.length > MAX_SYMBOLS) throw new CoinalyzeError(`At most ${MAX_SYMBOLS} symbols per request`, "http", 400);

    const fetch = async (symbols: string[], range: Range) => {
      const data = await this.get<SymbolHistory<P>[]>(path, {
        symbols: symbols.join(","), interval: p.interval, from: range.from, to: range.to, ...extra,
      }, symbols.length);
      return new Map(data.map((s) => [s.symbol, s.history]));
    };

    let bySymbol: Map<string, P[]>;
    if (!this.store) {
      bySymbol = await fetch(p.symbols, p);
    } else {
      const sec = INTERVAL_SECONDS[p.interval];
      bySymbol = await cachedSeries<P>({
        store: this.store,
        log,
        kind: extra.convert_to_usd === "true" ? `${path}:usd` : path,
        interval: p.interval,
        symbols: p.symbols,
        range: p,
        closedUntil: this.closedUntil(p.interval),
        tailTo: Math.floor(Date.now() / 1000 / sec) * sec + sec - 1, // end of the current interval
        alignSeconds: sec,
        fetch,
      });
    }
    return p.symbols.map((symbol) => ({ symbol, history: bySymbol.get(symbol) ?? [] }));
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number>,
    calls: number,
    ttlMs = this.cacheTtlMs,
  ): Promise<T> {
    if (calls > MAX_SYMBOLS) throw new CoinalyzeError(`At most ${MAX_SYMBOLS} symbols per request`, "http", 400);

    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const hit = this.cache.get<T>(url.toString());
    if (hit !== undefined) {
      log.debug("memory cache hit", { path });
      return hit;
    }

    // On 429 the wait comes from Retry-After (pushed into the queue), so retry immediately.
    const value = await withRetry(() => this.queue.run(calls, () => this.request<T>(url, calls)), {
      maxRetries: this.maxRetries,
      log,
      label: path,
      delayMs: (e, attempt) =>
        (e as CoinalyzeError).status === 429 ? 0 : 2 ** attempt * 1000 + Math.random() * 250,
    });
    this.cache.set(url.toString(), value, ttlMs);
    return value;
  }

  private async request<T>(url: URL, calls: number): Promise<T> {
    const path = url.pathname.split("/").at(-1);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", api_key: this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      log.warn("api request failed", { path, calls, ms: Date.now() - started, error: e });
      throw new CoinalyzeError(`Network error/timeout: ${(e as Error).message}`, "network");
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      const message = body?.message ?? `HTTP ${res.status}`;
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter)) this.queue.delayUntil(Date.now() + retryAfter * 1000);
        log.warn("rate limited", { path, calls, retryAfterSec: retryAfter });
      } else {
        log.warn("api request failed", { path, calls, status: res.status, ms: Date.now() - started, error: message });
      }
      throw new CoinalyzeError(message, "http", res.status);
    }

    log.info("api request", { path, calls, status: res.status, ms: Date.now() - started });
    try {
      return (await res.json()) as T;
    } catch {
      throw new CoinalyzeError("Invalid JSON in response", "parse");
    }
  }
}
