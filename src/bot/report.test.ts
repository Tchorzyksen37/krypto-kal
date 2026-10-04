// report.test.ts – the report built from a simulated trade, and the CLI's policy and halt commands.
// Run: node --test src/bot/report.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BotStore } from "./bot-store.ts";
import { ackHalt, addPolicy, policyTemplate, type PolicyFixture } from "./cli.ts";
import { defaultEngineRecord, loadEngineRecord, saveEngineRecord } from "./engine-state.ts";
import type { FuturesFill } from "./executor.ts";
import { buildReport, rebuildTrades, renderReport, tercileOf } from "./report.ts";
import { T0, config } from "./sim-fixtures.ts";
import { FakeMarket, MENU, MIN, longPolicy, openPosition, world } from "./trader-fixtures.ts";
import { FakeClock } from "./clock.ts";

describe("buildReport", () => {
  test("a stopped-out trade: net PnL with fees, R against the planned risk, and its conviction bucket", async () => {
    const w = world();
    await openPosition(w);
    w.tick(97999); // the stop fires
    await w.cycle();
    const r = buildReport(w.store, 0, config, w.clock.now());

    assert.equal(r.trades.length, 1);
    const t = r.trades[0]!;
    assert.equal(t.direction, "long");
    assert.equal(t.size, 0.004);
    assert.equal(t.entryAvg, 99245);
    assert.deepEqual(t.exits, ["sl"]);
    assert.ok(t.net < t.gross, "fees are deducted");
    assert.equal(t.riskUsd, Math.round(Math.abs(99245 - 98000) * 0.004 * 100) / 100);
    assert.ok(t.r! < -0.9 && t.r! > -1.2, `R ${t.r}`);
    assert.equal(t.conviction, 1);
    assert.deepEqual(r.calibration.find((c) => c.tercile === "high"), { tercile: "high", n: 1, avgR: t.r });
    assert.equal(r.calibration.find((c) => c.tercile === "low")!.n, 0);

    assert.equal(r.netPnl, Math.round((r.realized - r.fees - r.funding) * 100) / 100);
    assert.ok(r.fees > 0);
    assert.equal(r.policyAccuracy.tradesClosed, 1);
    assert.equal(r.policyAccuracy.wins, 0);
  });

  test("entries not taken are counted by reason from the journal", async () => {
    const w = world();
    w.tick(99250);
    await w.cycle(); // awaiting_confirmation
    w.tick(105000);
    w.clock.advance(61_000);
    await w.cycle(); // price outside the zone
    const r = buildReport(w.store, 0, config, w.clock.now());
    assert.equal(r.rejectedByReason.awaiting_confirmation, 1);
    assert.equal(Object.values(r.rejectedByReason).reduce((a, b) => a + b, 0), 2);
  });

  test("funding in the window is the account's funding since the last mark before it", () => {
    const store = new BotStore(":memory:");
    store.putDoc("sim_account", "acct", T0, { realizedPnl: 0, fees: 0, funding: 3 });
    store.putDoc("funding_mark", "a", T0 - 2 * 3_600_000, { t: T0 - 2 * 3_600_000, funding: 1 });
    store.putDoc("funding_mark", "b", T0 + 3_600_000, { t: T0 + 3_600_000, funding: 2.5 });
    assert.equal(buildReport(store, T0, config, T0 + 7_200_000).funding, 2);
    assert.equal(buildReport(store, 0, config, T0 + 7_200_000).funding, 3);
  });

  test("incidents are counted by kind and the report renders them", () => {
    const store = new BotStore(":memory:");
    store.addIncident({ tMs: T0, kind: "no_sl", detail: "long 0.004 without a stop" });
    store.addIncident({ tMs: T0 + 1, kind: "no_sl", detail: "again" });
    const r = buildReport(store, 0, config, T0 + 10);
    assert.deepEqual(r.incidentsByKind, { no_sl: 2 });
    const md = renderReport(r);
    assert.match(md, /No real orders/);
    assert.match(md, /2 incident\(s\): no_sl x2/);
    assert.match(md, /No closed trades in this window/);
  });

  test("rebuildTrades: partial exits, an exit without its entry is ignored, an open trade is not closed", () => {
    const f = (id: string, side: "buy" | "sell", size: number, price: number, min: number, pnl = 0, type = "taker"): FuturesFill => ({
      fill_id: `${id}-${min}`, order_id: "o", cliOrdId: id, symbol: "PF_XBTUSD", side, size, price,
      fillTime: new Date(T0 + min * MIN).toISOString(), fillType: type, realized_pnl: pnl,
    });
    const trades = rebuildTrades([
      f("bot-9-sl-0", "sell", 1, 100, 0, -1), // orphan exit
      f("bot-3-entry-0", "buy", 0.004, 100, 1, 0, "maker"),
      f("bot-3-tp1-0", "sell", 0.002, 110, 2, 0.02, "maker"),
      f("bot-3-sl-1", "sell", 0.002, 105, 3, 0.01),
      f("bot-4-entry-0", "sell", 0.01, 100, 4), // still open
    ], config);
    assert.equal(trades.length, 1);
    assert.deepEqual([trades[0]!.policyId, trades[0]!.exits, trades[0]!.exitAvg], [3, ["tp1", "sl"], 107.5]);
    assert.ok(Math.abs(trades[0]!.gross - 0.03) < 1e-12);
  });

  test("conviction terciles", () => {
    assert.deepEqual([tercileOf(0), tercileOf(0.34), tercileOf(0.67), tercileOf(1)], ["low", "mid", "high", "high"]);
  });
});

describe("policy add", () => {
  const fixture = (over: Partial<PolicyFixture["policy"]> = {}): PolicyFixture => {
    const { valid_until: _v, ...policy } = longPolicy();
    const { createdAtMs: _c, ...menu } = { ...MENU, id: "fx1" };
    return { menu, policy: { ...policy, menu_id: "fx1", ...over } };
  };

  test("stores a valid fixture with its menu (created now) and says how many more are needed", () => {
    const store = new BotStore(":memory:");
    const r = addPolicy(store, config, fixture(), T0);
    assert.ok(r.ok);
    assert.equal(store.getMenu("fx1")!.createdAtMs, T0);
    assert.match(r.note, /add it 1 more time/);
    const again = addPolicy(store, config, fixture(), T0 + MIN);
    assert.ok(again.ok);
    assert.match(again.note, /effective policy now includes it/);
    assert.equal(Date.parse(store.getPolicy(again.id)!.policy.valid_until), T0 + MIN + config.max_policy_ttl_min * MIN);
  });

  test("rejects an invalid fixture and stores nothing", () => {
    const store = new BotStore(":memory:");
    const r = addPolicy(store, config, fixture({ risk_budget_pct: 5 }), T0);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /risk_budget_pct 5 exceeds/);
    assert.equal(store.latestPolicies(10).length, 0);
    assert.equal(store.getMenu("fx1"), undefined);
    assert.equal(addPolicy(store, config, {} as PolicyFixture, T0).ok, false);
  });

  test("a menu id that exists with other levels is refused", () => {
    const store = new BotStore(":memory:");
    assert.ok(addPolicy(store, config, fixture(), T0).ok);
    const changed = fixture();
    changed.menu!.levels = changed.menu!.levels.map((l) => ({ ...l, price: l.price + 1 }));
    assert.match((addPolicy(store, config, changed, T0) as { reason: string }).reason, /already exists with different levels/);
  });

  test("the template built from the market is a fixture the validator accepts", async () => {
    const clock = new FakeClock(T0);
    const market = new FakeMarket(clock);
    market.last = 100000;
    for (const dir of ["long", "short"] as const) {
      const fx = await policyTemplate(market, config, dir, T0);
      const store = new BotStore(":memory:");
      const r = addPolicy(store, config, fx, T0);
      assert.ok(r.ok, r.ok ? "" : r.reason);
      const levels = Object.fromEntries(fx.menu!.levels.map((l) => [l.id, l.price]));
      if (dir === "long") assert.ok(levels.stop! < levels.zone_a! && levels.t1! > levels.zone_b!);
      else assert.ok(levels.stop! > levels.zone_b! && levels.t1! < levels.zone_a!);
    }
  });
});

describe("ack-halt", () => {
  test("clears a halt that needs acknowledgement, blocks entries until reconciled, and records it", () => {
    const store = new BotStore(":memory:");
    saveEngineRecord(store, { ...defaultEngineRecord(), state: "HALTED", reconciled: true, halt: { reason: "position_on_wrong_side", manualAck: true, untilMs: null } });
    const r = ackHalt(store, T0);
    assert.deepEqual(r, { ok: true, cleared: "position_on_wrong_side" });
    const rec = loadEngineRecord(store);
    assert.deepEqual([rec.state, rec.halt, rec.reconciled, rec.liqAckMs], ["FLAT", null, false, T0]);
    assert.equal(store.listIncidents(0)[0]!.kind, "halt_acknowledged");
  });

  test("never clears the daily-loss halt by hand", () => {
    const store = new BotStore(":memory:");
    saveEngineRecord(store, { ...defaultEngineRecord(), state: "HALTED", halt: { reason: "daily_loss_limit", manualAck: false, untilMs: T0 + 3_600_000 } });
    const r = ackHalt(store, T0);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /clears itself/);
    assert.equal(loadEngineRecord(store).state, "HALTED");
  });

  test("says so when the bot is not halted", () => {
    const store = new BotStore(":memory:");
    assert.match((ackHalt(store, T0) as { reason: string }).reason, /not halted/);
  });
});
