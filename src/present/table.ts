// present/table.ts – one series as text the model reads: a header with provenance (window, as-of time, the bar still
// open, units, gaps, a computed summary) followed by a CSV table with one row per bar. Deterministic: the same
// points, spec and asOf always give the same text. Nothing is dropped silently: missing values are empty cells,
// missing bars are listed as gaps, and resampled rows carry the number of native bars they hold.

import { type RoundRule, num, round, usdScale } from "./round.ts";
import { type Row, fitRows } from "./resample.ts";
import { extremes, pctChange } from "./stats.ts";
import type { SeriesSpec } from "./units.ts";

// Text that toResult hands to the model as it is (not JSON-encoded); `points` feeds the run statistics.
export class PresentedText {
  readonly text: string;
  readonly points: number;
  constructor(text: string, points: number) {
    this.text = text;
    this.points = points;
  }
}

export interface SeriesMeta {
  tool: string; // the MCP tool, first word of the header
  symbol: string;
  intervalSec: number;
  asOfSec: number; // "now" of the request, passed in (never read from the clock here)
  maxRows?: number; // row budget; absent: every bar
  recentRows?: number; // native rows kept under a budget (default 48, at most half of it)
}

const MAX_GAP_SPANS = 5;
export const DEFAULT_RECENT_ROWS = 48;

export const isoMinute = (tSec: number) => new Date(tSec * 1000).toISOString().slice(0, 16) + "Z";

export function intervalLabel(sec: number): string {
  if (sec % 604_800 === 0) return `${sec / 604_800}w`;
  if (sec % 86_400 === 0) return `${sec / 86_400}d`;
  if (sec % 3_600 === 0) return `${sec / 3_600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

interface Gap {
  from: number; // first missing bar start
  to: number; // last missing bar start
  bars: number;
}

// Missing bars between consecutive points of a regular series.
export function findGaps(times: number[], stepSec: number): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < times.length; i++) {
    const missing = Math.round((times[i]! - times[i - 1]!) / stepSec) - 1;
    if (missing > 0) gaps.push({ from: times[i - 1]! + stepSec, to: times[i]! - stepSec, bars: missing });
  }
  return gaps;
}

function gapLine(gaps: Gap[]): string {
  if (!gaps.length) return "gaps: none";
  const total = gaps.reduce((n, g) => n + g.bars, 0);
  const spans = gaps.slice(0, MAX_GAP_SPANS).map((g) => (g.bars === 1 ? isoMinute(g.from) : `${isoMinute(g.from)}..${isoMinute(g.to)} (${g.bars})`));
  const more = gaps.length > MAX_GAP_SPANS ? `, and ${gaps.length - MAX_GAP_SPANS} more spans` : "";
  return `gaps: ${total} bar${total === 1 ? "" : "s"} with no data returned, in ${gaps.length} span${gaps.length === 1 ? "" : "s"}: ${spans.join(", ")}${more}`;
}

interface Column {
  name: string;
  rule: RoundRule;
  values: (number | undefined)[];
}

export function renderSeries<P extends { t: number }>(spec: SeriesSpec<P>, points: P[], meta: SeriesMeta): string {
  const step = meta.intervalSec;
  const head = `${meta.tool} ${meta.symbol} ${intervalLabel(step)} (${spec.title})`;

  // One row per bar start, time ascending; a duplicate t keeps the later point.
  const byT = new Map<number, P>();
  for (const p of points) if (Number.isFinite(p.t)) byT.set(p.t, p);
  const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
  if (!sorted.length) return `${head}: no data returned for this range\nas of ${isoMinute(meta.asOfSec)}`;

  const gaps = findGaps(sorted.map((p) => p.t), step);
  let rows: Row[] = sorted.map((p) => ({ t: p.t, v: spec.base.map((c) => finite(c.get(p))), bars: 1 }));
  const plan = meta.maxRows ? fitRows(rows, step, meta.maxRows, meta.recentRows ?? DEFAULT_RECENT_ROWS, spec.base.map((c) => c.agg)) : undefined;
  if (plan) rows = plan.rows;

  // Base columns, then derived ones computed from the (possibly resampled) base values.
  const named = rows.map((r) => Object.fromEntries(spec.base.map((c, i) => [c.name, r.v[i]])) as Record<string, number | undefined>);
  const scales = new Map<string, ReturnType<typeof usdScale>>();
  for (const c of spec.base) {
    if (c.rule !== "usd") continue;
    const group = c.usdGroup ?? c.name;
    if (scales.has(group)) continue;
    const vals = spec.base.filter((o) => (o.usdGroup ?? o.name) === group).flatMap((o) => named.map((r) => r[o.name]).filter((v): v is number => v !== undefined));
    scales.set(group, usdScale(vals));
  }
  const columns: Column[] = [
    ...spec.base.map((c) => {
      const scale = c.rule === "usd" ? scales.get(c.usdGroup ?? c.name)! : undefined;
      return { name: scale ? `${c.name}_${scale.suffix}` : c.name, rule: scale ? scale.rule : (c.rule as RoundRule), values: named.map((r) => r[c.name]) };
    }),
    ...spec.derived.map((d) => ({ name: d.name, rule: d.rule, values: named.map((r) => finite(d.derive(r))) })),
  ];
  const byName = new Map(spec.base.map((c, i) => [c.name, columns[i]!]));

  const first = sorted[0]!.t;
  const last = sorted[sorted.length - 1]!.t;
  const lines = [`${head}: ${sorted.length} bar${sorted.length === 1 ? "" : "s"}, ${isoMinute(first)} .. ${isoMinute(last)} (bar start times, UTC)`];
  const open = last + step > meta.asOfSec;
  lines.push(`as of ${isoMinute(meta.asOfSec)}; ${open ? `last bar ${isoMinute(last)} is still open (its values will change)` : "all bars closed"}`);
  lines.push(`units: ${spec.units.join("; ")}`);
  lines.push(gapLine(gaps));
  const summary = summaryLine(spec, sorted, byName, columns);
  if (summary) lines.push(summary);
  if (plan) {
    lines.push(`rows: ${rows.length} (budget ${meta.maxRows}); bars before ${isoMinute(plan.boundary)} resampled to ${intervalLabel(plan.bucketSec)} buckets, the newest ${rows.filter((r) => r.t >= plan.boundary).length} at ${intervalLabel(step)}; column bars = native bars per row`);
  }

  const header = ["time", ...columns.map((c) => c.name), ...(plan ? ["bars"] : [])];
  lines.push(header.join(","));
  rows.forEach((r, i) => {
    const cells = [isoMinute(r.t), ...columns.map((c) => num(c.values[i] === undefined ? undefined : round(c.values[i]!, c.rule)))];
    if (plan) cells.push(String(r.bars));
    lines.push(cells.join(","));
  });
  return lines.join("\n");
}

// Summary from the native (unresampled) values, so a budget never changes it.
function summaryLine<P extends { t: number }>(spec: SeriesSpec<P>, sorted: P[], byName: Map<string, Column>, columns: Column[]): string | undefined {
  const s = spec.summary;
  const fmt = (name: string, v: number | undefined) => {
    const col = byName.get(name) ?? columns.find((c) => c.name === name);
    return v === undefined || !col ? "" : `${num(round(v, col.rule))}${col.name.endsWith("_musd") ? "M" : col.name.endsWith("_kusd") ? "k" : ""}`;
  };
  const get = (name: string) => {
    const c = spec.base.find((b) => b.name === name);
    return c ? sorted.map((p) => ({ t: p.t, v: finite(c.get(p)) })) : [];
  };
  if (s.kind === "level") {
    const pts = get(s.column).filter((p) => p.v !== undefined);
    if (!pts.length) return undefined;
    const a = pts[0]!.v!;
    const b = pts[pts.length - 1]!.v!;
    const lows = extremes(s.low ? get(s.low) : pts);
    const highs = extremes(s.high ? get(s.high) : pts);
    const change = s.relative
      ? (() => { const pc = pctChange(a, b); return pc === undefined ? "" : ` (${signedFixed(pc, 2)}%)`; })()
      : ` (${b - a >= 0 ? "+" : ""}${fmt(s.column, b - a)})`;
    const lo = lows ? `; low ${fmt(s.low ?? s.column, lows.min)} at ${isoMinute(lows.minT)}` : "";
    const hi = highs ? `; high ${fmt(s.high ?? s.column, highs.max)} at ${isoMinute(highs.maxT)}` : "";
    return `summary: ${s.label} ${fmt(s.column, a)} -> ${fmt(s.column, b)}${change}${lo}${hi}`;
  }
  const parts: string[] = [];
  for (const name of s.columns) {
    const pts = get(name);
    const total = pts.reduce((n, p) => n + (p.v ?? 0), 0);
    const e = extremes(pts);
    parts.push(`${name} total ${fmt(name, total)}${e && e.max > 0 ? `, largest ${fmt(name, e.max)} at ${isoMinute(e.maxT)}` : ""}`);
  }
  return `summary: ${s.label} over the window: ${parts.join("; ")}`;
}

const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);

// "+0.14", "-1.20", and "0.00" for a change that rounds to zero (never "-0.00").
function signedFixed(x: number, decimals: number): string {
  const s = x.toFixed(decimals);
  if (Number(s) === 0) return (0).toFixed(decimals);
  return x > 0 ? `+${s}` : s;
}

// Several symbols of one tool call: one block each, separated by a blank line, in the order given.
export function renderSeriesList<P extends { t: number }>(
  spec: SeriesSpec<P>, series: { symbol: string; history: P[] }[], meta: Omit<SeriesMeta, "symbol">,
): PresentedText {
  const text = series.map((s) => renderSeries(spec, s.history, { ...meta, symbol: s.symbol })).join("\n\n");
  return new PresentedText(text, series.reduce((n, s) => n + s.history.length, 0));
}
