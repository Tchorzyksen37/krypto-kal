// speculation/seasonality.test.ts – offline tests of the opening-hour seasonality (synthetic 15m bars).
// Run: node --test src/speculation/seasonality.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANCHORS, openingStats, seasonalityReport, type SeasonalityBar } from "./seasonality.ts";
import { localDate, zonedToUtcMs } from "./sessions.ts";

const Q = 900; // 15 minutes in seconds
const DAY_MS = 86_400_000;
const US_OPEN = ANCHORS.find((a) => a.id === "us_open")!;

// Price stays near 100, so a range in "percent" is simply a range in points.
interface DaySpec {
  before: number; // range of each of the 4 bars before the anchor
  after: number; // range of each of the 4 bars after the anchor
  moves?: number[]; // close - open of each of the 4 bars after the anchor
}

function dayBars(anchorMs: number, s: DaySpec): SeasonalityBar[] {
  const out: SeasonalityBar[] = [];
  const t0 = anchorMs / 1000;
  for (let k = -4; k < 0; k++) out.push({ t: t0 + k * Q, o: 100, h: 100 + s.before / 2, l: 100 - s.before / 2, c: 100 });
  let price = 100;
  for (let k = 0; k < 4; k++) {
    const o = price;
    const c = price + (s.moves?.[k] ?? 0);
    out.push({ t: t0 + k * Q, o, h: Math.max(o, c) + s.after / 2, l: Math.min(o, c) - s.after / 2, c });
    price = c;
  }
  return out;
}

// One block of bars per calendar day (weekends too) in the 20 days before `nowMs`, at the anchor's local time.
function history(nowMs: number, tz: string, time: string, spec: (weekdayIndex: number, dow: number) => DaySpec): SeasonalityBar[] {
  const dates: string[] = [];
  for (let i = 19; i >= 0; i--) dates.push(localDate(nowMs - i * DAY_MS, tz));
  const bars: SeasonalityBar[] = [];
  let wd = 0;
  for (const date of dates) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekday = dow !== 0 && dow !== 6;
    bars.push(...dayBars(zonedToUtcMs(date, time, tz), spec(weekday ? wd : -1, dow)));
    if (weekday) wd++;
  }
  return bars;
}

const NOW_SUMMER = Date.parse("2026-10-06T00:00:00Z"); // Tue; EDT in New York, 20 days back = 14 weekdays
const NOW_WINTER = Date.parse("2026-12-15T00:00:00Z"); // EST in New York

describe("openingStats", () => {
  test("compares the hour after the anchor with the hour before it (median over weekdays)", () => {
    const bars = history(NOW_SUMMER, US_OPEN.tz, US_OPEN.time, () => ({ before: 0.5, after: 1 }));
    const s = openingStats(bars, US_OPEN, NOW_SUMMER)!;
    assert.equal(s.days, 14);
    assert.equal(s.open_hour_range_pct, 1);
    assert.equal(s.prior_hour_range_pct, 0.5);
    assert.equal(s.range_ratio, 2);
  });

  test("ignores weekends", () => {
    const bars = history(NOW_SUMMER, US_OPEN.tz, US_OPEN.time, (wd) => (wd < 0 ? { before: 1, after: 10 } : { before: 0.5, after: 1 }));
    const s = openingStats(bars, US_OPEN, NOW_SUMMER)!;
    assert.equal(s.days, 14);
    assert.equal(s.open_hour_range_pct, 1);
    assert.equal(s.max_range_pct, 1);
  });

  test("follows the anchor's daylight saving time: 09:30 New York is 13:30 UTC in summer and 14:30 UTC in winter", () => {
    const bars = history(NOW_WINTER, US_OPEN.tz, US_OPEN.time, () => ({ before: 0.5, after: 1 }));
    const firstOpenBar = new Date(bars.find((b) => b.h === 100.5 && b.l === 99.5)!.t * 1000);
    assert.equal(`${firstOpenBar.getUTCHours()}:${firstOpenBar.getUTCMinutes()}`, "14:30");
    const s = openingStats(bars, US_OPEN, NOW_WINTER)!;
    assert.equal(s.open_hour_range_pct, 1); // a fixed 13:30 UTC reading would see the quiet hour (0.5)
    assert.equal(s.range_ratio, 2);
  });

  test("returns nothing when fewer than five weekdays have complete bars", () => {
    const bars = history(NOW_SUMMER, US_OPEN.tz, US_OPEN.time, () => ({ before: 0.5, after: 1 })).filter((b) => b.t * 1000 > NOW_SUMMER - 6 * DAY_MS);
    assert.equal(openingStats(bars, US_OPEN, NOW_SUMMER), undefined);
  });

  test("counts days the opening hour closed up", () => {
    const bars = history(NOW_SUMMER, US_OPEN.tz, US_OPEN.time, (wd) => ({ before: 0.5, after: 1, moves: wd % 2 === 0 ? [0.2, 0, 0, 0] : [-0.2, 0, 0, 0] }));
    const s = openingStats(bars, US_OPEN, NOW_SUMMER)!;
    assert.equal(s.up_days, 7);
    assert.equal(s.median_abs_move_pct, 0.2);
  });

  test("measures how often the first 15 minutes continue over the next 30", () => {
    // 14 weekdays: 6 continue, 2 reverse, 6 have a first move too small (0.1% or less) to count
    const bars = history(NOW_SUMMER, US_OPEN.tz, US_OPEN.time, (wd) => {
      if (wd < 6) return { before: 0.5, after: 1, moves: [0.3, 0.1, 0.1, 0] };
      if (wd < 8) return { before: 0.5, after: 1, moves: [0.3, -0.2, -0.2, 0] };
      return { before: 0.5, after: 1, moves: [0.05, 0.3, 0, 0] };
    });
    const s = openingStats(bars, US_OPEN, NOW_SUMMER)!;
    assert.deepEqual(s.first15, { n: 8, continued: 6 });
  });
});

describe("seasonalityReport", () => {
  test("gives one row per symbol and anchor that has enough data", () => {
    const eu = ANCHORS.find((a) => a.id === "europe_open")!;
    const bars = [...history(NOW_SUMMER, US_OPEN.tz, US_OPEN.time, () => ({ before: 0.5, after: 1 })), ...history(NOW_SUMMER, eu.tz, eu.time, () => ({ before: 0.2, after: 0.4 }))];
    const r = seasonalityReport({ BTC: bars, ETH: [] }, NOW_SUMMER);
    assert.deepEqual(r.rows.map((x) => `${x.symbol}:${x.anchor}`).sort(), ["BTC:europe_open", "BTC:us_open"]);
    assert.equal(r.days, 20);
  });
});
