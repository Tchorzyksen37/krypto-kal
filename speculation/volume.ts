// speculation/volume.ts – MEASURED share of daily trading volume per session window, from hourly candles.
// Answers "which part of the world's day generates the volume": the average USD volume per UTC hour of day
// is turned into a profile, and each session window (see sessions.ts) gets its share of the 24h total.
//   node speculation/volume.ts <candles-1h.json> [ISO now]
// Input: array of { t (epoch s or ms), c (close), v (volume in base units) }, ideally 7+ days of 1h bars.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SESSIONS, type SessionDef, sessionOptionsFromEnv, sessionWindow, localDate } from "./sessions.ts";

export interface VolumeBar {
  t: number; // epoch seconds, hour start
  c: number;
  v: number;
}

const HOUR_MS = 3_600_000;

// Average USD volume per UTC hour of day (24 values) and the number of days that contributed.
export function hourlyProfile(bars: VolumeBar[]): { usd: number[]; days: number } | undefined {
  const sums = new Array<number>(24).fill(0);
  const counts = new Array<number>(24).fill(0);
  const days = new Set<string>();
  for (const b of bars) {
    const ms = (b.t > 1e11 ? b.t : b.t * 1000);
    const d = new Date(ms);
    if (!Number.isFinite(b.v) || !Number.isFinite(b.c)) continue;
    sums[d.getUTCHours()]! += b.v * b.c;
    counts[d.getUTCHours()]! += 1;
    days.add(d.toISOString().slice(0, 10));
  }
  if (counts.some((n) => n === 0)) return undefined; // need every hour of the day represented
  return { usd: sums.map((s, h) => s / counts[h]!), days: days.size };
}

export interface SessionShare {
  id: string;
  label: string;
  hours: number;
  share: number; // fraction of the 24h volume that falls inside the window
  perHourVsAverage: number; // share per hour relative to a flat 24h day (1 = average)
  rank: number; // 1 = the busiest session per hour
}

// Share of daily volume inside the window of each session on local date `date` (UTC hour buckets, fractional edges).
export function sessionShares(profile: number[], date: string, tz: string, sessions: SessionDef[] = SESSIONS): SessionShare[] {
  const total = profile.reduce((a, b) => a + b, 0);
  const out = sessions.map((s) => {
    const w = sessionWindow(s, date, tz);
    let vol = 0;
    for (let t = Math.floor(w.startMs / HOUR_MS) * HOUR_MS; t < w.endMs; t += HOUR_MS) {
      const overlap = Math.min(w.endMs, t + HOUR_MS) - Math.max(w.startMs, t);
      if (overlap > 0) vol += (profile[new Date(t).getUTCHours()]! * overlap) / HOUR_MS;
    }
    const hours = (w.endMs - w.startMs) / HOUR_MS;
    const share = total > 0 ? vol / total : 0;
    return { id: s.id as string, label: s.label, hours, share: Math.round(share * 1000) / 1000, perHourVsAverage: Math.round((share / (hours / 24)) * 100) / 100, rank: 0 };
  });
  [...out].sort((a, b) => b.perHourVsAverage - a.perHourVsAverage).forEach((x, i) => (x.rank = i + 1));
  return out;
}

export function volumeReport(bars: VolumeBar[], nowMs: number, tz: string): { days: number; shares: SessionShare[] } | { error: string } {
  const p = hourlyProfile(bars);
  if (!p) return { error: "need hourly bars covering every UTC hour of the day" };
  if (p.days < 3) return { error: `only ${p.days} day(s) of bars; use 7 or more` };
  return { days: p.days, shares: sessionShares(p.usd, localDate(nowMs, tz), tz) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, nowArg] = process.argv.slice(2);
  if (!path) {
    console.error("usage: node speculation/volume.ts <candles-1h.json> [ISO now]");
    process.exit(2);
  }
  try {
    const bars = (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>[]).map((r) => ({ t: Number(r.t ?? r.time), c: Number(r.c ?? r.close), v: Number(r.v ?? r.volume) }));
    console.log(JSON.stringify(volumeReport(bars, nowArg ? Date.parse(nowArg) : Date.now(), sessionOptionsFromEnv().tz), null, 2));
  } catch (e) {
    console.error(`volume failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
