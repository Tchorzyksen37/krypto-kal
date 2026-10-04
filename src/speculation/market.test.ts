// speculation/market.test.ts – offline tests of the measurements taken from raw Kraken Futures data.
// Run: node --test src/speculation/market.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FuturesCandle } from "../providers/kraken/kraken-futures-client.ts";
import {
  baseOf, candlesOk, depthUsd, fundingPct8h, futuresOf, isLinearPerp, openInterestUsd, spreadBps, trueRanges, volatility, volumeUsd24h,
} from "./market.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z") / 1000;
// hourly candles ending at NOW - 3600, each with range `r(i)` around 100
const hourly = (n: number, r: (i: number) => number = () => 1): FuturesCandle[] =>
  Array.from({ length: n }, (_, i) => ({ t: NOW - (n - i) * 3600, o: 100, h: 100 + r(i) / 2, l: 100 - r(i) / 2, c: 100, v: 10 }));

describe("volatility", () => {
  test("true range uses the previous close for gaps", () => {
    const c: FuturesCandle[] = [
      { t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 },
      { t: 3600, o: 105, h: 106, l: 104, c: 105, v: 1 }, // gap up: TR = 106 - 100
    ];
    assert.deepEqual(trueRanges(c), [6]);
  });

  test("ATR is the mean TR of the last 14 hours; the ratio compares the last 3 with the 24-hour median", () => {
    const calm = volatility(hourly(30))!;
    assert.equal(calm.atr_1h, 1);
    assert.equal(calm.atrRatio, 1);
    const hot = volatility(hourly(30, (i) => (i >= 27 ? 4 : 1)))!;
    assert.equal(hot.atrRatio, 4);
    assert.ok(hot.atr_1h > 1);
    assert.equal(volatility(hourly(10)), undefined);
  });

  test("candlesOk needs a complete, recent last day", () => {
    assert.equal(candlesOk(hourly(30), NOW), true);
    const gap = hourly(30).filter((_, i) => i !== 20);
    assert.equal(candlesOk(gap, NOW), false);
    assert.equal(candlesOk(hourly(30), NOW + 5 * 3600), false); // stale
  });
});

describe("book, funding and symbols", () => {
  test("spread in basis points of mid", () => {
    assert.equal(spreadBps({ bid: 99.99, ask: 100.01 }), 2);
    assert.equal(spreadBps({ bid: 0, ask: 1 }), Number.POSITIVE_INFINITY);
  });

  test("depth: USD within 0.2% of mid on the thinner side", () => {
    const book = {
      symbol: "PF_X",
      bids: [{ price: 100, size: 10 }, { price: 99.9, size: 10 }, { price: 99, size: 1000 }], // 99 is outside 0.2%
      asks: [{ price: 100.1, size: 5 }, { price: 100.2, size: 5 }],
    };
    assert.equal(depthUsd(book), Math.min(100 * 10 + 99.9 * 10, 100.1 * 5 + 100.2 * 5));
    assert.equal(depthUsd({ symbol: "PF_X", bids: [], asks: [] }), 0);
  });

  test("Kraken's hourly absolute funding becomes percent per 8 hours", () => {
    // 0.65 USD per contract per hour at 65000 = 0.001%/h = 0.008%/8h
    assert.equal(fundingPct8h({ fundingRate: 0.65, markPrice: 65000 }), 0.008);
    assert.equal(fundingPct8h({ markPrice: 65000 }), 0);
  });

  test("volume and open interest in USD", () => {
    assert.equal(volumeUsd24h({ volumeQuote: 5e6, vol24h: 1, last: 2 }), 5e6);
    assert.equal(volumeUsd24h({ vol24h: 100, last: 2 }), 200);
    assert.equal(openInterestUsd({ openInterest: 10, markPrice: 3 }), 30);
  });

  test("symbol mapping handles Kraken's XBT", () => {
    assert.equal(baseOf("PF_XBTUSD"), "BTC");
    assert.equal(baseOf("PF_XRPUSD"), "XRP");
    assert.equal(futuresOf("BTC"), "PF_XBTUSD");
    assert.equal(futuresOf("eth"), "PF_ETHUSD");
    assert.equal(isLinearPerp({ symbol: "PF_XBTUSD", tag: "perpetual", suspended: false }), true);
    assert.equal(isLinearPerp({ symbol: "PI_XBTUSD", tag: "perpetual", suspended: false }), false);
    assert.equal(isLinearPerp({ symbol: "FF_XBTUSD_261225", tag: "month", suspended: false }), false);
    assert.equal(isLinearPerp({ symbol: "PF_ABCUSD", tag: "perpetual", suspended: true }), false);
  });
});
