import assert from "node:assert/strict";
import { test } from "node:test";
import { type MarketPoint, marketFacts, ordinal, usd } from "./facts.ts";
import { joinMarket, renderMarketView } from "./market-view.ts";

const H = 3600;
const T0 = 1759190400; // 2025-09-30T00:00Z

// 48 hourly bars: price rises 0.1% per bar, OI rises 0.2% per bar, funding climbs to the window high, accounts get
// more long, takers mostly sell, one long-liquidation spike at bar 40, Kraken 5 bps above.
function fixture(n = 48): MarketPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 * 1.001 ** (i + 1);
    const o = 100 * 1.001 ** i;
    return {
      t: T0 + i * H, o, h: c + 0.05, l: o - 0.05, c, v: 100, bv: 45,
      oi: 1e9 * 1.002 ** i, fr: 0.001 + i * 0.0001, ls: 1.5 + i * 0.01,
      liqL: i === 40 ? 5e6 : 1e5, liqS: 5e4, kf: c * 1.0005,
    };
  });
}

test("joinMarket is an outer join on the bar time", () => {
  const joined = joinMarket({
    ohlcv: [{ t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, bv: 6, tx: 1, btx: 1 }],
    openInterest: [{ t: 0, o: 5, h: 5, l: 5, c: 7 }, { t: H, o: 7, h: 8, l: 7, c: 8 }],
    funding: [], longShort: [{ t: H, r: 2, l: 66.7, s: 33.3 }], liquidations: [],
    krakenCandles: [{ t: 0, o: 1, h: 1, l: 1, c: 1.6, v: 1 }],
  });
  assert.deepEqual(joined, [
    { t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, bv: 6, oi: 7, kf: 1.6 },
    { t: H, oi: 8, ls: 2 },
  ]);
});

test("facts: changes, quadrant, funding percentile, long/short, taker flow, spikes, squeeze conditions, Kraken", () => {
  const facts = marketFacts(fixture(), H, { symbol: "PF_TESTUSD", fundingPct8h: 0.0123 });
  const byKind = (prefix: string) => facts.find((f) => f.startsWith(prefix)) ?? "";
  assert.match(byKind("price:"), /close 104\.9145 at 2025-10-01T23:00Z \(last closed bar\); change 1 bar \+0\.10%, 4h \+0\.40%, 24h \+2\.43%, window \+4\.81%/);
  assert.match(byKind("price:"), /ATR14 0\.2041 \(0\.19% of price\); σ of log returns 0\.00% per bar/);
  assert.match(byKind("open interest:"), /^open interest: 1\.10B USD; change 4h \+0\.80%, 24h \+4\.91%, window \+9\.85%; 100th percentile of the window; quadrant 4h: price up, OI up; 24h: price up, OI up/);
  assert.match(byKind("funding"), /: 0\.0057; 100th percentile of the window, z 1\.70; positive in 48 of 48 bars; at or above the 80th percentile: longs crowded$/);
  assert.match(byKind("long/short"), /: 1\.97; window median 1\.73; 24h change \+13\.87%; at least 5% above the median: accounts clearly long$/);
  assert.match(byKind("taker flow"), /^taker flow 24h: buy share 0\.450 \(below 0\.48: sellers dominate; window 0\.450\); CVD -240 in volume units; divergence: price \+2\.43% while CVD is negative$/);
  assert.match(byKind("liquidations"), /24h longs 7\.3M, shorts 1\.2M; window longs 9\.7M, shorts 2\.4M; spikes above the window's 95th percentile \(newest first\): 2025-10-01T16:00Z 5\.0M \(mostly longs\)$/);
  assert.match(byKind("squeeze"), /long squeeze 4 of 4 \(1 funding p100; 2 OI near the window high; 3 L\/S 1\.97 vs median 1\.73; 5 price up without aggressive buying\); short squeeze 1 of 4 \(5 sellers absorbed \(price not falling\)\)/);
  assert.equal(byKind("Kraken"), "Kraken Futures PF_TESTUSD: close 104.967; vs the Coinalyze close +5.0 bps; funding now 0.0123% per 8h (ticker)");
});

test("facts degrade cleanly: a short window, missing series, a daily interval", () => {
  const priceOnly = fixture(10).map(({ t, o, h, l, c, v, bv }) => ({ t, o, h, l, c, v, bv }));
  const facts = marketFacts(priceOnly, H);
  assert.ok(facts[0]!.includes("24h n/a"));
  assert.ok(facts[0]!.includes("ATR14 n/a"));
  assert.ok(!facts.some((f) => f.startsWith("open interest") || f.startsWith("funding") || f.startsWith("Kraken")));
  assert.deepEqual(marketFacts([], H), ["no closed bars in the window"]);
  const daily = marketFacts(fixture(20).map((p, i) => ({ ...p, t: T0 + i * 86_400 })), 86_400);
  assert.match(daily[0]!, /change 1 bar \+0\.10%, 24h \+0\.10%, window/); // a day is one bar; no 4h change
});

test("the view: open bar shown but not used by facts, hidden buy_volume, failed series, budget", () => {
  const pts = fixture(60);
  const at = (k: keyof MarketPoint) => pts.filter((p) => p[k] !== undefined);
  const view = renderMarketView({
    asset: "TEST", symbol: "TESTUSDT_PERP.A", intervalSec: H, asOfSec: T0 + 60 * H - 600,
    ohlcv: at("c").map((p) => ({ t: p.t, o: p.o!, h: p.h!, l: p.l!, c: p.c!, v: p.v!, bv: p.bv!, tx: 1, btx: 1 })),
    openInterest: at("oi").map((p) => ({ t: p.t, o: p.oi!, h: p.oi!, l: p.oi!, c: p.oi! })),
    funding: [], longShort: [], liquidations: [], maxRows: 30, failed: ["funding (http 500: boom)"],
  });
  const lines = view.text.split("\n");
  assert.equal(view.points, 60);
  assert.equal(lines[0], "market_view TEST (Coinalyze TESTUSDT_PERP.A) 1h (joined market view): 60 bars, 2025-09-30T00:00Z .. 2025-10-02T11:00Z (bar start times, UTC)");
  assert.equal(lines[1], "as of 2025-10-02T11:50Z; last bar 2025-10-02T11:00Z is still open (its values will change)");
  assert.ok(lines.includes("facts use the 59 closed bars through 2025-10-02T10:00Z; the table also shows the open bar"));
  assert.ok(lines.includes("not available: funding (http 500: boom) (their columns are empty)"));
  assert.match(view.text, /\nfacts:\n- price: close [\d.]+ at 2025-10-02T10:00Z/);
  const header = lines.find((l) => l.startsWith("time,"))!;
  assert.equal(header, "time,open,high,low,close,volume,oi_musd,funding,long_short_ratio,liq_long_usd,liq_short_usd,kf_close,taker_buy_share,bars");
  assert.ok(lines.filter((l) => /^2025-/.test(l)).length <= 30);
  assert.match(lines.at(-1)!, /^2025-10-02T11:00Z,.*,,,,,,0\.45,1$/); // missing series are empty cells, never zeros
});

test("ordinals", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 72, 100, 101, 111].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "72nd", "100th", "101st", "111th"]);
});

test("usd formatting picks B, M, k or units", () => {
  assert.deepEqual([1.234e9, 5.06e6, 1234, 12, -2.5e6, undefined].map(usd), ["1.23B", "5.1M", "1.2k", "12", "-2.5M", "n/a"]);
});
