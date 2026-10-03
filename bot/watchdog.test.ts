// watchdog.test.ts – offline tests of the watchdog: the independent check that every position has the right stop and
// targets, and the backstop that repairs or closes when the engine does not. Run: node --test bot/watchdog.test.ts
//
// Rules pinned here:
//  - it only reads the engine's record, never writes it (two processes must not read-modify-write one value);
//  - it waits 2 x protect_timeout_sec before acting, so the engine goes first;
//  - it never opens a position: everything it places is reduce-only;
//  - it never touches a position it has no trade record for, nor an order the bot did not create;
//  - a missing stop is re-placed once; if that does not work the position is closed at market;
//  - it cannot verify what it cannot read, and says so.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TradeRecord } from "./engine.ts";
import { type FuturesOpenOrder, type FuturesPosition, type OrderRequest, makeCliOrdId } from "./executor.ts";
import { config } from "./sim-fixtures.ts";
import { SL, TP1, TP2, arm, openPosition, world } from "./trader-fixtures.ts";
import { type ProtectionInput, checkProtection, watchdogTick } from "./watchdog.ts";

const GRACE = config.protect_timeout_sec * 2 * 1000; // 10 s
const kinds = (issues: { kind: string }[]) => issues.map((i) => i.kind).sort();

// ---- the pure check ---------------------------------------------------------------------------------------------------

const ID = 2;
const trade: TradeRecord = {
  policyId: ID, direction: "long", entryCliOrdId: makeCliOrdId(ID, "entry", 0), entryPrice: 99245,
  plan: { size: 0.004, stop: 98000, ladder: [{ price: 102000, size: 0.002 }, { price: 104000, size: 0.002 }], leverage: 2 },
  horizonEndMs: Date.now() + 1e9, protectSeq: 0,
};
const position = (over: Partial<FuturesPosition> = {}): FuturesPosition => ({
  symbol: "PF_XBTUSD", side: "long", size: 0.004, price: 99245, unrealizedPnl: 0, unrealizedFunding: 0, pnlCurrency: "USD", ...over,
});
const order = (cliOrdId: string, over: Partial<FuturesOpenOrder> = {}): FuturesOpenOrder => ({
  order_id: `o-${cliOrdId}`, cliOrdId, symbol: "PF_XBTUSD", side: "sell", orderType: "lmt", status: "untouched", filledSize: 0,
  unfilledSize: 0.002, reduceOnly: true, receivedTime: "x", lastUpdateTime: "x", ...over,
});
const stop = (size = 0.004, seq = 0, policy = ID) => order(makeCliOrdId(policy, "sl", seq), { orderType: "stp", stopPrice: 98000, unfilledSize: size });
const target = (n: 1 | 2 | 3, size = 0.002, policy = ID) => order(makeCliOrdId(policy, `tp${n}`, 0), { limitPrice: 100000 + n, unfilledSize: size });
const input = (over: Partial<ProtectionInput> = {}): ProtectionInput => ({
  position: position(), orders: [stop(), target(1), target(2)], trade, filledRoles: [], config, ...over,
});

describe("checkProtection", () => {
  test("a fully protected position has no issues", () => {
    assert.deepEqual(checkProtection(input()), []);
  });

  test("no stop", () => {
    assert.deepEqual(kinds(checkProtection(input({ orders: [target(1), target(2)] }))), ["no_sl"]);
  });

  test("a stop of the wrong size, either way", () => {
    assert.deepEqual(kinds(checkProtection(input({ orders: [stop(0.003), target(1), target(2)] }))), ["wrong_sl_size"]);
    assert.deepEqual(kinds(checkProtection(input({ orders: [stop(0.006), target(1), target(2)] }))), ["wrong_sl_size"]);
  });

  test("two stops are fine as long as one of them is the right size", () => {
    assert.deepEqual(checkProtection(input({ orders: [stop(0.004, 0), stop(0.004, 100), target(1), target(2)] })), []);
  });

  test("no targets, and targets that do not add up to the position", () => {
    assert.deepEqual(kinds(checkProtection(input({ orders: [stop()] }))), ["no_tp"]);
    assert.deepEqual(kinds(checkProtection(input({ orders: [stop(), target(1), target(2, 0.001)] }))), ["wrong_tp_size"]);
  });

  test("a filled rung is not expected any more", () => {
    const p = position({ size: 0.002 });
    assert.deepEqual(checkProtection(input({ position: p, filledRoles: ["tp1"], orders: [stop(0.002), target(2)] })), []);
  });

  test("when every rung has filled, no target is expected", () => {
    assert.deepEqual(checkProtection(input({ position: position({ size: 0.001 }), filledRoles: ["tp1", "tp2"], orders: [stop(0.001)] })), []);
  });

  test("orders that are not reduce-only do not count as protection", () => {
    const loose = order(makeCliOrdId(ID, "sl", 0), { orderType: "stp", stopPrice: 98000, unfilledSize: 0.004, reduceOnly: false });
    assert.deepEqual(kinds(checkProtection(input({ orders: [loose, target(1), target(2)] }))), ["no_sl"]);
  });

  test("a stop of another policy, or an order that is not the bot's, does not count", () => {
    assert.deepEqual(kinds(checkProtection(input({ orders: [stop(0.004, 0, 1), target(1), target(2)] }))), ["no_sl"]);
    assert.deepEqual(kinds(checkProtection(input({ orders: [order("my-stop", { orderType: "stp", unfilledSize: 0.004 }), target(1), target(2)] }))), ["no_sl"]);
  });

  test("reduce-only orders of the bot with no position are orphans; entries and foreign orders are not", () => {
    const entry = order(makeCliOrdId(ID, "entry", 0), { side: "buy", reduceOnly: false });
    const foreign = order("my-order", { reduceOnly: true });
    const issues = checkProtection(input({ position: null, orders: [stop(), target(1), entry, foreign] }));
    assert.deepEqual(issues.map((i) => i.kind), ["orphan_reduce_only", "orphan_reduce_only"]);
    assert.deepEqual(issues.map((i) => i.detail).sort(), [makeCliOrdId(ID, "sl", 0), makeCliOrdId(ID, "tp1", 0)].sort());
  });

  test("a position with no trade record is reported and not judged", () => {
    assert.deepEqual(kinds(checkProtection(input({ trade: null, orders: [] }))), ["unexplained_position"]);
  });

  test("a position on the wrong side of the trade is reported", () => {
    assert.deepEqual(kinds(checkProtection(input({ position: position({ side: "short" }) }))), ["position_on_wrong_side"]);
  });

  test("an exchange that omits remaining sizes is taken to be right, not accused", () => {
    const { unfilledSize: _a, ...bare } = stop();
    const { unfilledSize: _b, ...bareTp } = target(1);
    assert.deepEqual(checkProtection(input({ orders: [bare as FuturesOpenOrder, bareTp as FuturesOpenOrder] })), []);
  });

  test("property: no issues means the position really has a stop and the targets it should have", () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    let protectedCases = 0;
    for (let i = 0; i < 2000; i++) {
      const size = [0.004, 0.002, 0.003][Math.floor(rnd() * 3)]!;
      const pool = [stop(0.004), stop(0.002, 100), stop(size, 101), target(1), target(2), target(1, 0.001), target(2, size)];
      const orders = pool.filter(() => rnd() < 0.5);
      const filledRoles = rnd() < 0.3 ? (["tp1"] as const) : [];
      const issues = checkProtection(input({ position: position({ size }), orders, filledRoles: [...filledRoles] }));
      if (issues.length) continue;
      protectedCases++;
      assert.ok(orders.some((o) => o.cliOrdId?.includes("-sl-") && Math.abs((o.unfilledSize ?? 0) - size) < 1e-9), "no stop of the right size");
    }
    assert.ok(protectedCases > 0, "the generator never produced a protected case");
  });
});

// ---- the loop ---------------------------------------------------------------------------------------------------------

describe("watchdogTick", () => {
  test("a healthy position: nothing to report, nothing placed, no incident", async () => {
    const w = world();
    await openPosition(w);
    const placed: OrderRequest[] = [];
    w.wrapped.onPlace = (r) => placed.push(r);
    const before = w.store.listIncidents(0).length;
    assert.deepEqual(await watchdogTick(w.deps), []);
    assert.equal(placed.length, 0);
    assert.equal(w.store.listIncidents(0).length, before);
  });

  test("a missing stop: the engine gets its grace period first, then the stop is re-placed with a reduce-only order", async () => {
    const w = world();
    await openPosition(w);
    const placed: OrderRequest[] = [];
    w.wrapped.onPlace = (r) => placed.push(r);
    await w.ex.cancelOrder({ cliOrdId: SL });

    assert.deepEqual(kinds(await watchdogTick(w.deps)), ["no_sl"]);
    w.clock.advance(GRACE - 1000);
    assert.deepEqual(kinds(await watchdogTick(w.deps)), ["no_sl"]);
    assert.equal(placed.length, 0); // still inside the grace period

    w.clock.advance(2000);
    await watchdogTick(w.deps);
    assert.equal(placed.length, 1);
    const sl = await w.order("bot-2-sl-100");
    assert.deepEqual([sl?.orderType, sl?.stopPrice, sl?.unfilledSize, sl?.reduceOnly, sl?.side], ["stp", 98000, 0.004, true, "sell"]);
    assert.deepEqual(await watchdogTick(w.deps), []); // verified on the next tick
    assert.ok(placed.every((r) => r.reduceOnly));
  });

  test("the repaired stop is placed at the last trailed stop, not the original", async () => {
    const w = world();
    await openPosition(w);
    w.tick(101500); // 1R in profit
    await w.cycle(); // the engine trails the stop to 101500 - 1600 = 99900
    assert.equal((await w.order(SL))?.stopPrice, 99900);
    await w.ex.cancelOrder({ cliOrdId: SL });
    await watchdogTick(w.deps);
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps);
    assert.equal((await w.order("bot-2-sl-100"))?.stopPrice, 99900);
  });

  test("a repair that does not work: the next tick closes the position at market", async () => {
    const w = world();
    await openPosition(w);
    const placed: OrderRequest[] = [];
    w.wrapped.onPlace = (r) => placed.push(r);
    w.wrapped.refuse = (r) => r.cliOrdId.includes("-sl-");
    await w.ex.cancelOrder({ cliOrdId: SL });
    await watchdogTick(w.deps);
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps); // tries the stop: refused
    assert.equal((await w.ex.getPositions()).length, 1);
    await watchdogTick(w.deps); // still no stop: close
    assert.deepEqual(await w.ex.getPositions(), []);
    const close = placed.find((r) => r.orderType === "mkt");
    assert.deepEqual([close?.reduceOnly, close?.side, close?.size, close?.cliOrdId], [true, "sell", 0.004, "bot-2-close-1000"]);
    assert.ok(placed.every((r) => r.reduceOnly), "the watchdog must never place an opening order");
  });

  test("after the close, the targets left behind are cancelled, and nothing foreign is touched", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 80000, reduceOnly: false, cliOrdId: "my-manual-order" });
    w.wrapped.refuse = (r) => r.cliOrdId.includes("-sl-");
    await w.ex.cancelOrder({ cliOrdId: SL });
    await watchdogTick(w.deps);
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps);
    await watchdogTick(w.deps); // closes
    await watchdogTick(w.deps); // the orphaned targets
    assert.deepEqual(await w.ids(), ["my-manual-order"]);
  });

  test("a target that is missing is re-placed at its own rung for the missing size", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.cancelOrder({ cliOrdId: TP2 });
    assert.deepEqual(kinds(await watchdogTick(w.deps)), ["wrong_tp_size"]);
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps);
    const tp = await w.order("bot-2-tp2-100");
    assert.deepEqual([tp?.limitPrice, tp?.unfilledSize, tp?.reduceOnly], [104000, 0.002, true]);
    assert.deepEqual(await watchdogTick(w.deps), []);
  });

  test("a target is never repaired by closing the position", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.cancelOrder({ cliOrdId: TP1 });
    await w.ex.cancelOrder({ cliOrdId: TP2 });
    w.wrapped.refuse = (r) => r.cliOrdId.includes("-tp");
    await watchdogTick(w.deps);
    for (let i = 0; i < 4; i++) {
      w.clock.advance(GRACE + 1000);
      await watchdogTick(w.deps);
    }
    assert.equal((await w.ex.getPositions()).length, 1);
  });

  test("a stop of the wrong size is edited to the position size", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.editOrder({ cliOrdId: SL, size: 0.003 });
    assert.deepEqual(kinds(await watchdogTick(w.deps)), ["wrong_sl_size"]);
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps);
    assert.equal((await w.order(SL))?.unfilledSize, 0.004);
  });

  test("orders left behind after the position closed are cancelled once the engine has had its chance", async () => {
    const w = world();
    await openPosition(w);
    w.tick(97999); // the stop fires; the targets remain
    assert.deepEqual(await w.ex.getPositions(), []);
    assert.deepEqual(kinds(await watchdogTick(w.deps)), ["orphan_reduce_only", "orphan_reduce_only"]);
    assert.deepEqual(await w.ids(), [TP1, TP2]); // within the grace period
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps);
    assert.deepEqual(await w.ids(), []);
  });

  test("the engine and the watchdog repairing the same stop leave exactly one stop, in either order", async () => {
    // Engine first.
    const a = world();
    await openPosition(a);
    await a.ex.cancelOrder({ cliOrdId: SL });
    await a.cycle();
    await a.cycle();
    a.clock.advance(GRACE + 1000);
    a.tick(99244);
    await watchdogTick(a.deps);
    assert.equal((await a.ex.getOpenOrders()).filter((o) => o.cliOrdId?.includes("-sl-")).length, 1);

    // Watchdog first, then the engine.
    const b = world();
    await openPosition(b);
    await b.ex.cancelOrder({ cliOrdId: SL });
    await watchdogTick(b.deps);
    b.clock.advance(GRACE + 1000);
    await watchdogTick(b.deps);
    b.tick(99244);
    await b.cycle();
    await b.cycle();
    assert.equal((await b.ex.getOpenOrders()).filter((o) => o.cliOrdId?.includes("-sl-")).length, 1);
    assert.equal(b.rec().state, "OPEN");
  });

  test("right after a fill the engine's protection is awaited, then confirmed: the watchdog does nothing at all", async () => {
    const w = world();
    await arm(w);
    w.tick(99244); // filled; no protection yet
    const placed: OrderRequest[] = [];
    w.wrapped.onPlace = (r) => placed.push(r);
    assert.deepEqual(kinds(await watchdogTick(w.deps)), ["no_sl", "no_tp"]);
    assert.equal(placed.length, 0);
    await w.cycle(); // the engine protects
    assert.deepEqual(await watchdogTick(w.deps), []);
    assert.deepEqual(placed.map((r) => r.cliOrdId), ["bot-2-sl-0", "bot-2-tp1-0", "bot-2-tp2-0"]); // all the engine's
  });

  test("a position with no trade record is reported and never touched", async () => {
    const w = world();
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 0.004, reduceOnly: false, cliOrdId: "manual-position" });
    const placed: OrderRequest[] = [];
    w.wrapped.onPlace = (r) => placed.push(r);
    assert.deepEqual(kinds(await watchdogTick(w.deps)), ["unexplained_position"]);
    for (let i = 0; i < 4; i++) {
      w.clock.advance(GRACE + 1000);
      await watchdogTick(w.deps);
    }
    assert.equal(placed.length, 0);
    assert.equal((await w.ex.getPositions()).length, 1);
    assert.ok(w.store.listIncidents(0).some((i) => i.kind === "watchdog:unexplained_position"));
  });

  test("when the exchange cannot be read it says so, takes no action, and does not forget a pending repair", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.cancelOrder({ cliOrdId: SL });
    await watchdogTick(w.deps); // starts the grace clock
    w.wrapped.unreadable = true;
    const placed: OrderRequest[] = [];
    w.wrapped.onPlace = (r) => placed.push(r);
    w.clock.advance(GRACE + 1000);
    assert.deepEqual(kinds(await watchdogTick(w.deps)), ["cannot_verify"]);
    assert.equal(placed.length, 0);
    assert.ok(w.store.listIncidents(0).some((i) => i.kind === "watchdog:cannot_verify"));
    w.wrapped.unreadable = false;
    await watchdogTick(w.deps); // the grace period was running all along: it acts at once
    assert.equal(placed.length, 1);
  });

  test("it never writes the engine's record", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.cancelOrder({ cliOrdId: SL });
    const before = w.store.getKv("engine:record");
    await watchdogTick(w.deps);
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps);
    await watchdogTick(w.deps);
    assert.equal(w.store.getKv("engine:record"), before);
  });

  test("a repeated issue is one incident, not one per tick", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.cancelOrder({ cliOrdId: SL });
    for (let i = 0; i < 5; i++) {
      w.clock.advance(1000);
      await watchdogTick(w.deps);
    }
    assert.equal(w.store.listIncidents(0).filter((i) => i.kind === "watchdog:no_sl").length, 1);
  });

  test("a failing journal never stops a repair", async () => {
    const w = world();
    await openPosition(w);
    w.store.appendJournal = () => {
      throw new Error("disk full"); // the journal breaks after the trader has opened the position
    };
    await w.ex.cancelOrder({ cliOrdId: SL });
    await watchdogTick(w.deps);
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps);
    assert.ok(await w.order("bot-2-sl-100"));
  });

  test("a repair that is journalled leaves a watchdog row with the issue and the action", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.cancelOrder({ cliOrdId: SL });
    await watchdogTick(w.deps);
    w.clock.advance(GRACE + 1000);
    await watchdogTick(w.deps);
    const rows = w.store.listJournal(0, "watchdog");
    assert.ok(rows.some((r) => r.decision.includes("place:bot-2-sl-100") && r.reason.includes("no_sl")));
  });
});
