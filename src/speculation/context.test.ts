// speculation/context.test.ts – offline tests of the measured KNOWN layer (fake Kraken Futures and Coinalyze).
// Run: node --test src/speculation/context.test.ts

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { FutureMarket, HistoryParams } from "../providers/coinalyze/coinalyze-client.ts";
import type { FuturesCandle, FuturesTicker } from "../providers/kraken/kraken-futures-client.ts";
import { buildContext, clearVolumeCache, type CoinalyzeSource, type FuturesSource } from "./context.ts";

const NOW = Date.parse("2026-10-04T11:15:00Z") / 1000; // 13:15 Warsaw: the overlap session is next

const ticker = (base: string, price: number, over: Partial<FuturesTicker> = {}): FuturesTicker => ({
  symbol: `PF_${base}USD`, tag: "perpetual", last: price, markPrice: price, bid: price * 0.99995, ask: price * 1.00005,
  vol24h: 0, volumeQuote: 200e6, openInterest: 100e6 / price, fundingRate: 0, suspended: false, ...over,
});

// Hourly candles over the last `hours`, range `range(i)` as a fraction of price, volume `v(hour of day)`.
const candles = (price: number, hours: number, range: (i: number) => number = () => 0.004, v: (h: number) => number = () => 10): FuturesCandle[] => {
  const end = Math.floor(NOW / 3600) * 3600;
  return Array.from({ length: hours }, (_, i) => {
    const t = end - (hours - i) * 3600;
    const r = price * range(i);
    return { t, o: price, h: price + r / 2, l: price - r / 2, c: price, v: v(new Date(t * 1000).getUTCHours()) };
  });
};

function fakeFutures(tickers: FuturesTicker[], over: { hot?: string; failCandles?: string } = {}): FuturesSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async tickers() {
      calls.push("tickers");
      return tickers;
    },
    async candles(symbol, _res, range) {
      calls.push(`candles ${symbol}`);
      if (symbol === over.failCandles) throw new Error("HTTP 503");
      const t = tickers.find((x) => x.symbol === symbol)!;
      const hours = Math.round(((range.to ?? NOW) - (range.from ?? NOW)) / 3600);
      return { candles: candles(t.last, hours, (i) => (symbol === over.hot && i >= hours - 4 ? 0.02 : 0.004)) };
    },
    async orderBook(symbol) {
      calls.push(`book ${symbol}`);
      const t = tickers.find((x) => x.symbol === symbol)!;
      return { symbol, bids: [{ price: t.bid, size: 1e6 / t.bid }], asks: [{ price: t.ask, size: 1e6 / t.ask }] };
    },
  };
}

function fakeCoinalyze(): CoinalyzeSource & { requests: HistoryParams[] } {
  const requests: HistoryParams[] = [];
  const hist = <P>(p: HistoryParams, point: (i: number) => P) =>
    p.symbols.map((symbol) => ({ symbol, history: Array.from({ length: Math.round((p.to - p.from) / 3600) }, (_, i) => ({ t: p.from + i * 3600, ...point(i) })) }));
  const market = (symbol: string, base: string, exchange: string): FutureMarket => ({
    symbol, exchange, symbol_on_exchange: symbol, base_asset: base, quote_asset: "USDT", is_perpetual: true, margined: "STABLE",
    expire_at: null, oi_lq_vol_denominated_in: "BASE_ASSET", has_long_short_ratio_data: true, has_ohlcv_data: true, has_buy_sell_data: true,
  });
  return {
    requests,
    async futureMarkets() {
      return [market("BTCUSDT_PERP.A", "BTC", "A"), market("BTCUSDT_PERP.6", "BTC", "6"), market("ETHUSDT_PERP.A", "ETH", "A"), market("XRPUSDT_PERP.A", "XRP", "A"), market("SOLUSDT_PERP.A", "SOL", "A")];
    },
    async openInterestHistory(p) {
      requests.push(p);
      return hist(p, (i) => ({ o: 100 + i, h: 100 + i, l: 100 + i, c: 100 + i })); // rising OI
    },
    async longShortRatioHistory(p) {
      requests.push(p);
      return hist(p, () => ({ r: 1.8, l: 0.64, s: 0.36 }));
    },
    async liquidationHistory(p) {
      requests.push(p);
      const n = Math.round((p.to - p.from) / 3600);
      return hist(p, (i) => (i === n - 1 ? { l: 30, s: 30 } : { l: 5, s: 5 })); // last hour 6x normal
    },
    async ohlcvHistory(p) {
      requests.push(p);
      // more volume in US hours (13-20 UTC)
      return hist(p, (i) => {
        const h = new Date((p.from + i * 3600) * 1000).getUTCHours();
        return { o: 1, h: 1, l: 1, c: 1, v: h >= 13 && h <= 20 ? 30 : 10, bv: 0, tx: 0, btx: 0 };
      });
    },
  };
}

const universe = [
  ticker("XBT", 65000), ticker("ETH", 3000), ticker("XRP", 2.4),
  ticker("SOL", 150), ticker("DOGE", 0.2), ticker("ADA", 0.5, { volumeQuote: 1e6 }), // ADA too illiquid
  { ...ticker("XBT", 65000), symbol: "PI_XBTUSD" }, // inverse: not in the universe
];

beforeEach(() => clearVolumeCache());

describe("buildContext", () => {
  test("measures the core and screened symbols from Kraken and fills meta-ready rows", async () => {
    const futures = fakeFutures(universe, { hot: "PF_SOLUSD" });
    const ctx = await buildContext({ futures, coinalyze: fakeCoinalyze() }, { nowSec: NOW, screen: { extra: 1 } });
    assert.equal(ctx.session.session, "eu_us_overlap");
    assert.deepEqual(ctx.symbols.map((s) => s.symbol), ["BTC", "ETH", "XRP", "SOL"]);
    const sol = ctx.symbols.find((s) => s.symbol === "SOL")!;
    assert.match(sol.why, /^screen: ATR/);
    const btc = ctx.symbols[0]!;
    assert.equal(btc.futures, "PF_XBTUSD");
    assert.equal(btc.last, 65000);
    assert.ok(btc.atr_1h! > 0 && btc.spread_bps < 2);
    assert.deepEqual(Object.keys(ctx.metaSymbols[0]!).sort(), ["atr_1h", "futures", "last", "spread_bps", "symbol", "why"]);
    assert.match(ctx.excluded.find((e) => e.symbol === "ADA")?.reason ?? "ADA filtered before measuring", /volume|filtered/);
    assert.ok(!futures.calls.includes("candles PF_ADAUSD"), "illiquid symbols are not measured");
  });

  test("adds Coinalyze OI change, long/short ratio and liquidation burst", async () => {
    const ctx = await buildContext({ futures: fakeFutures(universe), coinalyze: fakeCoinalyze() }, { nowSec: NOW, screen: { extra: 0 } });
    const cz = ctx.symbols.find((s) => s.symbol === "XRP")!.coinalyze!;
    assert.equal(cz.symbol, "XRPUSDT_PERP.A");
    assert.ok(cz.oi_change_1h_pct! > 0 && cz.oi_change_4h_pct! > cz.oi_change_1h_pct!);
    assert.equal(cz.long_short_ratio, 1.8);
    assert.equal(cz.liquidation_burst, 6);
    assert.ok(!ctx.notMeasured.some((n) => /long\/short/.test(n)));
  });

  test("the volume share is summed across exchanges and ranks the US-heavy sessions first", async () => {
    const ctx = await buildContext({ futures: fakeFutures(universe), coinalyze: fakeCoinalyze() }, { nowSec: NOW, screen: { extra: 0 } });
    assert.ok(!("error" in ctx.volume), JSON.stringify(ctx.volume));
    assert.match(ctx.volume.source, /2 exchanges/);
    const shares = (ctx.volume as { shares: { id: string; rank: number }[] }).shares;
    assert.ok(shares.find((x) => x.id === "us")!.rank < shares.find((x) => x.id === "night_asia")!.rank);
  });

  test("without Coinalyze it still works: Kraken-only volume, and the gaps are listed under notMeasured", async () => {
    const ctx = await buildContext({ futures: fakeFutures(universe) }, { nowSec: NOW, screen: { extra: 0 } });
    assert.equal(ctx.symbols[0]!.coinalyze, undefined);
    assert.ok(ctx.notMeasured.some((n) => /no COINALYZE_API_KEY/.test(n)));
    assert.match(ctx.volume.source, /Kraken Futures PF_XBTUSD only/);
  });

  test("a failing candle request is a warning, and that symbol has no ATR and no meta row", async () => {
    const ctx = await buildContext({ futures: fakeFutures(universe, { failCandles: "PF_ETHUSD" }) }, { nowSec: NOW, screen: { extra: 0 } });
    assert.ok(ctx.warnings.some((w) => /candles PF_ETHUSD: HTTP 503/.test(w)));
    assert.equal(ctx.symbols.find((s) => s.symbol === "ETH")!.atr_1h, undefined);
    assert.ok(!ctx.metaSymbols.some((s) => s.symbol === "ETH"));
  });

  test("the volume profile is cached for six hours", async () => {
    const cz = fakeCoinalyze();
    await buildContext({ futures: fakeFutures(universe), coinalyze: cz }, { nowSec: NOW, screen: { extra: 0 } });
    const before = cz.requests.filter((r) => r.symbols.includes("BTCUSDT_PERP.6")).length;
    await buildContext({ futures: fakeFutures(universe), coinalyze: cz }, { nowSec: NOW + 3600, screen: { extra: 0 } });
    assert.equal(cz.requests.filter((r) => r.symbols.includes("BTCUSDT_PERP.6")).length, before);
  });
});
