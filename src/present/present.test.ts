import assert from "node:assert/strict";
import { test } from "node:test";
import { FUNDING, PRICE, QUANTITY, num, round, usdScale } from "./round.ts";
import { FACTORS, type Row, fitRows, resample } from "./resample.ts";
import { atr, extremes, logReturnSigma, pctChange, percentileRank, quadrant, spikes, swings, takerFlow, zScore } from "./stats.ts";
import { PresentedText, findGaps, intervalLabel, renderSeries, renderSeriesList } from "./table.ts";
import { COINALYZE_LONG_SHORT, COINALYZE_OHLCV, KRAKEN_FUTURES_CANDLES, type Agg, coinalyzeFunding, coinalyzeLiquidations, coinalyzeOpenInterest } from "./units.ts";

const H = 3600;
const T0 = 1759190400; // 2025-09-30T00:00Z

// Deterministic pseudo-random numbers for the property tests.
function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// ---- round ----

test("rounding rules: significant figures, float32 noise, -0 and scaled USD", () => {
  assert.equal(round(5678.89990234375, PRICE), 5678.9);
  assert.equal(round(102345.67, PRICE), 102345.7);
  assert.equal(round(0.523456789, PRICE), 0.5234568);
  assert.equal(round(3013.052267294251, QUANTITY), 3013.05);
  assert.equal(round(0.005650547992601315, FUNDING), 0.005651);
  assert.equal(Object.is(round(-0.0001, { kind: "fixed", decimals: 2 }), -0), false);
  assert.equal(round(7_412_345_678, { kind: "scaled", divisor: 1e6, decimals: 2 }), 7412.35);
  assert.equal(round(Number.NaN, PRICE), Number.NaN);
});

test("num never prints an exponent and leaves missing values empty", () => {
  assert.equal(num(1.5e-7), "0.00000015");
  assert.equal(num(-2.5e-8), "-0.000000025");
  assert.equal(num(1e21), "1000000000000000000000");
  assert.equal(num(62144.1), "62144.1");
  assert.equal(num(undefined), "");
  assert.equal(num(Number.POSITIVE_INFINITY), "");
});

test("usdScale picks one magnitude per column", () => {
  assert.equal(usdScale([7.4e9, 1e3]).suffix, "musd");
  assert.equal(usdScale([3.9e6, 0]).suffix, "kusd");
  assert.equal(usdScale([120_000]).suffix, "kusd");
  assert.equal(usdScale([99_999]).suffix, "usd");
  assert.equal(usdScale([]).suffix, "usd");
});

test("PRICE rounding never moves a price by more than half a unit of its 7th significant digit", () => {
  const rnd = lcg(11);
  for (let i = 0; i < 2000; i++) {
    const x = 10 ** (rnd() * 8 - 3) * (1 + rnd());
    const r = round(x, PRICE);
    const unit = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 6);
    assert.ok(Math.abs(r - x) <= unit / 2 + 1e-12 * Math.abs(x), `${x} -> ${r}`);
  }
});

// ---- stats ----

test("pctChange, extremes, percentileRank and zScore", () => {
  assert.equal(pctChange(100, 110), 10);
  assert.equal(pctChange(-100, -90), 10); // relative to the size of the base
  assert.equal(pctChange(0, 5), undefined);
  assert.deepEqual(extremes([{ t: 1, v: 5 }, { t: 2, v: 1 }, { t: 3, v: 5 }, { t: 4, v: 1 }, { t: 5, v: undefined }]), { min: 1, minT: 2, max: 5, maxT: 1 });
  assert.equal(extremes([]), undefined);
  assert.equal(percentileRank([1, 2, 3, 4], 3), 75);
  assert.equal(zScore([1, 1, 1], 1), undefined);
  assert.equal(zScore([1, 3], 3), 1);
});

test("logReturnSigma is the sample standard deviation of log returns", () => {
  const closes = [100, 110, 99, 108.9];
  const r = [Math.log(1.1), Math.log(0.9), Math.log(1.1)];
  const m = r.reduce((a, b) => a + b) / 3;
  const expected = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / 2);
  assert.ok(Math.abs(logReturnSigma(closes)! - expected) < 1e-12);
  assert.equal(logReturnSigma([100]), undefined);
});

test("atr uses closed bars only and refuses a gap", () => {
  const bars = Array.from({ length: 6 }, (_, i) => ({ t: T0 + i * H, o: 100, h: 102, l: 98, c: 100 }));
  assert.equal(atr(bars, 3, H, T0 + 6 * H), 4);
  assert.equal(atr(bars, 5, H, T0 + 5 * H + 1), undefined); // the last bar is open: only 5 closed, needs 6
  assert.equal(atr([bars[0]!, bars[1]!, bars[3]!, bars[4]!], 3, H, T0 + 9 * H), undefined);
});

test("swings need a strict extreme with confirmation on both sides", () => {
  const highs = [1, 2, 3, 9, 3, 2, 1, 2, 3, 3, 3];
  const bars = highs.map((h, i) => ({ t: T0 + i * H, o: h, h, l: h - 0.5, c: h }));
  const sw = swings(bars, 3);
  assert.deepEqual(sw.filter((s) => s.kind === "high").map((s) => s.price), [9]);
  assert.deepEqual(sw.filter((s) => s.kind === "low").map((s) => s.t), [T0 + 6 * H]);
});

test("takerFlow, quadrant and spikes", () => {
  assert.deepEqual(takerFlow([{ v: 10, bv: 6 }, { v: 10, bv: 4 }]), { buyShare: 0.5, cvd: 0 });
  assert.equal(takerFlow([]).buyShare, undefined);
  assert.equal(quadrant(-1.2, 3.4), "price down, OI up");
  assert.equal(quadrant(0.05, 3.4), "flat");
  const pts = Array.from({ length: 20 }, (_, i) => ({ t: i, v: i === 7 ? 100 : 1 }));
  assert.deepEqual(spikes(pts).map((p) => p.t), [7]);
  assert.deepEqual(spikes([{ t: 1, v: 0 }]), []);
});

// ---- resample ----

const AGGS: Agg[] = ["first", "max", "min", "last", "sum"];
const randomRows = (n: number, seed: number): Row[] => {
  const rnd = lcg(seed);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= 1 + (rnd() - 0.5) * 0.02;
    return { t: T0 + i * H, v: [o, Math.max(o, p) * 1.001, Math.min(o, p) * 0.999, p, rnd() * 10], bars: 1 };
  });
};

test("resample keeps the window's first open, high, low, last close, summed volume and bar count", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rows = randomRows(97, seed);
    for (const factor of FACTORS) {
      const out = resample(rows, H * factor, AGGS);
      assert.equal(out[0]!.v[0], rows[0]!.v[0]);
      assert.equal(Math.max(...out.map((r) => r.v[1]!)), Math.max(...rows.map((r) => r.v[1]!)));
      assert.equal(Math.min(...out.map((r) => r.v[2]!)), Math.min(...rows.map((r) => r.v[2]!)));
      assert.equal(out.at(-1)!.v[3], rows.at(-1)!.v[3]);
      const sum = (rs: Row[]) => rs.reduce((n, r) => n + r.v[4]!, 0);
      assert.ok(Math.abs(sum(out) - sum(rows)) < 1e-9);
      assert.equal(out.reduce((n, r) => n + r.bars, 0), rows.length);
      for (const r of out) assert.equal(r.t % (H * factor), 0); // epoch-aligned buckets
    }
  }
});

test("missing values aggregate to missing, never to zero", () => {
  const out = resample([{ t: 0, v: [undefined], bars: 1 }, { t: H, v: [undefined], bars: 1 }], 2 * H, ["sum"]);
  assert.deepEqual(out, [{ t: 0, v: [undefined], bars: 2 }]);
});

test("fitRows fits the budget, keeps the newest rows native and leaves fitting input alone", () => {
  const rows = randomRows(500, 9);
  assert.equal(fitRows(rows, H, 500, 48, AGGS), undefined);
  for (const maxRows of [10, 50, 100, 200, 499]) {
    const plan = fitRows(rows, H, maxRows, 48, AGGS)!;
    assert.ok(plan.rows.length <= maxRows, `${maxRows}: ${plan.rows.length}`);
    const native = plan.rows.filter((r) => r.t >= plan.boundary);
    assert.deepEqual(native, rows.slice(rows.length - native.length));
    assert.equal(native.length, Math.min(48, Math.floor(maxRows / 2)));
    assert.equal(plan.rows.reduce((n, r) => n + r.bars, 0), rows.length);
  }
});

// ---- table ----

const ohlcvPoint = (i: number) => ({
  t: T0 + i * H, o: 62000.1 + i * 10, h: 62100.4 + i * 10, l: 61950 + i, c: 62010.5 + i * 12,
  v: 3013.052267294251 + i, bv: 1632.4129827993788, tx: 93405, btx: 48972,
});

test("golden: OHLCV with a gap and an open last bar", () => {
  const pts = [0, 1, 2, 4].map(ohlcvPoint);
  const text = renderSeries(COINALYZE_OHLCV, pts, { tool: "coinalyze_ohlcv_history", symbol: "BTCUSDT_PERP.A", intervalSec: H, asOfSec: T0 + 4 * H + 600 });
  assert.equal(text, [
    "coinalyze_ohlcv_history BTCUSDT_PERP.A 1h (Coinalyze OHLCV): 4 bars, 2025-09-30T00:00Z .. 2025-09-30T04:00Z (bar start times, UTC)",
    "as of 2025-09-30T04:10Z; last bar 2025-09-30T04:00Z is still open (its values will change)",
    "units: open, high, low, close: price in the market's quote currency; volume, buy_volume: as reported by Coinalyze (base asset or contracts, depending on the market); buy = taker buys; taker_buy_share = buy_volume / volume (0..1; above 0.5 aggressive buyers dominate)",
    "gaps: 1 bar with no data returned, in 1 span: 2025-09-30T03:00Z",
    "summary: close 62010.5 -> 62058.5 (+0.08%); low 61950 at 2025-09-30T00:00Z; high 62140.4 at 2025-09-30T04:00Z",
    "time,open,high,low,close,volume,buy_volume,trades,buy_trades,taker_buy_share",
    "2025-09-30T00:00Z,62000.1,62100.4,61950,62010.5,3013.05,1632.41,93405,48972,0.542",
    "2025-09-30T01:00Z,62010.1,62110.4,61951,62022.5,3014.05,1632.41,93405,48972,0.542",
    "2025-09-30T02:00Z,62020.1,62120.4,61952,62034.5,3015.05,1632.41,93405,48972,0.541",
    "2025-09-30T04:00Z,62040.1,62140.4,61954,62058.5,3017.05,1632.41,93405,48972,0.541",
  ].join("\n"));
});

test("golden: USD open interest in millions, funding with absolute change, long/short", () => {
  const oi = renderSeries(coinalyzeOpenInterest(true), [0, 1].map((i) => ({ t: T0 + i * H, o: 7.4e9 + i * 1e7, h: 7.42e9 + i * 1e7, l: 7.39e9, c: 7.41e9 + i * 1.3e7 })),
    { tool: "coinalyze_open_interest_history", symbol: "BTCUSDT_PERP.A", intervalSec: H, asOfSec: T0 + 10 * H });
  assert.equal(oi.split("\n").slice(1).join("\n"), [
    "as of 2025-09-30T10:00Z; all bars closed",
    "units: oi_*: open interest in USD (scale in the column name)",
    "gaps: none",
    "summary: open interest 7410M -> 7423M (+0.18%); low 7390M at 2025-09-30T00:00Z; high 7430M at 2025-09-30T01:00Z",
    "time,oi_open_musd,oi_high_musd,oi_low_musd,oi_close_musd",
    "2025-09-30T00:00Z,7400,7420,7390,7410",
    "2025-09-30T01:00Z,7410,7430,7390,7423",
  ].join("\n"));

  const funding = renderSeries(coinalyzeFunding(false), [{ t: T0, o: 0.0056505, h: 0.0059536, l: 0.0054282, c: 0.0058842 }, { t: T0 + H, o: 0.0058842, h: 0.0071, l: 0.0058, c: 0.00702 }],
    { tool: "coinalyze_funding_rate_history", symbol: "BTCUSDT_PERP.A", intervalSec: H, asOfSec: T0 + 10 * H });
  assert.match(funding, /\nsummary: funding 0\.005884 -> 0\.00702 \(\+0\.001136\); low 0\.005428 at 2025-09-30T00:00Z; high 0\.0071 at 2025-09-30T01:00Z\n/);

  const ls = renderSeries(COINALYZE_LONG_SHORT, [{ t: T0, r: 1.8461538, l: 64.87, s: 35.13 }], { tool: "t", symbol: "S", intervalSec: H, asOfSec: T0 + H });
  assert.match(ls, /\ntime,long_short_ratio,long_pct,short_pct\n2025-09-30T00:00Z,1\.846,64\.87,35\.13$/);
});

test("golden: liquidations under a row budget", () => {
  const pts = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * H, l: i === 20 ? 3.9e6 : 120000 + i * 1000, s: 50000 }));
  const text = renderSeries(coinalyzeLiquidations(true), pts, { tool: "coinalyze_liquidation_history", symbol: "BTCUSDT_PERP.A", intervalSec: H, asOfSec: T0 + 40 * H, maxRows: 10, recentRows: 4 });
  assert.equal(text.split("\n").slice(4).join("\n"), [
    "summary: liquidations over the window: liq_long total 7795k, largest 3900k at 2025-09-30T20:00Z; liq_short total 1500k, largest 50k at 2025-09-30T00:00Z",
    "rows: 9 (budget 10); bars before 2025-10-01T02:00Z resampled to 6h buckets, the newest 4 at 1h; column bars = native bars per row",
    "time,liq_long_kusd,liq_short_kusd,bars",
    "2025-09-30T00:00Z,735,300,6",
    "2025-09-30T06:00Z,771,300,6",
    "2025-09-30T12:00Z,807,300,6",
    "2025-09-30T18:00Z,4603,300,6",
    "2025-10-01T00:00Z,289,100,2",
    "2025-10-01T02:00Z,146,50,1",
    "2025-10-01T03:00Z,147,50,1",
    "2025-10-01T04:00Z,148,50,1",
    "2025-10-01T05:00Z,149,50,1",
  ].join("\n"));
});

test("a derived share is recomputed from resampled sums, not averaged", () => {
  const pts = [{ ...ohlcvPoint(0), v: 10, bv: 9 }, { ...ohlcvPoint(1), v: 90, bv: 9 }, ohlcvPoint(2), ohlcvPoint(3)];
  const text = renderSeries(COINALYZE_OHLCV, pts, { tool: "t", symbol: "S", intervalSec: H, asOfSec: T0 + 9 * H, maxRows: 3, recentRows: 2 });
  const firstRow = text.split("\n").find((l) => l.startsWith("2025-09-30T00:00Z"))!;
  assert.match(firstRow, /,0\.18,2$/); // (9 + 9) / (10 + 90), over 2 native bars
});

test("one row per point without a budget, duplicates keep the later point, output is deterministic", () => {
  const rnd = lcg(3);
  const pts = Array.from({ length: 300 }, (_, i) => ({ t: T0 + i * 300, o: 1 + rnd(), h: 3, l: 0.5, c: 1 + rnd(), v: rnd() * 100 }));
  const meta = { tool: "kraken_futures_candles", symbol: "PF_XRPUSD", intervalSec: 300, asOfSec: T0 + 400 * 300 };
  const a = renderSeries(KRAKEN_FUTURES_CANDLES, pts, meta);
  assert.equal(a, renderSeries(KRAKEN_FUTURES_CANDLES, [...pts].reverse(), meta));
  assert.equal(a.split("\n").filter((l) => /^\d{4}-/.test(l)).length, 300);
  const dup = renderSeries(KRAKEN_FUTURES_CANDLES, [pts[0]!, { ...pts[0]!, c: 2.5 }], meta);
  assert.match(dup, /\n2025-09-30T00:00Z,[\d.]+,3,0\.5,2\.5,[\d.]+$/);
});

test("empty series, empty cells for missing values, and the multi-symbol wrapper", () => {
  assert.equal(renderSeries(KRAKEN_FUTURES_CANDLES, [], { tool: "t", symbol: "S", intervalSec: H, asOfSec: T0 }), "t S 1h (Kraken Futures trade-price candles): no data returned for this range\nas of 2025-09-30T00:00Z");
  const missing = renderSeries(coinalyzeLiquidations(true), [{ t: T0, l: Number.NaN, s: 5 }], { tool: "t", symbol: "S", intervalSec: H, asOfSec: T0 + H });
  assert.match(missing, /\n2025-09-30T00:00Z,,5$/);
  const list = renderSeriesList(coinalyzeLiquidations(false), [{ symbol: "A", history: [{ t: T0, l: 1, s: 2 }] }, { symbol: "B", history: [] }], { tool: "t", intervalSec: H, asOfSec: T0 + H });
  assert.ok(list instanceof PresentedText);
  assert.equal(list.points, 1);
  assert.match(list.text, /^t A 1h[\s\S]*\n\nt B 1h \(Coinalyze liquidations\): no data returned/);
});

test("a change that rounds to zero prints 0.00%, never -0.00%", () => {
  const pts = [{ t: T0, o: 1, h: 1, l: 1, c: 62040.5, v: 1 }, { t: T0 + H, o: 1, h: 1, l: 1, c: 62039.5, v: 1 }];
  assert.match(renderSeries(KRAKEN_FUTURES_CANDLES, pts, { tool: "t", symbol: "S", intervalSec: H, asOfSec: T0 + 9 * H }), /close 62040\.5 -> 62039\.5 \(0\.00%\)/);
});

test("gaps and interval labels", () => {
  assert.deepEqual(findGaps([0, H, 4 * H, 5 * H, 7 * H], H), [{ from: 2 * H, to: 3 * H, bars: 2 }, { from: 6 * H, to: 6 * H, bars: 1 }]);
  assert.deepEqual([60, 900, 3600, 14_400, 86_400, 604_800, 90].map(intervalLabel), ["1m", "15m", "1h", "4h", "1d", "1w", "90s"]);
});
