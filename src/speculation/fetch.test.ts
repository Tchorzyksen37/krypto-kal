// speculation/fetch.test.ts – offline tests of gathering candles and fills for the scorer (fake Kraken Futures).
// Run: node --test src/speculation/fetch.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FuturesCandle, FuturesFill } from "../providers/kraken/kraken-futures-client.ts";
import { setLogLevel } from "../core/logger.ts";
import { TradeStore } from "../trading/trade-store.ts";
import { candleRanges, fetchCandles, fillsFrom, gatherInput, type CandleSource } from "./fetch.ts";
import type { Bet, LoggedBet } from "./types.ts";

setLogLevel("error");

const T0 = Date.parse("2026-10-03T14:00:00Z") / 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const bet = (id: string, futures: string, startMin: number, closeMin: number, over: Partial<LoggedBet> = {}): LoggedBet => ({
  id, symbol: futures.slice(3, 6), futures, side: "long", entry: 2.39, stop_loss: 2.36, take_profit: 2.45, ttl_minutes: 45,
  probability: 0.4, rr: 2, ev_r: 0.1, break_even: 0.36,
  fill_from: iso(T0 + startMin * 60), entry_deadline: iso(T0 + (startMin + 30) * 60), latest_close: iso(T0 + closeMin * 60),
  report: "r.md", generated: iso(T0 - 1200), ...over,
} as Bet & LoggedBet);

// A fake charts API with one candle per minute, returning at most 2000 per call (like Kraken).
function fakeCandles(missing: (t: number) => boolean = () => false) {
  const calls: { from?: number; to?: number }[] = [];
  const source: CandleSource = {
    async candles(_symbol, _res, range) {
      calls.push(range);
      const out: FuturesCandle[] = [];
      for (let t = range.from!; t <= range.to! && out.length < 2000; t += 60) if (!missing(t)) out.push({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
      return { candles: out, moreCandles: false };
    },
  };
  return { source, calls };
}

describe("candleRanges", () => {
  test("covers each unresolved bet from its fill start to its latest close, merged per contract and capped at now", () => {
    const log = [
      bet("a", "PF_XRPUSD", 0, 75),
      bet("b", "PF_XRPUSD", 60, 120), // overlaps a
      bet("c", "PF_XRPUSD", 600, 700), // separate
      bet("d", "PF_XBTUSD", 0, 75, { hypothetical: { status: "tp" } }), // already final: not needed
      bet("e", "PF_ETHUSD", 0, 75, { hypothetical: { status: "open" } }), // still open: needed
    ];
    const r = candleRanges(log, T0 + 650 * 60);
    assert.deepEqual(r.get("PF_XRPUSD"), [{ from: T0 - 60, to: T0 + 121 * 60 }, { from: T0 + 599 * 60, to: T0 + 650 * 60 }]);
    assert.equal(r.has("PF_XBTUSD"), false);
    assert.ok(r.has("PF_ETHUSD"));
  });

  test("a bet in the future needs nothing yet", () => {
    assert.equal(candleRanges([bet("a", "PF_XRPUSD", 100, 200)], T0).size, 0);
  });
});

describe("fetchCandles", () => {
  test("pages through the 2000-candle limit without gaps or duplicates", async () => {
    const { source, calls } = fakeCandles();
    const range = { from: T0, to: T0 + 5000 * 60 };
    const c = await fetchCandles(source, "PF_XRPUSD", range);
    assert.equal(c.length, 5001);
    assert.ok(c.every((x, i) => i === 0 || x.t - c[i - 1]!.t === 60));
    assert.equal(calls.length, 3);
  });

  test("an empty stretch does not stop the paging", async () => {
    const { source } = fakeCandles((t) => t >= T0 && t < T0 + 2500 * 60); // the first 2500 minutes have no trades
    const c = await fetchCandles(source, "PF_XRPUSD", { from: T0, to: T0 + 3000 * 60 });
    assert.equal(c[0]!.t, T0 + 2500 * 60);
    assert.equal(c.length, 501);
  });
});

describe("fills", () => {
  const apiFill = (id: string, min: number, side: "buy" | "sell", price: number): FuturesFill => ({
    fill_id: id, order_id: `o-${id}`, symbol: "PF_XRPUSD", side, size: 100, price, fillTime: iso(T0 + min * 60), fillType: "maker",
  });

  test("fillsFrom starts at the oldest recent bet without a match and ignores old ones", () => {
    const now = T0 + 86_400;
    const log = [
      bet("a", "PF_XRPUSD", 0, 75),
      bet("b", "PF_XRPUSD", -60, 0, { actual: { entryFill: 1, entryAt: 1, slippagePct: 0, size: 1 } }),
      bet("old", "PF_XRPUSD", -30 * 1440, -30 * 1440 + 75),
    ];
    assert.equal(fillsFrom(log, now), T0 * 1000);
    assert.equal(fillsFrom([], now), undefined);
  });

  test("gatherInput syncs fills into the store and returns them with order id and fill type", async () => {
    const store = new TradeStore(":memory:");
    const all = [apiFill("f1", 6, "buy", 2.39), apiFill("f2", 20, "sell", 2.45), apiFill("early", -600, "buy", 2.3)];
    const fillSource = { async fills() { return all; } };
    const { input, warnings } = await gatherInput([bet("a", "PF_XRPUSD", 0, 75)], T0 + 100 * 60, {
      candles: fakeCandles().source, fills: { source: fillSource, store },
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(input.fills.map((f) => f.id).sort(), ["f1", "f2"]); // "early" is before the bet window
    assert.equal(input.fills.find((f) => f.id === "f1")!.fillType, "maker");
    assert.equal(input.fills.find((f) => f.id === "f1")!.orderId, "o-f1");
    assert.ok(input.candles.PF_XRPUSD!.length > 70);
    store.close();
  });

  test("without keys only candles are gathered, with a warning", async () => {
    const { input, warnings } = await gatherInput([bet("a", "PF_XRPUSD", 0, 75)], T0 + 100 * 60, { candles: fakeCandles().source });
    assert.deepEqual(input.fills, []);
    assert.match(warnings[0]!, /only hypothetical outcomes/);
  });

  test("a failing candle request becomes a warning, not a crash", async () => {
    const broken: CandleSource = { async candles() { throw new Error("HTTP 503"); } };
    const { input, warnings } = await gatherInput([bet("a", "PF_XRPUSD", 0, 75)], T0 + 100 * 60, { candles: broken });
    assert.deepEqual(input.candles.PF_XRPUSD, []);
    assert.match(warnings.join(" "), /PF_XRPUSD failed: HTTP 503/);
  });
});
