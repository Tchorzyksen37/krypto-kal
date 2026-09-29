// coinglass-client.ts  (Node >= 18, brak zależności)

const BASE_URL = "https://open-api-v4.coinglass.com";

export type Interval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "8h" | "1d";

export class CoinglassError extends Error {
  readonly kind: "http" | "api" | "network" | "parse";
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    message: string,
    kind: "http" | "api" | "network" | "parse",
    status?: number,
    code?: string,
  ) {
    super(message);
    this.name = "CoinglassError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

interface Envelope<T> {
  code: string; // "0" = sukces
  msg: string;
  data: T;
}

// Założone kształty – zweryfikuj na realnej odpowiedzi z Twojego planu.
export interface OhlcPoint {
  time: number; // ms epoch
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
}

export interface LiquidationPoint {
  time: number;
  long_liquidation_usd: string | number;
  short_liquidation_usd: string | number;
}

export interface ClientOptions {
  apiKey?: string; // domyślnie process.env.COINGLASS_API_KEY
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  minIntervalMs?: number; // odstęp między requestami (prosty throttle)
  cacheTtlMs?: number;
}

export class CoinglassClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;

  private cache = new Map<string, { at: number; value: unknown }>();
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(opts: ClientOptions = {}) {
    const key = opts.apiKey ?? process.env.COINGLASS_API_KEY;
    if (!key) throw new Error("Brak COINGLASS_API_KEY");
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.minIntervalMs = opts.minIntervalMs ?? 800;
    this.cacheTtlMs = opts.cacheTtlMs ?? 20_000;
  }

  // --- publiczne metody ---

  fundingRateHistory(p: {
    exchange: string; // np. "Binance"
    symbol: string; // para, np. "BTCUSDT"
    interval: Interval;
    limit?: number;
  }) {
    return this.get<OhlcPoint[]>("/api/futures/funding-rate/history", p);
  }

  openInterestHistory(p: {
    exchange: string;
    symbol: string;
    interval: Interval;
    limit?: number;
    unit?: "usd" | "coin";
  }) {
    return this.get<OhlcPoint[]>("/api/futures/open-interest/history", {
      unit: "usd",
      ...p,
    });
  }

  liquidationHistory(p: {
    exchange: string;
    symbol: string;
    interval: Interval;
    limit?: number;
  }) {
    return this.get<LiquidationPoint[]>("/api/futures/liquidation/history", p);
  }

  // --- rdzeń ---

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const cacheKey = url.toString();

    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.value as T;

    const value = await this.withRetry(() => this.throttled(() => this.request<T>(url)));
    this.cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  private async request<T>(url: URL): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", "CG-API-KEY": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new CoinglassError(`Błąd sieci/timeout: ${(e as Error).message}`, "network");
    }

    if (!res.ok) {
      throw new CoinglassError(`HTTP ${res.status}`, "http", res.status);
    }

    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      throw new CoinglassError("Niepoprawny JSON w odpowiedzi", "parse");
    }

    // Coinglass potrafi zwrócić HTTP 200 z błędem w envelope
    if (String(body.code) !== "0") {
      throw new CoinglassError(body.msg || "Błąd API", "api", res.status, String(body.code));
    }
    return body.data;
  }

  // Serializuje requesty i pilnuje minimalnego odstępu (rate limit zależy od planu).
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        const err = e as CoinglassError;
        const retryable =
          err.kind === "network" ||
          (err.kind === "http" && (err.status === 429 || (err.status ?? 0) >= 500));
        if (!retryable || attempt >= this.maxRetries) throw e;
        const backoff = 2 ** attempt * 1000 + Math.random() * 250;
        await sleep(backoff);
        attempt++;
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));