// policy.test.ts – offline tests of policy validation, level resolution and the effective policy.
// Run: node --test bot/policy.test.ts
//
// Contract pinned here (see docs/superpowers/specs/2026-10-03-trader-core-design.md, section 5):
//  - validatePolicy never throws on bad input; it returns { ok: false, reason } and the reason names the problem.
//  - The reason texts are matched loosely (a keyword), so wording can change but the keyword should stay.
//  - effectivePolicy(history, n) takes the history newest first and the most conservative value per field.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultConfig } from "./config.ts";
import { type LevelMenu, type Policy, effectivePolicy, validatePolicy } from "./policy.ts";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const config = defaultConfig(); // max_risk_per_trade_pct 0.5, max_policy_ttl_min 60, max_hold_hours 48, max_menu_age_min 15

// One menu with levels on both sides of the entry zone 99000..99500.
const menu: LevelMenu = {
  id: "m1",
  symbol: "PF_XBTUSD",
  createdAtMs: NOW - 2 * MIN,
  levels: [
    { id: "sup2", price: 96000, kind: "swing_low" },
    { id: "sup1", price: 98000, kind: "swing_low" },
    { id: "e_lo", price: 99000, kind: "atr_band" },
    { id: "e_hi", price: 99500, kind: "atr_band" },
    { id: "res1", price: 102000, kind: "swing_high" },
    { id: "res2", price: 104000, kind: "swing_high" },
    { id: "res3", price: 106000, kind: "swing_high" },
    { id: "res4", price: 108000, kind: "swing_high" },
  ],
};

const ctx = (over: Record<string, unknown> = {}) => ({
  config,
  getMenu: (id: string) => (id === menu.id ? menu : undefined),
  nowMs: NOW,
  ...over,
});

const longScenario = {
  direction: "long",
  entry_zone: { from: "e_lo", to: "e_hi" },
  targets: ["res1", "res2"],
  invalidation: "sup1",
  horizon_hours: 24,
};
const shortScenario = {
  direction: "short",
  entry_zone: { from: "e_lo", to: "e_hi" },
  targets: ["sup1", "sup2"],
  invalidation: "res1",
  horizon_hours: 24,
};

// A valid raw policy (what the LLM emits); `over` replaces top-level fields.
const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  menu_id: "m1",
  symbol: "PF_XBTUSD",
  bias: 0.6,
  conviction: 0.7,
  risk_budget_pct: 0.4,
  allowed_directions: ["long"],
  scenario: longScenario,
  valid_until: iso(NOW + 30 * MIN),
  rationale: "Brief points to de-escalation; oil is the weakest link.",
  sources: ["output/2026-10-01-geopolitics-brief.md"],
  ...over,
});
const withScenario = (over: Record<string, unknown>, base = longScenario) => raw({ scenario: { ...base, ...over } });

// Asserts the policy is rejected and the reason mentions `keyword`.
const rejected = (input: unknown, keyword: RegExp, c = ctx()) => {
  const r = validatePolicy(input, c);
  assert.ok(!r.ok, `expected rejection (${keyword}), got ok`);
  assert.match(r.reason, keyword);
};
const accepted = (input: unknown, c = ctx()) => {
  const r = validatePolicy(input, c);
  assert.ok(r.ok, r.ok ? "" : `expected ok, got: ${r.reason}`);
  return r;
};

describe("validatePolicy – accepted policies", () => {
  test("a valid long policy resolves level ids to the menu's prices", () => {
    const r = accepted(raw());
    assert.deepEqual(r.scenario, {
      direction: "long", entryLow: 99000, entryHigh: 99500, targets: [102000, 104000], stop: 98000, horizonHours: 24,
    });
  });

  test("a valid short policy resolves too (targets below, stop above)", () => {
    const r = accepted(raw({ allowed_directions: ["short"], scenario: shortScenario }));
    assert.deepEqual(r.scenario, {
      direction: "short", entryLow: 99000, entryHigh: 99500, targets: [98000, 96000], stop: 102000, horizonHours: 24,
    });
  });

  test("a null scenario is valid and means 'no entry'", () => {
    const r = accepted(raw({ scenario: null, bias: 0, allowed_directions: [] }));
    assert.equal(r.scenario, null);
  });

  test("the returned policy equals the input, and the input is not mutated", () => {
    const input = raw();
    const snapshot = structuredClone(input);
    const r = accepted(input);
    assert.deepEqual(r.policy, snapshot);
    assert.deepEqual(input, snapshot);
  });

  test("boundary values are accepted: risk at the cap, horizon at max_hold_hours, three targets", () => {
    accepted(raw({ risk_budget_pct: config.max_risk_per_trade_pct }));
    accepted(withScenario({ horizon_hours: config.max_hold_hours }));
    accepted(withScenario({ targets: ["res1", "res2", "res3"] }));
  });
});

describe("validatePolicy – shape", () => {
  test("non-objects are rejected", () => {
    for (const bad of [null, undefined, "policy", 42, []]) rejected(bad, /./);
  });

  test("missing, extra and wrongly typed fields are rejected", () => {
    const { menu_id: _omit, ...withoutMenu } = raw();
    rejected(withoutMenu, /menu_id/);
    rejected(raw({ surprise: true }), /surprise/);
    rejected(raw({ bias: "high" }), /bias/);
    rejected(raw({ allowed_directions: "long" }), /allowed_directions/);
    rejected(raw({ sources: "output/x.md" }), /sources/);
  });

  test("schema_version other than 1 is rejected", () => {
    rejected(raw({ schema_version: 2 }), /schema_version/);
  });

  test("bias outside [-1, 1] and conviction outside [0, 1] are rejected", () => {
    rejected(raw({ bias: 1.01 }), /bias/);
    rejected(raw({ bias: -1.01 }), /bias/);
    rejected(raw({ conviction: -0.01 }), /conviction/);
    rejected(raw({ conviction: 1.01 }), /conviction/);
  });

  test("NaN and Infinity are rejected everywhere a number is expected", () => {
    rejected(raw({ bias: Number.NaN }), /bias/);
    rejected(raw({ risk_budget_pct: Number.POSITIVE_INFINITY }), /risk_budget_pct/);
  });

  test("rationale over 1000 characters is rejected", () => {
    rejected(raw({ rationale: "x".repeat(1001) }), /rationale/);
    accepted(raw({ rationale: "x".repeat(1000) }));
  });

  test("allowed_directions only takes long and short", () => {
    rejected(raw({ allowed_directions: ["both"] }), /allowed_directions/);
  });
});

describe("validatePolicy – risk budget", () => {
  test("above max_risk_per_trade_pct is rejected, not clamped", () => {
    rejected(raw({ risk_budget_pct: config.max_risk_per_trade_pct + 0.01 }), /risk_budget_pct/);
  });

  test("zero and negative are rejected", () => {
    rejected(raw({ risk_budget_pct: 0 }), /risk_budget_pct/);
    rejected(raw({ risk_budget_pct: -0.1 }), /risk_budget_pct/);
  });
});

describe("validatePolicy – menu and symbol", () => {
  test("an unknown menu_id is rejected", () => {
    rejected(raw({ menu_id: "nope" }), /menu/i);
  });

  test("a menu older than max_menu_age_min is rejected; just inside is accepted", () => {
    const limitMs = config.max_menu_age_min * MIN;
    rejected(raw(), /menu/i, ctx({ nowMs: menu.createdAtMs + limitMs + 1 }));
    accepted(raw(), ctx({ nowMs: menu.createdAtMs + limitMs, }));
  });

  test("a symbol that differs from config.symbol is rejected", () => {
    rejected(raw({ symbol: "PF_ETHUSD" }), /symbol/i);
  });

  test("a menu built for another symbol is rejected", () => {
    const other: LevelMenu = { ...menu, symbol: "PF_ETHUSD" };
    rejected(raw(), /symbol/i, ctx({ getMenu: () => other }));
  });
});

describe("validatePolicy – valid_until", () => {
  test("an unparsable timestamp is rejected", () => {
    rejected(raw({ valid_until: "tomorrow" }), /valid_until/);
  });

  test("already expired (past or exactly now) is rejected", () => {
    rejected(raw({ valid_until: iso(NOW - MIN) }), /valid_until/);
    rejected(raw({ valid_until: iso(NOW) }), /valid_until/);
  });

  test("beyond max_policy_ttl_min is clamped to it", () => {
    const r = accepted(raw({ valid_until: iso(NOW + 6 * 60 * MIN) }));
    assert.equal(r.policy.valid_until, iso(NOW + config.max_policy_ttl_min * MIN));
  });

  test("within the TTL it is returned unchanged", () => {
    const r = accepted(raw({ valid_until: iso(NOW + 10 * MIN) }));
    assert.equal(r.policy.valid_until, iso(NOW + 10 * MIN));
  });
});

describe("validatePolicy – scenario completeness", () => {
  test("missing invalidation or targets means the policy is rejected (the engine never invents a stop)", () => {
    const { invalidation: _i, ...noStop } = longScenario;
    rejected(raw({ scenario: noStop }), /invalidation/);
    rejected(withScenario({ targets: [] }), /targets?/);
    const { targets: _t, ...noTargets } = longScenario;
    rejected(raw({ scenario: noTargets }), /targets?/);
  });

  test("more than three targets is rejected", () => {
    rejected(withScenario({ targets: ["res1", "res2", "res3", "res4"] }), /targets?/);
  });

  test("a level id that is not in the menu is rejected", () => {
    rejected(withScenario({ invalidation: "ghost" }), /level|ghost/i);
    rejected(withScenario({ targets: ["res1", "ghost"] }), /level|ghost/i);
    rejected(withScenario({ entry_zone: { from: "ghost", to: "e_hi" } }), /level|ghost/i);
  });

  test("scenario direction must be in allowed_directions", () => {
    rejected(raw({ allowed_directions: ["short"] }), /direction/i);
    rejected(raw({ allowed_directions: [] }), /direction/i);
  });

  test("horizon_hours must be positive and at most max_hold_hours", () => {
    rejected(withScenario({ horizon_hours: 0 }), /horizon/);
    rejected(withScenario({ horizon_hours: -1 }), /horizon/);
    rejected(withScenario({ horizon_hours: config.max_hold_hours + 1 }), /horizon/);
  });
});

describe("validatePolicy – level geometry (degenerate levels never reach sizing)", () => {
  test("entry_zone with from above to is rejected", () => {
    rejected(withScenario({ entry_zone: { from: "e_hi", to: "e_lo" } }), /entry_zone/);
  });

  test("long: invalidation at or above the entry zone's low is rejected", () => {
    rejected(withScenario({ invalidation: "e_lo" }), /invalidation/); // equal to entry low
    rejected(withScenario({ invalidation: "e_hi" }), /invalidation/); // inside the zone
    rejected(withScenario({ invalidation: "res1" }), /invalidation/); // above
  });

  test("short: invalidation at or below the entry zone's high is rejected", () => {
    const base = { ...shortScenario };
    const a = raw({ allowed_directions: ["short"], scenario: { ...base, invalidation: "e_hi" } });
    const b = raw({ allowed_directions: ["short"], scenario: { ...base, invalidation: "sup1" } });
    rejected(a, /invalidation/);
    rejected(b, /invalidation/);
  });

  test("long: every target must lie above the entry zone's high", () => {
    rejected(withScenario({ targets: ["e_hi"] }), /target/);
    rejected(withScenario({ targets: ["res1", "sup1"] }), /target/);
  });

  test("long: targets must be strictly ascending (no duplicates, no reversed order)", () => {
    rejected(withScenario({ targets: ["res2", "res1"] }), /target/);
    rejected(withScenario({ targets: ["res1", "res1"] }), /target/);
  });

  test("short: targets must lie below the zone and be strictly descending", () => {
    const short = (targets: string[]) => raw({ allowed_directions: ["short"], scenario: { ...shortScenario, targets } });
    rejected(short(["e_lo"]), /target/);
    rejected(short(["sup2", "sup1"]), /target/);
    rejected(short(["res1"]), /target/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// effectivePolicy: tighten instantly, loosen only after N confirming cycles. Newest policy first.

// A policy with sensible defaults; each test overrides the fields it is about.
const pol = (over: Partial<Policy> = {}): Policy => ({
  schema_version: 1,
  menu_id: "m1",
  symbol: "PF_XBTUSD",
  bias: 0.6,
  conviction: 0.7,
  risk_budget_pct: 0.4,
  allowed_directions: ["long", "short"],
  scenario: longScenario as Policy["scenario"],
  valid_until: iso(NOW + 30 * MIN),
  rationale: "r",
  sources: [],
  ...over,
});

describe("effectivePolicy", () => {
  test("an empty history has no effective policy", () => {
    assert.equal(effectivePolicy([], 2), null);
  });

  test("fewer policies than n: loosening is not yet confirmed, so there is no effective policy", () => {
    assert.equal(effectivePolicy([pol()], 2), null);
  });

  test("n = 1 returns the newest policy unchanged", () => {
    const newest = pol({ risk_budget_pct: 0.5 });
    assert.deepEqual(effectivePolicy([newest, pol({ risk_budget_pct: 0.1 })], 1), newest);
  });

  test("tightening applies at once: a lower risk budget in the newest policy wins", () => {
    const e = effectivePolicy([pol({ risk_budget_pct: 0.1 }), pol({ risk_budget_pct: 0.4 })], 2);
    assert.equal(e?.risk_budget_pct, 0.1);
  });

  test("loosening waits: a higher risk budget in the newest policy is held back by the older, lower one", () => {
    const e = effectivePolicy([pol({ risk_budget_pct: 0.4 }), pol({ risk_budget_pct: 0.1 })], 2);
    assert.equal(e?.risk_budget_pct, 0.1);
  });

  test("after n policies agree on the looser value, it takes effect", () => {
    const e = effectivePolicy([pol({ risk_budget_pct: 0.4 }), pol({ risk_budget_pct: 0.4 }), pol({ risk_budget_pct: 0.1 })], 2);
    assert.equal(e?.risk_budget_pct, 0.4);
  });

  test("only the newest n policies count", () => {
    const e = effectivePolicy([pol({ conviction: 0.9 }), pol({ conviction: 0.8 }), pol({ conviction: 0.1 })], 2);
    assert.equal(e?.conviction, 0.8);
  });

  test("conviction takes the minimum", () => {
    assert.equal(effectivePolicy([pol({ conviction: 0.9 }), pol({ conviction: 0.5 })], 2)?.conviction, 0.5);
  });

  test("bias: same sign takes the smaller magnitude; opposite signs collapse to 0", () => {
    assert.equal(effectivePolicy([pol({ bias: 0.8 }), pol({ bias: 0.3 })], 2)?.bias, 0.3);
    assert.equal(effectivePolicy([pol({ bias: -0.8 }), pol({ bias: -0.3 })], 2)?.bias, -0.3);
    assert.equal(effectivePolicy([pol({ bias: 0.8 }), pol({ bias: -0.3 })], 2)?.bias, 0);
  });

  test("allowed_directions is the intersection", () => {
    const e = effectivePolicy([pol({ allowed_directions: ["long", "short"] }), pol({ allowed_directions: ["long"] })], 2);
    assert.deepEqual(e?.allowed_directions, ["long"]);
    const none = effectivePolicy([pol({ allowed_directions: ["long"] }), pol({ allowed_directions: ["short"] })], 2);
    assert.deepEqual(none?.allowed_directions, []);
  });

  test("valid_until is the earliest", () => {
    const e = effectivePolicy([pol({ valid_until: iso(NOW + 60 * MIN) }), pol({ valid_until: iso(NOW + 30 * MIN) })], 2);
    assert.equal(e?.valid_until, iso(NOW + 30 * MIN));
  });

  test("scenario: kept (from the newest policy) only if all n policies have one with the same direction", () => {
    const newestScenario = { ...longScenario, targets: ["res3"] } as Policy["scenario"];
    const same = effectivePolicy([pol({ scenario: newestScenario }), pol()], 2);
    assert.deepEqual(same?.scenario, newestScenario);

    assert.equal(effectivePolicy([pol(), pol({ scenario: shortScenario as Policy["scenario"] })], 2)?.scenario, null);
    assert.equal(effectivePolicy([pol({ scenario: null }), pol()], 2)?.scenario, null);
    assert.equal(effectivePolicy([pol(), pol({ scenario: null })], 2)?.scenario, null);
  });

  test("the other fields (menu_id, symbol, rationale, sources) come from the newest policy", () => {
    const e = effectivePolicy([pol({ menu_id: "m2", rationale: "new" }), pol({ menu_id: "m1", rationale: "old" })], 2);
    assert.equal(e?.menu_id, "m2");
    assert.equal(e?.rationale, "new");
  });

  test("inputs are not mutated", () => {
    const history = [pol({ risk_budget_pct: 0.4 }), pol({ risk_budget_pct: 0.1 })];
    const snapshot = structuredClone(history);
    effectivePolicy(history, 2);
    assert.deepEqual(history, snapshot);
  });

  test("property: the effective value is never looser than the most conservative of the last n", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rnd() * 3);
      const history = Array.from({ length: n + Math.floor(rnd() * 3) }, () =>
        pol({ risk_budget_pct: 0.05 + rnd() * 0.45, conviction: rnd(), bias: rnd() * 2 - 1 }),
      );
      const e = effectivePolicy(history, n);
      assert.ok(e, "enough history must give a policy");
      const window = history.slice(0, n);
      assert.ok(e.risk_budget_pct <= Math.min(...window.map((p) => p.risk_budget_pct)) + 1e-12);
      assert.ok(e.conviction <= Math.min(...window.map((p) => p.conviction)) + 1e-12);
      assert.ok(Math.abs(e.bias) <= Math.min(...window.map((p) => Math.abs(p.bias))) + 1e-12);
    }
  });
});
