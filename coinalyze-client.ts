// coinalyze-client.ts  (Node >= 18, brak zależności)
// Darmowe API Coinalyze: https://api.coinalyze.net/v1/doc/
// Limit: 40 wywołań/min na klucz, każdy symbol w zapytaniu = jedno wywołanie.

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
  code: string; // np. "A" = Binance; symbole mają postać BTCUSDT_PERP.A
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

// Wszystkie historie: t = początek interwału, sekundy epoch; rosnąco.
export interface OhlcPoint { t: number; o: number; h: number; l: number; c: number }
export interface LiquidationPoint { t: number; l: number; s: number } // longi / shorty
export interface LongShortPoint { t: number; r: number; l: number; s: number }
export interface OhlcvPoint extends OhlcPoint { v: number; bv: number; tx: number; btx: number }

export interface SymbolHistory<P> {
  symbol: string;
  history: P[];
}

export interface HistoryParams {
  symbols: string[]; // max 20
  interval: CoinalyzeInterval;
  from: number; // sekundy epoch (włącznie)
  to: number; // sekundy epoch (włącznie)
}

export interface ClientOptions {
  apiKey?: string; // domyślnie process.env.COINALYZE_API_KEY
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  msPerCall?: number; // odstęp na jedno wywołanie (symbol); 60s / 40 = 1500ms
  cacheTtlMs?: number;
}

const MARKETS_TTL_MS = 60 * 60_000; // listy giełd/rynków zmieniają się rzadko

export class CoinalyzeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly msPerCall: number;
  private readonly cacheTtlMs: number;

  private cache = new Map<string, { at: number; ttl: number; value: unknown }>();
  private queue: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(opts: ClientOptions = {}) {
    const key = opts.apiKey ?? process.env.COINALYZE_API_KEY;
    if (!key) throw new Error("Brak COINALYZE_API_KEY");
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.msPerCall = opts.msPerCall ?? 1500;
    this.cacheTtlMs = opts.cacheTtlMs ?? 20_000;
  }

  // --- publiczne metody ---

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

  // --- rdzeń ---

  private history<P>(path: string, p: HistoryParams, extra: Record<string, string> = {}) {
    return this.get<SymbolHistory<P>[]>(path, {
      symbols: p.symbols.join(","),
      interval: p.interval,
      from: p.from,
      to: p.to,
      ...extra,
    }, p.symbols.length);
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number>,
    calls: number,
    ttlMs = this.cacheTtlMs,
  ): Promise<T> {
    if (calls > 20) throw new CoinalyzeError("Maksymalnie 20 symboli na zapytanie", "http", 400);

    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const cacheKey = url.toString();

    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;

    const value = await this.withRetry(() => this.throttled(calls, () => this.request<T>(url)));
    this.cache.set(cacheKey, { at: Date.now(), ttl: ttlMs, value });
    return value;
  }

  private async request<T>(url: URL): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", api_key: this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new CoinalyzeError(`Błąd sieci/timeout: ${(e as Error).message}`, "network");
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      const err = new CoinalyzeError(body?.message ?? `HTTP ${res.status}`, "http", res.status);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter)) this.nextAllowedAt = Date.now() + retryAfter * 1000;
      }
      throw err;
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new CoinalyzeError("Niepoprawny JSON w odpowiedzi", "parse");
    }
  }

  // Serializuje requesty; po każdym czeka `calls * msPerCall` (limit liczony per symbol).
  private throttled<T>(calls: number, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAllowedAt = Date.now() + calls * this.msPerCall;
      return fn();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  // Na 429 czekanie wynika z Retry-After (ustawione w nextAllowedAt), więc wystarczy ponowić.
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        const err = e as CoinalyzeError;
        const retryable =
          err.kind === "network" ||
          (err.kind === "http" && (err.status === 429 || (err.status ?? 0) >= 500));
        if (!retryable || attempt >= this.maxRetries) throw e;
        if (err.status !== 429) await sleep(2 ** attempt * 1000 + Math.random() * 250);
        attempt++;
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
