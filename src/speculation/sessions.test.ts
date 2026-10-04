// speculation/sessions.test.ts – offline tests of session windows, time zones and profiles.
// Run: node --test src/speculation/sessions.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INVESTORS, SESSIONS, describeWindow, localDate, pickSession, sessionById, sessionWindow, tzOffsetMs, windowsAround, zonedToUtcMs } from "./sessions.ts";

const TZ = "Europe/Warsaw";
const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

describe("time zone maths", () => {
  test("Warsaw is UTC+2 in summer and UTC+1 in winter", () => {
    assert.equal(tzOffsetMs(at("2026-10-03T12:00:00Z"), TZ), 2 * 3_600_000);
    assert.equal(tzOffsetMs(at("2026-12-03T12:00:00Z"), TZ), 3_600_000);
  });

  test("local wall-clock time converts to UTC on both sides of the DST change (2026-10-25)", () => {
    assert.equal(iso(zonedToUtcMs("2026-10-03", "22:00", TZ)), "2026-10-03T20:00:00.000Z");
    assert.equal(iso(zonedToUtcMs("2026-10-26", "22:00", TZ)), "2026-10-26T21:00:00.000Z");
    assert.equal(iso(zonedToUtcMs("2026-03-28", "08:00", TZ)), "2026-03-28T07:00:00.000Z"); // day before the spring change
    assert.equal(iso(zonedToUtcMs("2026-03-30", "08:00", TZ)), "2026-03-30T06:00:00.000Z");
  });

  test("localDate follows the local calendar day", () => {
    assert.equal(localDate(at("2026-10-03T22:30:00Z"), TZ), "2026-10-04"); // 00:30 local
    assert.equal(localDate(at("2026-10-03T21:30:00Z"), TZ), "2026-10-03");
  });
});

describe("session windows", () => {
  test("the four sessions in summer time match the user's local clock", () => {
    const d = (id: string) => describeWindow(sessionWindow(sessionById(id)!, "2026-10-03", TZ), TZ);
    assert.deepEqual([d("europe_open").startUtc, d("europe_open").endUtc], ["2026-10-03T06:00:00.000Z", "2026-10-03T10:00:00.000Z"]);
    assert.deepEqual([d("eu_us_overlap").startUtc, d("eu_us_overlap").endUtc], ["2026-10-03T11:30:00.000Z", "2026-10-03T15:30:00.000Z"]);
    assert.deepEqual([d("us").startUtc, d("us").endUtc], ["2026-10-03T15:30:00.000Z", "2026-10-03T20:00:00.000Z"]);
    assert.deepEqual([d("night_asia").startUtc, d("night_asia").endUtc], ["2026-10-03T20:00:00.000Z", "2026-10-04T06:00:00.000Z"]);
    assert.equal(d("night_asia").hours, 10);
    assert.equal(d("night_asia").endLocal, "2026-10-04 08:00");
  });

  test("a night window that spans the DST change is 11 hours long", () => {
    const w = sessionWindow(sessionById("night_asia")!, "2026-10-24", TZ);
    assert.equal((w.endMs - w.startMs) / 3_600_000, 11);
    assert.equal(iso(w.endMs), "2026-10-25T07:00:00.000Z"); // 08:00 local, now UTC+1
  });

  test("sessions are contiguous from the Europe open to the next day's Europe open, apart from one lull", () => {
    const ws = SESSIONS.map((s) => sessionWindow(s, "2026-10-03", TZ));
    assert.equal(ws[1]!.startMs - ws[0]!.endMs, 90 * 60_000); // 12:00-13:30 local lull is not reported
    assert.equal(ws[2]!.startMs, ws[1]!.endMs);
    assert.equal(ws[3]!.startMs, ws[2]!.endMs);
  });

  test("pickSession chooses the session about to open at the routine's firing time", () => {
    // lead of 20 minutes: 07:40, 13:10, 17:10, 21:40 local
    const pick = (local: string) => pickSession(zonedToUtcMs("2026-10-03", local, TZ), TZ).session.id;
    assert.equal(pick("07:40"), "europe_open");
    assert.equal(pick("13:10"), "eu_us_overlap");
    assert.equal(pick("17:10"), "us");
    assert.equal(pick("21:40"), "night_asia");
  });

  test("pickSession during a session reports on the running one; in the lull it picks the next", () => {
    const pick = (local: string) => pickSession(zonedToUtcMs("2026-10-03", local, TZ), TZ).session.id;
    assert.equal(pick("10:00"), "europe_open");
    assert.equal(pick("16:00"), "eu_us_overlap");
    assert.equal(pick("03:00"), "night_asia"); // belongs to the night that started the evening before
    assert.equal(pick("12:30"), "eu_us_overlap"); // lull: next is the overlap (its report time is 13:10)
  });

  test("windowsAround is sorted and never overlaps within a day", () => {
    const ws = windowsAround(at("2026-10-03T12:00:00Z"), TZ);
    assert.equal(ws.length, 12);
    for (let i = 1; i < ws.length; i++) assert.ok(ws[i]!.startMs >= ws[i - 1]!.startMs);
  });
});

describe("profiles", () => {
  test("every session has limits, regions, investors, and refers only to known investor types", () => {
    for (const s of SESSIONS) {
      assert.ok(s.profile.length > 0 && s.watch.length > 0 && s.caution.length > 0, s.id);
      assert.ok(s.regions.some((r) => r.role === "dominant"), `${s.id} needs a dominant region`);
      assert.ok(s.investors.some((i) => i.weight === "high"), `${s.id} needs a high-weight investor`);
      for (const i of s.investors) assert.ok(INVESTORS[i.id], `${s.id}: unknown investor ${i.id}`);
      assert.ok(s.maxTtlMinutes >= s.entryDeadlineMinutes);
    }
  });

  test("the sessions differ where it matters: night is the most conservative, overlap the widest", () => {
    const night = sessionById("night_asia")!;
    const overlap = sessionById("eu_us_overlap")!;
    assert.ok(night.maxBets < overlap.maxBets);
    assert.ok(night.minRewardRisk > overlap.minRewardRisk);
    assert.ok(night.maxTtlMinutes > overlap.maxTtlMinutes);
    assert.ok(overlap.maxEntryDeviation > night.maxEntryDeviation);
    assert.equal(night.regions.find((r) => r.role === "dominant")!.region.startsWith("Asia"), true);
    assert.equal(overlap.regions.find((r) => r.role === "dominant")!.region.startsWith("US"), true);
  });
});
