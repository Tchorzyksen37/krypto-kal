// liquidation-heatmap.test.ts – offline tests of the liquidation heatmap model.
// Run: npm run test:offline

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { estimateLiquidationHeatmap, type HeatmapBar } from "./liquidation-heatmap.ts";

const bar = (t: number, c: number, oi: number, longShare = 0.5, h = c, l = c): HeatmapBar => ({ t, h, l, c, oi, longShare });
const one = { tiers: [{ leverage: 10, weight: 1 }], maintenanceMargin: 0, bucketPct: 1, rangePct: 50 };

describe("estimateLiquidationHeatmap", () => {
  test("new open interest becomes long liquidations below and short above", () => {
    const h = estimateLiquidationHeatmap([bar(1, 100, 1000, 0.6)], one);
    assert.equal(h.totals.longBelow, 600);
    assert.equal(h.totals.shortAbove, 400);
    const longB = h.buckets.find((b) => b.long > 0)!;
    const shortB = h.buckets.find((b) => b.short > 0)!;
    assert.ok(Math.abs(longB.price - 90) < 1, `long near 90, got ${longB.price}`);
    assert.ok(Math.abs(shortB.price - 110) < 1, `short near 110, got ${shortB.price}`);
  });

  test("a cohort is removed once the price trades through its liquidation level", () => {
    const h = estimateLiquidationHeatmap(
      [bar(1, 100, 1000, 1), bar(2, 95, 1000, 1, 100, 89), bar(3, 100, 1000, 1)],
      one,
    );
    // The first cohort (liq 90) was wiped by the low of 89; the OI is then refilled at 100 -> liq 90 again.
    assert.equal(h.totals.longBelow, 1000);
    assert.equal(h.totals.modelOi, 1000);
    // ... but if OI stays lower the wiped cohort is not resurrected.
    const h2 = estimateLiquidationHeatmap([bar(1, 100, 1000, 1), bar(2, 95, 400, 1, 100, 89)], one);
    assert.equal(h2.totals.modelOi, 400);
    assert.ok(h2.buckets.every((b) => b.price > 80));
  });

  test("falling open interest shrinks surviving cohorts proportionally", () => {
    const h = estimateLiquidationHeatmap([bar(1, 100, 1000, 0.5), bar(2, 100, 500, 0.5)], one);
    assert.equal(h.totals.modelOi, 500);
    assert.equal(h.totals.longBelow, 250);
  });

  test("model OI always matches the real OI and maintenance margin moves the levels closer", () => {
    const bars = [bar(1, 100, 1000), bar(2, 102, 1300, 0.7), bar(3, 99, 1100, 0.4), bar(4, 101, 1500, 0.5)];
    const h = estimateLiquidationHeatmap(bars);
    assert.ok(Math.abs(h.totals.modelOi - 1500) <= 1);
    const tight = estimateLiquidationHeatmap([bar(1, 100, 1000, 1)], { ...one, maintenanceMargin: 0.02 });
    const loose = estimateLiquidationHeatmap([bar(1, 100, 1000, 1)], one);
    assert.ok(tight.buckets[0]!.price > loose.buckets[0]!.price);
  });

  test("clusters are sorted by size and carry the distance from the price", () => {
    const h = estimateLiquidationHeatmap([bar(1, 100, 1000, 0.5)], {
      tiers: [{ leverage: 10, weight: 3 }, { leverage: 20, weight: 1 }], maintenanceMargin: 0, bucketPct: 1, rangePct: 50,
    });
    assert.ok(h.clusters[0]!.long + h.clusters[0]!.short >= h.clusters.at(-1)!.long + h.clusters.at(-1)!.short);
    assert.ok(Math.abs(h.clusters[0]!.distancePct) > 5);
  });

  test("rejects empty input and leverage-free tiers", () => {
    assert.throws(() => estimateLiquidationHeatmap([]));
    assert.throws(() => estimateLiquidationHeatmap([bar(1, 100, 1)], { tiers: [{ leverage: 1, weight: 1 }] }));
  });
});
