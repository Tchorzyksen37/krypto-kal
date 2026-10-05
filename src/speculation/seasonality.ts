// speculation/seasonality.ts – MEASURED opening-hour behaviour: how large and in which direction the first hour after a
// market open usually is, compared with the hour before, over the last weeks (Monday-Friday only). Pure functions over
// 15-minute bars; the anchors follow the local clock of the exchange (09:30 New York is 13:30 UTC in summer and 14:30
// UTC in winter). A heuristic from a short sample: the report must quote `days` next to every number.

import { localDate, zonedToUtcMs } from "./sessions.ts";

export interface SeasonalityBar {
  t: number; // epoch seconds, bar start (15 minutes)
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Anchor {
  id: string;
  label: string;
  tz: string; // time zone of the market
  time: string; // local wall-clock time of the open, HH:MM
}

export const ANCHORS: Anchor[] = [
  { id: "asia_open", label: "Tokyo open (09:00 Tokyo)", tz: "Asia/Tokyo", time: "09:00" },
  { id: "europe_open", label: "Europe open (08:00 London)", tz: "Europe/London", time: "08:00" },
  { id: "us_open", label: "US cash open (09:30 New York)", tz: "America/New_York", time: "09:30" },
];

export interface AnchorStats {
  anchor: string;
  label: string;
  days: number; // weekdays with complete bars
  open_hour_range_pct: number; // median (high-low)/open of the hour after the open
  prior_hour_range_pct: number; // same for the hour before
  range_ratio: number; // median per-day open-hour range / prior-hour range
  max_range_pct: number; // widest open hour in the sample
  median_abs_move_pct: number; // median |close-open| of the open hour
  up_days: number; // days the open hour closed above its open
  first15: { n: number; continued: number }; // days with a first 15 min move over 0.1%, and how many continued over the next 30 min
}

const Q = 900;
const DAY_MS = 86_400_000;
export const MIN_DAYS = 5;

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d + 0; // + 0 turns -0 into 0
const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};
const rangePct = (bars: SeasonalityBar[]) => ((Math.max(...bars.map((b) => b.h)) - Math.min(...bars.map((b) => b.l))) / bars[0]!.o) * 100;

export function openingStats(bars: SeasonalityBar[], anchor: Anchor, nowMs: number, lookbackDays = 20): AnchorStats | undefined {
  const byT = new Map(bars.map((b) => [b.t, b]));
  const dates = new Set<string>();
  for (let i = 0; i <= lookbackDays + 1; i++) dates.add(localDate(nowMs - i * DAY_MS, anchor.tz));

  const open: number[] = [], prior: number[] = [], ratio: number[] = [], move: number[] = [];
  let up = 0, firstN = 0, firstCont = 0;
  for (const date of dates) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const anchorMs = zonedToUtcMs(date, anchor.time, anchor.tz);
    if (anchorMs < nowMs - lookbackDays * DAY_MS || anchorMs >= nowMs) continue;
    const t0 = anchorMs / 1000;
    const get = (k0: number) => Array.from({ length: 4 }, (_, i) => byT.get(t0 + (k0 + i) * Q));
    const before = get(-4), after = get(0);
    if (before.some((b) => !b) || after.some((b) => !b)) continue;
    const pre = before as SeasonalityBar[], post = after as SeasonalityBar[];
    const openRange = rangePct(post), priorRange = rangePct(pre);
    open.push(openRange);
    prior.push(priorRange);
    if (priorRange > 0) ratio.push(openRange / priorRange);
    const m = ((post[3]!.c - post[0]!.o) / post[0]!.o) * 100;
    move.push(Math.abs(m));
    if (m > 0) up++;
    const first = ((post[0]!.c - post[0]!.o) / post[0]!.o) * 100;
    if (Math.abs(first) > 0.1) {
      firstN++;
      const next = ((post[2]!.c - post[1]!.o) / post[1]!.o) * 100;
      if (Math.sign(next) === Math.sign(first)) firstCont++;
    }
  }
  if (open.length < MIN_DAYS) return undefined;
  return {
    anchor: anchor.id, label: anchor.label, days: open.length,
    open_hour_range_pct: round(median(open)), prior_hour_range_pct: round(median(prior)), range_ratio: round(median(ratio)),
    max_range_pct: round(Math.max(...open)), median_abs_move_pct: round(median(move)), up_days: up, first15: { n: firstN, continued: firstCont },
  };
}

export interface SeasonalityReport {
  days: number; // look-back in calendar days
  rows: ({ symbol: string } & AnchorStats)[];
}

export function seasonalityReport(barsBySymbol: Record<string, SeasonalityBar[]>, nowMs: number, anchors: Anchor[] = ANCHORS, lookbackDays = 20): SeasonalityReport {
  const rows: SeasonalityReport["rows"] = [];
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    for (const a of anchors) {
      const s = openingStats(bars, a, nowMs, lookbackDays);
      if (s) rows.push({ symbol, ...s });
    }
  }
  return { days: lookbackDays, rows };
}
