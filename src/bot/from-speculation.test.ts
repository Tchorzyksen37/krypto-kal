// from-speculation.test.ts – a checked speculation bet becomes a bot policy that trades only inside the bet's window.
// Run: node --test src/bot/from-speculation.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bet, ReportMeta } from "../speculation/types.ts";
import { BotStore } from "./bot-store.ts";
import { addFromSpeculation } from "./cli.ts";
import { fixturesFromSpeculation } from "./from-speculation.ts";
import { effectivePolicy, validatePolicy, type Policy } from "./policy.ts";
import { T0, config } from "./sim-fixtures.ts";
import { MIN, iso, reasons, world } from "./trader-fixtures.ts";

const H = 60 * MIN;

// A long BTC bet: window opens 20 min after T0, fill by 60 min after T0, hold 90 min. ATR 800 (as the fake market).
const bet = (over: Partial<Bet> = {}): Bet => ({
  id: "20261003-1220Z-BTC-1", symbol: "BTC", futures: "PF_XBTUSD", side: "long",
  entry: 99250, stop_loss: 97750, take_profit: 102500, ttl_minutes: 90, probability: 0.55, rationale: "squeeze",
  rr: 2.17, ev_r: 0.6, break_even: 0.33,
  fill_from: iso(T0 + 20 * MIN), entry_deadline: iso(T0 + 60 * MIN), latest_close: iso(T0 + 150 * MIN), ...over,
});
const meta = (bets: Bet[], over: Partial<ReportMeta> = {}): ReportMeta => ({
  generated: iso(T0), window: [iso(T0 + 20 * MIN), iso(T0 + 260 * MIN)],
  symbols: [{ symbol: "BTC", futures: "PF_XBTUSD", last: 99300, atr_1h: 800 }, { symbol: "XRP", futures: "PF_XRPUSD", last: 2.4, atr_1h: 0.03 }],
  bets: [], validated: bets, ...over,
});

describe("fixturesFromSpeculation", () => {
  test("maps the bet's levels and times onto a policy", () => {
    const c = fixturesFromSpeculation(meta([bet()]), config, T0, "r.meta.json");
    assert.equal(c.fixtures.length, 1);
    const { fixture, window } = c.fixtures[0]!;
    const levels = Object.fromEntries(fixture.menu!.levels.map((l) => [l.id, l.price]));
    assert.deepEqual(levels, { zone_lo: 99170, zone_hi: 99250, stop: 97750, tp1: 102500 }); // band 0.1 ATR below the limit
    const p = fixture.policy;
    assert.deepEqual([p.allowed_directions, p.scenario!.horizon_hours, p.conviction, p.bias], [["long"], 1.5, 0.55, 0.55]);
    assert.equal(p.not_before, iso(T0 + 20 * MIN));
    assert.equal(p.valid_until, iso(T0 + 60 * MIN));
    assert.deepEqual(window, { notBefore: iso(T0 + 20 * MIN), entryUntil: iso(T0 + 60 * MIN), closeBy: iso(T0 + 150 * MIN) });
    assert.deepEqual(p.sources, ["r.meta.json", "20261003-1220Z-BTC-1"]);
    assert.deepEqual(c.warnings, []);
  });

  test("a short bet gets its band above the limit, and a band never reaches the stop", () => {
    const short = fixturesFromSpeculation(meta([bet({ side: "short", entry: 99300, stop_loss: 100900, take_profit: 96000 })]), config, T0);
    const lv = Object.fromEntries(short.fixtures[0]!.fixture.menu!.levels.map((l) => [l.id, l.price]));
    assert.deepEqual([lv.zone_lo, lv.zone_hi], [99300, 99380]);
    const tight = fixturesFromSpeculation(meta([bet({ stop_loss: 99150 })]), config, T0); // risk 100 < 0.1 ATR
    const t = Object.fromEntries(tight.fixtures[0]!.fixture.menu!.levels.map((l) => [l.id, l.price]));
    assert.equal(t.zone_lo, 99225); // a quarter of the stop distance
  });

  test("bets on other contracts, past windows and second bets are skipped with a reason", () => {
    const c = fixturesFromSpeculation(meta([
      bet({ id: "x", symbol: "XRP", futures: "PF_XRPUSD", entry: 2.39, stop_loss: 2.3, take_profit: 2.6 }),
      bet({ id: "late", entry_deadline: iso(T0 - 1) }),
      bet({ id: "best" }),
      bet({ id: "second" }),
    ]), config, T0);
    assert.deepEqual(c.fixtures.map((f) => f.betId), ["best"]);
    assert.deepEqual(c.skipped.map((s) => s.betId), ["x", "late", "second"]);
    assert.match(c.skipped[0]!.reason, /trades PF_XBTUSD, this bet is on PF_XRPUSD/);
  });

  test("warns when the bot's own limits will refuse the entry or cut the window", () => {
    const c = fixturesFromSpeculation(meta([bet({ stop_loss: 98700, take_profit: 99600, entry_deadline: iso(T0 + 180 * MIN) })]), config, T0);
    const w = c.warnings.join("\n");
    assert.match(w, /sl_min_atr_multiple/);
    assert.match(w, /min_reward_risk/);
    assert.match(w, /max_policy_ttl_min \(60 min\)/);
  });

  test("an unchecked report or a report without bets gives nothing", () => {
    assert.match(fixturesFromSpeculation(meta([], { validated: undefined }), config, T0).warnings[0]!, /run `node src\/speculation\/check.ts/);
    assert.match(fixturesFromSpeculation(meta([]), config, T0).warnings[0]!, /no bets/);
  });
});

describe("not_before", () => {
  const ctx = { config, nowMs: T0, getMenu: () => ({ id: "m", symbol: "PF_XBTUSD", createdAtMs: T0, levels: [] }) };
  const base = (over: Partial<Policy>): Policy => ({
    schema_version: 1, menu_id: "m", symbol: "PF_XBTUSD", bias: 0.5, conviction: 0.5, risk_budget_pct: 0.5, allowed_directions: ["long"],
    scenario: null, valid_until: iso(T0 + H), rationale: "", sources: [], ...over,
  });

  test("must come before valid_until", () => {
    const r = validatePolicy(base({ not_before: iso(T0 + H) }), ctx);
    assert.deepEqual(r, { ok: false, reason: "not_before is not before valid_until" });
    assert.equal(validatePolicy(base({ not_before: iso(T0 + 10 * MIN) }), ctx).ok, true);
  });

  test("the effective policy waits for the latest start in its window", () => {
    const e = effectivePolicy([base({ not_before: iso(T0 + 5 * MIN) }), base({ not_before: iso(T0 + 20 * MIN) })], 2)!;
    assert.equal(e.not_before, iso(T0 + 20 * MIN));
    assert.equal(effectivePolicy([base({}), base({})], 2)!.not_before, undefined);
  });
});

describe("the bot trades only inside the speculation's window", () => {
  test("no entry before the window, an entry inside it, and the time-stop closes it after the hold time", async () => {
    const w = world({ policies: 0 });
    const r = addFromSpeculation(w.store, config, meta([bet()]), w.clock.now());
    assert.equal(r.added, 1, r.text);
    assert.match(r.text, /2 agreeing copies/);

    w.tick(99240); // inside the zone, but the window has not opened
    assert.deepEqual(reasons(await w.cycle()), ["policy_not_yet_active"]);

    w.clock.advance(20 * MIN); // window open; price has been at the level for longer than the 30 s confirmation
    w.tick(99240);
    assert.deepEqual(reasons(await w.cycle()), ["entry", "entry_placed"]);
    w.tick(99000); // trades through the limit
    await w.cycle();
    await w.cycle();
    assert.equal(w.rec().state, "OPEN");

    w.clock.advance(91 * MIN); // past the hold time (and past the entry window)
    w.tick(99300);
    assert.ok(reasons(await w.cycle()).includes("time_stop"));
  });

  test("no entry once the bet's fill-by time has passed", async () => {
    const w = world({ policies: 0 });
    addFromSpeculation(w.store, config, meta([bet()]), w.clock.now());
    w.clock.advance(61 * MIN);
    w.tick(99240);
    assert.deepEqual(reasons(await w.cycle()), ["policy_expired"]);
  });

  test("a dry run stores nothing", () => {
    const store = new BotStore(":memory:");
    const r = addFromSpeculation(store, config, meta([bet()]), T0, { dry: true });
    assert.equal(r.added, 0);
    assert.match(r.text, /dry run: nothing stored/);
    assert.equal(store.latestPolicies(5).length, 0);
  });
});
