// dry-run-replay.test.ts – offline tests of the DryRunExecutor's funding, candle replay, fault injection and shapes.
// Run: node --test bot/dry-run-replay.test.ts
//
// Funding: rates are { t (epoch ms), rate (fraction of price per hour; positive means longs pay shorts) }.
// Replay: 1-minute candles ({ t in epoch SECONDS }) are walked through the adverse extreme first (low for a long,
//         high for a short), so a stop beats a target inside one candle. Orders placed after a candle never fire in it.
// Faults: one-shot, in memory (tests only).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FuturesCandle } from "../providers/kraken/kraken-futures-client.ts";
import { T0, closeTo, goLong, place, setup } from "./sim-fixtures.ts";

const HOUR = 3_600_000;
const candle = (startMs: number, o: number, h: number, l: number, c: number): FuturesCandle => ({
  t: startMs / 1000, o, h, l, c, v: 1,
});

describe("funding", () => {
  test("a long pays a positive rate once per funding time; the same time is never charged twice", async () => {
    const w = setup();
    await goLong(w, 100000, 0.01); // opened at T0 + 1 s
    w.clock.advance(HOUR);
    w.tick(100000);
    const rates = [{ t: T0 + HOUR, rate: 0.0001 }];
    w.ex.accrueFunding(rates);
    w.ex.accrueFunding(rates);
    const a = await w.ex.getAccount();
    closeTo(a.funding, 0.01 * 100000 * 0.0001); // 0.1
    closeTo(a.equity, 1000 - a.fees - 0.1 + a.unrealizedPnl);
    closeTo((await w.ex.getPositions())[0]?.unrealizedFunding ?? NaN, -0.1); // in PnL sign: a cost
  });

  test("several due rates are all charged, in time order, whatever order they arrive in", async () => {
    const w = setup();
    await goLong(w);
    w.clock.advance(3 * HOUR);
    w.tick(100000);
    w.ex.accrueFunding([{ t: T0 + 3 * HOUR, rate: 0.0001 }, { t: T0 + HOUR, rate: 0.0001 }, { t: T0 + 2 * HOUR, rate: 0.0002 }]);
    closeTo((await w.ex.getAccount()).funding, 0.01 * 100000 * (0.0001 + 0.0002 + 0.0001));
  });

  test("a short receives a positive rate (negative cost)", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "sell" });
    w.clock.advance(HOUR);
    w.tick(100000);
    w.ex.accrueFunding([{ t: T0 + HOUR, rate: 0.0001 }]);
    closeTo((await w.ex.getAccount()).funding, -0.1);
  });

  test("rates in the future, before the position opened, or while flat cost nothing", async () => {
    const w = setup();
    w.tick(100000); // flat
    w.ex.accrueFunding([{ t: T0 + 500, rate: 0.001 }]); // while flat
    await place(w, { side: "buy" }); // opened at T0 + 1 s
    w.ex.accrueFunding([{ t: T0 + 600, rate: 0.001 }]); // before the position existed
    w.ex.accrueFunding([{ t: w.clock.now() + HOUR, rate: 0.001 }]); // in the future
    assert.equal((await w.ex.getAccount()).funding, 0);
  });

  test("a rate seen while flat is not charged to a position opened later", async () => {
    const w = setup();
    w.tick(100000);
    w.clock.advance(HOUR);
    w.tick(100000);
    const rates = [{ t: T0 + HOUR - 500, rate: 0.001 }];
    w.ex.accrueFunding(rates); // flat: consumed, nothing charged
    await place(w, { side: "buy" });
    w.ex.accrueFunding(rates); // same rate again after the position opened
    assert.equal((await w.ex.getAccount()).funding, 0);
  });

  test("non-finite rates and times are ignored", async () => {
    const w = setup();
    await goLong(w);
    w.clock.advance(HOUR);
    w.tick(100000);
    w.ex.accrueFunding([{ t: Number.NaN, rate: 0.001 }, { t: T0 + HOUR, rate: Number.NaN }]);
    assert.equal((await w.ex.getAccount()).funding, 0);
  });

  test("a position's unrealized funding resets when it is closed and reopened", async () => {
    const w = setup();
    await goLong(w);
    w.clock.advance(HOUR);
    w.tick(100000);
    w.ex.accrueFunding([{ t: T0 + HOUR, rate: 0.0001 }]);
    await place(w, { side: "sell" }); // closed
    await place(w, { side: "buy" }); // a new position
    closeTo((await w.ex.getPositions())[0]?.unrealizedFunding ?? NaN, 0);
    closeTo((await w.ex.getAccount()).funding, 0.1); // the account keeps the history
  });
});

describe("replay – downtime", () => {
  test("a stop that a candle's low crossed fires, at the low (a gap through the stop is not rounded in the bot's favour)", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    w.ex.replay([candle(T0 + 60_000, 100000, 100100, 98900, 99500)]);
    assert.deepEqual(await w.ex.getPositions(), []);
    const fill = (await w.ex.getFills(new Date(0)))[1];
    assert.equal(fill?.price, 98900);
    const t = Date.parse(fill?.fillTime ?? "");
    assert.ok(t >= T0 + 60_000 && t < T0 + 120_000, "the fill is stamped inside the candle");
  });

  test("a candle that only touches the stop does not fire it", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    w.ex.replay([candle(T0 + 60_000, 100000, 100100, 99001, 99500)]);
    assert.equal((await w.ex.getPositions()).length, 1);
  });

  test("a long whose candle crosses both stop and target: the STOP fires first and the target is orphaned, not filled", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, cliOrdId: "bot-1-sl-0" });
    await place(w, { side: "sell", orderType: "lmt", limitPrice: 101000, reduceOnly: true, cliOrdId: "bot-1-tp1-0" });
    w.ex.replay([candle(T0 + 60_000, 100000, 101100, 98900, 100500)]);
    const fills = await w.ex.getFills(new Date(0));
    assert.deepEqual(fills.map((f) => f.cliOrdId), [fills[0]?.cliOrdId, "bot-1-sl-0"]);
    assert.deepEqual(await w.ex.getOpenOrders(), []); // the target was cancelled with nothing to reduce
  });

  test("a short whose candle crosses both: the high comes first, so its stop fires first", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "sell" });
    await place(w, { side: "buy", orderType: "stp", stopPrice: 101000, reduceOnly: true, cliOrdId: "bot-1-sl-0" });
    await place(w, { side: "buy", orderType: "lmt", limitPrice: 99000, reduceOnly: true, cliOrdId: "bot-1-tp1-0" });
    w.ex.replay([candle(T0 + 60_000, 100000, 101100, 98900, 99500)]);
    const fills = await w.ex.getFills(new Date(0));
    assert.equal(fills[1]?.cliOrdId, "bot-1-sl-0");
    assert.equal(fills.length, 2);
  });

  test("a target that only the candle's high reaches fills as a maker once the stop is clear", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, cliOrdId: "bot-1-sl-0" });
    await place(w, { side: "sell", orderType: "lmt", limitPrice: 101000, reduceOnly: true, cliOrdId: "bot-1-tp1-0" });
    w.ex.replay([candle(T0 + 60_000, 100000, 101100, 99500, 101000)]);
    const fills = await w.ex.getFills(new Date(0));
    assert.equal(fills[1]?.cliOrdId, "bot-1-tp1-0");
    assert.equal(fills[1]?.fillType, "maker");
    assert.equal(fills[1]?.price, 101000);
  });

  test("a resting entry limit fills during the replay only if the low trades through it", async () => {
    const touch = setup();
    touch.tick(100000);
    await place(touch, { side: "buy", orderType: "lmt", limitPrice: 99000 });
    touch.ex.replay([candle(T0 + 60_000, 100000, 100100, 99000, 99500)]);
    assert.deepEqual(await touch.ex.getPositions(), []);

    const through = setup();
    through.tick(100000);
    await place(through, { side: "buy", orderType: "lmt", limitPrice: 99000 });
    through.ex.replay([candle(T0 + 60_000, 100000, 100100, 98999, 99500)]);
    assert.equal((await through.ex.getPositions())[0]?.price, 99000);
  });

  test("an order placed AFTER a candle never fires inside it", async () => {
    const w = setup();
    await goLong(w);
    w.clock.advance(10 * 60_000); // the bot placed its stop ten minutes later
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    w.ex.replay([candle(T0 + 60_000, 100000, 100100, 98900, 99500)]);
    assert.equal((await w.ex.getPositions()).length, 1);
  });

  test("candles older than the last live quote are ignored", async () => {
    const w = setup();
    await goLong(w); // last tick at T0 + 1 s
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    w.ex.replay([candle(T0 - 60_000, 100000, 100100, 98900, 99500)]);
    assert.equal((await w.ex.getPositions()).length, 1);
  });

  test("candles are processed oldest first, and the last close becomes the current price", async () => {
    const w = setup();
    w.tick(100000);
    w.ex.replay([candle(T0 + 120_000, 100500, 100600, 100400, 100550), candle(T0 + 60_000, 100000, 100600, 99900, 100500)]);
    await place(w, { side: "buy" }); // a market order uses the replayed price
    assert.equal((await w.ex.getPositions())[0]?.price, 100550); // zero spread in a replay
  });

  test("malformed candles are skipped, never thrown on", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    w.ex.replay([candle(T0 + 60_000, Number.NaN, 100100, 98900, 99500), candle(T0 + 120_000, 100000, 98000, 99000, 99500)]);
    assert.equal((await w.ex.getPositions()).length, 1);
  });

  test("replay is atomic: a failure part-way leaves nothing half-applied", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    const before = await w.ex.getFills(new Date(0));
    // The second candle throws when its open is read (a getter), after the first one already fired the stop.
    const bad = { t: (T0 + 120_000) / 1000, get o(): number { throw new Error("boom"); }, h: 1, l: 1, c: 1, v: 1 } as unknown as FuturesCandle;
    assert.throws(() => w.ex.replay([candle(T0 + 60_000, 100000, 100100, 98900, 99500), bad]), /boom/);
    assert.deepEqual(await w.ex.getFills(new Date(0)), before);
    assert.equal((await w.ex.getPositions()).length, 1);
  });
});

describe("fault injection", () => {
  test("dropAck: the order IS recorded but the call throws; a retry with the same cliOrdId returns it and creates no second", async () => {
    const w = setup();
    w.tick(100000);
    w.ex.inject({ dropAck: 1 });
    await assert.rejects(
      w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.01, limitPrice: 99000, reduceOnly: false, cliOrdId: "bot-1-entry-0" }),
      /ack lost/,
    );
    assert.equal((await w.ex.getOpenOrders()).length, 1);
    const id = await place(w, { orderType: "lmt", limitPrice: 99000, cliOrdId: "bot-1-entry-0" });
    assert.equal((await w.ex.getOpenOrders())[0]?.order_id, id);
    assert.equal((await w.ex.getOpenOrders()).length, 1);
  });

  test("dropAck counts down: n ack losses, then calls behave again", async () => {
    const w = setup();
    w.tick(100000);
    w.ex.inject({ dropAck: 2 });
    await assert.rejects(w.ex.cancelOrder({ cliOrdId: "x" }), /ack lost/);
    await assert.rejects(w.ex.cancelOrder({ cliOrdId: "x" }), /ack lost/);
    await w.ex.cancelOrder({ cliOrdId: "x" });
  });

  test("rejectNext: the next order is refused with the given kind and nothing is created; the one after works", async () => {
    const w = setup();
    w.tick(100000);
    w.ex.inject({ rejectNext: "rate_limited" });
    const r = await w.ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 0.01, reduceOnly: false, cliOrdId: "bot-1-entry-0" });
    assert.ok(!r.ok);
    assert.equal(r.kind, "rate_limited");
    assert.deepEqual(await w.ex.getPositions(), []);
    await place(w, { cliOrdId: "bot-1-entry-0" }); // the same id is free to be used: the rejected call left no trace
    assert.equal((await w.ex.getPositions()).length, 1);
  });

  test("partialFill: a resting order fills only the fraction, stays open for the rest, and the fault is one-shot", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "buy", orderType: "lmt", limitPrice: 99000, size: 0.01 });
    w.ex.inject({ partialFill: 0.4 });
    w.tick(98999);
    let [o] = await w.ex.getOpenOrders();
    closeTo(o?.filledSize ?? NaN, 0.004);
    closeTo(o?.unfilledSize ?? NaN, 0.006);
    assert.equal(o?.status, "partiallyFilled");
    closeTo((await w.ex.getPositions())[0]?.size ?? NaN, 0.004);

    w.tick(98990); // the rest fills in full: the fault is spent
    assert.deepEqual(await w.ex.getOpenOrders(), []);
    closeTo((await w.ex.getPositions())[0]?.size ?? NaN, 0.01);
    [o] = await w.ex.getOpenOrders();
    assert.equal(o, undefined);
  });

  test("partialFill on a market order: the remainder is dropped, not left resting", async () => {
    const w = setup();
    w.tick(100000);
    w.ex.inject({ partialFill: 0.5 });
    await place(w, { side: "buy", size: 0.01 });
    closeTo((await w.ex.getPositions())[0]?.size ?? NaN, 0.005);
    assert.deepEqual(await w.ex.getOpenOrders(), []);
  });

  test("delayMs: the call returns only after the injected sleep, which a test wires to the fake clock", async () => {
    let sleepHook = (_ms: number) => {};
    const w = setup(undefined, { sleep: (ms) => sleepHook(ms) });
    sleepHook = (ms) => w.clock.advance(ms);
    w.tick(100000);
    const before = w.clock.now();
    w.ex.inject({ delayMs: 7000 });
    await place(w, { orderType: "lmt", limitPrice: 99000 });
    assert.equal(w.clock.now(), before + 7000);
    const before2 = w.clock.now();
    await place(w, { orderType: "lmt", limitPrice: 98000 }); // one-shot
    assert.equal(w.clock.now(), before2);
  });

  test("invalid fault settings throw", () => {
    const w = setup();
    assert.throws(() => w.ex.inject({ partialFill: 0 }), RangeError);
    assert.throws(() => w.ex.inject({ partialFill: 1 }), RangeError);
    assert.throws(() => w.ex.inject({ dropAck: -1 }), RangeError);
    assert.throws(() => w.ex.inject({ delayMs: -5 }), RangeError);
  });
});

// The objects must carry exactly the keys of the client's FuturesPosition / FuturesOpenOrder / FuturesFill, so the
// engine reads them the same way in dry-run and live. (The interfaces are typed from the docs; the client returns the
// API's JSON unmapped, so this checks us against the interfaces, not against a recorded response.)
describe("shapes match the Futures* interfaces", () => {
  const check = (obj: object, required: string[], optional: string[]) => {
    const keys = Object.keys(obj);
    for (const k of required) assert.ok(keys.includes(k), `missing required key ${k}`);
    for (const k of keys) assert.ok([...required, ...optional].includes(k), `unexpected key ${k}`);
  };

  test("positions", async () => {
    const w = setup();
    await goLong(w);
    check((await w.ex.getPositions())[0]!, ["symbol", "side", "size", "price", "unrealizedFunding"], ["unrealizedPnl", "pnlCurrency"]);
  });

  test("open orders: limit, stop and take-profit", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "lmt", limitPrice: 101000, reduceOnly: true });
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    await place(w, { side: "sell", orderType: "take_profit", stopPrice: 102000, reduceOnly: true });
    const orders = await w.ex.getOpenOrders();
    assert.equal(orders.length, 3);
    for (const o of orders) {
      check(o, ["order_id", "symbol", "side", "orderType", "status", "filledSize", "reduceOnly", "receivedTime", "lastUpdateTime"],
        ["cliOrdId", "limitPrice", "stopPrice", "unfilledSize", "triggerSignal"]);
    }
  });

  test("fills", async () => {
    const w = setup();
    await goLong(w);
    check((await w.ex.getFills(new Date(0)))[0]!, ["fill_id", "order_id", "symbol", "side", "size", "price", "fillTime", "fillType"], ["cliOrdId", "realized_pnl"]);
  });
});
