// sizing.test.ts – offline tests of position sizing, price rounding, the TP ladder and pre-trade validation.
// Run: node --test bot/sizing.test.ts
//
// Contract pinned here (docs/superpowers/specs/2026-10-03-trader-core-design.md, section 5):
//  - planTrade never throws on bad numbers; it returns { ok: false, reason } with a stable reason string.
//  - Rounding is never in the bot's favour: the stop moves away from the entry, targets move toward it.
//  - The hard risk cap applies after the conviction multiplier. Leverage caps the size. The stop never moves.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type BotConfig, defaultConfig } from "./config.ts";
import type { ResolvedScenario } from "./policy.ts";
import {
  type Contract, type TradeInput, ceilTo, computeSize, convictionMultiplier, estimateLiquidation, floorTo,
  planTrade, splitLadder,
} from "./sizing.ts";

const closeTo = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} to be within ${eps} of ${expected}`);

const contract: Contract = { tickSize: 0.5, sizeStep: 0.0001, minSize: 0.0001 };

describe("floorTo / ceilTo", () => {
  test("round to a multiple of the step without float noise", () => {
    assert.equal(floorTo(0.3, 0.1), 0.3);
    assert.equal(ceilTo(0.3, 0.1), 0.3);
    assert.equal(floorTo(99999.9, 0.5), 99999.5);
    assert.equal(ceilTo(98000.1, 0.5), 98000.5);
    assert.equal(floorTo(0.00409, 0.0001), 0.0040);
    assert.equal(floorTo(0.004, 0.0001), 0.004); // 0.004 / 0.0001 is 40.00000000000001 in floats
  });
});

describe("convictionMultiplier", () => {
  test("is linear from 0.5 (no conviction) to the cap (full conviction)", () => {
    assert.equal(convictionMultiplier(0, 1.25), 0.5);
    assert.equal(convictionMultiplier(1, 1.25), 1.25);
    closeTo(convictionMultiplier(0.5, 1.25), 0.875);
  });
});

describe("estimateLiquidation (isolated margin approximation)", () => {
  test("long is below the entry, short above, by 1/leverage - mmr", () => {
    closeTo(estimateLiquidation({ side: "long", entry: 100, leverage: 2, mmr: 0.005 }), 50.5);
    closeTo(estimateLiquidation({ side: "short", entry: 100, leverage: 2, mmr: 0.005 }), 149.5);
  });

  test("at or beyond the leverage where margin no longer covers mmr, liquidation sits at the entry", () => {
    assert.equal(estimateLiquidation({ side: "long", entry: 100, leverage: 200, mmr: 0.005 }), 100);
    assert.equal(estimateLiquidation({ side: "long", entry: 100, leverage: 500, mmr: 0.005 }), 100);
  });
});

describe("computeSize", () => {
  const base = {
    capital: 1000, riskBudgetPct: 0.5, maxRiskPct: 0.5, conviction: 1, convictionCap: 1.25, maxLeverage: 2,
    entry: 99250, stop: 98000, contract,
  };

  test("size = capital x risk% / stop distance, rounded down to the step", () => {
    const r = computeSize(base);
    assert.ok(!("reject" in r));
    assert.equal(r.size, 0.004); // $5 of risk / $1250 of stop distance
    closeTo(r.riskUsd, 5);
    closeTo(r.riskPct, 0.5);
    assert.equal(r.convictionMult, 1.25);
  });

  test("the hard cap applies after the multiplier: 0.5% x 1.25 never becomes 0.625%", () => {
    const r = computeSize(base);
    assert.ok(!("reject" in r));
    assert.ok(r.riskPct <= base.maxRiskPct + 1e-12);
  });

  test("low conviction shrinks the position", () => {
    const r = computeSize({ ...base, riskBudgetPct: 0.4, conviction: 0 }); // mult 0.5 -> 0.2% -> $2
    assert.ok(!("reject" in r));
    assert.equal(r.size, 0.0016);
  });

  test("a short sizes by the absolute distance", () => {
    const r = computeSize({ ...base, entry: 99250, stop: 100500 });
    assert.ok(!("reject" in r));
    assert.equal(r.size, 0.004);
  });

  test("rounds down, never up, so realised risk never exceeds the allowed risk", () => {
    const r = computeSize({ ...base, riskBudgetPct: 0.408, maxRiskPct: 1 }); // $5.10 -> 0.00408 -> 0.0040
    assert.ok(!("reject" in r));
    assert.equal(r.size, 0.004);
    assert.ok(r.riskUsd <= 5.1);
  });

  test("a tight stop is capped by max_leverage, not by risk", () => {
    const r = computeSize({ ...base, stop: 99200 }); // $50 distance: risk alone would allow 0.1 BTC
    assert.ok(!("reject" in r));
    assert.equal(r.size, 0.0201); // floor(1000 x 2 / 99250, step); 0.0201 x 99250 = $1995 <= $2000
    closeTo(r.riskUsd, 0.0201 * 50);
  });

  test("below the minimum size is size_below_min", () => {
    assert.deepEqual(computeSize({ ...base, riskBudgetPct: 0.01, conviction: 0 }), { reject: "size_below_min" });
  });

  test("stop equal to entry is zero_stop_distance, not a division by zero", () => {
    assert.deepEqual(computeSize({ ...base, stop: base.entry }), { reject: "zero_stop_distance" });
  });

  test("bad numbers are invalid_input and never throw", () => {
    for (const bad of [
      { capital: 0 }, { capital: Number.NaN }, { entry: Number.NaN }, { entry: -1 }, { stop: Number.NaN },
      { riskBudgetPct: -1 }, { riskBudgetPct: Number.NaN }, { conviction: Number.NaN }, { maxLeverage: 0 },
      { contract: { ...contract, sizeStep: 0 } }, { contract: { ...contract, minSize: Number.NaN } },
    ]) {
      assert.deepEqual(computeSize({ ...base, ...bad }), { reject: "invalid_input" }, JSON.stringify(bad));
    }
  });
});

describe("splitLadder", () => {
  const prices = [102000, 104000, 106000];

  test("splits in whole size steps, the remainder going to the nearest rung", () => {
    assert.deepEqual(splitLadder(prices, 0.0005, contract), [
      { price: 102000, size: 0.0003 }, { price: 104000, size: 0.0001 }, { price: 106000, size: 0.0001 },
    ]);
    assert.deepEqual(splitLadder(prices, 0.003, contract), [
      { price: 102000, size: 0.001 }, { price: 104000, size: 0.001 }, { price: 106000, size: 0.001 },
    ]);
  });

  test("collapses to the nearest fewer rungs when a rung would fall below the minimum size", () => {
    assert.deepEqual(splitLadder(prices, 0.0002, contract), [
      { price: 102000, size: 0.0001 }, { price: 104000, size: 0.0001 },
    ]);
    assert.deepEqual(splitLadder(prices, 0.0001, contract), [{ price: 102000, size: 0.0001 }]);
  });

  test("sizes always sum to the position", () => {
    for (let units = 1; units <= 60; units++) {
      const size = Number((units * 0.0001).toFixed(4));
      const total = splitLadder(prices, size, contract).reduce((s, r) => s + Math.round(r.size / 0.0001), 0);
      assert.equal(total, units, `size ${size}`);
    }
  });
});

describe("planTrade", () => {
  const config: BotConfig = defaultConfig(); // capital 1000, max_leverage 2, R:R 1.5, noise floor 1 x ATR, fees 2+5 bps
  const longScenario: ResolvedScenario = {
    direction: "long", entryLow: 99000, entryHigh: 99500, targets: [102000, 104000], stop: 98000, horizonHours: 24,
  };
  const shortScenario: ResolvedScenario = {
    direction: "short", entryLow: 99000, entryHigh: 99500, targets: [95000, 92000], stop: 102000, horizonHours: 24,
  };
  const input = (over: Partial<TradeInput> = {}): TradeInput => ({
    scenario: longScenario, entry: 99250, atr: 800, conviction: 1, riskBudgetPct: 0.5, fundingBpsPerHour: 0,
    config, contract, ...over,
  });
  const rejected = (i: TradeInput, reason: string) => {
    const r = planTrade(i);
    assert.ok(!r.ok, `expected ${reason}, got a plan`);
    assert.equal(r.reason, reason);
  };
  const planned = (i: TradeInput) => {
    const r = planTrade(i);
    assert.ok(r.ok, r.ok ? "" : `expected a plan, got ${r.reason}`);
    return r;
  };

  test("a valid long: size, ladder, stop, leverage and reward/risk", () => {
    const p = planned(input());
    assert.equal(p.size, 0.004);
    closeTo(p.riskUsd, 5);
    assert.equal(p.stop, 98000);
    assert.deepEqual(p.ladder, [{ price: 102000, size: 0.002 }, { price: 104000, size: 0.002 }]);
    assert.equal(p.leverage, 2);
    closeTo(p.rewardRisk, 3); // average reward 3750 / stop distance 1250
  });

  test("a valid short mirrors it", () => {
    const p = planned(input({ scenario: shortScenario }));
    assert.equal(p.size, 0.0018); // $5 / $2750, rounded down
    assert.equal(p.stop, 102000);
    assert.deepEqual(p.ladder, [{ price: 95000, size: 0.0009 }, { price: 92000, size: 0.0009 }]);
  });

  test("ladder sizes sum to the position and the nearest rung comes first", () => {
    const p = planned(input({ scenario: { ...longScenario, targets: [102000, 104000, 106000] } }));
    assert.equal(p.ladder.reduce((s, r) => s + Math.round(r.size / 0.0001), 0), Math.round(p.size / 0.0001));
    assert.deepEqual(p.ladder.map((r) => r.price), [102000, 104000, 106000]);
  });

  describe("rounding is never in the bot's favour", () => {
    const coarse: Contract = { tickSize: 1000, sizeStep: 0.0001, minSize: 0.0001 };

    test("long: the stop rounds down (wider), targets round down (toward the entry)", () => {
      const p = planned(input({ contract: coarse, scenario: { ...longScenario, stop: 98400, targets: [102500, 104900] } }));
      assert.equal(p.stop, 98000);
      assert.deepEqual(p.ladder.map((r) => r.price), [102000, 104000]);
    });

    test("short: the stop rounds up (wider), targets round up (toward the entry)", () => {
      const p = planned(input({ contract: coarse, scenario: { ...shortScenario, stop: 101600, targets: [95100, 92100] } }));
      assert.equal(p.stop, 102000);
      assert.deepEqual(p.ladder.map((r) => r.price), [96000, 93000]);
    });

    test("a target that rounds onto or past the entry is dropped; none left means no entry", () => {
      rejected(input({ contract: coarse, scenario: { ...longScenario, targets: [99900] } }), "no_target_beyond_entry");
    });

    test("targets that round to the same price become one rung", () => {
      const p = planned(input({ contract: coarse, scenario: { ...longScenario, targets: [102100, 102900] } }));
      assert.deepEqual(p.ladder, [{ price: 102000, size: 0.004 }]);
    });
  });

  describe("stop checks", () => {
    test("stop equal to entry is zero_stop_distance", () => {
      rejected(input({ entry: 98000 }), "zero_stop_distance");
    });

    test("stop on the wrong side of the entry is stop_not_beyond_entry", () => {
      rejected(input({ scenario: { ...longScenario, stop: 99300 } }), "stop_not_beyond_entry");
      rejected(input({ scenario: { ...shortScenario, stop: 99000 } }), "stop_not_beyond_entry");
    });

    test("closer than sl_min_atr_multiple x ATR is stop_inside_noise_floor; exactly at the floor is fine", () => {
      rejected(input({ atr: 1250.01 }), "stop_inside_noise_floor");
      planned(input({ atr: 1250 }));
    });
  });

  describe("targets, costs and reward/risk", () => {
    test("reward/risk below min_reward_risk is reward_risk_too_low", () => {
      rejected(input({ scenario: { ...longScenario, targets: [100000] } }), "reward_risk_too_low"); // 750 / 1250 = 0.6
    });

    test("a target that does not clear round-trip fees is dropped; none left is target_within_costs", () => {
      rejected(input({ scenario: { ...longScenario, targets: [99260] } }), "target_within_costs"); // fees ~ 69.5
    });

    test("expected funding is added to the cost for the side that pays it", () => {
      // 150 above the entry clears fees alone (69.5) but not fees plus 24 h x 5 bps/h of funding (~1260)
      const near = { ...longScenario, targets: [99400] };
      rejected(input({ scenario: near }), "reward_risk_too_low");
      rejected(input({ scenario: near, fundingBpsPerHour: 5 }), "target_within_costs");
    });

    test("funding the bot would receive is never credited", () => {
      const paid = planTrade(input({ fundingBpsPerHour: -3 }));
      assert.deepEqual(paid, planTrade(input({ fundingBpsPerHour: 0 })));
    });

    test("for a short, negative funding is the cost", () => {
      const near = { ...shortScenario, targets: [99100, 92000] };
      assert.ok(planTrade(input({ scenario: near, fundingBpsPerHour: -20 })).ok); // far target still clears costs
      rejected(input({ scenario: { ...shortScenario, targets: [99100] }, fundingBpsPerHour: -20 }), "target_within_costs");
    });
  });

  describe("liquidation", () => {
    test("the stop never moves; the size is reduced so the position fits a leverage that keeps the margin", () => {
      const wide = { ...config, max_risk_per_trade_pct: 100, max_leverage: 100 };
      const p = planned(input({ config: wide, riskBudgetPct: 100 }));
      assert.equal(p.stop, 98000);
      const liq = estimateLiquidation({ side: "long", entry: 99250, leverage: p.leverage, mmr: wide.maintenance_margin_rate });
      assert.ok(99250 - liq >= wide.liq_distance_min_multiple * 1250, "liquidation must be >= k x stop distance away");
      assert.ok((p.size * 99250) / wide.trading_capital_usd <= p.leverage + 1e-9, "the position must fit the leverage");
      assert.ok(p.leverage <= wide.max_leverage);
    });

    test("when even the minimum size cannot satisfy it, there is no entry", () => {
      rejected(input({ config: { ...config, liq_distance_min_multiple: 100_000 } }), "liquidation_too_close");
    });
  });

  describe("size", () => {
    test("below the minimum size is size_below_min", () => {
      rejected(input({ riskBudgetPct: 0.01, conviction: 0 }), "size_below_min");
    });
  });

  describe("bad market numbers are invalid_input, never a throw or a NaN", () => {
    test("ATR, entry, contract and scenario prices", () => {
      for (const bad of [
        { atr: 0 }, { atr: Number.NaN }, { atr: -5 }, { entry: 0 }, { entry: Number.NaN }, { entry: -99250 },
        { fundingBpsPerHour: Number.NaN }, { contract: { ...contract, tickSize: 0 } },
        { scenario: { ...longScenario, stop: Number.NaN } }, { scenario: { ...longScenario, targets: [Number.NaN] } },
      ] as Partial<TradeInput>[]) {
        rejected(input(bad), "invalid_input");
      }
    });
  });
});
