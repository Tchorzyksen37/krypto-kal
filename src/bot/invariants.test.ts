// invariants.test.ts – property tests of the whole bot: random scenarios (see sim.ts) with the spec's safety
// properties checked after every step. Run: node --test bot/invariants.test.ts
//
//   SIM_SEEDS=1000 SIM_STEPS=800 npm run test:bot     a deeper run (the default takes about 20 seconds)
//
// A failing property prints its seed and step. Replay it with:  collectScenario(seed, steps, { trace: true })
//
// Three things make a passing run mean something:
//  - coverage thresholds: the scenarios must actually have opened positions, hit stops and targets, restarted, ...
//  - the tripwire: with the safety net broken (stops and closes never reach the exchange) the harness MUST report P1;
//  - determinism: the same seed gives the same result, so a failure can be replayed.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { type Prop, type Stats, type Violation, collectScenario, runRandomScenario } from "./sim.ts";

const SEEDS = Number(process.env.SIM_SEEDS ?? 60);
const STEPS = Number(process.env.SIM_STEPS ?? 500);
const scale = (SEEDS * STEPS) / (60 * 500); // the thresholds below are for the default size, found by measurement

const violations: Violation[] = [];
const total: Stats = {
  steps: 0, entries: 0, positionsOpened: 0, stopFills: 0, targetFills: 0, closes: 0, watchdogRepairs: 0, restarts: 0,
  clockBackJumps: 0, policiesStored: 0, policiesRejected: 0, halts: 0, faults: 0, reasons: {},
};

before(async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { violations: v, stats } = await collectScenario(seed, STEPS);
    violations.push(...v);
    for (const key of Object.keys(total) as (keyof Stats)[]) {
      if (key !== "reasons") (total[key] as number) += stats[key] as number;
    }
    for (const [reason, n] of Object.entries(stats.reasons)) total.reasons[reason] = (total.reasons[reason] ?? 0) + n;
  }
});

const of = (prop: Prop) => violations.filter((v) => v.prop === prop).map((v) => `${v.prop} seed ${v.seed} step ${v.step}: ${v.detail}`);

describe(`safety properties over ${SEEDS} random scenarios of ${STEPS} steps`, () => {
  test("P1  a bot position never goes without a stop for longer than the bound", () => assert.deepEqual(of("P1"), []));
  test("P2  a stop only ever moves toward the market within a trade", () => assert.deepEqual(of("P2"), []));
  test("P3  no entry breaks a cap: state, risk, leverage, entries per day, the order budget for the whole bundle", () => assert.deepEqual(of("P3"), []));
  test("P4  in OPEN, after an undisturbed cycle, the stop equals the position and the targets cover it", () => assert.deepEqual(of("P4"), []));
  test("P5  every entry keeps the liquidation distance and the leverage the spec demands", () => assert.deepEqual(of("P5"), []));
  test("P6  the daily counters never decrease, restarts included", () => assert.deepEqual(of("P6"), []));
  test("P7  the effective policy is never looser than the most conservative of the last N", () => assert.deepEqual(of("P7"), []));
  test("P8  a reduce-only order never increases exposure", () => assert.deepEqual(of("P8"), []));
  test("G1  at most one entry order is open, and an order the bot did not create is never touched", () => assert.deepEqual(of("G1"), []));
  test("G3  an active state always has a trade record", () => assert.deepEqual(of("G3"), []));
  test("G5  the account stays finite", () => assert.deepEqual(of("G5"), []));
  test("X1  nothing ever throws", () => assert.deepEqual(of("X1"), []));
});

describe("the scenarios really exercised the bot (a property cannot pass because nothing happened)", () => {
  const atLeast = (name: keyof Stats, n: number) =>
    test(`${name} >= ${Math.ceil(n * scale)}`, () => assert.ok((total[name] as number) >= n * scale, `only ${total[name]} ${name} in ${total.steps} steps`));
  // About half of what the default run measures (51 entries, 29 positions, 26 stop fills, 13 target fills, 16 closes, ...).
  atLeast("steps", 30_000);
  atLeast("entries", 25);
  atLeast("positionsOpened", 12);
  atLeast("stopFills", 10);
  atLeast("targetFills", 4);
  atLeast("closes", 6);
  atLeast("watchdogRepairs", 3);
  atLeast("restarts", 80);
  atLeast("clockBackJumps", 70);
  atLeast("policiesStored", 250);
  atLeast("faults", 400);

  test("hostile policies were produced and refused by the real validator", () => {
    assert.ok(total.policiesRejected >= 200 * scale, `only ${total.policiesRejected} rejected`);
  });

  test("the engine met both ordinary and awkward situations", () => {
    for (const reason of ["entry", "protected", "trail", "holding", "cooldown", "price_outside_zone", "foreign_exposure", "clock_went_backwards", "policy_expired"]) {
      assert.ok((total.reasons[reason] ?? 0) > 0, `the engine never answered "${reason}"`);
    }
  });
});

describe("the harness itself", () => {
  test("TRIPWIRE: with stops and closes never reaching the exchange, P1 is reported and runRandomScenario throws", async () => {
    let hit: { seed: number; step: number } | null = null;
    for (let seed = 1; seed <= 60 && !hit; seed++) {
      const { violations: v } = await collectScenario(seed, STEPS, { breakProtectTimeout: true });
      const p1 = v.find((x) => x.prop === "P1");
      if (p1) hit = { seed, step: p1.step };
    }
    assert.ok(hit, "a broken safety net went unnoticed: the harness cannot see P1 fail");
    const { seed } = hit;
    await assert.rejects(runRandomScenario(seed, STEPS, { breakProtectTimeout: true }), (e: Error) => {
      assert.match(e.message, /^P1 violated \(seed \d+, step \d+\): /);
      assert.ok(e.message.includes(`seed ${seed},`), "the message must name the seed that failed");
      return true;
    });
  });

  test("the same seed gives the same result (a failure can be replayed)", async () => {
    const a = await collectScenario(7, 300);
    const b = await collectScenario(7, 300);
    assert.deepEqual(a, b);
  });

  test("different seeds give different scenarios", async () => {
    const a = await collectScenario(7, 300);
    const b = await collectScenario(8, 300);
    assert.notDeepEqual(a.stats, b.stats);
  });
});
