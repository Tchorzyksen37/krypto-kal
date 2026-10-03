// dry-run-executor.test.ts – offline tests of the simulated exchange (core: orders, fills, fees, netting).
// Run: node --test bot/dry-run-executor.test.ts
//
// The fill model is deliberately pessimistic: limits fill only when the last price trades THROUGH them, stops fill
// at the worse of the stop and the current quote (plus slippage), and every ambiguity goes against the bot.
// Conventions: px(p) builds a quote around p (bid p-5, ask p+5); slippage is 0 unless a test sets it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BotStore } from "./bot-store.ts";
import { FakeClock } from "./clock.ts";
import { type BotConfig, defaultConfig } from "./config.ts";
import { DryRunExecutor } from "./dry-run-executor.ts";
import { type OrderRequest, type PriceEvent, isBotOrder, makeCliOrdId, parseCliOrdId } from "./executor.ts";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const config: BotConfig = { ...defaultConfig(), slippage_cap_bps: 0 }; // capital 1000, max_leverage 2, fees 2/5 bps

const closeTo = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} to be within ${eps} of ${expected}`);

const px = (p: number, t: number): PriceEvent => ({ t, mark: p, last: p, bid: p - 5, ask: p + 5 });

function setup(cfg: BotConfig = config) {
  const store = new BotStore(":memory:");
  const clock = new FakeClock(T0);
  const ex = new DryRunExecutor({ store, clock, config: cfg });
  // Moves time on by one second and feeds a quote; `over` overrides single fields of the event.
  const tick = (p: number, over: Partial<PriceEvent> = {}) => {
    clock.advance(1000);
    ex.onPrice({ ...px(p, clock.now()), ...over });
  };
  return { store, clock, ex, tick };
}
type World = ReturnType<typeof setup>;

let seq = 0;
const req = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 0.01, reduceOnly: false, cliOrdId: `bot-1-entry-${seq++}`, ...over,
});

// Places an order that must be accepted and returns its exchange order id.
async function place(w: World, over: Partial<OrderRequest> = {}): Promise<string> {
  const r = await w.ex.placeOrder(req(over));
  assert.ok(r.ok, r.ok ? "" : `rejected: ${r.kind} ${r.message}`);
  return r.orderId;
}

// A long position of `size` bought at the ask of a quote around `p`.
async function goLong(w: World, p = 100000, size = 0.01) {
  w.tick(p);
  await place(w, { side: "buy", orderType: "mkt", size });
}

describe("cliOrdId helpers", () => {
  test("makeCliOrdId is deterministic, prefixed with bot-, and within 100 characters", () => {
    const id = makeCliOrdId(42, "sl", 0);
    assert.equal(id, "bot-42-sl-0");
    assert.equal(makeCliOrdId(42, "sl", 0), id);
    assert.ok(id.length <= 100);
    assert.ok(isBotOrder(id));
    assert.ok(!isBotOrder("manual-order-1"));
    assert.ok(!isBotOrder(undefined));
  });

  test("parseCliOrdId is the inverse, and returns undefined for anything else", () => {
    assert.deepEqual(parseCliOrdId("bot-7-tp2-3"), { policyId: 7, role: "tp2", seq: 3 });
    assert.equal(parseCliOrdId("bot-7-tp9-3"), undefined);
    assert.equal(parseCliOrdId("manual"), undefined);
  });

  test("invalid parts throw", () => {
    assert.throws(() => makeCliOrdId(-1, "sl", 0));
    assert.throws(() => makeCliOrdId(1, "nope" as never, 0));
    assert.throws(() => makeCliOrdId(1, "sl", 1.5));
  });
});

describe("DryRunExecutor – market orders and fees", () => {
  test("is a dry-run executor", () => {
    assert.equal(setup().ex.kind, "dry-run");
  });

  test("a market buy fills at the ask as a taker and opens a long", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "buy", orderType: "mkt", size: 0.01 });
    const [pos] = await w.ex.getPositions();
    assert.equal(pos?.side, "long");
    assert.equal(pos?.size, 0.01);
    assert.equal(pos?.price, 100005);
    const [fill] = await w.ex.getFills(new Date(0));
    assert.equal(fill?.fillType, "taker");
    assert.equal(fill?.price, 100005);
    closeTo((await w.ex.getAccount()).fees, 0.01 * 100005 * 5 / 10_000);
  });

  test("a market order before any quote is rejected as unknown", async () => {
    const r = await setup().ex.placeOrder(req());
    assert.ok(!r.ok);
    assert.equal(r.kind, "unknown");
  });

  test("slippage moves a market fill against the bot", async () => {
    const w = setup({ ...config, slippage_cap_bps: 10 });
    w.tick(100000);
    await place(w, { side: "buy" });
    closeTo((await w.ex.getPositions())[0]?.price ?? 0, 100005 * 1.001, 1e-6);
  });

  test("margin: an order that needs more than the available margin is rejected and leaves no trace", async () => {
    const w = setup();
    w.tick(100000);
    const r = await w.ex.placeOrder(req({ size: 1 })); // ~$100k notional on $1000 at 2x
    assert.ok(!r.ok);
    assert.equal(r.kind, "insufficient_margin");
    assert.deepEqual(await w.ex.getPositions(), []);
    assert.deepEqual(await w.ex.getOpenOrders(), []);
    assert.deepEqual(await w.ex.getFills(new Date(0)), []);
  });
});

describe("DryRunExecutor – limit orders", () => {
  test("a resting buy limit fills only when the last price trades THROUGH it, not on a touch", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "buy", orderType: "lmt", limitPrice: 99000 });
    w.tick(99000); // touch
    assert.equal((await w.ex.getOpenOrders()).length, 1);
    assert.deepEqual(await w.ex.getPositions(), []);
    w.tick(98999); // through
    assert.equal((await w.ex.getOpenOrders()).length, 0);
    const [pos] = await w.ex.getPositions();
    assert.equal(pos?.price, 99000); // at the limit, not at the better market price
    const [fill] = await w.ex.getFills(new Date(0));
    assert.equal(fill?.fillType, "maker");
    closeTo((await w.ex.getAccount()).fees, 0.01 * 99000 * 2 / 10_000);
  });

  test("a resting sell limit mirrors it", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "sell", orderType: "lmt", limitPrice: 101000 });
    w.tick(101000);
    assert.equal((await w.ex.getOpenOrders()).length, 1);
    w.tick(101001);
    assert.equal((await w.ex.getPositions())[0]?.side, "short");
  });

  test("a marketable limit fills at once at the ask as a taker", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "buy", orderType: "lmt", limitPrice: 100100 });
    const [fill] = await w.ex.getFills(new Date(0));
    assert.equal(fill?.price, 100005);
    assert.equal(fill?.fillType, "taker");
    assert.deepEqual(await w.ex.getOpenOrders(), []);
  });

  test("a post-only order that would cross is rejected with would_cross and creates nothing", async () => {
    const w = setup();
    w.tick(100000);
    const r = await w.ex.placeOrder(req({ side: "buy", orderType: "post", limitPrice: 100100 }));
    assert.ok(!r.ok);
    assert.equal(r.kind, "would_cross");
    assert.deepEqual(await w.ex.getOpenOrders(), []);
  });

  test("a price event older than the last one is ignored", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "buy", orderType: "lmt", limitPrice: 99000 });
    w.ex.onPrice(px(98000, T0)); // older than the last tick (T0 + 1000)
    assert.equal((await w.ex.getOpenOrders()).length, 1);
    assert.deepEqual(await w.ex.getPositions(), []);
  });
});

describe("DryRunExecutor – stop and take-profit orders", () => {
  test("a stop triggers on the configured signal: mark ignores a last-price dip", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, triggerSignal: "mark", size: 0.01 });
    w.tick(98900, { mark: 99500 }); // last is below the stop, mark is not
    assert.equal((await w.ex.getOpenOrders()).length, 1);
    w.tick(98990); // mark follows
    assert.deepEqual(await w.ex.getOpenOrders(), []);
    assert.deepEqual(await w.ex.getPositions(), []);
  });

  test("a stop on the last price triggers on the last price", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, triggerSignal: "last" });
    w.tick(98990, { mark: 99500 });
    assert.deepEqual(await w.ex.getPositions(), []);
  });

  test("a triggered stop fills at the WORSE of the stop and the quote (a gap is not rounded in the bot's favour)", async () => {
    const w = setup();
    await goLong(w); // bought at 100005
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    w.tick(98990); // bid 98985 is below the stop
    const fills = await w.ex.getFills(new Date(0));
    assert.equal(fills[1]?.price, 98985);
    assert.equal(fills[1]?.fillType, "taker");
    closeTo(fills[1]?.realized_pnl ?? 0, (98985 - 100005) * 0.01);
  });

  test("a stop never fills better than the stop price", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    w.tick(99004, { mark: 98999, bid: 99500 }); // mark trips it, the quote is still above the stop
    assert.equal((await w.ex.getFills(new Date(0)))[1]?.price, 99000);
  });

  test("slippage applies to a triggered stop", async () => {
    const w = setup({ ...config, slippage_cap_bps: 10 });
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true });
    w.tick(98990);
    closeTo((await w.ex.getFills(new Date(0)))[1]?.price ?? 0, 98985 * 0.999, 1e-6);
  });

  test("a buy stop closes a short when the price rises to it", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "sell", orderType: "mkt" });
    await place(w, { side: "buy", orderType: "stp", stopPrice: 101000, reduceOnly: true });
    w.tick(100990);
    assert.equal((await w.ex.getPositions()).length, 1);
    w.tick(101000);
    assert.deepEqual(await w.ex.getPositions(), []);
  });

  test("take_profit: a sell triggers when the price rises to it", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "take_profit", stopPrice: 101000, reduceOnly: true });
    w.tick(100990);
    assert.equal((await w.ex.getOpenOrders()).length, 1);
    w.tick(101000);
    assert.deepEqual(await w.ex.getPositions(), []);
  });
});

describe("DryRunExecutor – reduce-only", () => {
  test("is rejected at placement when it could not reduce anything", async () => {
    const w = setup();
    w.tick(100000);
    const flat = await w.ex.placeOrder(req({ side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true }));
    assert.ok(!flat.ok);
    assert.equal(flat.kind, "reduce_only_violation");

    await place(w, { side: "buy" }); // now long
    const wrongWay = await w.ex.placeOrder(req({ side: "buy", orderType: "lmt", limitPrice: 99000, reduceOnly: true }));
    assert.ok(!wrongWay.ok);
    assert.equal(wrongWay.kind, "reduce_only_violation");
  });

  test("is capped at the position size when it fires", async () => {
    const w = setup();
    await goLong(w, 100000, 0.004);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, size: 0.01 });
    w.tick(98990);
    const fills = await w.ex.getFills(new Date(0));
    assert.equal(fills[1]?.size, 0.004);
    assert.deepEqual(await w.ex.getPositions(), []);
    assert.deepEqual(await w.ex.getOpenOrders(), []);
  });

  test("a reduce-only order left over after the position closed stays open (the orphan hazard is modelled)", async () => {
    const w = setup();
    await goLong(w, 100000, 0.004);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, size: 0.004, cliOrdId: "bot-1-sl-0" });
    await place(w, { side: "sell", orderType: "lmt", limitPrice: 101000, reduceOnly: true, size: 0.004, cliOrdId: "bot-1-tp1-0" });
    w.tick(98990); // the stop closes the position
    assert.deepEqual((await w.ex.getOpenOrders()).map((o) => o.cliOrdId), ["bot-1-tp1-0"]);
  });

  test("an orphan reduce-only order that fires with no position is cancelled without a fill", async () => {
    const w = setup();
    await goLong(w, 100000, 0.004);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, size: 0.004 });
    await place(w, { side: "sell", orderType: "lmt", limitPrice: 101000, reduceOnly: true, size: 0.004 });
    w.tick(98990);
    const fillsBefore = (await w.ex.getFills(new Date(0))).length;
    w.tick(101001);
    assert.deepEqual(await w.ex.getOpenOrders(), []);
    assert.equal((await w.ex.getFills(new Date(0))).length, fillsBefore);
  });

  test("an orphan reduce-only order reduces a LATER position (why the engine must cancel leftovers)", async () => {
    const w = setup();
    await goLong(w, 100000, 0.004);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, size: 0.004 });
    await place(w, { side: "sell", orderType: "lmt", limitPrice: 101000, reduceOnly: true, size: 0.004 });
    w.tick(98990); // stopped out, the take-profit is orphaned
    await place(w, { side: "buy", orderType: "mkt", size: 0.004 }); // a new, unrelated long
    w.tick(101001);
    assert.deepEqual(await w.ex.getPositions(), []); // the orphan closed it
  });
});

describe("DryRunExecutor – positions, netting and the account", () => {
  test("buying more averages the entry price", async () => {
    const w = setup();
    await goLong(w, 100000, 0.005); // 100005
    w.tick(101000);
    await place(w, { side: "buy", size: 0.005 }); // 101005
    const [pos] = await w.ex.getPositions();
    assert.equal(pos?.size, 0.01);
    closeTo(pos?.price ?? 0, 100505);
  });

  test("closing realises PnL and the account shows equity after fees", async () => {
    const w = setup();
    await goLong(w, 100000, 0.01); // buy at 100005, fee 0.500025
    w.tick(101000);
    await place(w, { side: "sell", size: 0.01 }); // sell at bid 100995, fee 0.504975
    const fills = await w.ex.getFills(new Date(0));
    assert.equal(fills[0]?.realized_pnl, 0);
    closeTo(fills[1]?.realized_pnl ?? NaN, 9.9);
    const a = await w.ex.getAccount();
    closeTo(a.realizedPnl, 9.9);
    closeTo(a.fees, 1.005);
    closeTo(a.unrealizedPnl, 0);
    closeTo(a.equity, 1000 + 9.9 - 1.005);
    closeTo(a.availableMargin, a.equity);
    assert.deepEqual(await w.ex.getPositions(), []);
  });

  test("an order larger than the position (not reduce-only) closes it and opens the remainder the other way", async () => {
    const w = setup();
    await goLong(w, 100000, 0.01);
    await place(w, { side: "sell", size: 0.02 });
    const [pos] = await w.ex.getPositions();
    assert.equal(pos?.side, "short");
    assert.equal(pos?.size, 0.01);
  });

  test("a short position reports side short and a positive size", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { side: "sell" });
    const [pos] = await w.ex.getPositions();
    assert.equal(pos?.side, "short");
    assert.equal(pos?.size, 0.01);
    assert.equal(pos?.price, 99995);
  });

  test("unrealised PnL and available margin follow the mark price", async () => {
    const w = setup();
    await goLong(w, 100000, 0.01); // entry 100005
    w.tick(101005);
    const a = await w.ex.getAccount();
    closeTo(a.unrealizedPnl, 10);
    closeTo(a.equity, 1000 - 0.500025 + 10);
    closeTo(a.availableMargin, a.equity - (0.01 * 101005) / 2);
    closeTo((await w.ex.getPositions())[0]?.unrealizedPnl ?? NaN, 10);
  });
});

describe("DryRunExecutor – order bookkeeping", () => {
  test("a repeated cliOrdId returns the same order and creates no second one", async () => {
    const w = setup();
    w.tick(100000);
    const a = await place(w, { orderType: "lmt", limitPrice: 99000, cliOrdId: "bot-1-entry-0" });
    const b = await place(w, { orderType: "lmt", limitPrice: 99000, cliOrdId: "bot-1-entry-0" });
    assert.equal(a, b);
    assert.equal((await w.ex.getOpenOrders()).length, 1);
  });

  test("idempotency survives the order being filled or cancelled (a retry never re-opens it)", async () => {
    const w = setup();
    w.tick(100000);
    const a = await place(w, { orderType: "mkt", cliOrdId: "bot-1-entry-0" });
    assert.equal(await place(w, { orderType: "mkt", cliOrdId: "bot-1-entry-0" }), a);
    assert.equal((await w.ex.getPositions())[0]?.size, 0.01); // not 0.02

    const c = await place(w, { orderType: "lmt", limitPrice: 99000, cliOrdId: "bot-1-entry-1" });
    await w.ex.cancelOrder({ cliOrdId: "bot-1-entry-1" });
    assert.equal(await place(w, { orderType: "lmt", limitPrice: 99000, cliOrdId: "bot-1-entry-1" }), c);
    assert.deepEqual(await w.ex.getOpenOrders(), []);
  });

  test("invalid requests are rejected as unknown, never throw, and store nothing", async () => {
    const w = setup();
    w.tick(100000);
    const bad: Partial<OrderRequest>[] = [
      { size: 0 }, { size: -1 }, { size: Number.NaN }, { cliOrdId: "" }, { cliOrdId: "x".repeat(101) },
      { symbol: "PF_ETHUSD" }, { orderType: "lmt" }, { orderType: "lmt", limitPrice: Number.NaN },
      { orderType: "stp", reduceOnly: false }, { orderType: "stp", stopPrice: Number.NaN },
      { orderType: "stp", stopPrice: 99000, limitPrice: 98900 }, // stop-limit is not supported: stop-market only
      { processBefore: new Date(T0).toISOString() }, // already in the past
    ];
    for (const over of bad) {
      const r = await w.ex.placeOrder(req(over));
      assert.ok(!r.ok, JSON.stringify(over));
      assert.equal(r.kind, "unknown", JSON.stringify(over));
    }
    assert.deepEqual(await w.ex.getOpenOrders(), []);
    assert.deepEqual(await w.ex.getPositions(), []);
  });

  test("cancelOrder works by cliOrdId and by orderId, and is idempotent for unknown orders", async () => {
    const w = setup();
    w.tick(100000);
    const id = await place(w, { orderType: "lmt", limitPrice: 99000, cliOrdId: "bot-1-entry-0" });
    await place(w, { orderType: "lmt", limitPrice: 98000, cliOrdId: "bot-1-entry-1" });
    await w.ex.cancelOrder({ orderId: id });
    assert.deepEqual((await w.ex.getOpenOrders()).map((o) => o.cliOrdId), ["bot-1-entry-1"]);
    await w.ex.cancelOrder({ cliOrdId: "bot-1-entry-1" });
    await w.ex.cancelOrder({ cliOrdId: "never-existed" });
    await w.ex.cancelOrder({ orderId: "sim-999" });
    assert.deepEqual(await w.ex.getOpenOrders(), []);
  });

  test("cancelAll cancels the open orders of that symbol only", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { orderType: "lmt", limitPrice: 99000 });
    await place(w, { orderType: "lmt", limitPrice: 98000 });
    await w.ex.cancelAll("PF_ETHUSD");
    assert.equal((await w.ex.getOpenOrders()).length, 2);
    await w.ex.cancelAll("PF_XBTUSD");
    assert.deepEqual(await w.ex.getOpenOrders(), []);
  });

  test("editOrder moves a stop; an unknown or finished order is rejected", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, cliOrdId: "bot-1-sl-0" });
    const ok = await w.ex.editOrder({ cliOrdId: "bot-1-sl-0", stopPrice: 99500 });
    assert.ok(ok.ok);
    assert.equal((await w.ex.getOpenOrders())[0]?.stopPrice, 99500);
    const unknown = await w.ex.editOrder({ cliOrdId: "bot-1-sl-9", stopPrice: 99500 });
    assert.ok(!unknown.ok);
    assert.equal(unknown.kind, "unknown");
  });

  test("open orders use the real client's shape", async () => {
    const w = setup();
    w.tick(100000);
    await place(w, { orderType: "post", limitPrice: 99000, cliOrdId: "bot-1-entry-0" });
    const [o] = await w.ex.getOpenOrders();
    assert.deepEqual(Object.keys(o ?? {}).sort(), [
      "cliOrdId", "filledSize", "lastUpdateTime", "limitPrice", "orderType", "order_id", "receivedTime", "reduceOnly",
      "side", "status", "symbol", "unfilledSize",
    ]);
    assert.equal(o?.orderType, "lmt"); // post-only is a limit order to the outside
    assert.equal(o?.status, "untouched");
    assert.equal(o?.unfilledSize, 0.01);
    assert.equal(o?.receivedTime, new Date(w.clock.now()).toISOString());

    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, cliOrdId: "bot-1-sl-0" }); // below the market: rests
    const stop = (await w.ex.getOpenOrders()).find((x) => x.cliOrdId === "bot-1-sl-0");
    assert.equal(stop?.orderType, "stp");
    assert.equal(stop?.stopPrice, 99000);
    assert.equal(stop?.triggerSignal, "mark"); // the default
  });

  test("fills carry the order id and cliOrdId, have unique ids, and can be listed from a time", async () => {
    const w = setup();
    w.tick(100000);
    const id = await place(w, { cliOrdId: "bot-1-entry-0" });
    w.tick(100500);
    await place(w, { side: "sell", cliOrdId: "bot-1-close-0" });
    const all = await w.ex.getFills(new Date(0));
    assert.equal(all.length, 2);
    assert.equal(all[0]?.order_id, id);
    assert.equal(all[0]?.cliOrdId, "bot-1-entry-0");
    assert.notEqual(all[0]?.fill_id, all[1]?.fill_id);
    assert.equal(all[0]?.fillTime, new Date(T0 + 1000).toISOString());
    assert.equal((await w.ex.getFills(new Date(T0 + 2000))).length, 1);
  });
});

describe("DryRunExecutor – state lives in the store", () => {
  test("a new executor on the same store sees the same positions, orders, fills and account", async () => {
    const w = setup();
    await goLong(w);
    await place(w, { side: "sell", orderType: "stp", stopPrice: 99000, reduceOnly: true, cliOrdId: "bot-1-sl-0" });
    const again = new DryRunExecutor({ store: w.store, clock: w.clock, config });
    assert.deepEqual(await again.getPositions(), await w.ex.getPositions());
    assert.deepEqual(await again.getOpenOrders(), await w.ex.getOpenOrders());
    assert.deepEqual(await again.getFills(new Date(0)), await w.ex.getFills(new Date(0)));
    assert.deepEqual(await again.getAccount(), await w.ex.getAccount());
  });

  test("two executors on one store see each other's orders at once (trader and watchdog share the file)", async () => {
    const w = setup();
    const other = new DryRunExecutor({ store: w.store, clock: w.clock, config });
    w.tick(100000);
    await other.placeOrder(req({ orderType: "lmt", limitPrice: 99000, cliOrdId: "bot-1-entry-0" }));
    assert.equal((await w.ex.getOpenOrders()).length, 1);
    w.tick(98999); // fed to one executor only
    assert.deepEqual(await other.getOpenOrders(), []);
    assert.equal((await other.getPositions())[0]?.size, 0.01);
  });

  test("ids and the quote clock survive a restart: the next order id does not repeat", async () => {
    const w = setup();
    w.tick(100000);
    const a = await place(w, { orderType: "lmt", limitPrice: 99000 });
    const again = new DryRunExecutor({ store: w.store, clock: w.clock, config });
    const r = await again.placeOrder(req({ orderType: "lmt", limitPrice: 98000 }));
    assert.ok(r.ok);
    assert.notEqual(r.orderId, a);
    again.onPrice(px(98000, T0)); // older than the stored last tick: still ignored after a restart
    assert.equal((await again.getOpenOrders()).length, 2);
  });
});
