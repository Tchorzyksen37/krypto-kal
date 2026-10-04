// coinglass-client.ts  (Node >= 18, no dependencies)
// Client for Coinglass Open API v4. The current account plan has no API access ("Upgrade plan").

import { RequestQueue, TtlCache, withRetry } from "../../core/http-utils.ts";
import { createLogger } from "../../core/logger.ts";

const log = createLogger("coinglass");

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
  code: string; // "0" = success
  msg: string;
  data: T;
}

// Assumed shapes – verify against a real response once the plan allows it.
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
  apiKey?: string; // defaults to process.env.COINGLASS_API_KEY
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  minIntervalMs?: number; // spacing between requests (simple throttle)
  cacheTtlMs?: number;
}

export class CoinglassClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  private readonly queue: RequestQueue;
  private readonly cache = new TtlCache();

  constructor(opts: ClientOptions = {}) {
    const key = opts.apiKey ?? process.env.COINGLASS_API_KEY;
    if (!key) throw new Error("COINGLASS_API_KEY is not set");
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.cacheTtlMs = opts.cacheTtlMs ?? 20_000;
    this.queue = new RequestQueue(log, opts.minIntervalMs ?? 800);
  }

  // --- public methods ---

  fundingRateHistory(p: {
    exchange: string; // e.g. "Binance"
    symbol: string; // pair, e.g. "BTCUSDT"
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

  // --- core ---

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const hit = this.cache.get<T>(url.toString());
    if (hit !== undefined) {
      log.debug("memory cache hit", { path });
      return hit;
    }

    const value = await withRetry(() => this.queue.run(1, () => this.request<T>(url)), {
      maxRetries: this.maxRetries,
      log,
      label: path,
    });
    this.cache.set(url.toString(), value, this.cacheTtlMs);
    return value;
  }

  private async request<T>(url: URL): Promise<T> {
    const path = url.pathname;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", "CG-API-KEY": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      log.warn("api request failed", { path, ms: Date.now() - started, error: e });
      throw new CoinglassError(`Network error/timeout: ${(e as Error).message}`, "network");
    }

    if (!res.ok) {
      log.warn("api request failed", { path, status: res.status, ms: Date.now() - started });
      throw new CoinglassError(`HTTP ${res.status}`, "http", res.status);
    }

    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      throw new CoinglassError("Invalid JSON in response", "parse");
    }

    // Coinglass can return HTTP 200 with an error inside the envelope.
    if (String(body.code) !== "0") {
      log.warn("api error", { path, code: body.code, error: body.msg, ms: Date.now() - started });
      throw new CoinglassError(body.msg || "API error", "api", res.status, String(body.code));
    }
    log.info("api request", { path, status: res.status, ms: Date.now() - started });
    return body.data;
  }
}
