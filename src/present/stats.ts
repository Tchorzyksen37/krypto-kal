// present/stats.ts – deterministic statistics over a window of bars, so the model reads computed numbers instead of
// doing arithmetic over hundreds of values. Pure functions; times are epoch seconds and `asOf` is always passed in.

export interface Bar {
  t: number; // epoch seconds, bar start
  o: number;
  h: number;
  l: number;
  c: number;
}

// Relative change in %, or undefined when the base is 0 or a value is missing.
export function pctChange(from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to) || from === 0) return undefined;
  return ((to - from) / Math.abs(from)) * 100;
}

export interface Extremes {
  min: number;
  minT: number;
  max: number;
  maxT: number;
}

// Lowest and highest value with their times; the first occurrence wins a tie.
export function extremes(points: { t: number; v: number | undefined }[]): Extremes | undefined {
  let out: Extremes | undefined;
  for (const { t, v } of points) {
    if (v === undefined || !Number.isFinite(v)) continue;
    if (!out) out = { min: v, minT: t, max: v, maxT: t };
    if (v < out.min) Object.assign(out, { min: v, minT: t });
    if (v > out.max) Object.assign(out, { max: v, maxT: t });
  }
  return out;
}

// Share of `values` at or below `x`, in % (0..100). The last funding rate at 81 = higher than 81% of the window.
export function percentileRank(values: number[], x: number): number | undefined {
  const finite = values.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(x)) return undefined;
  return (finite.filter((v) => v <= x).length / finite.length) * 100;
}

// (x - mean) / population standard deviation of `values`; undefined when they do not vary.
export function zScore(values: number[], x: number): number | undefined {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2 || !Number.isFinite(x)) return undefined;
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const sd = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length);
  return sd > 0 ? (x - mean) / sd : undefined;
}

// Sample standard deviation of log returns between consecutive closes (per bar, as a fraction, not %).
export function logReturnSigma(closes: number[]): number | undefined {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (a > 0 && b > 0) r.push(Math.log(b / a));
  }
  if (r.length < 2) return undefined;
  const mean = r.reduce((x, y) => x + y, 0) / r.length;
  return Math.sqrt(r.reduce((x, y) => x + (y - mean) ** 2, 0) / (r.length - 1));
}

// Average true range: the simple mean of the true range over the last `period` CLOSED bars (the same definition as
// bot/indicators.ts). Undefined with too few bars or a gap between them, because a true range across a gap is wrong.
export function atr(bars: Bar[], period: number, stepSec: number, asOfSec: number): number | undefined {
  const closed = [...bars].sort((a, b) => a.t - b.t).filter((b) => b.t + stepSec <= asOfSec);
  if (period < 1 || closed.length < period + 1) return undefined;
  const w = closed.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < w.length; i++) {
    const c = w[i]!;
    const p = w[i - 1]!;
    if (c.t - p.t !== stepSec) return undefined;
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return sum / period;
}

export interface Swing {
  t: number;
  price: number;
  kind: "high" | "low";
}

// Swing points: a bar whose high (low) is strictly above (below) the `side` bars on each side. Bars too close to
// either end of the window cannot be confirmed and are not reported. Ordered by time.
export function swings(bars: Bar[], side = 3): Swing[] {
  const b = [...bars].sort((x, y) => x.t - y.t);
  const out: Swing[] = [];
  for (let i = side; i < b.length - side; i++) {
    const around = [...b.slice(i - side, i), ...b.slice(i + 1, i + 1 + side)];
    if (around.every((o) => b[i]!.h > o.h)) out.push({ t: b[i]!.t, price: b[i]!.h, kind: "high" });
    if (around.every((o) => b[i]!.l < o.l)) out.push({ t: b[i]!.t, price: b[i]!.l, kind: "low" });
  }
  return out;
}

// Taker buy share of the summed volume (0..1) and the cumulative volume delta Σ(2·buy − volume).
export function takerFlow(rows: { v: number; bv: number }[]): { buyShare: number | undefined; cvd: number } {
  let v = 0;
  let bv = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.v) || !Number.isFinite(r.bv)) continue;
    v += r.v;
    bv += r.bv;
  }
  return { buyShare: v > 0 ? bv / v : undefined, cvd: 2 * bv - v };
}

export type Quadrant = "price up, OI up" | "price up, OI down" | "price down, OI up" | "price down, OI down" | "flat";

// The price / open-interest quadrant of a window. Changes smaller than `flatPct` (in %) count as no change, and when
// either side is flat the quadrant is "flat" (the four readings need both to move).
export function quadrant(priceChangePct: number, oiChangePct: number, flatPct = 0.1): Quadrant {
  if (Math.abs(priceChangePct) < flatPct || Math.abs(oiChangePct) < flatPct) return "flat";
  return `price ${priceChangePct > 0 ? "up" : "down"}, OI ${oiChangePct > 0 ? "up" : "down"}`;
}

// Bars whose value is strictly above the window's q-quantile (nearest rank), e.g. liquidation spikes. Strictly: when
// most bars share the quantile's value (quiet bars), none of them is a spike.
export function spikes(points: { t: number; v: number }[], q = 0.95): { t: number; v: number }[] {
  const vals = points.map((p) => p.v).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return [];
  const threshold = vals[Math.min(vals.length - 1, Math.max(0, Math.ceil(q * vals.length) - 1))]!;
  return points.filter((p) => p.v > threshold);
}
