// reconcile.test.ts – offline tests of startup reconciliation: what the bot does when it starts and finds the exchange
// (or the simulation) in a state its own record may not match. Run: node --test bot/reconcile.test.ts
//
// Rules pinned here (spec section 8):
//  - nothing opens until a reconciliation has finished CLEAN; an unreadable exchange is not clean;
//  - a position of the bot without a stop is an incident: the bot halts for manual acknowledgement and closes it;
//  - a position the bot has no trade record for may be the user's: it halts and never touches it;
//  - orders the bot created that no trade explains are cancelled; orders it did not create are never touched;
//  - counters are rebuilt from the order history and only ever raised;
//  - what a simulated stop did during downtime is replayed from candles, once.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FuturesCandle } from "../providers/kraken/kraken-futures-client.ts";
import { saveEngineRecord } from "./engine-state.ts";
import { reconcile } from "./reconcile.ts";
import { E, MIN, SL, TP1, TP2, arm, openPosition, reasons, world } from "./trader-fixtures.ts";
import { T0, config } from "./sim-fixtures.ts";

const kinds = (r: { incidents: { kind: string }[] }) => r.incidents.map((i) => i.kind).sort();
const candle = (startMs: number, o: number, h: number, l: number, c: number): FuturesCandle => ({ t: startMs / 1000, o, h, l, c, v: 1 });

// A fresh process: the engine record says "not reconciled" until reconcile() has run.
const restart = (w: ReturnType<typeof world>) => {
  const rec = w.rec();
  saveEngineRecord(w.store, { ...rec, reconciled: false });
};

describe("a clean start", () => {
  test("with nothing on the exchange it is clean, records nothing, and lets the bot trade", async () => {
    const w = world({ reconciled: false });
    w.tick(99250);
    assert.deepEqual(reasons(await w.cycle()), ["not_reconciled"]); // blocked until reconciled
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, true);
    assert.deepEqual(r.incidents, []);
    assert.equal(w.rec().reconciled, true);
    assert.equal(w.rec().state, "FLAT");
    assert.deepEqual(reasons(await w.cycle()), ["awaiting_confirmation"]); // now it can start
  });

  test("a healthy open position is left exactly as it is", async () => {
    const w = world();
    await openPosition(w);
    restart(w);
    const before = { ids: await w.ids(), rec: w.rec() };
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, true);
    assert.deepEqual(r.incidents, []);
    assert.deepEqual(await w.ids(), before.ids);
    assert.deepEqual({ ...w.rec(), reconciled: false }, { ...before.rec, reconciled: false });
    assert.equal(w.rec().reconciled, true);
  });

  test("a resting entry survives a restart", async () => {
    const w = world();
    await arm(w);
    restart(w);
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, true);
    assert.deepEqual(await w.ids(), [E]);
    assert.equal(w.rec().state, "ENTERING");
  });

  test("running it twice changes nothing the second time", async () => {
    const w = world();
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 90000, reduceOnly: false, cliOrdId: "bot-1-entry-0" });
    const first = await reconcile(w.deps, { replayer: w.ex });
    const second = await reconcile(w.deps, { replayer: w.ex });
    assert.deepEqual(kinds(first), ["orphan_bot_order"]);
    assert.deepEqual(second.incidents, []);
    assert.equal(second.clean, true);
  });
});

describe("the flag that gates trading", () => {
  test("is cleared as soon as a reconciliation starts, and stays cleared if the exchange cannot be read", async () => {
    const w = world(); // reconciled: true
    w.tick(99250);
    w.wrapped.unreadable = true;
    const r = await reconcile(w.deps);
    assert.equal(r.clean, false);
    assert.deepEqual(kinds(r), ["cannot_verify"]);
    assert.equal(w.rec().reconciled, false);
    w.wrapped.unreadable = false;
    assert.deepEqual(reasons(await w.cycle()), ["not_reconciled"]);
  });

  test("is cleared before anything else happens: a crash half-way through must leave entries blocked", async () => {
    const w = world(); // reconciled: true
    w.tick(99250);
    const seen: boolean[] = [];
    w.wrapped.onRead = () => seen.push(w.rec().reconciled);
    await reconcile(w.deps);
    assert.equal(seen[0], false);
    assert.equal(w.rec().reconciled, true); // and set again once it finished clean
  });

  test("an unreadable engine record is not clean either, and the bot does not guess", async () => {
    const w = world();
    w.store.setKv("engine:record", "{ broken");
    const r = await reconcile(w.deps);
    assert.equal(r.clean, false);
    assert.deepEqual(kinds(r), ["cannot_verify"]);
  });
});

describe("a position the bot cannot account for", () => {
  test("a bot position without a stop: incident, halt for acknowledgement, and the position is closed", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.cancelAll("PF_XBTUSD"); // the protection is gone (for instance cancelled while the bot was down)
    restart(w);
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, false);
    assert.deepEqual(kinds(r), ["unprotected_position"]);
    assert.equal(w.rec().state, "HALTED");
    assert.equal(w.rec().halt?.manualAck, true);
    assert.equal(w.rec().reconciled, false);
    assert.equal((await w.ex.getPositions()).length, 1); // reconcile only halts; the next cycle acts
    w.tick(99250);
    await w.cycle(); // HALTED with a bot position and no stop: close at market
    assert.deepEqual(await w.ex.getPositions(), []);
    assert.equal(w.rec().state, "HALTED"); // and it stays halted until the user acknowledges
  });

  test("a position with no trade record may be the user's: halt, and never close it", async () => {
    const w = world();
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 0.004, reduceOnly: false, cliOrdId: "manual-position" });
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, false);
    assert.deepEqual(kinds(r), ["unexplained_position"]);
    assert.equal(w.rec().state, "HALTED");
    assert.equal(w.rec().halt?.manualAck, true);
    for (let i = 0; i < 3; i++) {
      w.tick(99250);
      await w.cycle();
    }
    assert.equal((await w.ex.getPositions()).length, 1); // untouched
  });

  test("the stops of a position nobody can explain are kept: they are all that protects it", async () => {
    const w = world();
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 0.004, reduceOnly: false, cliOrdId: "bot-9-entry-0" });
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "sell", orderType: "stp", size: 0.004, stopPrice: 98000, reduceOnly: true, cliOrdId: "bot-9-sl-0" });
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.deepEqual(kinds(r), ["unexplained_position"]);
    assert.deepEqual(await w.ids(), ["bot-9-sl-0"]);
  });

  test("a position on the wrong side of the trade record is an incident", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.cancelAll("PF_XBTUSD");
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "sell", orderType: "mkt", size: 0.008, reduceOnly: false, cliOrdId: "flip-it" }); // now short 0.004
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, false);
    assert.ok(kinds(r).includes("position_on_wrong_side"));
    assert.equal(w.rec().state, "HALTED");
  });
});

describe("orders", () => {
  test("orders the bot created that no trade explains are cancelled and reported", async () => {
    const w = world();
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "sell", orderType: "lmt", size: 0.002, limitPrice: 110000, reduceOnly: false, cliOrdId: "bot-1-tp1-0" });
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.002, limitPrice: 90000, reduceOnly: false, cliOrdId: "bot-1-entry-3" });
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, true);
    assert.deepEqual(kinds(r), ["orphan_bot_order", "orphan_bot_order"]);
    assert.deepEqual(await w.ids(), []);
  });

  test("orders the bot did NOT create are never touched; they are reported and block entries while they exist", async () => {
    const w = world();
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 90000, reduceOnly: false, cliOrdId: "my-manual-order" });
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.deepEqual(kinds(r), ["foreign_order"]);
    assert.equal(r.clean, true); // the block is dynamic: it lasts exactly as long as the order does
    assert.deepEqual(await w.ids(), ["my-manual-order"]);
    assert.deepEqual(reasons(await w.cycle()), ["foreign_exposure"]);
    await w.ex.cancelOrder({ cliOrdId: "my-manual-order" });
    w.tick(99250);
    assert.deepEqual(reasons(await w.cycle()), ["awaiting_confirmation"]); // unblocked without a restart
  });

  test("the orders of the current trade are kept, those of an older policy are not", async () => {
    const w = world();
    await openPosition(w);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "sell", orderType: "lmt", size: 0.001, limitPrice: 120000, reduceOnly: true, cliOrdId: "bot-1-tp3-0" });
    restart(w);
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.deepEqual(kinds(r), ["orphan_bot_order"]);
    assert.deepEqual(await w.ids(), [SL, TP1, TP2]);
  });
});

describe("counters", () => {
  test("are raised to what the order history shows (a restart cannot reset the day's budget)", async () => {
    const w = world();
    w.tick(99250);
    for (const [i, id] of ["bot-2-entry-0", "bot-2-sl-0", "bot-2-tp1-0"].entries()) {
      await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 80000 + i, reduceOnly: false, cliOrdId: id });
    }
    assert.equal(w.store.getCounter("2026-10-03", "orders"), 0); // placed behind the trader's back
    await reconcile(w.deps, { replayer: w.ex });
    assert.equal(w.store.getCounter("2026-10-03", "orders"), 3);
    assert.equal(w.store.getCounter("2026-10-03", "entries"), 1);
  });

  test("are never lowered", async () => {
    const w = world();
    w.store.addCounter("2026-10-03", "orders", 9);
    w.store.addCounter("2026-10-03", "entries", 2);
    await reconcile(w.deps, { replayer: w.ex });
    assert.equal(w.store.getCounter("2026-10-03", "orders"), 9);
    assert.equal(w.store.getCounter("2026-10-03", "entries"), 2);
  });

  test("orders that are not the bot's do not count", async () => {
    const w = world();
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 90000, reduceOnly: false, cliOrdId: "my-manual-order" });
    await reconcile(w.deps, { replayer: w.ex });
    assert.equal(w.store.getCounter("2026-10-03", "orders"), 0);
  });

  test("after a rebuild that finds the entry budget used, the next entry is refused", async () => {
    const w = world();
    w.tick(99250);
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 80000, reduceOnly: false, cliOrdId: "bot-2-entry-0" });
    await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 80001, reduceOnly: false, cliOrdId: "bot-2-entry-1" });
    await reconcile(w.deps, { replayer: w.ex });
    w.tick(99250);
    await w.cycle();
    w.clock.advance(31_000);
    w.tick(99250);
    assert.deepEqual(reasons(await w.cycle()), ["limit:max_entries_per_day"]);
  });
});

describe("downtime (the simulated exchange)", () => {
  test("a stop that a candle crossed while the bot was down fires once, and the PnL is booked once", async () => {
    const w = world();
    await openPosition(w);
    restart(w);
    // Ten minutes pass with the bot off. In the second minute the market trades down through the stop.
    w.clock.advance(10 * MIN);
    w.market.minuteCandles = [
      candle(T0 + 2 * MIN, 99200, 99250, 97900, 98500),
      candle(T0 + 3 * MIN, 98500, 98600, 98400, 98500),
    ];
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, true);
    assert.deepEqual(kinds(r), ["closed_during_downtime"]);
    assert.deepEqual(await w.ex.getPositions(), []);

    // The engine still believes OPEN: it winds down from there.
    w.tick(98500);
    await w.cycle(); // OPEN -> REDUCING
    await w.cycle(); // leftover targets cancelled
    await w.cycle(); // COOLDOWN
    const rec = w.rec();
    assert.equal(rec.state, "COOLDOWN");
    assert.equal(rec.trade, null);
    assert.equal(rec.cooldownUntilMs, w.clock.now() + config.cooldown_after_loss_min * MIN); // it was a loss
    const stops = (await w.ex.getFills(new Date(0))).filter((f) => f.cliOrdId === SL);
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.price, 97900); // the low of the candle, not the stop price
    assert.ok((await w.ex.getAccount()).realizedPnl < 0);

    await reconcile(w.deps, { replayer: w.ex }); // a second restart books nothing again
    assert.equal((await w.ex.getFills(new Date(0))).filter((f) => f.cliOrdId === SL).length, 1);
  });

  test("a target the replay reaches fills too, and funding for the hours held is charged", async () => {
    const w = world();
    await openPosition(w);
    restart(w);
    w.clock.advance(2 * 60 * MIN);
    w.market.minuteCandles = [candle(T0 + 5 * MIN, 99300, 102100, 99290, 102000)];
    await reconcile(w.deps, { replayer: w.ex });
    const fills = await w.ex.getFills(new Date(0));
    assert.ok(fills.some((f) => f.cliOrdId === TP1 && f.fillType === "maker"));
    assert.ok((await w.ex.getAccount()).funding !== 0, "the funding of the hours held was charged");
  });

  test("when no candles can be fetched but something is open, the bot cannot know: not clean, halt for acknowledgement", async () => {
    const w = world();
    await openPosition(w);
    restart(w);
    w.clock.advance(10 * MIN);
    w.market.failCandles = true;
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, false);
    assert.deepEqual(kinds(r), ["replay_failed"]);
    assert.equal(w.rec().state, "HALTED");
    assert.equal(w.rec().halt?.manualAck, true);
  });

  test("a downtime longer than the candle window with exposure: not clean, halt", async () => {
    const w = world();
    await openPosition(w);
    restart(w);
    w.clock.advance(40 * 60 * MIN); // 40 hours, more than 2000 one-minute candles
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, false);
    assert.deepEqual(kinds(r), ["replay_gap_too_large"]);
    assert.equal(w.rec().state, "HALTED");
  });

  test("a long downtime with nothing open is harmless: clean", async () => {
    const w = world();
    w.tick(99250);
    w.clock.advance(40 * 60 * MIN);
    w.market.failCandles = true; // not even needed
    const r = await reconcile(w.deps, { replayer: w.ex });
    assert.equal(r.clean, true);
    assert.deepEqual(r.incidents, []);
  });
});
