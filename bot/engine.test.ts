// engine.test.ts – offline tests of the pure decision function (the state machine, spec section 4).
// Run: node --test bot/engine.test.ts
//
// decide(snapshot, config) returns the actions for one cycle and does no I/O. Every cycle returns at least one
// action; "do nothing" is a `skip` with a reason, so the journal always records why.
// Conventions: a long trade with the zone 99000..99500, stop 98000, targets 102000 and 104000; policy id 7;
// quote 99250 (bid 99245, ask 99255); ATR 800; capital 1000, risk 0.5%, so the plan is 0.004 BTC with two 0.002 rungs.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultConfig } from "./config.ts";
import {
  type Action, type EngineState, type Snapshot, type TradeRecord, decide,
} from "./engine.ts";
import { type FuturesOpenOrder, type FuturesPosition, type OrderRequest, makeCliOrdId, parseCliOrdId } from "./executor.ts";
import { dayStartMs } from "./limits.ts";
import type { Policy, ResolvedScenario } from "./policy.ts";
import { T0, px } from "./sim-fixtures.ts";
import type { Contract } from "./sizing.ts";

const config = defaultConfig();
const NOW = T0;
const MIN = 60_000;
const ID = 7;
const iso = (ms: number) => new Date(ms).toISOString();

const longScenario: ResolvedScenario = {
  direction: "long", entryLow: 99000, entryHigh: 99500, targets: [102000, 104000], stop: 98000, horizonHours: 24,
};
const shortScenario: ResolvedScenario = {
  direction: "short", entryLow: 99000, entryHigh: 99500, targets: [95000, 92000], stop: 102000, horizonHours: 24,
};
const policy = (over: Partial<Policy> = {}): Policy => ({
  schema_version: 1, menu_id: "m1", symbol: "PF_XBTUSD", bias: 0.6, conviction: 1, risk_budget_pct: 0.5,
  allowed_directions: ["long"], scenario: null, valid_until: iso(NOW + 30 * MIN), rationale: "r", sources: [], ...over,
});
const contract: Contract = { tickSize: 0.5, sizeStep: 0.0001, minSize: 0.0001 };

const base = (over: Partial<Snapshot> = {}): Snapshot => ({
  nowMs: NOW, lastClockMs: NOW - 1000, state: "FLAT", stateSinceMs: NOW - 60_000, halt: null, trade: null,
  position: null, openOrders: [], price: px(99250, NOW), priceAgeSec: 1, atr: 800,
  policy: { id: ID, policy: policy(), scenario: longScenario }, inZoneSinceMs: NOW - 60_000,
  reconciled: true, foreignExposure: false, dailyLossBreached: false, liquidated: false, cooldownUntilMs: null,
  lastTradePnl: null, filledRoles: [], counters: { entriesToday: 0, ordersToday: 0 }, openRiskPct: 0, contract, fundingBpsPerHour: 0,
  ...over,
});
const shortPolicy = { id: ID, policy: policy({ bias: -0.6, allowed_directions: ["short"] }), scenario: shortScenario };

const trade = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  policyId: ID, direction: "long", entryCliOrdId: makeCliOrdId(ID, "entry", 0), entryPrice: 99245,
  plan: { size: 0.004, stop: 98000, ladder: [{ price: 102000, size: 0.002 }, { price: 104000, size: 0.002 }], leverage: 2 },
  horizonEndMs: NOW + 24 * 60 * MIN, protectSeq: 0, ...over,
});
const position = (over: Partial<FuturesPosition> = {}): FuturesPosition => ({
  symbol: "PF_XBTUSD", side: "long", size: 0.004, price: 99245, unrealizedPnl: 0, unrealizedFunding: 0, pnlCurrency: "USD", ...over,
});
const order = (cliOrdId: string, over: Partial<FuturesOpenOrder> = {}): FuturesOpenOrder => ({
  order_id: `o-${cliOrdId}`, cliOrdId, symbol: "PF_XBTUSD", side: "sell", orderType: "lmt", status: "untouched",
  filledSize: 0, unfilledSize: 0.002, reduceOnly: true, receivedTime: iso(NOW), lastUpdateTime: iso(NOW), ...over,
});
const slOrder = (size = 0.004, stop = 98000, seq = 0) =>
  order(makeCliOrdId(ID, "sl", seq), { orderType: "stp", stopPrice: stop, unfilledSize: size, triggerSignal: "mark" });
const tpOrder = (n: 1 | 2 | 3, price: number, size = 0.002, seq = 0) =>
  order(makeCliOrdId(ID, `tp${n}`, seq), { orderType: "lmt", limitPrice: price, unfilledSize: size });
const entryOrder = (size = 0.004) =>
  order(makeCliOrdId(ID, "entry", 0), { side: "buy", orderType: "lmt", limitPrice: 99245, unfilledSize: size, reduceOnly: false });
const protectedOrders = () => [slOrder(), tpOrder(1, 102000), tpOrder(2, 104000)];

// ---- reading actions ----------------------------------------------------------------------------------------------

const places = (a: Action[]) => a.flatMap((x) => (x.type === "place" ? [x.req] : []));
const cancels = (a: Action[]) => a.flatMap((x) => (x.type === "cancel" ? [x.cliOrdId] : []));
const edits = (a: Action[]) => a.flatMap((x) => (x.type === "edit" ? [x] : []));
const transitions = (a: Action[]) => a.flatMap((x) => (x.type === "transition" ? [x] : []));
const halts = (a: Action[]) => a.flatMap((x) => (x.type === "halt" ? [x] : []));
const skips = (a: Action[]) => a.flatMap((x) => (x.type === "skip" ? [x.reason] : []));
const only = <T>(xs: T[]): T => {
  assert.equal(xs.length, 1, `expected exactly one, got ${xs.length}`);
  return xs[0]!;
};
const slReq = (size = 0.004, stop = 98000, seq = 0): OrderRequest => ({
  symbol: "PF_XBTUSD", side: "sell", orderType: "stp", size, stopPrice: stop, reduceOnly: true, triggerSignal: "mark",
  cliOrdId: makeCliOrdId(ID, "sl", seq),
});
const tpReq = (n: 1 | 2 | 3, price: number, size = 0.002, seq = 0): OrderRequest => ({
  symbol: "PF_XBTUSD", side: "sell", orderType: "lmt", size, limitPrice: price, reduceOnly: true, cliOrdId: makeCliOrdId(ID, `tp${n}`, seq),
});
const closeReq = (size = 0.004, attempt = 0): OrderRequest => ({
  symbol: "PF_XBTUSD", side: "sell", orderType: "mkt", size, reduceOnly: true, cliOrdId: makeCliOrdId(ID, "close", attempt),
});

describe("decide – every state, global rules", () => {
  const STATES: EngineState[] = ["FLAT", "ENTERING", "PROTECTING", "OPEN", "REDUCING", "COOLDOWN", "HALTED"];

  describe("a clock that moved backwards", () => {
    const behind = { nowMs: NOW - 5000, lastClockMs: NOW };

    test("still protects a position whose stop is missing (protection does not depend on the time)", () => {
      const a = decide(base({ ...behind, state: "PROTECTING", trade: trade(), position: position(), openOrders: [] }), config);
      assert.deepEqual(places(a), [slReq(), tpReq(1, 102000), tpReq(2, 104000)]);
    });

    test("in OPEN, a missing stop sends it back to PROTECTING with a fresh sequence number", () => {
      const a = decide(base({ ...behind, state: "OPEN", trade: trade(), position: position(), openOrders: [tpOrder(1, 102000), tpOrder(2, 104000)] }), config);
      assert.equal(only(transitions(a)).to, "PROTECTING");
      assert.equal(only(transitions(a)).trade?.protectSeq, 1);
    });

    test("in OPEN, a stop of the wrong size is still resized", () => {
      const a = decide(base({ ...behind, state: "OPEN", trade: trade(), position: position({ size: 0.002 }), openOrders: [slOrder(0.004), tpOrder(2, 104000)] }), config);
      assert.deepEqual(edits(a).map((e) => [e.cliOrdId, e.size]), [[makeCliOrdId(ID, "sl", 0), 0.002]]);
    });

    test("but nothing that depends on the time: no timeout close, no time-stop, no trailing, no entry, no halt expiry", () => {
      const lateProtect = decide(base({ ...behind, state: "PROTECTING", stateSinceMs: NOW - 99 * MIN, trade: trade(), position: position(), openOrders: [] }), config);
      assert.deepEqual(places(lateProtect).filter((r) => r.orderType === "mkt"), []);
      const timeStop = decide(base({ ...behind, state: "OPEN", trade: trade({ horizonEndMs: NOW - MIN }), position: position(), openOrders: protectedOrders(), price: px(101000, NOW) }), config);
      assert.deepEqual(timeStop, [{ type: "skip", reason: "clock_went_backwards" }]);
      assert.deepEqual(decide(base({ ...behind }), config), [{ type: "skip", reason: "clock_went_backwards" }]);
      const expired = decide(base({ ...behind, state: "HALTED", halt: { reason: "daily_loss_limit", manualAck: false, untilMs: NOW - 99 * MIN } }), config);
      assert.deepEqual(transitions(expired), []);
    });
  });

  test("a clock that moved backwards yields only a skip when there is nothing to protect, in every state", () => {
    for (const state of STATES) {
      const a = decide(base({ state, nowMs: NOW - 5000, lastClockMs: NOW, trade: trade(), position: position(), openOrders: protectedOrders() }), config);
      assert.deepEqual(a, [{ type: "skip", reason: "clock_went_backwards" }], state);
    }
  });

  test("a liquidation or ADL fill halts for manual acknowledgement and does nothing else", () => {
    for (const state of STATES) {
      const a = decide(base({ state, liquidated: true, trade: trade(), position: position(), openOrders: protectedOrders() }), config);
      assert.equal(a.length, 1, state);
      assert.deepEqual(halts(a).map((h) => [h.manualAck, h.reason]), [[true, "liquidation_or_adl"]], state);
    }
  });

  test("the daily loss limit halts until the next reset hour, without closing the position", () => {
    const a = decide(base({ state: "OPEN", dailyLossBreached: true, trade: trade(), position: position(), openOrders: protectedOrders() }), config);
    const h = only(halts(a));
    assert.equal(h.manualAck, false);
    assert.equal(h.untilMs, dayStartMs(NOW, config.day_reset_utc_hour) + 24 * 60 * MIN);
    assert.deepEqual(places(a), []); // protection stays, nothing is closed
  });

  test("the daily loss limit during ENTERING cancels the resting entry first", () => {
    const a = decide(base({ state: "ENTERING", dailyLossBreached: true, trade: trade(), openOrders: [entryOrder()] }), config);
    assert.deepEqual(cancels(a), [makeCliOrdId(ID, "entry", 0)]);
    assert.equal(only(halts(a)).manualAck, false);
  });
});

describe("FLAT -> ENTERING", () => {
  test("with every condition met it places a limit entry inside the zone and moves to ENTERING with a trade record", () => {
    const a = decide(base(), config);
    assert.deepEqual(only(places(a)), {
      symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.004, limitPrice: 99245, reduceOnly: false,
      cliOrdId: "bot-7-entry-0", processBefore: iso(NOW + config.entry_timeout_sec * 1000),
    });
    const t = only(transitions(a));
    assert.equal(t.to, "ENTERING");
    assert.deepEqual(t.trade, trade());
  });

  test("the entry limit is the bid for a long and the ask for a short, kept inside the zone", () => {
    const longLow = decide(base({ price: { ...px(99250, NOW), bid: 98000 } }), config); // bid far below the zone
    assert.equal(only(places(longLow)).limitPrice, 99000);
    const short = decide(base({ policy: shortPolicy }), config);
    const req = only(places(short));
    assert.deepEqual([req.side, req.limitPrice, req.size], ["sell", 99255, 0.0018]);
    assert.equal(only(transitions(short)).trade?.direction, "short");
  });

  test("the entry id carries today's entry count, so a second entry of the day has a fresh id", () => {
    const a = decide(base({ counters: { entriesToday: 1, ordersToday: 5 } }), config);
    assert.equal(only(places(a)).cliOrdId, "bot-7-entry-1");
    assert.equal(only(transitions(a)).trade?.entryCliOrdId, "bot-7-entry-1");
  });

  test("the trade's time-stop is the scenario horizon", () => {
    assert.equal(only(transitions(decide(base(), config))).trade?.horizonEndMs, NOW + 24 * 60 * MIN);
  });

  // Each failing condition yields exactly one skip with its own reason and places nothing.
  const blocked: [string, Partial<Snapshot>, string | RegExp][] = [
    ["not reconciled", { reconciled: false }, "not_reconciled"],
    ["foreign exposure", { foreignExposure: true }, "foreign_exposure"],
    ["no price", { price: null, priceAgeSec: null }, "no_price"],
    ["stale price", { priceAgeSec: config.stale_data_max_age_sec + 1 }, "stale_data"],
    ["no policy", { policy: null }, "no_policy"],
    ["expired policy", { policy: { id: ID, policy: policy({ valid_until: iso(NOW) }), scenario: longScenario } }, "policy_expired"],
    ["no scenario", { policy: { id: ID, policy: policy(), scenario: null } }, "no_scenario"],
    ["direction not allowed", { policy: { id: ID, policy: policy({ allowed_directions: ["short"] }), scenario: longScenario } }, "direction_not_allowed"],
    ["bias against the scenario", { policy: { id: ID, policy: policy({ bias: -0.4 }), scenario: longScenario } }, "bias_conflict"],
    ["no ATR", { atr: null }, "no_atr"],
    ["price above the zone", { price: px(99600, NOW) }, "price_outside_zone"],
    ["price below the zone", { price: px(98900, NOW) }, "price_outside_zone"],
    ["never confirmed", { inZoneSinceMs: null }, "awaiting_confirmation"],
    ["confirmed too recently", { inZoneSinceMs: NOW - 5_000 }, "awaiting_confirmation"],
    ["stop inside the noise floor", { atr: 2000 }, "plan:stop_inside_noise_floor"],
    ["entries used up", { counters: { entriesToday: 2, ordersToday: 2 } }, "limit:max_entries_per_day"],
    ["order budget cannot hold the bundle", { counters: { entriesToday: 0, ordersToday: 17 } }, "limit:max_orders_per_day"],
    ["total open risk", { openRiskPct: 0.3 }, "limit:max_total_open_risk"],
  ];
  for (const [name, over, reason] of blocked) {
    test(`blocked: ${name}`, () => {
      const a = decide(base(over), config);
      assert.deepEqual(places(a), []);
      assert.deepEqual(transitions(a), []);
      assert.deepEqual(skips(a), [reason]);
    });
  }

  test("a position while the state is FLAT is an unexplained state: halt for manual acknowledgement", () => {
    const a = decide(base({ position: position() }), config);
    assert.deepEqual(halts(a).map((h) => [h.manualAck, h.reason]), [[true, "position_in_flat_state"]]);
    assert.deepEqual(places(a), []);
  });

  test("an expired or stale policy never leads to a cancel of anything (FLAT has nothing to cancel)", () => {
    assert.deepEqual(cancels(decide(base({ priceAgeSec: 9999 }), config)), []);
  });
});

describe("ENTERING", () => {
  const entering = (over: Partial<Snapshot> = {}) =>
    base({ state: "ENTERING", stateSinceMs: NOW - 10_000, trade: trade(), openOrders: [entryOrder()], ...over });

  test("a resting entry that is still fine just waits", () => {
    assert.deepEqual(decide(entering(), config), [{ type: "skip", reason: "entry_resting" }]);
  });

  const abandon: [string, Partial<Snapshot>, string][] = [
    ["timeout", { stateSinceMs: NOW - (config.entry_timeout_sec + 1) * 1000 }, "entry_timeout"],
    ["price left the zone", { price: px(99600, NOW) }, "left_zone"],
    ["stale data", { priceAgeSec: 999 }, "stale_data"],
    ["policy gone", { policy: null }, "no_policy"],
    ["direction no longer allowed", { policy: { id: ID, policy: policy({ allowed_directions: ["short"] }), scenario: longScenario } }, "direction_not_allowed"],
    ["bias turned against it", { policy: { id: ID, policy: policy({ bias: -0.5 }), scenario: longScenario } }, "bias_conflict"],
  ];
  for (const [name, over, reason] of abandon) {
    test(`with no fill, ${name} cancels the entry and returns to FLAT`, () => {
      const a = decide(entering(over), config);
      assert.deepEqual(cancels(a), [makeCliOrdId(ID, "entry", 0)]);
      const t = only(transitions(a));
      assert.equal(t.to, "FLAT");
      assert.equal(t.trade, null);
      assert.equal(t.reason, reason);
      assert.deepEqual(places(a), []);
    });
  }

  test("an entry order that vanished without a fill returns to FLAT", () => {
    const a = decide(entering({ openOrders: [] }), config);
    assert.deepEqual(only(transitions(a)), { type: "transition", to: "FLAT", reason: "entry_vanished", trade: null });
  });

  test("a partial fill with the entry still resting: cancel the remainder and wait for it before protecting", () => {
    const a = decide(entering({ position: position({ size: 0.0015 }), openOrders: [entryOrder(0.0025)] }), config);
    assert.deepEqual(cancels(a), [makeCliOrdId(ID, "entry", 0)]);
    assert.equal(only(transitions(a)).to, "PROTECTING");
    assert.deepEqual(places(a), []); // the size is not final until the cancel is confirmed
  });

  test("a complete fill protects at once: stop and targets, then PROTECTING", () => {
    const a = decide(entering({ position: position(), openOrders: [] }), config);
    assert.deepEqual(places(a), [slReq(), tpReq(1, 102000), tpReq(2, 104000)]);
    assert.equal(only(transitions(a)).to, "PROTECTING");
    assert.deepEqual(cancels(a), []);
  });

  test("a position on the wrong side of the trade is an unexplained state: halt", () => {
    const a = decide(entering({ position: position({ side: "short" }), openOrders: [] }), config);
    assert.equal(only(halts(a)).manualAck, true);
  });

  test("a state without a trade record returns to FLAT", () => {
    const a = decide(entering({ trade: null, openOrders: [] }), config);
    assert.equal(only(transitions(a)).to, "FLAT");
  });
});

describe("PROTECTING", () => {
  const protecting = (over: Partial<Snapshot> = {}) =>
    base({ state: "PROTECTING", stateSinceMs: NOW - 1000, trade: trade(), position: position(), openOrders: [], ...over });

  test("places the missing stop and targets, sized to the position", () => {
    assert.deepEqual(places(decide(protecting(), config)), [slReq(), tpReq(1, 102000), tpReq(2, 104000)]);
  });

  test("after a partial fill the protection follows the filled quantity", () => {
    const a = decide(protecting({ position: position({ size: 0.0025 }) }), config);
    assert.deepEqual(places(a), [slReq(0.0025), tpReq(1, 102000, 0.0013), tpReq(2, 104000, 0.0012)]);
    const total = places(a).filter((r) => r.orderType === "lmt").reduce((s, r) => s + r.size, 0);
    assert.ok(Math.abs(total - 0.0025) < 1e-12);
  });

  test("a position too small for the ladder collapses to fewer rungs", () => {
    const a = decide(protecting({ position: position({ size: 0.0001 }) }), config);
    assert.deepEqual(places(a), [slReq(0.0001), tpReq(1, 102000, 0.0001)]);
  });

  test("only what is missing is placed, with the same ids on every retry", () => {
    const withSl = protecting({ openOrders: [slOrder()] });
    const a = decide(withSl, config);
    assert.deepEqual(places(a), [tpReq(1, 102000), tpReq(2, 104000)]);
    assert.deepEqual(decide(withSl, config), a); // deterministic: same snapshot, same actions
  });

  test("stop confirmed but a target missing: not OPEN yet, the target is placed", () => {
    const a = decide(protecting({ openOrders: [slOrder(), tpOrder(1, 102000)] }), config);
    assert.deepEqual(places(a), [tpReq(2, 104000)]);
    assert.deepEqual(transitions(a), []);
  });

  test("a protective order of the wrong size is edited to the position size", () => {
    const a = decide(protecting({ openOrders: [slOrder(0.003), tpOrder(1, 102000), tpOrder(2, 104000)] }), config);
    assert.deepEqual(edits(a).map((e) => [e.cliOrdId, e.size]), [[makeCliOrdId(ID, "sl", 0), 0.004]]);
    assert.deepEqual(transitions(a), []);
  });

  test("everything confirmed on the exchange moves to OPEN", () => {
    const a = decide(protecting({ openOrders: protectedOrders() }), config);
    assert.deepEqual(a, [{ type: "transition", to: "OPEN", reason: "protected" }]);
  });

  test("an ack is not a confirmation: nothing is confirmed until it is in the open orders", () => {
    const a = decide(protecting({ openOrders: [slOrder()] }), config);
    assert.equal(transitions(a).length, 0);
  });

  test("past protect_timeout_sec without both orders confirmed: close at market and move to REDUCING", () => {
    const late = { stateSinceMs: NOW - (config.protect_timeout_sec + 1) * 1000 };
    const noStop = decide(protecting(late), config);
    assert.deepEqual(places(noStop), [closeReq()]);
    assert.equal(only(transitions(noStop)).to, "REDUCING");

    const noTarget = decide(protecting({ ...late, openOrders: [slOrder(), tpOrder(1, 102000)] }), config);
    assert.deepEqual(places(noTarget), [closeReq()]);
    assert.equal(only(transitions(noTarget)).to, "REDUCING");
  });

  test("the position vanished before it was protected: REDUCING cleans up", () => {
    const a = decide(protecting({ position: null, openOrders: [slOrder()] }), config);
    assert.equal(only(transitions(a)).to, "REDUCING");
  });

  test("a position on the wrong side of the trade halts", () => {
    assert.equal(only(halts(decide(protecting({ position: position({ side: "short" }) }), config))).manualAck, true);
  });

  test("a stop that has to be re-placed is never wider than the last trailed stop", () => {
    const t = trade({ protectSeq: 1, lastStop: 99400 });
    const a = decide(protecting({ trade: t, openOrders: [tpOrder(1, 102000), tpOrder(2, 104000)] }), config);
    assert.deepEqual(places(a), [slReq(0.004, 99400, 1)]);
  });

  test("a rung that already filled is not placed again: the remaining position is split over the rungs left", () => {
    // tp1 filled earlier; 0.002 is left and the stop has to be re-protected
    const a = decide(protecting({ position: position({ size: 0.002 }), filledRoles: ["tp1"], openOrders: [] }), config);
    assert.deepEqual(places(a), [slReq(0.002), tpReq(2, 104000, 0.002)]);
  });

  test("with the remaining rung already working, nothing but the stop is needed", () => {
    const a = decide(protecting({ position: position({ size: 0.002 }), filledRoles: ["tp1"], openOrders: [slOrder(0.002), tpOrder(2, 104000, 0.002)] }), config);
    assert.deepEqual(a, [{ type: "transition", to: "OPEN", reason: "protected" }]);
  });

  test("when every rung has filled, only the stop is protected", () => {
    const a = decide(protecting({ position: position({ size: 0.001 }), filledRoles: ["tp1", "tp2"], openOrders: [] }), config);
    assert.deepEqual(places(a), [slReq(0.001)]);
  });

  test("a short protects with buy orders", () => {
    const t = trade({ direction: "short", plan: { size: 0.0018, stop: 102000, ladder: [{ price: 95000, size: 0.0009 }, { price: 92000, size: 0.0009 }], leverage: 2 } });
    const a = decide(protecting({ trade: t, position: position({ side: "short", size: 0.0018 }), policy: shortPolicy }), config);
    assert.deepEqual(places(a).map((r) => [r.side, r.orderType, r.stopPrice ?? r.limitPrice, r.size]), [
      ["buy", "stp", 102000, 0.0018], ["buy", "lmt", 95000, 0.0009], ["buy", "lmt", 92000, 0.0009],
    ]);
  });
});

describe("OPEN", () => {
  const open = (over: Partial<Snapshot> = {}) =>
    base({ state: "OPEN", stateSinceMs: NOW - 5 * MIN, trade: trade(), position: position(), openOrders: protectedOrders(), ...over });

  test("a healthy position is held", () => {
    assert.deepEqual(decide(open(), config), [{ type: "skip", reason: "holding" }]);
  });

  test("the position closed (stop or target filled): REDUCING", () => {
    const a = decide(open({ position: null, openOrders: [tpOrder(1, 102000)] }), config);
    assert.deepEqual(a, [{ type: "transition", to: "REDUCING", reason: "position_closed" }]);
  });

  test("a target rung filled: the stop is resized to the remaining position before anything else", () => {
    const a = decide(open({ position: position({ size: 0.002 }), openOrders: [slOrder(0.004), tpOrder(2, 104000)] }), config);
    assert.deepEqual(edits(a).map((e) => [e.cliOrdId, e.size, e.stopPrice]), [[makeCliOrdId(ID, "sl", 0), 0.002, undefined]]);
    assert.deepEqual(places(a), []);
  });

  test("the stop disappeared: back to PROTECTING with a fresh sequence number, since the old id cannot be reused", () => {
    const a = decide(open({ openOrders: [tpOrder(1, 102000), tpOrder(2, 104000)] }), config);
    const t = only(transitions(a));
    assert.equal(t.to, "PROTECTING");
    assert.equal(t.trade?.protectSeq, 1);
    assert.deepEqual(places(a), []); // the next cycle places it with the new id
  });

  test("after that, the protection uses the new sequence number", () => {
    const a = decide(base({ state: "PROTECTING", stateSinceMs: NOW - 1000, trade: trade({ protectSeq: 1 }), position: position(), openOrders: [tpOrder(1, 102000), tpOrder(2, 104000)] }), config);
    assert.deepEqual(places(a), [slReq(0.004, 98000, 1)]);
  });

  test("the time-stop closes at market; no trailing edit is emitted alongside it", () => {
    const a = decide(open({ trade: trade({ horizonEndMs: NOW }), price: px(101000, NOW) }), config);
    assert.deepEqual(places(a), [closeReq()]);
    assert.equal(only(transitions(a)).to, "REDUCING");
    assert.deepEqual(edits(a), []);
  });

  test("a policy that flips against the trade closes it", () => {
    const a = decide(open({ policy: { id: ID, policy: policy({ bias: -0.3 }), scenario: longScenario } }), config);
    assert.deepEqual(places(a), [closeReq()]);
    assert.equal(only(transitions(a)).reason, "policy_flip");
  });

  test("a direction that is no longer allowed closes it", () => {
    const a = decide(open({ policy: { id: ID, policy: policy({ allowed_directions: ["short"] }), scenario: null } }), config);
    assert.deepEqual(places(a), [closeReq()]);
    assert.equal(only(transitions(a)).reason, "policy_void");
  });

  test("an EXPIRED policy never closes a position, even one that would flip or void it (it is not authoritative)", () => {
    const expiredFlip = { id: ID, policy: policy({ bias: -0.8, valid_until: iso(NOW - 1) }), scenario: null };
    const expiredVoid = { id: ID, policy: policy({ allowed_directions: ["short"], valid_until: iso(NOW - 1) }), scenario: null };
    for (const p of [expiredFlip, expiredVoid]) {
      const a = decide(open({ policy: p }), config);
      assert.deepEqual(places(a), []);
      assert.deepEqual(transitions(a), []);
    }
  });

  test("a missing, expired or stale policy never closes a position (reduce-only mode: the stop stays)", () => {
    for (const over of [{ policy: null }, { priceAgeSec: 9999 }, { policy: { id: ID, policy: policy({ valid_until: iso(NOW - 1) }), scenario: null } }]) {
      const a = decide(open(over), config);
      assert.deepEqual(places(a), [], JSON.stringify(over).slice(0, 40));
      assert.deepEqual(transitions(a), []);
    }
  });

  describe("trailing stop (tighten only)", () => {
    const profit = (last: number, stop = 98000) =>
      open({ price: px(last, NOW), openOrders: [slOrder(0.004, stop), tpOrder(1, 102000), tpOrder(2, 104000)] });

    test("once 1R in profit it follows the price at 2 ATR, rounded away from the price", () => {
      const a = decide(profit(101000), config); // 101000 - 2 x 800 = 99400
      assert.deepEqual(edits(a).map((e) => [e.cliOrdId, e.stopPrice, e.size]), [[makeCliOrdId(ID, "sl", 0), 99400, undefined]]);
    });

    test("not before the trade is trail_start_r in profit", () => {
      assert.deepEqual(edits(decide(profit(100400), config)), []); // 1155 of profit < R of 1245
    });

    test("not when the candidate is not tighter than the current stop", () => {
      assert.deepEqual(edits(decide(profit(101000, 99400), config)), []); // already there
      assert.deepEqual(edits(decide(profit(100600, 99400), config)), []); // price fell back: never loosen
    });

    test("not without an ATR", () => {
      assert.deepEqual(edits(decide(base({ ...profit(101000), atr: null }), config)), []);
    });

    test("a short trails downward", () => {
      const t = trade({ direction: "short", entryPrice: 99255, plan: { size: 0.0018, stop: 102000, ladder: [{ price: 95000, size: 0.0009 }, { price: 92000, size: 0.0009 }], leverage: 2 } });
      const shortSl = order(makeCliOrdId(ID, "sl", 0), { side: "buy", orderType: "stp", stopPrice: 102000, unfilledSize: 0.0018, triggerSignal: "mark" });
      const a = decide(base({
        state: "OPEN", trade: t, policy: shortPolicy, position: position({ side: "short", size: 0.0018, price: 99255 }),
        price: px(96000, NOW), openOrders: [shortSl], // profit 3255 > R of 2745
      }), config);
      assert.deepEqual(edits(a).map((e) => e.stopPrice), [97600]); // 96000 + 2 x 800
    });

    test("an expired policy does not stop the trailing", () => {
      const expired = { id: ID, policy: policy({ valid_until: iso(NOW - 1) }), scenario: null };
      assert.equal(edits(decide({ ...profit(101000), policy: expired }, config)).length, 1);
    });
  });
});

describe("REDUCING", () => {
  const reducing = (over: Partial<Snapshot> = {}) =>
    base({ state: "REDUCING", stateSinceMs: NOW - 1000, trade: trade(), position: position(), openOrders: [slOrder()], ...over });

  test("with a position and no close order, it places a reduce-only market close", () => {
    assert.deepEqual(places(decide(reducing(), config)), [closeReq()]);
  });

  test("a close order already working is left alone", () => {
    const working = order(makeCliOrdId(ID, "close", 0), { orderType: "lmt", side: "sell", unfilledSize: 0.004 });
    assert.deepEqual(decide(reducing({ openOrders: [slOrder(), working] }), config), [{ type: "skip", reason: "closing" }]);
  });

  test("a close that did not finish is retried with a fresh id once per protect_timeout interval", () => {
    const sec = config.protect_timeout_sec * 1000;
    assert.equal(only(places(decide(reducing({ stateSinceMs: NOW - sec * 0.5 }), config))).cliOrdId, makeCliOrdId(ID, "close", 0));
    assert.equal(only(places(decide(reducing({ stateSinceMs: NOW - sec * 1.5 }), config))).cliOrdId, makeCliOrdId(ID, "close", 1));
    assert.equal(only(places(decide(reducing({ stateSinceMs: NOW - sec * 2.5 }), config))).cliOrdId, makeCliOrdId(ID, "close", 2));
  });

  test("flat with leftover bot orders: every one is cancelled (nothing may linger to hit a later position)", () => {
    const a = decide(reducing({ position: null, openOrders: [slOrder(), tpOrder(1, 102000), tpOrder(2, 104000)] }), config);
    assert.deepEqual(cancels(a), [makeCliOrdId(ID, "sl", 0), makeCliOrdId(ID, "tp1", 0), makeCliOrdId(ID, "tp2", 0)]);
    assert.deepEqual(transitions(a), []); // not in COOLDOWN until they are gone
  });

  test("an order that is not the bot's is never cancelled", () => {
    const manual = order("my-manual-order", { reduceOnly: false });
    const a = decide(reducing({ position: null, openOrders: [manual] }), config);
    assert.deepEqual(cancels(a), []);
    assert.equal(only(transitions(a)).to, "COOLDOWN");
  });

  test("flat and clean: COOLDOWN until the normal cooldown after a profit", () => {
    const a = decide(reducing({ position: null, openOrders: [], lastTradePnl: 12 }), config);
    const t = only(transitions(a));
    assert.equal(t.to, "COOLDOWN");
    assert.equal(t.cooldownUntilMs, NOW + config.cooldown_after_close_min * MIN);
    assert.equal(t.trade, null);
  });

  test("the cooldown is longer after a loss", () => {
    const t = only(transitions(decide(reducing({ position: null, openOrders: [], lastTradePnl: -3 }), config)));
    assert.equal(t.cooldownUntilMs, NOW + config.cooldown_after_loss_min * MIN);
  });

  test("an unknown PnL is treated as a loss (the longer cooldown)", () => {
    const t = only(transitions(decide(reducing({ position: null, openOrders: [], lastTradePnl: null }), config)));
    assert.equal(t.cooldownUntilMs, NOW + config.cooldown_after_loss_min * MIN);
  });
});

describe("COOLDOWN", () => {
  const cooling = (over: Partial<Snapshot> = {}) => base({ state: "COOLDOWN", cooldownUntilMs: NOW + 10 * MIN, ...over });

  test("waits for the timer", () => {
    assert.deepEqual(decide(cooling(), config), [{ type: "skip", reason: "cooldown" }]);
  });

  test("returns to FLAT only once the timer has run out", () => {
    assert.equal(only(transitions(decide(cooling({ cooldownUntilMs: NOW }), config))).to, "FLAT");
    assert.equal(transitions(decide(cooling({ cooldownUntilMs: NOW + 1 }), config)).length, 0);
  });

  test("a state with no timer does not wait forever", () => {
    assert.equal(only(transitions(decide(cooling({ cooldownUntilMs: null }), config))).to, "FLAT");
  });

  test("leftover bot orders are cancelled even during the cooldown", () => {
    assert.deepEqual(cancels(decide(cooling({ openOrders: [tpOrder(1, 102000)] }), config)), [makeCliOrdId(ID, "tp1", 0)]);
  });

  test("a position during the cooldown is unexplained: halt", () => {
    assert.equal(only(halts(decide(cooling({ position: position() }), config))).manualAck, true);
  });
});

describe("HALTED", () => {
  const halted = (over: Partial<Snapshot> = {}) =>
    base({ state: "HALTED", halt: { reason: "daily_loss_limit", manualAck: false, untilMs: NOW + 60 * MIN }, ...over });

  test("never opens anything", () => {
    assert.deepEqual(places(decide(halted(), config)), []);
  });

  test("a daily-loss halt clears when its time has come and nothing is open", () => {
    const a = decide(halted({ halt: { reason: "daily_loss_limit", manualAck: false, untilMs: NOW } }), config);
    assert.equal(only(transitions(a)).to, "FLAT");
  });

  test("not before its time, and not while a position is open", () => {
    assert.equal(transitions(decide(halted(), config)).length, 0);
    const withPosition = halted({ halt: { reason: "daily_loss_limit", manualAck: false, untilMs: NOW }, position: position(), openOrders: [slOrder()] });
    assert.equal(transitions(decide(withPosition, config)).length, 0);
  });

  test("a manual halt never clears by itself, even one that carries a time that has passed", () => {
    const a = decide(halted({ halt: { reason: "unexplained_position", manualAck: true, untilMs: NOW - 1 } }), config);
    assert.equal(transitions(a).length, 0);
  });

  test("a manual halt with no time never clears either, whatever the clock says", () => {
    const a = decide(halted({ halt: { reason: "liquidation_or_adl", manualAck: true, untilMs: null }, nowMs: NOW + 99 * 24 * 60 * MIN, lastClockMs: NOW }), config);
    assert.equal(transitions(a).length, 0);
  });

  test("a resting entry order is cancelled", () => {
    assert.deepEqual(cancels(decide(halted({ openOrders: [entryOrder()] }), config)), [makeCliOrdId(ID, "entry", 0)]);
  });

  test("a position with its stop is left alone", () => {
    assert.deepEqual(places(decide(halted({ trade: trade(), position: position(), openOrders: [slOrder()] }), config)), []);
  });

  test("a position with no trade record may be the user's own: it is never closed, stop or no stop", () => {
    const a = decide(halted({ trade: null, position: position(), openOrders: [] }), config);
    assert.deepEqual(places(a), []);
    assert.deepEqual(cancels(a), []);
    assert.deepEqual(a, [{ type: "skip", reason: "halted" }]);
  });

  test("a position without a stop is closed at market", () => {
    assert.deepEqual(places(decide(halted({ trade: trade(), position: position(), openOrders: [] }), config)), [closeReq()]);
  });
});

describe("decide – properties over random snapshots", () => {
  let seed = 20261003;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const STATES: EngineState[] = ["FLAT", "ENTERING", "PROTECTING", "OPEN", "REDUCING", "COOLDOWN", "HALTED"];

  function randomSnapshot(): Snapshot {
    const dir = pick<"long" | "short">(["long", "short"]);
    const sc = dir === "long" ? longScenario : shortScenario;
    const size = pick([0.0001, 0.0015, 0.004]);
    const last = 96000 + rnd() * 8000;
    const t = trade({
      direction: dir, entryPrice: 99250,
      plan: { size: 0.004, stop: sc.stop, ladder: dir === "long" ? trade().plan.ladder : [{ price: 95000, size: 0.002 }, { price: 92000, size: 0.002 }], leverage: 2 },
      horizonEndMs: NOW + (rnd() - 0.3) * 3600_000, protectSeq: pick([0, 1]),
    });
    const closing = dir === "long" ? "sell" : "buy";
    const pool: FuturesOpenOrder[] = [
      order(makeCliOrdId(ID, "sl", pick([0, 1])), { side: closing, orderType: "stp", stopPrice: sc.stop + (dir === "long" ? 1 : -1) * rnd() * 800, unfilledSize: pick([size, 0.003]) }),
      order(makeCliOrdId(ID, "tp1", 0), { side: closing, limitPrice: sc.targets[0]!, unfilledSize: 0.002 }),
      order(makeCliOrdId(ID, "tp2", 0), { side: closing, limitPrice: sc.targets[1]!, unfilledSize: 0.002 }),
      order(makeCliOrdId(ID, "close", pick([0, 1])), { side: closing, orderType: "lmt", unfilledSize: size }),
      entryOrder(),
      order("someone-elses-order", { reduceOnly: false }),
    ];
    // Some snapshots are made trailing-eligible on purpose, so the stop-only-tightens property is really exercised.
    const friendly = rnd() < 0.3;
    const friendlyOver: Partial<Snapshot> = friendly
      ? {
          state: "OPEN", trade: t, position: position({ side: dir, size: 0.004, price: 99250 }), price: px(dir === "long" ? 101500 : 97000, NOW),
          priceAgeSec: 1, atr: 800, dailyLossBreached: false, liquidated: false, lastClockMs: NOW - 1000, openOrders: [pool[0]!],
          policy: { id: ID, policy: policy({ bias: dir === "long" ? 0.5 : -0.5, allowed_directions: [dir], valid_until: iso(NOW + 30 * MIN) }), scenario: sc },
        }
      : {};
    return base({
      state: pick(STATES), nowMs: NOW, lastClockMs: pick([NOW - 1000, NOW - 1000, NOW + 5000]),
      stateSinceMs: NOW - Math.floor(rnd() * 20 * MIN), trade: pick([t, t, null]),
      position: pick([null, position({ side: dir, size, price: 99250 })]),
      openOrders: pool.filter(() => rnd() < 0.5), price: pick([null, px(last, NOW)]), priceAgeSec: pick([null, 1, 500]),
      atr: pick([null, 800, 5000]), policy: pick([null, { id: ID, policy: policy({ bias: pick([-0.5, 0, 0.6]), allowed_directions: pick([["long"], ["short"], ["long", "short"], []] as ("long" | "short")[][]), valid_until: iso(NOW + pick([-MIN, 30 * MIN])) }), scenario: pick([null, sc]) }]),
      inZoneSinceMs: pick([null, NOW - 5000, NOW - 5 * MIN]), reconciled: pick([true, true, false]),
      foreignExposure: pick([false, false, true]), dailyLossBreached: pick([false, false, false, true]), liquidated: pick([false, false, false, true]),
      cooldownUntilMs: pick([null, NOW - 1, NOW + 10 * MIN]), lastTradePnl: pick([null, -5, 5]),
      counters: { entriesToday: pick([0, 1, 2]), ordersToday: pick([0, 10, 18]) },
      ...friendlyOver,
    });
  }

  test("deterministic, pure, and never an empty answer", () => {
    for (let i = 0; i < 1500; i++) {
      const s = randomSnapshot();
      const before = JSON.stringify(s);
      const a = decide(s, config);
      assert.ok(a.length >= 1, "an empty action list");
      assert.deepEqual(decide(s, config), a);
      assert.equal(JSON.stringify(s), before, "the snapshot was mutated");
    }
  });

  test("only FLAT ever places an order that can open exposure", () => {
    for (let i = 0; i < 1500; i++) {
      const s = randomSnapshot();
      for (const req of places(decide(s, config))) {
        if (!req.reduceOnly) assert.equal(s.state, "FLAT", `${s.state} placed ${req.cliOrdId} without reduceOnly`);
      }
    }
  });

  test("no order is ever placed on a backwards clock, with stale data (entries) or while halted", () => {
    for (let i = 0; i < 1500; i++) {
      const s = randomSnapshot();
      const a = decide(s, config);
      if (s.nowMs < s.lastClockMs) {
        // Only protection is allowed: no entry, no close, no halt, no cancel, and no state change but OPEN -> PROTECTING.
        for (const x of a) {
          if (x.type === "skip") continue;
          if (x.type === "place") assert.ok(x.req.reduceOnly && !x.req.cliOrdId.includes("-close-"), `${x.req.cliOrdId} on a backwards clock`);
          else if (x.type === "edit") assert.equal(x.stopPrice, undefined, "a stop must not be moved on an untrusted clock");
          else if (x.type === "transition") assert.ok(s.state === "OPEN" && x.to === "PROTECTING", `transition to ${x.to} on a backwards clock`);
          else assert.fail(`${x.type} on a backwards clock`);
        }
      }
      const entries = places(a).filter((r) => !r.reduceOnly);
      if (entries.length) {
        assert.ok(s.priceAgeSec !== null && s.priceAgeSec <= config.stale_data_max_age_sec, "an entry on stale data");
        assert.ok(s.policy && Date.parse(s.policy.policy.valid_until) > s.nowMs, "an entry on an expired policy");
        assert.ok(s.reconciled && !s.foreignExposure && !s.dailyLossBreached && !s.liquidated);
      }
    }
  });

  test("a stop is only ever tightened, never widened", () => {
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const s = randomSnapshot();
      const dir = s.trade?.direction === "short" ? -1 : 1;
      for (const e of edits(decide(s, config))) {
        if (e.stopPrice === undefined) continue;
        const current = s.openOrders.find((o) => o.cliOrdId === e.cliOrdId)?.stopPrice;
        assert.ok(current !== undefined, "an edit of an order that is not open");
        assert.ok((e.stopPrice - current) * dir > 0, `stop moved ${current} -> ${e.stopPrice} against a ${dir > 0 ? "long" : "short"}`);
        checked++;
      }
    }
    assert.ok(checked > 0, "the generator never produced a trailing edit: the property was not exercised");
  });

  test("a close never exceeds the position, and every id is a valid bot id", () => {
    for (let i = 0; i < 1500; i++) {
      const s = randomSnapshot();
      for (const req of places(decide(s, config))) {
        assert.ok(req.cliOrdId.length <= 100 && parseCliOrdId(req.cliOrdId), req.cliOrdId);
        if (req.reduceOnly && s.position) assert.ok(req.size <= s.position.size + 1e-12, `${req.cliOrdId} larger than the position`);
      }
    }
  });
});
