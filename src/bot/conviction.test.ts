// conviction.test.ts – offline tests of the history-corrected conviction.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { HypotheticalStatus, LoggedBet } from "../speculation/types.ts";
import { calibratedConviction, calibrationRatio, loadCalibration } from "./conviction.ts";

// Each bet gets its own hour so bets never overlap unless a test asks for it.
let seq = 0;
const bet = (probability: number, status: HypotheticalStatus | undefined, over: Partial<LoggedBet> = {}): LoggedBet => {
  const n = seq++;
  const from = Date.UTC(2026, 9, 1) + n * 3 * 3600_000;
  return {
    id: `b${n}`,
    symbol: "BTC",
    futures: "PF_XBTUSD",
    side: "long",
    probability,
    fill_from: new Date(from).toISOString(),
    entry_deadline: new Date(from + 3600_000).toISOString(),
    latest_close: new Date(from + 2 * 3600_000).toISOString(),
    ...(status ? { hypothetical: { status } } : {}),
    ...over,
  } as unknown as LoggedBet;
};

const many = (n: number, p: number, hits: number): LoggedBet[] =>
  Array.from({ length: n }, (_, i) => bet(p, i < hits ? "tp" : "sl"));

describe("calibrationRatio", () => {
  test("no touched bets: ratio is 1", () => {
    assert.equal(calibrationRatio([]).ratio, 1);
    assert.equal(calibrationRatio([bet(0.5, "not_touched"), bet(0.5, undefined)]).ratio, 1);
  });

  test("3 touched bets with stated 0.4 and no hit: ratio is 4 / 5.2 (0.769)", () => {
    const r = calibrationRatio([bet(0.4, "sl"), bet(0.4, "ttl"), bet(0.4, "sl")]);
    assert.ok(Math.abs(r.ratio - 4 / 5.2) < 1e-3, String(r.ratio));
    assert.equal(r.touched, 3);
    assert.equal(r.hits, 0);
    assert.ok(Math.abs(r.expected - 1.2) < 1e-9);
  });

  test("a well calibrated sample of 100 (hits equal expected) gives ratio 1", () => {
    assert.ok(Math.abs(calibrationRatio(many(100, 0.4, 40)).ratio - 1) < 1e-9);
  });

  test("a badly calibrated sample of 100 (40 expected, 5 hits) gives a ratio near 0.3", () => {
    const r = calibrationRatio(many(100, 0.4, 5)).ratio;
    assert.ok(r < 0.4 && r > 0.2, String(r));
  });

  test("an over-performing sample gives ratio above 1 and calibratedConviction clamps to 1", () => {
    const r = calibrationRatio(many(100, 0.4, 80)).ratio;
    assert.ok(r > 1);
    assert.equal(calibratedConviction(0.9, r), 1);
  });

  test("overlapping bets on the same symbol and side count once", () => {
    const a = bet(0.4, "sl");
    const b = bet(0.4, "sl", { fill_from: a.fill_from, entry_deadline: a.entry_deadline, latest_close: a.latest_close });
    assert.equal(calibrationRatio([a, b]).touched, 1);
  });
});

describe("calibratedConviction", () => {
  test("multiplies and clamps to [0, 1]", () => {
    assert.ok(Math.abs(calibratedConviction(0.6, 0.5) - 0.3) < 1e-9);
    assert.equal(calibratedConviction(0.6, 3), 1);
    assert.equal(calibratedConviction(-0.2, 1), 0);
  });
});

describe("loadCalibration", () => {
  const dirWith = (content?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "conviction-"));
    if (content !== undefined) writeFileSync(join(dir, "bets-log.json"), content);
    return dir;
  };

  test("missing file, invalid JSON and a non-array each return ratio 1 and a warning", () => {
    for (const dir of [dirWith(), dirWith("{ not json"), dirWith('{"a":1}')]) {
      const c = loadCalibration(dir);
      assert.equal(c.ratio, 1);
      assert.ok(c.warning, "expected a warning");
    }
  });

  test("a valid file returns the ratio and no warning", () => {
    const c = loadCalibration(dirWith(JSON.stringify([bet(0.4, "sl"), bet(0.4, "sl"), bet(0.4, "sl")])));
    assert.ok(Math.abs(c.ratio - 4 / 5.2) < 1e-3);
    assert.equal(c.touched, 3);
    assert.equal(c.warning, undefined);
  });
});
