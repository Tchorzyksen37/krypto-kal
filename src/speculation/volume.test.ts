// speculation/volume.test.ts – offline tests of the measured volume-by-session profile.
// Run: node --test src/speculation/volume.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hourlyProfile, sessionShares, volumeReport, type VolumeBar } from "./volume.ts";

const TZ = "Europe/Warsaw";
const DAY0 = Date.parse("2026-09-25T00:00:00Z") / 1000;

// `days` days of hourly bars; volumeAt(utcHour) is in base units, close fixed at 2 (USD volume = 2 x).
const bars = (days: number, volumeAt: (h: number) => number): VolumeBar[] =>
  Array.from({ length: days * 24 }, (_, i) => ({ t: DAY0 + i * 3600, c: 2, v: volumeAt(i % 24) }));

describe("hourlyProfile", () => {
  test("averages USD volume per UTC hour over the days", () => {
    const p = hourlyProfile(bars(7, (h) => h + 1))!;
    assert.equal(p.days, 7);
    assert.equal(p.usd[0], 2);
    assert.equal(p.usd[23], 48);
  });

  test("accepts millisecond timestamps and refuses incomplete days", () => {
    const ms = bars(3, () => 1).map((b) => ({ ...b, t: b.t * 1000 }));
    assert.equal(hourlyProfile(ms)!.days, 3);
    assert.equal(hourlyProfile(bars(3, () => 1).filter((b) => new Date(b.t * 1000).getUTCHours() !== 5)), undefined);
  });
});

describe("sessionShares", () => {
  test("flat volume gives each session its share of the day's hours", () => {
    const flat = new Array<number>(24).fill(1);
    const s = sessionShares(flat, "2026-10-03", TZ);
    const by = Object.fromEntries(s.map((x) => [x.id, x]));
    assert.equal(by.europe_open!.share, Math.round((4 / 24) * 1000) / 1000);
    assert.equal(by.night_asia!.share, Math.round((10 / 24) * 1000) / 1000);
    assert.ok(s.every((x) => x.perHourVsAverage === 1));
  });

  test("a US-heavy profile ranks the overlap and US sessions above the night", () => {
    const usHeavy = Array.from({ length: 24 }, (_, h) => (h >= 13 && h <= 20 ? 10 : 1));
    const s = sessionShares(usHeavy, "2026-10-03", TZ);
    const rank = (id: string) => s.find((x) => x.id === id)!.rank;
    assert.ok(rank("us") < rank("night_asia"));
    assert.ok(rank("eu_us_overlap") < rank("europe_open"));
    assert.ok(s.find((x) => x.id === "us")!.perHourVsAverage > 1);
  });

  test("half-hour window edges are weighted, and the night window wraps midnight", () => {
    const onlyHour11 = Array.from({ length: 24 }, (_, h) => (h === 11 ? 24 : 0));
    // overlap window starts 11:30 UTC: it contains half of hour 11
    assert.equal(sessionShares(onlyHour11, "2026-10-03", TZ).find((x) => x.id === "eu_us_overlap")!.share, 0.5);
    const onlyHour2 = Array.from({ length: 24 }, (_, h) => (h === 2 ? 1 : 0));
    assert.equal(sessionShares(onlyHour2, "2026-10-03", TZ).find((x) => x.id === "night_asia")!.share, 1); // 02:00 UTC is inside 20:00-06:00 UTC
  });
});

describe("volumeReport", () => {
  test("needs at least 3 days of bars", () => {
    assert.match((volumeReport(bars(2, () => 1), Date.parse("2026-10-03T10:00:00Z"), TZ) as { error: string }).error, /only 2 day/);
  });

  test("returns shares that add up to the covered part of the day", () => {
    const r = volumeReport(bars(7, () => 1), Date.parse("2026-10-03T10:00:00Z"), TZ);
    assert.ok("shares" in r);
    const total = r.shares.reduce((a, s) => a + s.share, 0);
    assert.ok(Math.abs(total - (4 + 4 + 4.5 + 10) / 24) < 0.01); // 22.5 of 24 hours; 12:00-13:30 local is not a session
  });
});
