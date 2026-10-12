import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOT_MS, slotAt, dueSlot } from "./slots.ts";
import { pickSession, sessionById, sessionOptionsFromEnv } from "../speculation/sessions.ts";

const at = (iso: string) => Date.parse(iso);

test("slotAt returns the 2-hour UTC slot containing the instant", () => {
  const s = slotAt(at("2026-10-12T09:41:00Z"));
  assert.equal(s.id, "20261012-0800Z");
  assert.equal(s.startMs, at("2026-10-12T08:00:00Z"));
  assert.equal(s.endMs, at("2026-10-12T10:00:00Z"));
});

test("the slot session is the one pickSession gives for the slot start", () => {
  const s = slotAt(at("2026-10-12T08:00:00Z"));
  const { tz } = sessionOptionsFromEnv();
  assert.equal(s.session, pickSession(s.startMs, tz, 0).session.id);
  assert.equal(s.session, "europe_open");
});

test("entry cutoff never exceeds the slot end", () => {
  const night = slotAt(at("2026-10-12T22:30:00Z"));
  assert.equal(night.session, "night_asia");
  assert.equal(night.entryCutoffMs, night.startMs + SLOT_MS);
  const eu = slotAt(at("2026-10-12T08:00:00Z"));
  assert.equal(eu.entryCutoffMs, eu.startMs + sessionById("europe_open")!.entryDeadlineMinutes * 60_000);
});

test("dueSlot: current slot is due until handled", () => {
  const now = at("2026-10-12T08:10:00Z");
  assert.equal(dueSlot(now, new Set()).due?.id, "20261012-0800Z");
  assert.equal(dueSlot(now, new Set(["20261012-0800Z"])).due, undefined);
});

test("dueSlot: late wake-up after the cutoff gives no due slot", () => {
  const r = dueSlot(at("2026-10-12T09:10:00Z"), new Set());
  assert.equal(r.due, undefined);
  assert.equal(r.missed.length, 12);
  assert.ok(r.missed.every((m) => m.endMs <= at("2026-10-12T08:00:00Z")));
  assert.ok(!r.missed.some((m) => m.id === "20261012-0800Z"));
});

test("missed skips handled slots and the current slot", () => {
  const now = at("2026-10-12T10:05:00Z");
  const r = dueSlot(now, new Set(["20261012-0800Z", "20261012-0600Z"]));
  const ids = r.missed.map((m) => m.id);
  assert.ok(!ids.includes("20261012-0800Z"));
  assert.ok(!ids.includes("20261012-0600Z"));
  assert.ok(!ids.includes("20261012-1000Z"));
  assert.equal(ids.length, 10);
});

test("DST change day: 12 distinct slot ids, each exactly 2 hours", () => {
  const day = at("2026-10-25T00:00:00Z");
  const slots = Array.from({ length: 12 }, (_, i) => slotAt(day + i * SLOT_MS));
  assert.equal(new Set(slots.map((s) => s.id)).size, 12);
  for (const s of slots) assert.equal(s.endMs - s.startMs, SLOT_MS);
});
