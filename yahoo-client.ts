// yahoo-client.ts  (Node >= 18, no dependencies)
// Client for the unofficial Yahoo Finance API (no key): indices, currencies, stocks, futures, yields.
// Uses the chart endpoint (/v8/finance/chart) for both history and current quotes, because the
// quote endpoint (/v7/finance/quote) requires a cookie "crumb".
//
// Symbols: stocks AAPL, CDR.WA; indices ^GSPC ^IXIC ^DJI ^VIX; FX EURUSD=X, USDPLN=X;
// dollar index DX-Y.NYB; 10y yield ^TNX; futures CL=F (oil), GC=F (gold).
//
// Prices are split-adjusted but not dividend-adjusted. The persistent cache rebuilds a symbol's
// history when a new split shows up, so cached and fresh bars never mix.

import type { HistoryStore, Range } from "./history-store.ts";
import { RequestQueue, TtlCache, withRetry } from "./http-utils.ts";
import { createLogger } from "./logger.ts";
import { cachedSeries } from "./series-cache.ts";

const log = createLogger("yahoo");

const BASE_URL = "https://query1.finance.yahoo.com";
// Yahoo rejects or throttles requests without a browser-like User-Agent.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export type YahooInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "1wk" | "1mo";

export const YAHOO_INTERVAL_SECONDS: Record<YahooInterval, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
  "1d": 86400, "1wk": 604800, "1mo": 31 * 86400,
};

// How far back Yahoo serves each interval (slightly under its limits: 1m 30 days, 5m–30m 60 days, 1h 730 days).
export const YAHOO_MAX_LOOKBACK_DAYS: Record<YahooInterval, number> = {
  "1m": 29, "5m": 59, "15m": 59, "30m": 59, "1h": 729, "1d": 365 * 60, "1wk": 365 * 60, "1mo": 365 * 60,
};

// Longest range per request; 1m data is limited to 8 days per request.
const MAX_SPAN_DAYS: Partial<Record<YahooInterval, number>> = { "1m": 7 };

const SERIES_KIND = "yahoo-chart";

export class YahooError extends Error {
  readonly kind: "http" | "network" | "parse";
  readonly status: number | undefined;

  constructor(message: string, kind: "http" | "network" | "parse", status?: number) {
    super(message);
    this.name = "YahooError";
    this.kind = kind;
    this.status = status;
  }
}

// One bar; t = bar start in epoch seconds (stock bars start at the session open, e.g. 13:30 UTC).
export interface YahooBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface YahooQuote {
  symbol: string;
  name: string | undefined;
  type: string | undefined; // EQUITY, INDEX, CURRENCY, FUTURE, ETF, ...
  currency: string | undefined;
  exchange: string | undefined;
  price: number;
  previousClose: number | undefined;
  change: number | undefined;
  changePercent: number | undefined;
  dayHigh: number | undefined;
  dayLow: number | undefined;
  volume: number | undefined;
  fiftyTwoWeekHigh: number | undefined;
  fiftyTwoWeekLow: number | undefined;
  marketTime: string; // ISO time of the last price
  timezone: string | undefined;
}

export interface YahooSearchResult {
  symbol: string;
  name: string | undefined;
  type: string | undefined;
  exchange: string | undefined;
}

export interface YahooHistoryParams {
  symbols: string[];
  interval: YahooInterval;
  from: number; // epoch seconds, inclusive
  to: number; // epoch seconds, inclusive
}

export interface YahooClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  msPerCall?: number; // spacing between requests (the API is unofficial – be gentle)
  quoteTtlMs?: number;
  store?: HistoryStore; // persistent history cache
  settleSeconds?: number;
}

interface ChartMeta {
  symbol: string;
  currency?: string;
  instrumentType?: string;
  fullExchangeName?: string;
  exchangeName?: string;
  exchangeTimezoneName?: string;
  longName?: string;
  shortName?: string;
  regularMarketPrice: number;
  regularMarketTime: number;
  regularMarketChangePercent?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
}

interface ChartResponse {
  chart: {
    result:
      | {
          meta: ChartMeta;
          timestamp?: number[];
          events?: { splits?: Record<string, { date: number }> };
          indicators: {
            quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[];
          };
        }[]
      | null;
    error: { code: string; description: string } | null;
  };
}

interface Chart {
  meta: ChartMeta;
  bars: YahooBar[];
  splits: number[]; // split dates, epoch seconds
}

export class YahooClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly quoteTtlMs: number;
  private readonly store: HistoryStore | undefined;
  private readonly settleSeconds: number;
  private readonly queue: RequestQueue;
  private readonly cache = new TtlCache();

  constructor(opts: YahooClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.quoteTtlMs = opts.quoteTtlMs ?? 15_000;
    this.store = opts.store;
    this.settleSeconds = opts.settleSeconds ?? 300;
    this.queue = new RequestQueue(log, opts.msPerCall ?? 500);
  }

  // Bars are not epoch-aligned, so a bar is final once its full length has passed (plus settle time).
  closedUntil(interval: YahooInterval, nowMs = Date.now()): number {
    return Math.floor(nowMs / 1000) - this.settleSeconds - YAHOO_INTERVAL_SECONDS[interval];
  }

  // Earliest time Yahoo still serves for the interval.
  earliestAvailable(interval: YahooInterval, nowMs = Date.now()): number {
    return Math.floor(nowMs / 1000) - YAHOO_MAX_LOOKBACK_DAYS[interval] * 86400;
  }

  // --- public methods ---

  async search(query: string, limit = 10): Promise<YahooSearchResult[]> {
    const url = new URL("/v1/finance/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("quotesCount", String(limit));
    url.searchParams.set("newsCount", "0");
    const body = await this.get<{ quotes?: { symbol: string; shortname?: string; longname?: string; quoteType?: string; exchDisp?: string }[] }>(
      url, 60 * 60_000,
    );
    return (body.quotes ?? []).map((q) => ({
      symbol: q.symbol,
      name: q.longname ?? q.shortname,
      type: q.quoteType,
      exchange: q.exchDisp,
    }));
  }

  // Current price and daily change for each symbol (one request per symbol).
  async quotes(symbols: string[]): Promise<YahooQuote[]> {
    const out: YahooQuote[] = [];
    for (const symbol of symbols) {
      const url = this.chartUrl(symbol, { range: "1d", interval: "1d" });
      const { meta } = parseChart(await this.get<ChartResponse>(url, this.quoteTtlMs));
      const previousClose = meta.previousClose ?? meta.chartPreviousClose;
      const change = previousClose !== undefined ? meta.regularMarketPrice - previousClose : undefined;
      out.push({
        symbol: meta.symbol,
        name: meta.longName ?? meta.shortName,
        type: meta.instrumentType,
        currency: meta.currency,
        exchange: meta.fullExchangeName ?? meta.exchangeName,
        price: meta.regularMarketPrice,
        previousClose,
        change,
        changePercent:
          meta.regularMarketChangePercent ??
          (change !== undefined && previousClose ? (change / previousClose) * 100 : undefined),
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
        volume: meta.regularMarketVolume,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        marketTime: new Date(meta.regularMarketTime * 1000).toISOString(),
        timezone: meta.exchangeTimezoneName,
      });
    }
    return out;
  }

  // OHLCV history. `from` is clamped to what Yahoo still serves for the interval.
  async history(p: YahooHistoryParams): Promise<{ symbol: string; history: YahooBar[] }[]> {
    const range: Range = { from: Math.max(p.from, this.earliestAvailable(p.interval)), to: p.to };
    if (range.from > range.to) return p.symbols.map((symbol) => ({ symbol, history: [] }));

    let bySymbol: Map<string, YahooBar[]>;
    if (!this.store) {
      bySymbol = new Map();
      for (const symbol of p.symbols) bySymbol.set(symbol, (await this.chart(symbol, p.interval, range)).bars);
    } else {
      bySymbol = await this.cachedHistory(this.store, p.symbols, p.interval, range);
    }
    return p.symbols.map((symbol) => ({ symbol, history: bySymbol.get(symbol) ?? [] }));
  }

  // --- core ---

  private async cachedHistory(store: HistoryStore, symbols: string[], interval: YahooInterval, range: Range) {
    const sec = YAHOO_INTERVAL_SECONDS[interval];
    const splitSymbols = new Set<string>();
    const run = (syms: string[]) =>
      cachedSeries<YahooBar>({
        store,
        log,
        kind: SERIES_KIND,
        interval,
        symbols: syms,
        range,
        closedUntil: this.closedUntil(interval),
        tailTo: Math.floor(Date.now() / 1000 / sec) * sec + sec - 1, // stable within the current interval
        fetch: async (fetchSymbols, fetchRange) => {
          const out = new Map<string, YahooBar[]>();
          for (const symbol of fetchSymbols) {
            const chart = await this.chart(symbol, interval, fetchRange);
            // A split after bars we already cached means those cached bars use the old price scale.
            const key = { kind: SERIES_KIND, symbol, interval };
            if (chart.splits.some((d) => store.hasPointsBefore(key, d))) splitSymbols.add(symbol);
            out.set(symbol, chart.bars);
          }
          return out;
        },
      });

    const result = await run(symbols);
    if (splitSymbols.size > 0) {
      const rebuild = [...splitSymbols];
      log.warn("stock split detected, rebuilding cached history", { symbols: rebuild.join(",") });
      for (const symbol of rebuild) store.deleteSeries(SERIES_KIND, symbol);
      for (const [symbol, bars] of await run(rebuild)) result.set(symbol, bars);
    }
    return result;
  }

  // Fetches bars for one symbol, splitting long 1m ranges into allowed chunks.
  private async chart(symbol: string, interval: YahooInterval, range: Range): Promise<Chart> {
    const span = (MAX_SPAN_DAYS[interval] ?? Infinity) * 86400;
    const bars: YahooBar[] = [];
    const splits: number[] = [];
    let meta: ChartMeta | undefined;
    for (let from = range.from; from <= range.to; from += span) {
      const to = Math.min(range.to, from + span - 1);
      const url = this.chartUrl(symbol, {
        interval, period1: String(from), period2: String(to + 1), events: "split", includePrePost: "false",
      });
      const chart = parseChart(await this.get<ChartResponse>(url, 0));
      meta = chart.meta;
      bars.push(...chart.bars.filter((b) => b.t >= from && b.t <= to));
      splits.push(...chart.splits);
    }
    return { meta: meta!, bars, splits };
  }

  private chartUrl(symbol: string, params: Record<string, string>): URL {
    const url = new URL(`/v8/finance/chart/${encodeURIComponent(symbol)}`, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  private async get<T>(url: URL, ttlMs: number): Promise<T> {
    const hit = this.cache.get<T>(url.toString());
    if (hit !== undefined) {
      log.debug("memory cache hit", { path: url.pathname });
      return hit;
    }
    const value = await withRetry(() => this.queue.run(1, () => this.request<T>(url)), {
      maxRetries: this.maxRetries,
      log,
      label: url.pathname,
    });
    this.cache.set(url.toString(), value, ttlMs);
    return value;
  }

  private async request<T>(url: URL): Promise<T> {
    const path = url.pathname;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      log.warn("api request failed", { path, ms: Date.now() - started, error: e });
      throw new YahooError(`Network error/timeout: ${(e as Error).message}`, "network");
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      log.warn("api request failed", { path, status: res.status, ms: Date.now() - started, error: "invalid JSON" });
      throw new YahooError(`HTTP ${res.status}: invalid JSON in response`, res.ok ? "parse" : "http", res.status);
    }

    if (!res.ok) {
      // e.g. 404 "No data found, symbol may be delisted", 422 "1m data not available for ..."
      const err = (body as Partial<ChartResponse>).chart?.error;
      const message = err?.description ?? `HTTP ${res.status}`;
      log.warn("api request failed", { path, status: res.status, ms: Date.now() - started, error: message });
      throw new YahooError(message, "http", res.status);
    }

    log.info("api request", { path, status: res.status, ms: Date.now() - started });
    return body as T;
  }
}

function parseChart(body: ChartResponse): Chart {
  const result = body.chart.result?.[0];
  if (!result) throw new YahooError(body.chart.error?.description ?? "Empty chart response", "parse");

  const q = result.indicators.quote[0];
  const bars: YahooBar[] = [];
  (result.timestamp ?? []).forEach((t, i) => {
    const c = q?.close[i];
    if (c === null || c === undefined) return; // gaps (e.g. halted trading) come as nulls
    bars.push({ t, o: q!.open[i] ?? c, h: q!.high[i] ?? c, l: q!.low[i] ?? c, c, v: q!.volume[i] ?? 0 });
  });
  const splits = Object.values(result.events?.splits ?? {}).map((s) => s.date);
  return { meta: result.meta, bars, splits };
}
