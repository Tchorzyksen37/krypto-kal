// speculation/screen.test.ts – offline tests of symbol screening.
// Run: node --test speculation/screen.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Candidate, filterReason, DEFAULT_SCREEN, screen, screenOptionsFromEnv, setupScore } from "./screen.ts";

const cand = (symbol: string, over: Partial<Candidate> = {}): Candidate => ({
  symbol,
  futures: `PF_${symbol}USD`,
  volumeUsd24h: 100e6,
  openInterestUsd: 50e6,
  spreadBps: 1,
  depthUsd: 500_000,
  candlesOk: true,
  atrRatio: 1,
  oiChange1hPct: 0,
  oiChange4hPct: 0,
  fundingPct: 0,
  longShortRatio: 1,
  liqBurst: 1,
  ...over,
});

describe("setupScore", () => {
  test("is zero for a calm market and grows with each signal", () => {
    assert.equal(setupScore(cand("A")).score, 0);
    assert.equal(setupScore(cand("A")).reason, "no strong signal");
    const hot = setupScore(cand("A", { atrRatio: 2, oiChange1hPct: 3, fundingPct: 0.05, liqBurst: 4 }));
    assert.ok(hot.score > 6);
    assert.match(hot.reason, /ATR 2\.0x/);
  });

  test("a crowded side counts the same in both directions", () => {
    assert.equal(setupScore(cand("A", { longShortRatio: 2 })).score, setupScore(cand("A", { longShortRatio: 0.5 })).score);
  });

  test("never exceeds the sum of weights", () => {
    const max = setupScore(cand("A", { atrRatio: 99, oiChange1hPct: 99, oiChange4hPct: 99, fundingPct: 9, longShortRatio: 99, liqBurst: 99, heatmapDistancePct: 0, xMentions: 99 }));
    assert.ok(max.score <= 11 + 1e-9);
  });
});

describe("filterReason", () => {
  test("names the first failing filter", () => {
    assert.equal(filterReason(cand("A"), DEFAULT_SCREEN), undefined);
    assert.match(filterReason(cand("A", { volumeUsd24h: 1e6 }), DEFAULT_SCREEN)!, /volume/);
    assert.match(filterReason(cand("A", { openInterestUsd: 1e6 }), DEFAULT_SCREEN)!, /open interest/);
    assert.match(filterReason(cand("A", { spreadBps: 12 }), DEFAULT_SCREEN)!, /spread/);
    assert.match(filterReason(cand("A", { depthUsd: 1000 }), DEFAULT_SCREEN)!, /depth/);
    assert.match(filterReason(cand("A", { candlesOk: false }), DEFAULT_SCREEN)!, /candles/);
  });
});

describe("screen", () => {
  const all = [
    cand("BTC"),
    cand("ETH"),
    cand("XRP"),
    cand("SOL", { atrRatio: 2, fundingPct: 0.04 }),
    cand("DOGE", { oiChange1hPct: 2.5, liqBurst: 3 }),
    cand("ADA", { atrRatio: 1.2 }),
    cand("AVAX", { atrRatio: 1.1 }),
    cand("TINY", { atrRatio: 3, volumeUsd24h: 1e6 }),
  ];

  test("core first in configured order, then the top extras by score", () => {
    const r = screen(all);
    assert.deepEqual(r.picks.map((p) => p.symbol), ["BTC", "ETH", "XRP", "SOL", "DOGE", "ADA"]);
    assert.equal(r.picks[0]!.why, "core");
    assert.match(r.picks[3]!.why, /^screen: /);
  });

  test("illiquid symbols are excluded however hot they are, with the reason", () => {
    const r = screen(all);
    assert.ok(!r.picks.some((p) => p.symbol === "TINY"));
    assert.match(r.excluded.find((e) => e.symbol === "TINY")!.reason, /volume/);
    assert.match(r.excluded.find((e) => e.symbol === "AVAX")!.reason, /ranked below/);
  });

  test("a core symbol is never dropped, only warned about", () => {
    const r = screen([cand("BTC"), cand("ETH", { spreadBps: 20 }), cand("XRP")]);
    const eth = r.picks.find((p) => p.symbol === "ETH")!;
    assert.match(eth.warnings[0]!, /spread/);
    assert.equal(r.picks.length, 3);
  });

  test("a missing core symbol is reported, extra=0 disables screening", () => {
    const r = screen([cand("BTC"), cand("ETH"), cand("SOL", { atrRatio: 3 })], { extra: 0 });
    assert.deepEqual(r.picks.map((p) => p.symbol), ["BTC", "ETH"]);
    assert.match(r.excluded.find((e) => e.symbol === "XRP")!.reason, /missing/);
  });

  test("ties are broken by symbol name so the output is deterministic", () => {
    const r = screen([cand("BTC"), cand("ETH"), cand("XRP"), cand("ZED"), cand("ABC")], { extra: 1 });
    assert.equal(r.picks[3]!.symbol, "ABC");
  });

  test("reads options from the environment", () => {
    assert.deepEqual(screenOptionsFromEnv({ SPECULATION_SYMBOLS: "btc, xrp", SPECULATION_SCREEN_EXTRA: "2", SPECULATION_MIN_VOLUME_USD: "5000000" } as NodeJS.ProcessEnv), {
      core: ["BTC", "XRP"],
      extra: 2,
      minVolumeUsd: 5_000_000,
    });
    assert.deepEqual(screenOptionsFromEnv({} as NodeJS.ProcessEnv), {});
  });
});
