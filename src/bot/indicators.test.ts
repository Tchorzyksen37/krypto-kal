// indicators.test.ts – offline tests of the ATR and the persisted engine record.
// Run: node --test bot/indicators.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FuturesCandle } from "../providers/kraken/kraken-futures-client.ts";
import { BotStore } from "./bot-store.ts";
import { defaultEngineRecord, loadEngineRecord, saveEngineRecord } from "./engine-state.ts";
import { atr } from "./indicators.ts";

const HOUR = 3600;
const T = Date.parse("2026-10-03T12:00:00Z") / 1000; // an hour boundary, in seconds
const NOW = (T + 10 * 60) * 1000; // ten minutes into the hour that starts at T
const c = (k: number, o: number, h: number, l: number, cl: number): FuturesCandle => ({ t: T - k * HOUR, o, h, l, c: cl, v: 1 });

// Four closed hourly candles, oldest first (k = 4 .. 1). True ranges of the last three: 10, 20, 10.
const closed = [c(4, 100, 110, 90, 100), c(3, 100, 105, 95, 100), c(2, 105, 120, 100, 110), c(1, 112, 115, 105, 110)];

describe("atr", () => {
  test("is the average true range of the last `period` closed candles", () => {
    const v = atr(closed, 3, "1h", NOW);
    assert.ok(v !== null && Math.abs(v - (10 + 20 + 10) / 3) < 1e-9, `got ${v}`);
  });

  test("uses the previous close, so a gap between candles widens the range", () => {
    // Candle 2 opens far above candle 3's close: TR = max(20, |120 - 100|, |100 - 100|) = 20, not just high - low (20 here too);
    // make the gap show: prev close 100, next candle 130..135 -> TR = max(5, 35, 30) = 35.
    const gapUp = [c(2, 100, 101, 99, 100), c(1, 131, 135, 130, 133)];
    assert.equal(atr(gapUp, 1, "1h", NOW), 35);
  });

  test("ignores the candle still forming and uses only the last period + 1 closed ones", () => {
    const forming: FuturesCandle = { t: T, o: 110, h: 400, l: 10, c: 200, v: 1 }; // started at T, ends at T + 1 h > now
    const older = c(5, 50, 300, 1, 100);
    const v = atr([older, ...closed, forming], 3, "1h", NOW);
    assert.ok(v !== null && Math.abs(v - 40 / 3) < 1e-9);
  });

  test("candles in any order give the same answer", () => {
    assert.equal(atr([...closed].reverse(), 3, "1h", NOW), atr(closed, 3, "1h", NOW));
  });

  test("a candle that closes exactly now counts as closed", () => {
    assert.ok(atr(closed, 3, "1h", T * 1000) !== null); // candle 1 ends at T
  });

  test("too few closed candles is null (it needs period + 1)", () => {
    assert.equal(atr(closed.slice(1), 3, "1h", NOW), null);
    assert.equal(atr([], 3, "1h", NOW), null);
  });

  test("a missing candle in the window is null: the true range across a hole would be wrong", () => {
    assert.equal(atr([closed[0]!, closed[1]!, closed[3]!, c(0, 110, 112, 108, 110)], 3, "1h", NOW + HOUR * 1000), null);
  });

  test("a malformed candle is null, never a number", () => {
    for (const bad of [c(2, 105, 120, 100, Number.NaN), c(2, 105, 90, 100, 110), c(2, 0, 120, 100, 110), c(2, 105, Number.POSITIVE_INFINITY, 100, 110)]) {
      assert.equal(atr([closed[0]!, closed[1]!, bad, closed[3]!], 3, "1h", NOW), null);
    }
  });

  test("an unknown resolution, a bad period or a bad clock is null", () => {
    assert.equal(atr(closed, 3, "2h", NOW), null);
    assert.equal(atr(closed, 0, "1h", NOW), null);
    assert.equal(atr(closed, 1.5, "1h", NOW), null);
    assert.equal(atr(closed, 3, "1h", Number.NaN), null);
  });

  test("a flat market gives an ATR of exactly zero, which the sizing refuses (not a division by zero here)", () => {
    const flat = [c(4, 100, 100, 100, 100), c(3, 100, 100, 100, 100), c(2, 100, 100, 100, 100), c(1, 100, 100, 100, 100)];
    assert.equal(atr(flat, 3, "1h", NOW), 0);
  });
});

describe("engine record", () => {
  test("a missing record is a fresh FLAT engine that has not been reconciled", () => {
    const rec = loadEngineRecord(new BotStore(":memory:"));
    assert.deepEqual(rec, defaultEngineRecord());
    assert.equal(rec.state, "FLAT");
    assert.equal(rec.reconciled, false);
  });

  test("round-trips, including a trade and a halt", () => {
    const store = new BotStore(":memory:");
    const rec = {
      ...defaultEngineRecord(), state: "HALTED" as const, sinceMs: 5, reconciled: true, lastClockMs: 9,
      halt: { reason: "daily_loss_limit", manualAck: false, untilMs: 100 }, cooldownUntilMs: 7,
    };
    saveEngineRecord(store, rec);
    assert.deepEqual(loadEngineRecord(store), rec);
  });

  test("fields added in a later version get their defaults when an old record is loaded", () => {
    const store = new BotStore(":memory:");
    store.setKv("engine:record", JSON.stringify({ state: "OPEN", sinceMs: 3 }));
    const rec = loadEngineRecord(store);
    assert.equal(rec.state, "OPEN");
    assert.equal(rec.liqAckMs, 0);
    assert.equal(rec.reconciled, false);
  });

  test("a record that cannot be read throws instead of guessing a state", () => {
    const store = new BotStore(":memory:");
    store.setKv("engine:record", "{ not json");
    assert.throws(() => loadEngineRecord(store), /not valid JSON/);
    store.setKv("engine:record", JSON.stringify({ state: "WANDERING" }));
    assert.throws(() => loadEngineRecord(store), /unknown state/);
    store.setKv("engine:record", "42");
    assert.throws(() => loadEngineRecord(store), /unknown state/);
  });
});
