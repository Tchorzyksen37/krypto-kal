// present/facts.ts – fact lines for the joined market view, computed from closed bars only (an open bar's volume,
// taker share and liquidations are partial). Each fact carries its numbers and, where it classifies, the threshold
// it used (thresholds.ts). Facts describe the data; they never recommend a trade.

import { pctChange, percentileRank, zScore, atr, logReturnSigma, swings, takerFlow, quadrant, spikes, extremes, type Bar } from "./stats.ts";
import { num, round, PRICE } from "./round.ts";
import {
  ATR_PERIOD, FUNDING_CROWDED_PCTL, FUNDING_QUIET_PCTL, LS_ABOVE_MEDIAN, LS_BELOW_MEDIAN, OI_NEAR_HIGH,
  QUADRANT_FLAT_PCT, SPIKE_QUANTILE, SWING_SIDE, TAKER_BUYERS_SHARE, TAKER_SELLERS_SHARE,
} from "./thresholds.ts";

// One joined bar: Coinalyze OHLCV, open interest close (USD), funding close (%), long/short ratio, liquidations (USD),
// and the Kraken Futures close of the same bar. Any field can be missing.
export interface MarketPoint {
  t: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  bv?: number;
  oi?: number;
  fr?: number;
  ls?: number;
  liqL?: number;
  liqS?: number;
  kf?: number;
}

export interface KrakenContext {
  symbol: string; // PF_XBTUSD
  fundingPct8h?: number | undefined; // from the ticker, % per 8h
}

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16) + "Z";
const signed = (x: number | undefined, decimals = 2, unit = "%") => {
  if (x === undefined || !Number.isFinite(x)) return "n/a";
  const s = x.toFixed(decimals);
  if (Number(s) === 0) return `${(0).toFixed(decimals)}${unit}`;
  return `${x > 0 ? "+" : ""}${s}${unit}`;
};
const price = (x: number | undefined) => (x === undefined ? "n/a" : num(round(x, PRICE)));
export function usd(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return "n/a";
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(1)}k`;
  return x.toFixed(0);
}
// 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st, 100th.
export function ordinal(n: number): string {
  const k = Math.round(n);
  const tens = k % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[k % 10] ?? "th";
  return `${k}${suffix}`;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return undefined;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// Bars covering `seconds` at `stepSec`, or undefined when it is not a whole number of bars.
const barsIn = (seconds: number, stepSec: number) => (seconds >= stepSec && seconds % stepSec === 0 ? seconds / stepSec : undefined);

interface Series {
  pts: MarketPoint[];
  get: (k: keyof MarketPoint) => { t: number; v: number }[];
  last: (k: keyof MarketPoint) => number | undefined;
  ago: (k: keyof MarketPoint, bars: number | undefined) => number | undefined; // value `bars` bars before the last one
}

function series(pts: MarketPoint[], step: number): Series {
  const get = (k: keyof MarketPoint) => pts.filter((p) => p[k] !== undefined && Number.isFinite(p[k])).map((p) => ({ t: p.t, v: p[k] as number }));
  const lastT = pts.length ? pts[pts.length - 1]!.t : 0;
  return {
    pts, get,
    last: (k) => get(k).at(-1)?.v,
    ago: (k, bars) => {
      if (bars === undefined || !pts.length) return undefined;
      const target = lastT - bars * step;
      return get(k).find((p) => p.t === target)?.v;
    },
  };
}

// `closed` = the closed bars of the window, time ascending, on a regular grid of `stepSec`.
export function marketFacts(closed: MarketPoint[], stepSec: number, kraken?: KrakenContext): string[] {
  const s = series([...closed].sort((a, b) => a.t - b.t), stepSec);
  if (!s.pts.length) return ["no closed bars in the window"];
  const facts: string[] = [];
  const day = barsIn(86_400, stepSec);
  const four = barsIn(14_400, stepSec);
  const dayLabel = day ? "24h" : undefined;
  const lastT = s.pts[s.pts.length - 1]!.t;

  // Price.
  const close = s.last("c");
  const bars: Bar[] = s.pts.filter((p) => [p.o, p.h, p.l, p.c].every((x) => x !== undefined)).map((p) => ({ t: p.t, o: p.o!, h: p.h!, l: p.l!, c: p.c! }));
  const pc24 = pctChange(s.ago("c", day), close);
  const pc4 = pctChange(s.ago("c", four), close);
  if (close !== undefined) {
    const lows = extremes(s.get("l"));
    const highs = extremes(s.get("h"));
    const a = atr(bars, ATR_PERIOD, stepSec, lastT + stepSec);
    const sigma = logReturnSigma(s.get("c").map((p) => p.v));
    const parts = [
      `price: close ${price(close)} at ${iso(lastT)} (last closed bar)`,
      `change 1 bar ${signed(pctChange(s.ago("c", 1), close))}${four && four > 1 ? `, 4h ${signed(pc4)}` : ""}${dayLabel ? `, 24h ${signed(pc24)}` : ""}, window ${signed(pctChange(s.get("c")[0]?.v, close))}`,
      lows && highs ? `window range ${price(lows.min)} (${iso(lows.minT)}) .. ${price(highs.max)} (${iso(highs.maxT)})` : "",
      a !== undefined ? `ATR${ATR_PERIOD} ${num(round(a, { kind: "sig", digits: 4 }))} (${(a / close * 100).toFixed(2)}% of price)` : `ATR${ATR_PERIOD} n/a (too few closed bars or a gap)`,
      sigma !== undefined ? `σ of log returns ${(sigma * 100).toFixed(2)}% per bar${day ? `, ≈ ±${(sigma * Math.sqrt(day) * 100).toFixed(2)}% per day (1σ)` : ""}` : "",
    ];
    facts.push(parts.filter(Boolean).join("; "));

    const sw = swings(bars, SWING_SIDE);
    const above = sw.filter((x) => x.kind === "high" && x.price > close).sort((x, y) => x.price - y.price || y.t - x.t)[0];
    const below = sw.filter((x) => x.kind === "low" && x.price < close).sort((x, y) => y.price - x.price || y.t - x.t)[0];
    facts.push(`levels (swing highs/lows that beat ${SWING_SIDE} bars on each side): nearest above ${above ? `${price(above.price)} (${iso(above.t)})` : "none in the window"}; nearest below ${below ? `${price(below.price)} (${iso(below.t)})` : "none in the window"}`);
  }

  // Open interest.
  const oi = s.last("oi");
  const oi24 = pctChange(s.ago("oi", day), oi);
  const oi4 = pctChange(s.ago("oi", four), oi);
  if (oi !== undefined) {
    const oiVals = s.get("oi").map((p) => p.v);
    const q = (p: number | undefined, o: number | undefined) => (p === undefined || o === undefined ? "n/a" : quadrant(p, o, QUADRANT_FLAT_PCT));
    facts.push(`open interest: ${usd(oi)} USD; change${four && four > 1 ? ` 4h ${signed(oi4)},` : ""}${dayLabel ? ` 24h ${signed(oi24)},` : ""} window ${signed(pctChange(oiVals[0], oi))}; ${ordinal(percentileRank(oiVals, oi)!)} percentile of the window; quadrant${four && four > 1 ? ` 4h: ${q(pc4, oi4)};` : ""}${dayLabel ? ` 24h: ${q(pc24, oi24)}` : ""} (moves under ${QUADRANT_FLAT_PCT}% count as flat)`);
  }

  // Funding.
  const fr = s.last("fr");
  const frVals = s.get("fr").map((p) => p.v);
  const frPct = fr === undefined ? undefined : percentileRank(frVals, fr);
  if (fr !== undefined) {
    const positive = frVals.filter((x) => x > 0).length;
    const z = zScore(frVals, fr);
    const label = fr < 0 ? "negative: shorts pay longs"
      : frPct! >= FUNDING_CROWDED_PCTL ? `at or above the ${ordinal(FUNDING_CROWDED_PCTL)} percentile: longs crowded`
        : frPct! <= FUNDING_QUIET_PCTL ? `at or below the ${ordinal(FUNDING_QUIET_PCTL)} percentile: little long demand` : "mid-range";
    facts.push(`funding (Coinalyze, % per the exchange's interval): ${num(round(fr, { kind: "sig", digits: 4 }))}; ${ordinal(frPct!)} percentile of the window${z !== undefined ? `, z ${z.toFixed(2)}` : ""}; positive in ${positive} of ${frVals.length} bars; ${label}`);
  }

  // Long/short ratio.
  const ls = s.last("ls");
  const lsMed = median(s.get("ls").map((p) => p.v));
  if (ls !== undefined && lsMed !== undefined) {
    const side = ls >= lsMed * LS_ABOVE_MEDIAN ? `at least ${Math.round((LS_ABOVE_MEDIAN - 1) * 100)}% above the median: accounts clearly long`
      : ls <= lsMed * LS_BELOW_MEDIAN ? `at least ${Math.round((1 - LS_BELOW_MEDIAN) * 100)}% below the median: accounts clearly short` : "near the median";
    facts.push(`long/short ratio (accounts, not size): ${ls.toFixed(2)}; window median ${lsMed.toFixed(2)}${dayLabel ? `; 24h change ${signed(pctChange(s.ago("ls", day), ls))}` : ""}; ${side}`);
  }

  // Taker flow over the last day (or the whole window).
  const flowBars = day ? s.pts.slice(-day) : s.pts;
  const flowRows = flowBars.filter((p) => p.v !== undefined && p.bv !== undefined).map((p) => ({ v: p.v!, bv: p.bv! }));
  const flow = takerFlow(flowRows);
  const windowFlow = takerFlow(s.pts.filter((p) => p.v !== undefined && p.bv !== undefined).map((p) => ({ v: p.v!, bv: p.bv! })));
  if (flow.buyShare !== undefined) {
    const who = flow.buyShare < TAKER_SELLERS_SHARE ? `below ${TAKER_SELLERS_SHARE}: sellers dominate` : flow.buyShare > TAKER_BUYERS_SHARE ? `above ${TAKER_BUYERS_SHARE}: buyers dominate` : "balanced";
    const pcFlow = day ? pc24 : pctChange(s.get("c")[0]?.v, close);
    const diverge = pcFlow !== undefined && Math.abs(pcFlow) >= QUADRANT_FLAT_PCT && Math.sign(flow.cvd) !== Math.sign(pcFlow) && flow.cvd !== 0
      ? `; divergence: price ${signed(pcFlow)} while CVD is ${flow.cvd > 0 ? "positive" : "negative"}` : "";
    facts.push(`taker flow ${dayLabel ?? "window"}: buy share ${flow.buyShare.toFixed(3)} (${who}; window ${windowFlow.buyShare?.toFixed(3) ?? "n/a"}); CVD ${num(round(flow.cvd, { kind: "sig", digits: 4 }))} in volume units${diverge}`);
  }

  // Liquidations.
  const liq = s.pts.filter((p) => p.liqL !== undefined || p.liqS !== undefined);
  if (liq.length) {
    const recent = day ? liq.filter((p) => p.t > lastT - day * stepSec) : liq;
    const sum = (ps: MarketPoint[], k: "liqL" | "liqS") => ps.reduce((n, p) => n + (p[k] ?? 0), 0);
    const totals = liq.map((p) => ({ t: p.t, v: (p.liqL ?? 0) + (p.liqS ?? 0) }));
    const sp = spikes(totals, SPIKE_QUANTILE).sort((a, b) => b.t - a.t).slice(0, 3).map((x) => {
      const p = liq.find((q) => q.t === x.t)!;
      return `${iso(x.t)} ${usd(x.v)} (mostly ${(p.liqL ?? 0) >= (p.liqS ?? 0) ? "longs" : "shorts"})`;
    });
    facts.push(`liquidations (USD): ${dayLabel ?? "window"} longs ${usd(sum(recent, "liqL"))}, shorts ${usd(sum(recent, "liqS"))}; window longs ${usd(sum(liq, "liqL"))}, shorts ${usd(sum(liq, "liqS"))}; spikes above the window's ${ordinal(SPIKE_QUANTILE * 100)} percentile (newest first): ${sp.length ? sp.join(", ") : "none"}`);
  }

  // Squeeze conditions of derivatives-playbook section 5 that the data can decide.
  if (fr !== undefined || oi !== undefined || ls !== undefined || flow.buyShare !== undefined) {
    const oiMax = Math.max(...s.get("oi").map((p) => p.v));
    const fr24 = s.ago("fr", day);
    const longC: string[] = [];
    const shortC: string[] = [];
    if (frPct !== undefined && (frPct >= FUNDING_CROWDED_PCTL || (fr! > (fr24 ?? Infinity) && (oi24 ?? 0) > 0))) longC.push(`1 funding ${frPct >= FUNDING_CROWDED_PCTL ? `p${frPct.toFixed(0)}` : "rising with OI"}`);
    if (oi !== undefined && (oi >= OI_NEAR_HIGH * oiMax || (oi24 !== undefined && pc24 !== undefined && pc24 > 0 && oi24 > pc24))) longC.push(oi >= OI_NEAR_HIGH * oiMax ? "2 OI near the window high" : "2 OI rising faster than price");
    if (ls !== undefined && lsMed !== undefined && ls >= lsMed * LS_ABOVE_MEDIAN) longC.push(`3 L/S ${ls.toFixed(2)} vs median ${lsMed.toFixed(2)}`);
    if (flow.buyShare !== undefined && flow.buyShare < TAKER_SELLERS_SHARE && (pc24 ?? 0) > 0) longC.push("5 price up without aggressive buying");
    if (frPct !== undefined && (fr! < 0 || frPct <= FUNDING_QUIET_PCTL)) shortC.push(`1 funding ${fr! < 0 ? "negative" : `p${frPct.toFixed(0)}`}`);
    if (oi24 !== undefined && pc24 !== undefined && oi24 > 0 && pc24 <= 0) shortC.push("2 OI rising while price falls or stalls");
    if (ls !== undefined && lsMed !== undefined && ls <= lsMed * LS_BELOW_MEDIAN) shortC.push(`3 L/S ${ls.toFixed(2)} vs median ${lsMed.toFixed(2)}`);
    if (flow.buyShare !== undefined && flow.buyShare < TAKER_SELLERS_SHARE && (pc24 ?? -1) >= 0) shortC.push("5 sellers absorbed (price not falling)");
    const list = (c: string[]) => (c.length ? ` (${c.join("; ")})` : "");
    facts.push(`squeeze conditions met (derivatives-playbook section 5, the 4 measurable ones): long squeeze ${longC.length} of 4${list(longC)}; short squeeze ${shortC.length} of 4${list(shortC)}; not computed: 4 tests of a level, 6 rejection or first liquidation candles (chart judgment)`);
  }

  // Kraken Futures, the venue the user trades.
  if (kraken) {
    const kf = s.last("kf");
    const premium = kf !== undefined && close !== undefined && close > 0 ? ((kf - close) / close) * 10_000 : undefined;
    const parts = [`Kraken Futures ${kraken.symbol}: close ${price(kf)}`];
    if (premium !== undefined) parts.push(`vs the Coinalyze close ${signed(premium, 1, " bps")}`);
    if (kraken.fundingPct8h !== undefined) parts.push(`funding now ${kraken.fundingPct8h.toFixed(4)}% per 8h (ticker)`);
    facts.push(parts.join("; "));
  }
  return facts;
}
