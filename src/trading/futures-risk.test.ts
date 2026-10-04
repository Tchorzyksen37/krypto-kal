// futures-risk.test.ts – offline tests of the futures bot's pre-trade risk limits.
// Run: npm run test:offline

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type RiskLimits, type RiskState, checkOrder, exposure, grossNotional } from "./futures-risk.ts";

const LIMITS: RiskLimits = {
  symbols: ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"],
  maxPositionNotional: 1000,
  maxTotalNotional: 2000,
  maxLeverage: 3,
  maxOpenPositions: 2,
  maxOrderNotional: 600,
  maxOpenOrders: 5,
  maxOrdersPerHour: 10,
  maxDailyLoss: 100,
};

const state = (s: Partial<RiskState> = {}): RiskState => ({
  equity: 1000,
  dayStartEquity: 1000,
  positions: [],
  openOrders: [],
  prices: { PF_XBTUSD: 100, PF_ETHUSD: 10, PF_SOLUSD: 1 },
  ordersLastHour: 0,
  ...s,
});

describe("checkOrder", () => {
  test("allows an order within all limits unchanged", () => {
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 2 }, state(), LIMITS), { action: "allow", size: 2 });
  });

  test("clamps to the max order notional", () => {
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 50 }, state(), LIMITS), {
      action: "allow", size: 6, clampedBy: "max order 600 USD",
    });
  });

  test("clamps to the per-symbol position cap, counting the current position", () => {
    const s = state({ positions: [{ symbol: "PF_XBTUSD", size: 8 }] });
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 5 }, s, LIMITS), {
      action: "allow", size: 2, clampedBy: "max position 1000 USD in PF_XBTUSD",
    });
  });

  test("resting opening orders count toward the cap (worst case)", () => {
    const s = state({
      positions: [{ symbol: "PF_XBTUSD", size: 4 }],
      openOrders: [{ symbol: "PF_XBTUSD", side: "buy", size: 5, reduceOnly: false }],
    });
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 5 }, s, LIMITS), {
      action: "allow", size: 1, clampedBy: "max position 1000 USD in PF_XBTUSD",
    });
  });

  test("a close is treated as opening when resting orders could already flip the position", () => {
    // long 4, resting sell 30 → worst case short 26 (over the 10-contract cap); another sell only adds to it
    const s = state({
      positions: [{ symbol: "PF_XBTUSD", size: 4 }],
      openOrders: [{ symbol: "PF_XBTUSD", side: "sell", size: 30, reduceOnly: false }],
    });
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "sell", size: 4 }, s, LIMITS), {
      action: "reject", reason: "max position 1000 USD in PF_XBTUSD",
    });
    // a reduce-only close is still fine: the exchange guarantees it can't open anything
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "sell", size: 4, reduceOnly: true }, s, LIMITS), { action: "allow", size: 4 });
  });

  test("reduce-only resting orders don't count as exposure", () => {
    const e = exposure(state({
      positions: [{ symbol: "PF_XBTUSD", size: 4 }],
      openOrders: [{ symbol: "PF_XBTUSD", side: "sell", size: 4, reduceOnly: true }],
    })).get("PF_XBTUSD")!;
    assert.deepEqual(e, { position: 4, worstLong: 4, worstShort: 4, worstAbs: 4 });
  });

  test("rejects a new symbol when max open positions is reached", () => {
    const s = state({ positions: [{ symbol: "PF_XBTUSD", size: 1 }, { symbol: "PF_ETHUSD", size: -1 }] });
    assert.deepEqual(checkOrder({ symbol: "PF_SOLUSD", side: "buy", size: 1 }, s, LIMITS), {
      action: "reject", reason: "max 2 open positions",
    });
    // ...but adding to an existing one is fine.
    assert.equal(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 1 }, s, LIMITS).action, "allow");
  });

  test("a pending opening order occupies a position slot", () => {
    const s = state({
      positions: [{ symbol: "PF_XBTUSD", size: 1 }],
      openOrders: [{ symbol: "PF_ETHUSD", side: "sell", size: 1, reduceOnly: false }],
    });
    assert.equal(checkOrder({ symbol: "PF_SOLUSD", side: "buy", size: 1 }, s, LIMITS).action, "reject");
  });

  test("clamps to max leverage when it is tighter than the total cap", () => {
    // equity 500 × 3 = 1500 < 2000; existing 900 → 600 USD of room = 6 contracts
    const s = state({ equity: 500, dayStartEquity: 500, positions: [{ symbol: "PF_ETHUSD", size: 90 }] });
    const d = checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 9 }, s, { ...LIMITS, maxOrderNotional: 10_000 });
    assert.deepEqual(d, { action: "allow", size: 6, clampedBy: "max leverage 3x" });
  });

  test("clamps to the total exposure cap", () => {
    // gross 900 + 500 + 500 = 1900 of 2000; SOL has 500 USD of per-symbol room and 600 of order room
    const s = state({
      equity: 10_000, dayStartEquity: 10_000,
      positions: [{ symbol: "PF_XBTUSD", size: 9 }, { symbol: "PF_ETHUSD", size: -50 }, { symbol: "PF_SOLUSD", size: 500 }],
    });
    assert.deepEqual(checkOrder({ symbol: "PF_SOLUSD", side: "buy", size: 300 }, s, LIMITS), {
      action: "allow", size: 100, clampedBy: "max total exposure 2000 USD",
    });
  });

  test("reducing orders are allowed even when trading is halted or the daily loss is hit", () => {
    const s = state({ equity: 850, positions: [{ symbol: "PF_XBTUSD", size: 3 }], halted: true, ordersLastHour: 99 });
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "sell", size: 3 }, s, LIMITS), { action: "allow", size: 3 });
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "sell", size: 3, reduceOnly: true }, s, LIMITS), { action: "allow", size: 3 });
  });

  test("a flip is cut down to a close when opening is blocked", () => {
    const s = state({ equity: 850, positions: [{ symbol: "PF_XBTUSD", size: 3 }] });
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "sell", size: 5 }, s, LIMITS), {
      action: "allow", size: 3, clampedBy: "daily loss limit (100 USD) reached",
    });
  });

  test("opening is rejected after the daily loss limit", () => {
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 1 }, state({ equity: 900 }), LIMITS), {
      action: "reject", reason: "daily loss limit (100 USD) reached",
    });
  });

  test("reduce-only is capped at the position and rejected without one", () => {
    const s = state({ positions: [{ symbol: "PF_XBTUSD", size: -2 }] });
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 5, reduceOnly: true }, s, LIMITS), {
      action: "allow", size: 2, clampedBy: "reduce-only: position size",
    });
    assert.equal(checkOrder({ symbol: "PF_XBTUSD", side: "sell", size: 1, reduceOnly: true }, s, LIMITS).action, "reject");
  });

  test("rejects symbols outside the allow-list, unknown prices, order floods and too many open orders", () => {
    assert.equal(checkOrder({ symbol: "PF_DOGEUSD", side: "buy", size: 1 }, state(), LIMITS).action, "reject");
    assert.equal(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 1 }, state({ prices: {} }), LIMITS).action, "reject");
    assert.equal(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 1 }, state({ ordersLastHour: 10 }), LIMITS).action, "reject");
    const orders = Array.from({ length: 5 }, () => ({ symbol: "PF_XBTUSD", side: "sell" as const, size: 1, reduceOnly: true }));
    assert.equal(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 1 }, state({ openOrders: orders }), LIMITS).action, "reject");
  });

  test("an existing position without a price blocks opening anywhere", () => {
    const s = state({ positions: [{ symbol: "PF_ADAUSD", size: 100 }] });
    assert.deepEqual(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 1 }, s, LIMITS), {
      action: "reject", reason: "no price for PF_ADAUSD",
    });
  });

  test("respects the exchange minimum size after clamping", () => {
    const s = state({ positions: [{ symbol: "PF_XBTUSD", size: 9.995 }] });
    assert.equal(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size: 1, minSize: 0.01 }, s, LIMITS).action, "reject");
  });

  test("rejects invalid sizes", () => {
    for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(checkOrder({ symbol: "PF_XBTUSD", side: "buy", size }, state(), LIMITS).action, "reject");
    }
  });
});

// Randomized invariant check: whatever the state and order, an allowed order (added as a resting
// order) never pushes worst-case exposure past a cap that was not already exceeded.
describe("checkOrder invariants (randomized)", () => {
  // Small deterministic PRNG so failures are reproducible.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const symbols = ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_DOGEUSD"] as const;
  const prices = { PF_XBTUSD: 100, PF_ETHUSD: 10, PF_SOLUSD: 1, PF_DOGEUSD: 0.5 };

  test("caps hold for 20 000 random cases", () => {
    for (let i = 0; i < 20_000; i++) {
      const s = state({
        equity: 200 + rand() * 1500,
        dayStartEquity: 1000,
        prices,
        ordersLastHour: Math.floor(rand() * 12),
        halted: rand() < 0.05,
        positions: symbols.filter(() => rand() < 0.4).map((symbol) => ({ symbol, size: (rand() - 0.5) * 20 / prices[symbol] * 50 })),
        openOrders: Array.from({ length: Math.floor(rand() * 4) }, () => ({
          symbol: pick(symbols), side: pick(["buy", "sell"] as const), size: rand() * 300 / prices.PF_ETHUSD, reduceOnly: rand() < 0.3,
        })),
      });
      const intent = {
        symbol: pick(symbols), side: pick(["buy", "sell"] as const), size: rand() * 2000 / 10, reduceOnly: rand() < 0.2,
      };
      const d = checkOrder(intent, s, LIMITS);
      if (d.action === "reject") continue;
      const ctx = JSON.stringify({ i, intent, d, s });

      assert.ok(d.size > 0 && d.size <= intent.size + 1e-9, `size within request: ${ctx}`);

      const before = exposure(s);
      const after = { ...s, openOrders: [...s.openOrders, { symbol: intent.symbol, side: intent.side, size: d.size, reduceOnly: !!intent.reduceOnly }] };
      const exAfter = exposure(after);
      const grew = (sym: string) => (exAfter.get(sym)?.worstAbs ?? 0) > (before.get(sym)?.worstAbs ?? 0) + 1e-9;
      const anyGrowth = [...exAfter.keys()].some(grew);
      if (!anyGrowth) continue; // pure reduction – always allowed

      const sym = intent.symbol;
      const price = prices[sym as keyof typeof prices];
      assert.ok(!s.halted && s.dayStartEquity - s.equity < LIMITS.maxDailyLoss, `opening while halted: ${ctx}`);
      assert.ok(LIMITS.symbols.includes(sym), `opening a forbidden symbol: ${ctx}`);
      assert.ok(exAfter.get(sym)!.worstAbs * price <= LIMITS.maxPositionNotional + 1e-6, `symbol cap: ${ctx}`);
      const grossCap = Math.min(LIMITS.maxTotalNotional, LIMITS.maxLeverage * s.equity);
      assert.ok(grossNotional(after) <= Math.max(grossCap, grossNotional(s)) + 1e-6, `gross cap: ${ctx}`);
      assert.ok(grossNotional(after) <= grossCap + 1e-6, `gross cap exceeded while growing: ${ctx}`);
      const active = [...exAfter.values()].filter((x) => x.worstAbs > 1e-12).length;
      const activeBefore = [...before.values()].filter((x) => x.worstAbs > 1e-12).length;
      assert.ok(active <= Math.max(LIMITS.maxOpenPositions, activeBefore), `position count: ${ctx}`);
    }
  });
});
