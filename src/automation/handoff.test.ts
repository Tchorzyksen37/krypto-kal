// handoff.test.ts – the best clean bet becomes a dry-run bot policy; anything doubtful stores nothing.
// Run: node --test src/automation/handoff.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { BotStore } from "../bot/bot-store.ts";
import { loadConfig } from "../bot/config.ts";
import { effectivePolicy } from "../bot/policy.ts";
import { T0, config as baseConfig } from "../bot/sim-fixtures.ts";
import { MIN, iso } from "../bot/trader-fixtures.ts";
import type { Bet, ReportMeta } from "../speculation/types.ts";
import { handoff } from "./handoff.ts";

const config = { ...baseConfig, max_policy_ttl_min: 120 };

const bet = (over: Partial<Bet> = {}): Bet => ({
  id: "20261003-1220Z-BTC-1", symbol: "BTC", futures: "PF_XBTUSD", side: "long",
  entry: 99250, stop_loss: 97750, take_profit: 102500, ttl_minutes: 90, probability: 0.55, rationale: "squeeze",
  rr: 2.17, ev_r: 0.6, break_even: 0.33,
  fill_from: iso(T0 + 20 * MIN), entry_deadline: iso(T0 + 60 * MIN), latest_close: iso(T0 + 150 * MIN), ...over,
});
const meta = (validated: Bet[] | undefined): ReportMeta => ({
  generated: iso(T0), window: [iso(T0 + 20 * MIN), iso(T0 + 260 * MIN)],
  symbols: [{ symbol: "BTC", futures: "PF_XBTUSD", last: 99300, atr_1h: 800 }, { symbol: "XRP", futures: "PF_XRPUSD", last: 2.4, atr_1h: 0.03 }],
  bets: [], ...(validated ? { validated } : {}),
});

describe("handoff", () => {
  test("a store error is a failed result, not a throw", () => {
    const store = new BotStore(":memory:");
    store.putPolicy = () => { throw new Error("database is locked"); };
    const r = handoff(store, config, meta([bet()]), T0, "s");
    assert.equal(r.status, "failed");
    assert.match(r.detail, /bot store error: database is locked/);
  });

  test("a failure on a later copy leaves nothing stored", () => {
    const cfg = { ...config, loosen_confirm_cycles: 2 };
    const store = new BotStore(":memory:");
    const put = store.putPolicy.bind(store);
    let n = 0;
    store.putPolicy = (p, t) => { if (++n === 2) throw new Error("disk full"); return put(p, t); };
    const r = handoff(store, cfg, meta([bet()]), T0, "s");
    assert.equal(r.status, "failed");
    assert.equal(store.latestPolicies(10).length, 0);
  });

  test("handoff passes the ratio through", () => {
    const store = new BotStore(":memory:");
    const r = handoff(store, config, meta([bet({ probability: 0.6 })]), T0, "r.meta.json", 0.5);
    assert.equal(r.status, "handed_off");
    assert.ok(Math.abs(store.latestPolicies(1)[0]!.policy.conviction - 0.3) < 1e-9);
  });

  test("a clean BTC bet is handed off", () => {
    const store = new BotStore(":memory:");
    const r = handoff(store, config, meta([bet()]), T0, "r.meta.json");
    assert.equal(r.status, "handed_off");
    if (r.status === "handed_off") assert.equal(r.betId, "20261003-1220Z-BTC-1");
    assert.equal(store.latestPolicies(2).length, 2);
  });

  test("one call stores exactly loosen_confirm_cycles policies", () => {
    const store = new BotStore(":memory:");
    handoff(store, config, meta([bet()]), T0, "r.meta.json");
    assert.equal(store.latestPolicies(100).length, config.loosen_confirm_cycles);
  });

  test("a bet on another contract is no_bet and nothing is stored", () => {
    const store = new BotStore(":memory:");
    const r = handoff(store, config, meta([bet({ symbol: "XRP", futures: "PF_XRPUSD", entry: 2.39, stop_loss: 2.3, take_profit: 2.6 })]), T0, "s");
    assert.equal(r.status, "no_bet");
    assert.match(r.detail, /PF_XBTUSD/);
    assert.equal(store.latestPolicies(10).length, 0);
  });

  test("a bet with a warning is never stored", () => {
    const store = new BotStore(":memory:");
    const r = handoff(store, config, meta([bet({ stop_loss: 98700 })]), T0, "s");
    assert.equal(r.status, "no_bet");
    assert.match(r.detail, /sl_min_atr_multiple/);
    assert.equal(store.latestPolicies(10).length, 0);
  });

  test("a report the checker has not validated fails", () => {
    const r = handoff(new BotStore(":memory:"), config, meta(undefined), T0, "s");
    assert.equal(r.status, "failed");
    assert.match(r.detail, /check/);
  });

  // A tick that crashes after the handoff but before the ledger write hands the same bet off again.
  for (const laterMin of [0, 5]) {
    test(`a repeated handoff of the same bet (${laterMin} min later) leaves the effective policy unchanged`, () => {
      const store = new BotStore(":memory:");
      const n = config.loosen_confirm_cycles;
      const effective = () => effectivePolicy(store.latestPolicies(n).map((p) => p.policy), n);
      const first = handoff(store, config, meta([bet()]), T0, "r.meta.json");
      assert.equal(first.status, "handed_off");
      const before = effective();
      assert.ok(before);
      const second = handoff(store, config, meta([bet()]), T0 + laterMin * MIN, "r.meta.json");
      assert.equal(second.status, "handed_off", second.detail);
      assert.doesNotMatch(second.detail, /already exists/);
      assert.equal(store.latestPolicies(100).length, 2 * n);
      assert.deepEqual(effective(), before);
    });
  }

  test("no validated bets is no_bet", () => {
    assert.equal(handoff(new BotStore(":memory:"), config, meta([]), T0, "s").status, "no_bet");
  });
});

test("config/bot.auto.json only raises max_policy_ttl_min", () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-cfg-"));
  try {
    writeFileSync(join(dir, "empty.json"), "{}");
    const defaults = loadConfig(join(dir, "empty.json")).config;
    const auto = loadConfig(join(dirname(fileURLToPath(import.meta.url)), "../../config/bot.auto.json")).config;
    assert.equal(auto.max_policy_ttl_min, 120);
    assert.deepEqual({ ...auto, max_policy_ttl_min: 0 }, { ...defaults, max_policy_ttl_min: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
