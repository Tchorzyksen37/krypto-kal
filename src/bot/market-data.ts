// market-data.ts – the bot's view of the market, from the real Kraken Futures public endpoints (no keys), in dry-run
// too. FeedingMarket additionally hands every quote it reads to the simulated exchange, so the dry-run fills follow
// the real market at the trader's sampling rate.

import type { FuturesCandle, FuturesFundingRate, FuturesInstrument, FuturesTicker, KrakenFuturesResolution } from "../providers/kraken/kraken-futures-client.ts";
import type { Clock } from "./clock.ts";
import type { MarketData, PriceEvent } from "./executor.ts";
import type { Contract } from "./sizing.ts";

// The subset of KrakenFuturesClient the bot reads (public endpoints only).
export interface FuturesPublicApi {
  tickers(symbols?: string[]): Promise<FuturesTicker[]>;
  candles(symbol: string, resolution: KrakenFuturesResolution, range?: { from?: number; to?: number }): Promise<{ candles: FuturesCandle[] }>;
  instrument(symbol: string): Promise<FuturesInstrument>;
  fundingRates(symbol: string): Promise<FuturesFundingRate[]>;
}

export const RESOLUTION_SEC: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14_400, "12h": 43_200, "1d": 86_400, "1w": 604_800,
};

export class KrakenMarketData implements MarketData {
  readonly clock: Clock;
  private readonly api: FuturesPublicApi;
  private readonly symbol: string;

  constructor(api: FuturesPublicApi, symbol: string, clock: Clock) {
    this.api = api;
    this.symbol = symbol;
    this.clock = clock;
  }

  // The ticker carries no timestamp of its own: the time of the read is used (the trader's staleness check then
  // measures our own delay, which is what matters for acting on it).
  async ticker(): Promise<PriceEvent> {
    const t = (await this.api.tickers([this.symbol]))[0];
    if (!t) throw new Error(`no ticker for ${this.symbol}`);
    if (t.suspended) throw new Error(`${this.symbol} is suspended`);
    return { t: this.clock.now(), mark: t.markPrice, last: t.last, bid: t.bid, ask: t.ask };
  }

  // The newest `n` candles of `resolution` (the last one may still be forming; indicators drop it themselves).
  async candles(resolution: string, n: number): Promise<FuturesCandle[]> {
    const sec = RESOLUTION_SEC[resolution];
    if (!sec) throw new Error(`unknown resolution ${resolution}`);
    const to = Math.floor(this.clock.now() / 1000);
    const { candles } = await this.api.candles(this.symbol, resolution as KrakenFuturesResolution, { from: to - (n + 1) * sec, to });
    return candles.slice(-n);
  }

  async contract(): Promise<Contract> {
    const i = await this.api.instrument(this.symbol);
    // 1 / 10^p, not 10^-p: in floating point 10 ** -4 is 0.00009999999999999999, a step that breaks size rounding.
    const p = i.contractValueTradePrecision;
    const sizeStep = p >= 0 ? 1 / 10 ** p : 10 ** -p;
    return { tickSize: i.tickSize, sizeStep, minSize: sizeStep };
  }

  async fundingRates(): Promise<{ t: number; rate: number }[]> {
    return (await this.api.fundingRates(this.symbol)).map((r) => ({ t: r.t * 1000, rate: r.relativeFundingRate }));
  }
}

export interface PriceSink {
  onPrice(e: PriceEvent): void;
}

// Every quote read through this market is also fed to the simulated exchange (a quote that cannot be fed is still
// returned: the engine must see the market even if the simulation is behind).
export class FeedingMarket implements MarketData {
  readonly clock: Clock;
  private readonly inner: MarketData;
  private readonly sink: PriceSink;
  onFeedError: (e: unknown) => void = () => {};

  constructor(inner: MarketData, sink: PriceSink) {
    this.inner = inner;
    this.sink = sink;
    this.clock = inner.clock;
  }

  async ticker(): Promise<PriceEvent> {
    const p = await this.inner.ticker();
    try {
      this.sink.onPrice(p);
    } catch (e) {
      this.onFeedError(e);
    }
    return p;
  }

  candles(resolution: string, n: number) { return this.inner.candles(resolution, n); }
  contract() { return this.inner.contract(); }
  fundingRates() { return this.inner.fundingRates(); }
}
