// trader.test.ts – offline scenario tests of the trader cycle against the real DryRunExecutor and the real store.
// Run: node --test bot/trader.test.ts
//
// The world (a long policy, ATR 800, capital 1000, ids bot-2-<role>-<seq>) comes from trader-fixtures.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FailingJournalStore, MIN, SL, TP1, TP2, E, arm, iso, openPosition, reasons, world, contract } from "./trader-fixtures.ts";
import { defaultEngineRecord, saveEngineRecord } from "./engine-state.ts";
import { T0, config } from "./sim-fixtures.ts";
import { JOURNAL_HEARTBEAT_MS, buildSnapshot } from "./trader.ts";

describe("buildSnapshot", () => {
  test("reads the exchange, the market, the stored policy and the counters", async () => {
    const w = world();
    w.tick(99250);
    const s = await buildSnapshot(w.deps);
    assert.equal(s.state, "FLAT");
    assert.equal(s.position, null);
    assert.deepEqual(s.openOrders, []);
    assert.equal(s.price?.last, 99250);
    assert.equal(s.priceAgeSec, 0);
    assert.equal(s.atr, 800);
    assert.equal(s.policy?.id, 2); // the newest of the two stored policies
    assert.deepEqual(s.policy?.scenario, { direction: "long", entryLow: 99000, entryHigh: 99500, targets: [102000, 104000], stop: 98000, horizonHours: 24 });
    assert.deepEqual(s.contract, contract);
    assert.ok(Math.abs(s.fundingBpsPerHour - 1) < 1e-9);
    assert.deepEqual(s.counters, { entriesToday: 0, ordersToday: 0 });
    assert.equal(s.reconciled, true);
    assert.equal(s.inZoneSinceMs, w.clock.now());
    assert.equal(s.foreignExposure, false);
    assert.equal(s.dailyLossBreached, false);
    assert.equal(s.liquidated, false);
    assert.equal(s.lastTradePnl, null);
  });

  test("fewer stored policies than the confirmation count means no effective policy", async () => {
    const w = world({ policies: 1 });
    w.tick(99250);
    assert.equal((await buildSnapshot(w.deps)).policy, null);
    assert.deepEqual(reasons(await w.cycle()), ["no_policy"]);
  });

  test("a stale or missing quote is passed on as such (reduce-only mode), not as an error", async () => {
    const w = world();
    w.tick(99250);
    w.market.ageMs = (config.stale_data_max_age_sec + 5) * 1000;
    assert.deepEqual(reasons(await w.cycle()), ["stale_data"]);
    w.market.ageMs = 0;
    w.market.failTicker = true;
    assert.deepEqual(reasons(await w.cycle()), ["no_price"]);
  });

  test("a price outside the zone, or stale, does not count as time in the zone", async () => {
    const w = world();
    w.tick(99600);
    assert.equal((await buildSnapshot(w.deps)).inZoneSinceMs, null);
    w.tick(99250);
    w.market.ageMs = 500_000;
    assert.equal((await buildSnapshot(w.deps)).inZoneSinceMs, null);
  });

  test("a failed contract read falls back to the last good one; with none cached it cannot build", async () => {
    const w = world();
    w.tick(99250);
    await buildSnapshot(w.deps);
    w.market.failContract = true;
    assert.deepEqual((await buildSnapshot(w.deps)).contract, contract);

    const cold = world();
    cold.market.failContract = true;
    cold.tick(99250);
    await assert.rejects(buildSnapshot(cold.deps), /contract specification is unavailable/);
  });

  test("an order that is not the bot's is foreign exposure and blocks entries", async () => {
    const w = world();
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 90000, reduceOnly: false, cliOrdId: "my-manual-order" });
    assert.equal((await buildSnapshot(w.deps)).foreignExposure, true);
    assert.deepEqual(reasons(await w.cycle()), ["foreign_exposure"]);
    assert.deepEqual(await w.ids(), ["my-manual-order"]); // never touched
  });
});

describe("entry", () => {
  test("after the confirmation the entry is placed, the state is saved first, and the order counters move", async () => {
    const w = world();
    const a = await arm(w);
    assert.deepEqual(reasons(a), ["entry", "entry_placed"]);
    const rec = w.rec();
    assert.equal(rec.state, "ENTERING");
    assert.equal(rec.trade?.policyId, 2);
    assert.equal(rec.trade?.entryCliOrdId, E);
    assert.equal(rec.tradeStartedMs, w.clock.now());
    assert.deepEqual(await w.ids(), [E]);
    const o = await w.order(E);
    assert.deepEqual([o?.side, o?.limitPrice, o?.unfilledSize], ["buy", 99245, 0.004]);
    assert.equal(w.store.getCounter("2026-10-03", "entries"), 1);
    assert.equal(w.store.getCounter("2026-10-03", "orders"), 1);
  });

  test("the new state is saved BEFORE the entry order reaches the exchange (a crash in between must not leave a resting entry in FLAT)", async () => {
    const w = world();
    const seen: string[] = [];
    w.wrapped.onPlace = (r) => {
      if (r.cliOrdId === E) seen.push(w.rec().state);
    };
    await arm(w);
    assert.deepEqual(seen, ["ENTERING"]);
  });

  test("protective orders do not wait for a state change: they are placed before the state moves on", async () => {
    const w = world();
    const seen: string[] = [];
    await arm(w);
    w.tick(99244);
    w.wrapped.onPlace = (r) => {
      if (r.cliOrdId === SL) seen.push(w.rec().state);
    };
    await w.cycle();
    assert.deepEqual(seen, ["ENTERING"]); // the state changes to PROTECTING only after the orders were sent
    assert.equal(w.rec().state, "PROTECTING");
  });

  test("a lost ack on the entry leaves one order and the ENTERING state; the next cycle just waits", async () => {
    const w = world();
    w.tick(99250);
    await w.cycle();
    w.clock.advance(31_000);
    w.tick(99250);
    w.ex.inject({ dropAck: 1 });
    await w.cycle(); // the order took effect, the ack was lost
    assert.equal(w.rec().state, "ENTERING");
    assert.deepEqual(await w.ids(), [E]);
    assert.deepEqual(reasons(await w.cycle()), ["entry_resting"]);
    assert.deepEqual(await w.ids(), [E]); // no duplicate
    assert.equal(w.store.getCounter("2026-10-03", "entries"), 1);
    assert.ok(w.store.listIncidents(0).some((i) => i.kind === "order_ack_lost"));
  });

  test("an entry that is not filled in time is withdrawn and the bot returns to FLAT", async () => {
    const w = world();
    await arm(w);
    w.clock.advance((config.entry_timeout_sec + 1) * 1000);
    w.tick(99250);
    await w.cycle();
    assert.equal(w.rec().state, "FLAT");
    assert.equal(w.rec().trade, null);
    assert.deepEqual(await w.ids(), []);
  });
});

describe("protection", () => {
  test("a filled entry is protected at once, and OPEN is reached only after the exchange shows both orders", async () => {
    const w = world();
    await arm(w);
    w.tick(99244);
    await w.cycle();
    assert.equal(w.rec().state, "PROTECTING");
    assert.deepEqual(await w.ids(), [SL, TP1, TP2]);
    assert.equal(w.store.getCounter("2026-10-03", "orders"), 4); // entry + stop + two targets
    const sl = await w.order(SL);
    assert.deepEqual([sl?.orderType, sl?.stopPrice, sl?.unfilledSize, sl?.reduceOnly], ["stp", 98000, 0.004, true]);
    assert.equal((await w.order(TP1))?.unfilledSize, 0.002);
    await w.cycle();
    assert.equal(w.rec().state, "OPEN");
  });

  test("an ack is not a confirmation: a target that was acknowledged but never placed keeps the bot out of OPEN, then closes it", async () => {
    const w = world();
    w.wrapped.lie = (r) => r.cliOrdId.includes("-tp");
    await arm(w);
    w.tick(99244);
    await w.cycle();
    await w.cycle();
    assert.equal(w.rec().state, "PROTECTING");
    w.clock.advance((config.protect_timeout_sec + 1) * 1000);
    w.tick(99244);
    await w.cycle(); // timeout: close at market
    assert.deepEqual(await w.ex.getPositions(), []);
    assert.equal(w.rec().state, "REDUCING");
    await w.cycle(); // the stop is a leftover
    await w.cycle();
    assert.equal(w.rec().state, "COOLDOWN");
    assert.deepEqual(await w.ids(), []);
  });

  test("a stop that is refused for good: the position is closed within the timeout", async () => {
    const w = world();
    w.wrapped.refuse = (r) => r.cliOrdId.includes("-sl-");
    await arm(w);
    w.tick(99244);
    await w.cycle();
    await w.cycle();
    assert.equal(w.rec().state, "PROTECTING");
    assert.equal((await w.ex.getPositions()).length, 1); // still open, within the timeout
    w.clock.advance((config.protect_timeout_sec + 1) * 1000);
    w.tick(99244);
    await w.cycle();
    assert.deepEqual(await w.ex.getPositions(), []);
    assert.ok(w.store.listIncidents(0).some((i) => i.kind === "order_rejected:unknown"));
    assert.ok(w.store.listJournal(0).some((j) => j.decision.includes("place:bot-2-close-0")));
  });

  test("a lost ack on the stop is retried with the same id: one stop, not two", async () => {
    const w = world();
    await arm(w);
    w.tick(99244);
    w.ex.inject({ dropAck: 1 }); // the first protective order takes effect but its ack is lost
    await w.cycle();
    await w.cycle();
    assert.equal(w.rec().state, "OPEN");
    assert.deepEqual(await w.ids(), [SL, TP1, TP2]);
  });

  test("a partial fill: the remainder is cancelled first, then the protection follows the filled size", async () => {
    const w = world();
    await arm(w);
    w.ex.inject({ partialFill: 0.4 });
    w.tick(99244); // fills 0.0016 of 0.004
    await w.cycle(); // cancel the remainder, PROTECTING
    assert.equal(w.rec().state, "PROTECTING");
    assert.deepEqual(await w.ids(), []);
    await w.cycle(); // protect what was filled
    const sl = await w.order(SL);
    assert.equal(sl?.unfilledSize, 0.0016);
    const tp = (await w.ex.getOpenOrders()).filter((o) => o.cliOrdId?.includes("-tp"));
    assert.ok(Math.abs(tp.reduce((s, o) => s + (o.unfilledSize ?? 0), 0) - 0.0016) < 1e-12);
    await w.cycle();
    assert.equal(w.rec().state, "OPEN");
  });
});

describe("open position", () => {
  test("a filled target shrinks the stop to the remaining size, then the stop trails and the tightest stop is remembered", async () => {
    const w = world();
    await openPosition(w);
    w.tick(102001); // target 1 fills: 0.002 of 0.004
    await w.cycle();
    assert.equal((await w.order(SL))?.unfilledSize, 0.002);
    await w.cycle(); // 1R in profit: trail to 102001 - 2 x 800
    assert.equal((await w.order(SL))?.stopPrice, 100401);
    assert.equal(w.rec().trade?.lastStop, 100401);
  });

  test("a stop that goes missing is re-protected under a new id, at the last trailed stop and without the filled target", async () => {
    const w = world();
    await openPosition(w);
    w.tick(102001);
    await w.cycle();
    await w.cycle(); // resized, then trailed to 100401
    await w.ex.cancelOrder({ cliOrdId: SL });
    await w.cycle(); // OPEN -> PROTECTING with a new sequence number
    assert.equal(w.rec().state, "PROTECTING");
    assert.equal(w.rec().trade?.protectSeq, 1);
    await w.cycle(); // the new stop
    const sl = await w.order("bot-2-sl-1");
    assert.deepEqual([sl?.stopPrice, sl?.unfilledSize], [100401, 0.002]);
    assert.deepEqual(await w.ids(), ["bot-2-sl-1", TP2]); // target 1 is not placed again
    await w.cycle();
    assert.equal(w.rec().state, "OPEN");
  });

  test("when the stop is hit, leftover targets are cancelled before the cooldown, and a loss means the longer one", async () => {
    const w = world();
    await openPosition(w);
    w.tick(97999); // the stop fires
    assert.deepEqual(await w.ex.getPositions(), []);
    await w.cycle();
    assert.equal(w.rec().state, "REDUCING");
    await w.cycle();
    assert.deepEqual(await w.ids(), []); // the targets are gone, not left to hit a later position
    assert.equal(w.rec().state, "REDUCING");
    await w.cycle();
    const rec = w.rec();
    assert.equal(rec.state, "COOLDOWN");
    assert.equal(rec.trade, null);
    assert.equal(rec.cooldownUntilMs, w.clock.now() + config.cooldown_after_loss_min * MIN);
  });

  test("the time-stop closes the position", async () => {
    const w = world();
    await openPosition(w);
    w.clock.advance(24 * 60 * MIN);
    w.tick(99250);
    await w.cycle();
    assert.deepEqual(await w.ex.getPositions(), []);
    assert.equal(w.rec().state, "REDUCING");
    assert.ok(w.store.listJournal(0).some((j) => j.reason === "time_stop"));
  });
});

describe("journal", () => {
  test("a repeated identical skip is written once, again after the heartbeat, and again when the reason changes", async () => {
    const w = world();
    const rows = () => w.store.listJournal(0, "cycle").length;
    w.tick(99600); // outside the zone
    for (let i = 0; i < 4; i++) {
      await w.cycle();
      w.clock.advance(1000);
    }
    assert.equal(rows(), 1);
    w.clock.advance(JOURNAL_HEARTBEAT_MS);
    w.tick(99600);
    await w.cycle();
    assert.equal(rows(), 2);
    w.tick(99250); // a different reason
    await w.cycle();
    assert.equal(rows(), 3);
  });

  test("a row holds the config hash, the policy id, the decision, the reason and the input snapshot", async () => {
    const w = world();
    w.tick(99600);
    await w.cycle();
    const [row] = w.store.listJournal(0, "cycle");
    assert.equal(row?.configHash, "h1");
    assert.equal(row?.policyId, 2);
    assert.equal(row?.decision, "skip:price_outside_zone");
    assert.equal(row?.reason, "price_outside_zone");
    assert.equal((row?.snapshot as { state: string }).state, "FLAT");
  });

  test("every action is journalled, with the order id in the decision", async () => {
    const w = world();
    await arm(w);
    assert.ok(w.store.listJournal(0).some((j) => j.decision === "place:bot-2-entry-0;transition:ENTERING"));
  });

  test("a failing journal blocks new entries", async () => {
    const w = world({ store: new FailingJournalStore(":memory:") });
    w.tick(99250);
    await w.cycle();
    w.clock.advance(31_000);
    w.tick(99250);
    const a = await w.cycle();
    assert.deepEqual(reasons(a), ["journal_unavailable"]);
    assert.deepEqual(await w.ids(), []);
    assert.equal(w.rec().state, "FLAT");
  });

  test("a failing journal never blocks protection of an open position", async () => {
    const w = world({ store: new FailingJournalStore(":memory:") });
    w.tick(99250);
    // A position that already exists, with its trade record, but no protection yet.
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 0.004, reduceOnly: false, cliOrdId: E });
    saveEngineRecord(w.store, {
      ...w.rec(), state: "PROTECTING", sinceMs: w.clock.now(),
      trade: {
        policyId: 2, direction: "long", entryCliOrdId: E, entryPrice: 99255,
        plan: { size: 0.004, stop: 98000, ladder: [{ price: 102000, size: 0.002 }, { price: 104000, size: 0.002 }], leverage: 2 },
        horizonEndMs: w.clock.now() + 24 * 60 * MIN, protectSeq: 0,
      },
    });
    await w.cycle();
    assert.deepEqual(await w.ids(), [SL, TP1, TP2]);
  });
});

describe("safety", () => {
  test("an unreadable exchange means no decisions: an incident, a skip, and not a single order", async () => {
    const w = world();
    await arm(w);
    w.wrapped.unreadable = true;
    w.tick(99250); // does not reach the entry limit
    const before = await w.ids();
    assert.deepEqual(before, [E]);
    const a = await w.cycle();
    assert.deepEqual(a, [{ type: "skip", reason: "snapshot_unavailable" }]);
    assert.ok(w.store.listIncidents(0).some((i) => i.kind === "cannot_verify"));
    assert.deepEqual(await w.ids(), before);
    assert.equal(w.rec().state, "ENTERING");
  });

  test("a corrupt engine record is also 'cannot verify', not a guess", async () => {
    const w = world();
    w.tick(99250);
    w.store.setKv("engine:record", "{ broken");
    assert.deepEqual(reasons(await w.cycle()), ["snapshot_unavailable"]);
    assert.deepEqual(await w.ids(), []);
  });

  test("a clock that moved backwards yields only a skip and never lowers the remembered time", async () => {
    const w = world();
    await arm(w);
    const seen = w.rec().lastClockMs;
    w.clock.set(w.clock.now() - 5 * MIN);
    assert.deepEqual(reasons(await w.cycle()), ["clock_went_backwards"]);
    assert.equal(w.rec().lastClockMs, seen);
    assert.equal(w.rec().state, "ENTERING");
  });

  test("the daily loss limit halts until the next reset hour, and the halt clears by itself on the new day", async () => {
    const w = world();
    w.tick(99250);
    w.wrapped.extraFills = [{
      fill_id: "x1", order_id: "o", cliOrdId: "bot-1-close-0", symbol: "PF_XBTUSD", side: "sell", size: 0.0001, price: 100000,
      fillTime: iso(w.clock.now()), fillType: "taker", realized_pnl: -20,
    }];
    await w.cycle();
    const rec = w.rec();
    assert.equal(rec.state, "HALTED");
    assert.equal(rec.halt?.manualAck, false);
    assert.equal(rec.halt?.untilMs, Date.parse("2026-10-04T00:00:00Z"));

    w.clock.set(Date.parse("2026-10-04T00:00:01Z"));
    w.tick(99250);
    await w.cycle();
    assert.equal(w.rec().state, "FLAT");
    assert.equal(w.rec().halt, null);
  });

  test("a liquidation fill halts for manual acknowledgement and does not clear with time", async () => {
    const w = world();
    w.tick(99250);
    w.wrapped.extraFills = [{
      fill_id: "x2", order_id: "o", symbol: "PF_XBTUSD", side: "sell", size: 0.004, price: 90000,
      fillTime: iso(w.clock.now()), fillType: "liquidation", realized_pnl: 0,
    }];
    await w.cycle();
    assert.equal(w.rec().state, "HALTED");
    assert.equal(w.rec().halt?.manualAck, true);
    w.clock.advance(3 * 24 * 60 * MIN);
    w.tick(99250);
    await w.cycle();
    assert.equal(w.rec().state, "HALTED");
  });

  test("a cycle never leaves a position unprotected for longer than the timeout, whatever the order of events", async () => {
    // Fill, then a long gap of failing cycles (unreadable exchange), then recovery: the protection still follows.
    const w = world();
    await arm(w);
    w.tick(99244);
    w.wrapped.unreadable = true;
    await w.cycle();
    await w.cycle();
    assert.deepEqual(await w.ids(), []); // nothing could be done blind
    w.wrapped.unreadable = false;
    w.tick(99244);
    await w.cycle();
    assert.deepEqual(await w.ids(), [SL, TP1, TP2]);
  });
});
