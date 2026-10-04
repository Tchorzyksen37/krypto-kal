// bot-store.test.ts – offline tests of the bot's SQLite store: menus, policies, state, counters, journal, incidents.
// Run: node --test bot/bot-store.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BotStore, expandHome } from "./bot-store.ts";
import type { LevelMenu, Policy } from "./policy.ts";

const menu = (id = "m1"): LevelMenu => ({
  id, symbol: "PF_XBTUSD", createdAtMs: 1_000, levels: [{ id: "sup1", price: 98000, kind: "swing_low" }],
});

const policy = (over: Partial<Policy> = {}): Policy => ({
  schema_version: 1, menu_id: "m1", symbol: "PF_XBTUSD", bias: 0.5, conviction: 0.5, risk_budget_pct: 0.3,
  allowed_directions: ["long"], scenario: null, valid_until: "2026-10-03T13:00:00.000Z", rationale: "r", sources: [],
  ...over,
});

const store = () => new BotStore(":memory:");

describe("expandHome", () => {
  test("expands a leading ~ and leaves everything else alone", () => {
    assert.equal(expandHome("~"), homedir());
    assert.equal(expandHome("~/.krypto-kal/bot.db"), join(homedir(), ".krypto-kal", "bot.db"));
    assert.equal(expandHome(":memory:"), ":memory:");
    assert.equal(expandHome("/data/bot.db"), "/data/bot.db");
    assert.equal(expandHome("a~b/c.db"), "a~b/c.db");
  });
});

describe("menus", () => {
  test("round-trip, and an unknown id is undefined", () => {
    const s = store();
    s.putMenu(menu());
    assert.deepEqual(s.getMenu("m1"), menu());
    assert.equal(s.getMenu("nope"), undefined);
  });

  test("a duplicate id throws: a published menu is never silently replaced", () => {
    const s = store();
    s.putMenu(menu());
    assert.throws(() => s.putMenu({ ...menu(), levels: [] }));
    assert.deepEqual(s.getMenu("m1"), menu());
  });
});

describe("policies", () => {
  test("putPolicy assigns increasing ids; getPolicy returns the stored policy", () => {
    const s = store();
    const a = s.putPolicy(policy(), 1_000);
    const b = s.putPolicy(policy({ bias: -0.2 }), 2_000);
    assert.ok(b > a);
    assert.deepEqual(s.getPolicy(b), { id: b, createdAtMs: 2_000, policy: policy({ bias: -0.2 }) });
    assert.equal(s.getPolicy(9999), undefined);
  });

  test("latestPolicies is newest first by createdAtMs, not by insertion order, and honours n", () => {
    const s = store();
    const late = s.putPolicy(policy({ bias: 0.3 }), 3_000);
    const early = s.putPolicy(policy({ bias: 0.1 }), 1_000); // inserted after, but older
    const mid = s.putPolicy(policy({ bias: 0.2 }), 2_000);
    assert.deepEqual(s.latestPolicies(3).map((p) => p.id), [late, mid, early]);
    assert.deepEqual(s.latestPolicies(2).map((p) => p.id), [late, mid]);
    assert.deepEqual(s.latestPolicies(0), []);
  });

  test("equal createdAtMs falls back to the higher id first", () => {
    const s = store();
    const a = s.putPolicy(policy(), 1_000);
    const b = s.putPolicy(policy(), 1_000);
    assert.deepEqual(s.latestPolicies(2).map((p) => p.id), [b, a]);
  });
});

describe("kv", () => {
  test("get is undefined until set; set overwrites", () => {
    const s = store();
    assert.equal(s.getKv("state"), undefined);
    s.setKv("state", "FLAT");
    s.setKv("state", "OPEN");
    assert.equal(s.getKv("state"), "OPEN");
  });
});

describe("docs", () => {
  test("put/get round-trip; the same key replaces; an unknown key is undefined", () => {
    const s = store();
    s.putDoc("order", "a", 1_000, { n: 1 });
    s.putDoc("order", "a", 2_000, { n: 2 });
    assert.deepEqual(s.getDoc("order", "a"), { n: 2 });
    assert.equal(s.getDoc("order", "zzz"), undefined);
    assert.equal(s.getDoc("fill", "a"), undefined); // kinds are separate namespaces
  });

  test("listDocs returns one kind, oldest first, from a time on", () => {
    const s = store();
    s.putDoc("fill", "f2", 2_000, { id: 2 });
    s.putDoc("fill", "f1", 1_000, { id: 1 });
    s.putDoc("order", "o1", 1_500, { id: "o" });
    assert.deepEqual(s.listDocs("fill"), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(s.listDocs("fill", 1_500), [{ id: 2 }]);
  });

  test("deleteDoc removes one document and is a no-op for an unknown key", () => {
    const s = store();
    s.putDoc("order", "a", 1_000, { n: 1 });
    s.deleteDoc("order", "a");
    s.deleteDoc("order", "never-existed");
    assert.equal(s.getDoc("order", "a"), undefined);
  });
});

describe("counters", () => {
  test("default 0, accumulate, and are separate per day and name", () => {
    const s = store();
    assert.equal(s.getCounter("2026-10-03", "entries"), 0);
    s.addCounter("2026-10-03", "entries", 1);
    s.addCounter("2026-10-03", "entries", 2);
    s.addCounter("2026-10-03", "orders", 5);
    s.addCounter("2026-10-04", "entries", 1);
    assert.equal(s.getCounter("2026-10-03", "entries"), 3);
    assert.equal(s.getCounter("2026-10-03", "orders"), 5);
    assert.equal(s.getCounter("2026-10-04", "entries"), 1);
  });
});

describe("raiseCounter", () => {
  test("raises a counter to at least the value and never lowers it", () => {
    const s = store();
    s.addCounter("d", "n", 3);
    s.raiseCounter("d", "n", 2);
    assert.equal(s.getCounter("d", "n"), 3);
    s.raiseCounter("d", "n", 5);
    assert.equal(s.getCounter("d", "n"), 5);
    s.raiseCounter("d", "fresh", 4); // creates it when missing
    assert.equal(s.getCounter("d", "fresh"), 4);
  });
});

describe("journal", () => {
  const entry = (over = {}) => ({
    tMs: 5_000, configHash: "abc123", kind: "cycle", snapshot: { state: "FLAT", price: { mark: 99000 } },
    decision: "skip", reason: "no_policy", ...over,
  });

  test("keeps the config hash, the snapshot and the optional policy id", () => {
    const s = store();
    const id = s.putPolicy(policy(), 1_000);
    s.appendJournal(entry({ policyId: id }));
    s.appendJournal(entry({ tMs: 6_000 }));
    const rows = s.listJournal(0);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], entry({ policyId: id }));
    assert.equal(rows[0]?.configHash, "abc123");
    assert.equal(rows[1]?.policyId, undefined);
  });

  test("listJournal filters by time and kind, oldest first", () => {
    const s = store();
    s.appendJournal(entry({ tMs: 1_000, kind: "cycle" }));
    s.appendJournal(entry({ tMs: 2_000, kind: "reject" }));
    s.appendJournal(entry({ tMs: 3_000, kind: "cycle" }));
    assert.deepEqual(s.listJournal(2_000).map((e) => e.tMs), [2_000, 3_000]);
    assert.deepEqual(s.listJournal(0, "cycle").map((e) => e.tMs), [1_000, 3_000]);
  });

  test("appendJournal throws when the write fails (a closed database)", () => {
    const s = store();
    s.close();
    assert.throws(() => s.appendJournal(entry()));
  });
});

describe("incidents", () => {
  test("are listed from a time on, oldest first", () => {
    const s = store();
    s.addIncident({ tMs: 1_000, kind: "no_sl", detail: "long 0.004 without a stop" });
    s.addIncident({ tMs: 3_000, kind: "cannot_verify", detail: "exchange unreachable" });
    assert.deepEqual(s.listIncidents(2_000), [{ tMs: 3_000, kind: "cannot_verify", detail: "exchange unreachable" }]);
    assert.equal(s.listIncidents(0).length, 2);
  });
});

describe("transaction", () => {
  test("returns the callback's value and commits", () => {
    const s = store();
    const out = s.transaction(() => {
      s.addCounter("d", "n", 1);
      return 42;
    });
    assert.equal(out, 42);
    assert.equal(s.getCounter("d", "n"), 1);
  });

  test("rolls back everything when the callback throws", () => {
    const s = store();
    assert.throws(() => s.transaction(() => {
      s.addCounter("d", "n", 1);
      s.setKv("k", "v");
      throw new Error("boom");
    }), /boom/);
    assert.equal(s.getCounter("d", "n"), 0);
    assert.equal(s.getKv("k"), undefined);
  });

  test("is reentrant: only the outermost call commits, and an outer failure undoes the inner work", () => {
    const s = store();
    assert.throws(() => s.transaction(() => {
      s.transaction(() => s.addCounter("d", "n", 1));
      assert.equal(s.getCounter("d", "n"), 1); // visible inside
      throw new Error("outer fails");
    }), /outer fails/);
    assert.equal(s.getCounter("d", "n"), 0);

    s.transaction(() => s.transaction(() => s.addCounter("d", "n", 2)));
    assert.equal(s.getCounter("d", "n"), 2);
  });

  test("the store is usable after a rolled-back transaction", () => {
    const s = store();
    assert.throws(() => s.transaction(() => { throw new Error("x"); }));
    s.addCounter("d", "n", 1);
    assert.equal(s.getCounter("d", "n"), 1);
  });
});

describe("persistence", () => {
  test("data survives closing and reopening a file database (and parent directories are created)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bot-store-")), "nested", "bot.db");
    const first = new BotStore(path);
    first.putMenu(menu());
    const id = first.putPolicy(policy(), 1_000);
    first.setKv("state", "COOLDOWN");
    first.addCounter("2026-10-03", "entries", 2);
    first.close();

    const second = new BotStore(path);
    assert.deepEqual(second.getMenu("m1"), menu());
    assert.equal(second.getPolicy(id)?.policy.menu_id, "m1");
    assert.equal(second.getKv("state"), "COOLDOWN");
    assert.equal(second.getCounter("2026-10-03", "entries"), 2);
    second.close();
  });

  test("policy ids keep increasing after a reopen (an id is never reused)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bot-store-")), "bot.db");
    const first = new BotStore(path);
    const a = first.putPolicy(policy(), 1_000);
    first.close();
    const second = new BotStore(path);
    assert.ok(second.putPolicy(policy(), 2_000) > a);
    second.close();
  });
});
