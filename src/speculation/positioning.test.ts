// speculation/positioning.test.ts – offline tests of the open-interest rhythm and the post-shock behaviour (synthetic hourly series).
// Run: node --test src/speculation/positioning.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hourlyOiProfile, postShockStats, type HourBar, type OiPoint } from "./positioning.ts";

const HOUR = 3600;
const T0 = Date.parse("2026-09-01T00:00:00Z") / 1000; // a Tuesday, midnight UTC
const HOURS = 960; // 40 days

interface Shock {
  at: number; // hour index of the shocked bar
  move: number; // fraction, e.g. 0.03 = +3% in that hour
  revert?: boolean; // price walks back linearly over the next 24 hours
  boost?: { range: number; volume: number }; // range of each bar (percent) over the next 12h and volume over the next 24h
}

// Price flat at 100 with hourly range 0.2; shocks are single-hour jumps. Open interest follows the move: it jumps by 5%
// in the direction of the move, then fades back over 48 hours (up: 1030 after 4h, 1010 after 24h, back to 1000 after 48h).
function build(shocks: Shock[]): { price: HourBar[]; oi: OiPoint[] } {
  const price: HourBar[] = [];
  const oi: OiPoint[] = [];
  let prevClose = 100;
  for (let i = 0; i < HOURS; i++) {
    let level = 100;
    let oiRel = 0;
    let range = 0.2;
    let volume = 10;
    for (const s of shocks) {
      const dt = i - s.at;
      if (dt >= 0) level += s.move * 100 * (s.revert ? (dt === 0 ? 1 : Math.max(0, 1 - dt / 24)) : 1);
      const sign = Math.sign(s.move);
      oiRel += sign * (dt < 0 ? 0 : dt < 4 ? 0.05 : dt < 24 ? 0.03 : dt < 48 ? 0.01 : 0);
      if (s.boost && dt >= 1 && dt <= 12) range = s.boost.range;
      if (s.boost && dt >= 1 && dt <= 24) volume = s.boost.volume;
    }
    const o = prevClose;
    price.push({ t: T0 + i * HOUR, o, h: Math.max(o, level) + range / 2, l: Math.min(o, level) - range / 2, c: level, v: volume });
    oi.push({ t: T0 + i * HOUR, c: 1000 * (1 + oiRel) });
    prevClose = level;
  }
  return { price, oi };
}

const FOUR = [{ at: 200, move: 0.03 }, { at: 400, move: 0.03 }, { at: 600, move: -0.03 }, { at: 800, move: -0.03 }];

describe("postShockStats", () => {
  test("finds the shocks and splits them into up and down moves", () => {
    const { price, oi } = build(FOUR.map((s) => ({ ...s, revert: false })));
    const r = postShockStats(price, oi)!;
    assert.equal(r.events, 4);
    assert.equal(r.up_events, 2);
    assert.equal(r.down_events, 2);
  });

  test("open interest rises with an up shock and unwinds over the next two days; a down shock drops it and it rebuilds", () => {
    const { price, oi } = build(FOUR);
    const r = postShockStats(price, oi)!;
    assert.deepEqual(r.up, { n: 2, oi_at_shock_pct: 5, oi_after_4h_pct: -1.9, oi_after_24h_pct: -3.81, oi_after_48h_pct: -4.76 });
    assert.deepEqual(r.down, { n: 2, oi_at_shock_pct: -5, oi_after_4h_pct: 2.11, oi_after_24h_pct: 4.21, oi_after_48h_pct: 5.26 });
  });

  test("says how much of the move was given back after 24 and 48 hours (1 = all of it, 0 = none)", () => {
    const stays = postShockStats(...pair(build(FOUR.map((s) => ({ ...s })))))!;
    assert.equal(stays.retraced_24h, 0);
    assert.equal(stays.retraced_48h, 0);
    const back = postShockStats(...pair(build(FOUR.map((s) => ({ ...s, revert: true })))))!;
    assert.equal(back.retraced_24h, 1);
    assert.equal(back.retraced_48h, 1);
  });

  test("compares range and volume after a shock with the day before it", () => {
    const { price, oi } = build(FOUR.map((s) => ({ ...s, boost: { range: 0.4, volume: 20 } })));
    const r = postShockStats(price, oi)!;
    // ranges are relative to the open, which the 3% jump itself shifts a little, hence the tolerance
    assert.ok(Math.abs(r.range_ratio_next_12h! - 2) < 0.1, `got ${r.range_ratio_next_12h}`);
    assert.ok(Math.abs(r.range_ratio_13_36h! - 1) < 0.1, `got ${r.range_ratio_13_36h}`);
    assert.equal(r.volume_ratio_next_24h, 2);
  });

  test("returns nothing with fewer than three shocks", () => {
    const { price, oi } = build(FOUR.slice(0, 2));
    assert.equal(postShockStats(price, oi), undefined);
  });
});

const pair = (x: { price: HourBar[]; oi: OiPoint[] }): [HourBar[], OiPoint[]] => [x.price, x.oi];

describe("hourlyOiProfile", () => {
  // Weekdays: open interest builds by 1% in hour 12 and unwinds by 2% in hour 14; every other hour changes by 0.1%
  // alternately up and down. Weekends are wild (5% moves) and must not count.
  function oiSeries(): OiPoint[] {
    const out: OiPoint[] = [];
    let v = 1000;
    for (let i = 0; i < HOURS; i++) {
      const t = T0 + i * HOUR;
      const d = new Date(t * 1000);
      const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      const h = d.getUTCHours();
      const pct = weekend ? (i % 2 ? 5 : -5) : h === 12 ? 1 : h === 14 ? -2 : i % 2 ? 0.1 : -0.1;
      v *= 1 + pct / 100;
      out.push({ t, c: v });
    }
    return out;
  }

  test("names the hours where open interest is built, unwound and moves most (UTC, weekdays only)", () => {
    const p = hourlyOiProfile(oiSeries())!;
    assert.equal(p.build_hours_utc[0]!.hour, 12);
    assert.equal(p.unwind_hours_utc[0]!.hour, 14);
    assert.equal(p.busiest_hours_utc[0]!.hour, 14);
    assert.equal(p.busiest_hours_utc[1]!.hour, 12);
    assert.ok(p.busiest_hours_utc[0]!.median_abs_change_pct >= 2 && p.busiest_hours_utc[0]!.median_abs_change_pct < 2.1);
    assert.ok(p.days >= 20);
  });

  test("returns nothing without enough days of data", () => {
    assert.equal(hourlyOiProfile(oiSeries().slice(0, 48)), undefined);
  });
});
