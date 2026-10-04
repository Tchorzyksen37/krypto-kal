// limits.test.ts – offline tests of the day boundary, daily counters, entry limits, cooldowns and the daily-loss test.
// Run: node --test bot/limits.test.ts
//
// Limits only ever block ENTRIES. An entry places several orders (entry, stop, up to three targets), so the gate
// must reserve room for all of them: the protective orders themselves must never be blocked by a limit.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FuturesFill } from "../providers/kraken/kraken-futures-client.ts";
import { BotStore } from "./bot-store.ts";
import { type BotConfig, defaultConfig } from "./config.ts";
import {
  type EntryCheck, cooldownUntil, dailyLossBreached, dayStartMs, entryAllowed, netRealizedSince, rebuildCounters,
  recordPlacedOrder, tradingDay,
} from "./limits.ts";

const config: BotConfig = defaultConfig(); // 2 entries/day, 20 orders/day, 1 position, risk 0.5%/trade and in total
const NOW = Date.parse("2026-10-03T12:00:00Z");
const DAY = "2026-10-03";
const iso = (s: string) => Date.parse(s);

describe("tradingDay / dayStartMs", () => {
  test("with reset hour 0 the day changes at 00:00 UTC", () => {
    assert.equal(tradingDay(iso("2026-10-03T23:59:59.999Z"), 0), "2026-10-03");
    assert.equal(tradingDay(iso("2026-10-04T00:00:00.000Z"), 0), "2026-10-04");
  });

  test("with reset hour 6 the day changes at 06:00 UTC, across month and year ends too", () => {
    assert.equal(tradingDay(iso("2026-10-04T05:59:59.999Z"), 6), "2026-10-03");
    assert.equal(tradingDay(iso("2026-10-04T06:00:00.000Z"), 6), "2026-10-04");
    assert.equal(tradingDay(iso("2026-01-01T03:00:00Z"), 6), "2025-12-31");
    assert.equal(tradingDay(iso("2026-03-01T05:00:00Z"), 6), "2026-02-28");
  });

  test("dayStartMs is the most recent reset instant at or before now", () => {
    assert.equal(dayStartMs(iso("2026-10-04T10:00:00Z"), 6), iso("2026-10-04T06:00:00Z"));
    assert.equal(dayStartMs(iso("2026-10-04T05:00:00Z"), 6), iso("2026-10-03T06:00:00Z"));
    assert.equal(dayStartMs(iso("2026-10-04T06:00:00Z"), 6), iso("2026-10-04T06:00:00Z"));
    assert.equal(dayStartMs(iso("2026-10-04T10:00:00Z"), 0), iso("2026-10-04T00:00:00Z"));
  });

  test("every instant belongs to the day that starts at its dayStartMs", () => {
    for (const reset of [0, 5, 23]) {
      for (let h = 0; h < 72; h += 7) {
        const t = iso("2026-10-01T00:00:00Z") + h * 3_600_000 + 12_345;
        assert.equal(tradingDay(dayStartMs(t, reset), reset), tradingDay(t, reset));
        assert.equal(tradingDay(dayStartMs(t, reset) - 1, reset) === tradingDay(t, reset), false);
      }
    }
  });
});

describe("recordPlacedOrder", () => {
  test("counts every placed order, and entries separately", () => {
    const s = new BotStore(":memory:");
    assert.equal(recordPlacedOrder(s, config, NOW, { cliOrdId: "bot-1-entry-0", isEntry: true }), true);
    assert.equal(recordPlacedOrder(s, config, NOW, { cliOrdId: "bot-1-sl-0", isEntry: false }), true);
    assert.equal(recordPlacedOrder(s, config, NOW, { cliOrdId: "bot-1-tp1-0", isEntry: false }), true);
    assert.equal(s.getCounter(DAY, "orders"), 3);
    assert.equal(s.getCounter(DAY, "entries"), 1);
  });

  test("is idempotent per cliOrdId: a retry after a lost ack is not counted twice", () => {
    const s = new BotStore(":memory:");
    recordPlacedOrder(s, config, NOW, { cliOrdId: "bot-1-entry-0", isEntry: true });
    assert.equal(recordPlacedOrder(s, config, NOW + 5_000, { cliOrdId: "bot-1-entry-0", isEntry: true }), false);
    assert.equal(s.getCounter(DAY, "orders"), 1);
    assert.equal(s.getCounter(DAY, "entries"), 1);
  });

  test("the day boundary decides which day an order counts for", () => {
    const s = new BotStore(":memory:");
    recordPlacedOrder(s, config, iso("2026-10-03T23:59:00Z"), { cliOrdId: "a", isEntry: true });
    recordPlacedOrder(s, config, iso("2026-10-04T00:01:00Z"), { cliOrdId: "b", isEntry: true });
    assert.equal(s.getCounter("2026-10-03", "entries"), 1);
    assert.equal(s.getCounter("2026-10-04", "entries"), 1);
  });
});

describe("entryAllowed", () => {
  const store = () => new BotStore(":memory:");
  const check = (s: BotStore, over: Partial<EntryCheck> = {}): ReturnType<typeof entryAllowed> =>
    entryAllowed({
      store: s, config, nowMs: NOW, lastClockMs: NOW - 1000, openRiskPct: 0, newRiskPct: 0.3, openPositions: 0, ordersNeeded: 5,
      ...over,
    });
  const blocked = (r: ReturnType<typeof entryAllowed>, reason: string) => {
    assert.ok(!r.ok, `expected ${reason}, got ok`);
    assert.equal(r.reason, reason);
  };

  test("a fresh day with nothing open is allowed", () => {
    assert.deepEqual(check(store()), { ok: true });
  });

  test("max_entries_per_day blocks at the limit, not before", () => {
    const s = store();
    s.addCounter(DAY, "entries", config.max_entries_per_day - 1);
    assert.deepEqual(check(s), { ok: true });
    s.addCounter(DAY, "entries", 1);
    blocked(check(s), "max_entries_per_day");
  });

  test("max_orders_per_day reserves room for the whole bundle (entry, stop, targets)", () => {
    const s = store();
    s.addCounter(DAY, "orders", config.max_orders_per_day - 5);
    assert.deepEqual(check(s, { ordersNeeded: 5 }), { ok: true }); // 15 + 5 = 20: exactly fits
    s.addCounter(DAY, "orders", 1);
    blocked(check(s, { ordersNeeded: 5 }), "max_orders_per_day"); // 16 + 5 = 21: the stop would not fit
    assert.deepEqual(check(s, { ordersNeeded: 4 }), { ok: true }); // a smaller bundle (two targets) still fits
  });

  test("counters of other days do not count", () => {
    const s = store();
    s.addCounter("2026-10-02", "entries", 99);
    s.addCounter("2026-10-02", "orders", 99);
    assert.deepEqual(check(s), { ok: true });
  });

  test("an open position blocks a new entry (max_open_positions, then max_positions_per_asset)", () => {
    blocked(check(store(), { openPositions: 1 }), "max_open_positions");
    const looser: BotConfig = { ...config, max_open_positions: 3 };
    blocked(
      entryAllowed({ store: store(), config: looser, nowMs: NOW, lastClockMs: 0, openRiskPct: 0, newRiskPct: 0.1, openPositions: 1, ordersNeeded: 5 }),
      "max_positions_per_asset",
    );
  });

  test("total open risk plus the new risk may not exceed max_total_open_risk_pct", () => {
    const looser: BotConfig = { ...config, max_open_positions: 3, max_positions_per_asset: 3 };
    const at = (open: number, add: number) =>
      entryAllowed({ store: store(), config: looser, nowMs: NOW, lastClockMs: 0, openRiskPct: open, newRiskPct: add, openPositions: 1, ordersNeeded: 5 });
    assert.deepEqual(at(0.3, 0.2), { ok: true }); // 0.5 = the limit
    blocked(at(0.3, 0.21), "max_total_open_risk");
  });

  test("one trade's risk may not exceed max_risk_per_trade_pct (defence in depth behind sizing)", () => {
    blocked(check(store(), { newRiskPct: config.max_risk_per_trade_pct + 0.01 }), "max_risk_per_trade");
    assert.deepEqual(check(store(), { newRiskPct: config.max_risk_per_trade_pct }), { ok: true });
  });

  test("a clock that moved backwards blocks entries instead of throwing", () => {
    blocked(check(store(), { nowMs: NOW - 60_000, lastClockMs: NOW }), "clock_went_backwards");
    assert.deepEqual(check(store(), { nowMs: NOW, lastClockMs: NOW }), { ok: true }); // equal is fine
  });

  test("garbage numbers block instead of passing", () => {
    for (const bad of [
      { newRiskPct: Number.NaN }, { openRiskPct: Number.NaN }, { nowMs: Number.NaN }, { ordersNeeded: -1 },
      { ordersNeeded: Number.NaN }, { openPositions: -1 }, { newRiskPct: 0 },
    ] as Partial<EntryCheck>[]) {
      blocked(check(store(), bad), "invalid_input");
    }
  });

  test("property: an allowed entry never breaks any cap", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    const loose: BotConfig = { ...config, max_open_positions: 4, max_positions_per_asset: 4 };
    for (let i = 0; i < 500; i++) {
      const s = store();
      const entries = Math.floor(rnd() * 4);
      const orders = Math.floor(rnd() * 25);
      s.addCounter(DAY, "entries", entries);
      s.addCounter(DAY, "orders", orders);
      const open = Math.floor(rnd() * 5);
      const openRisk = rnd() * 0.8;
      const add = 0.01 + rnd() * 0.7;
      const need = 1 + Math.floor(rnd() * 5);
      const r = entryAllowed({ store: s, config: loose, nowMs: NOW, lastClockMs: 0, openRiskPct: openRisk, newRiskPct: add, openPositions: open, ordersNeeded: need });
      if (!r.ok) continue;
      assert.ok(entries < loose.max_entries_per_day);
      assert.ok(orders + need <= loose.max_orders_per_day);
      assert.ok(open < loose.max_open_positions && open < loose.max_positions_per_asset);
      assert.ok(openRisk + add <= loose.max_total_open_risk_pct + 1e-9);
      assert.ok(add <= loose.max_risk_per_trade_pct + 1e-9);
    }
  });
});

describe("cooldownUntil", () => {
  test("is the close time plus the cooldown, and longer after a loss", () => {
    const closedAtMs = NOW;
    assert.equal(cooldownUntil({ closedAtMs, lossy: false, config }), NOW + 30 * 60_000);
    assert.equal(cooldownUntil({ closedAtMs, lossy: true, config }), NOW + 120 * 60_000);
  });

  test("after a loss it is never shorter than after a normal close, even with an odd config", () => {
    const odd: BotConfig = { ...config, cooldown_after_close_min: 90, cooldown_after_loss_min: 10 };
    assert.equal(cooldownUntil({ closedAtMs: NOW, lossy: true, config: odd }), NOW + 90 * 60_000);
  });
});

describe("dailyLossBreached", () => {
  // limit: 1.5% of 1000 = $15
  test("realised plus unrealised loss at or beyond the limit breaches it", () => {
    assert.equal(dailyLossBreached({ realized: -10, unrealized: -5, config }), true); // exactly 15
    assert.equal(dailyLossBreached({ realized: -10, unrealized: -4.99, config }), false);
    assert.equal(dailyLossBreached({ realized: 0, unrealized: -20, config }), true); // an open loss counts
    assert.equal(dailyLossBreached({ realized: -20, unrealized: 0, config }), true);
  });

  test("profit never breaches, and a profit offsets a loss", () => {
    assert.equal(dailyLossBreached({ realized: 50, unrealized: 0, config }), false);
    assert.equal(dailyLossBreached({ realized: 20, unrealized: -30, config }), false); // net -10
  });

  test("numbers that cannot be evaluated count as breached (fail safe)", () => {
    assert.equal(dailyLossBreached({ realized: Number.NaN, unrealized: 0, config }), true);
    assert.equal(dailyLossBreached({ realized: 0, unrealized: Number.POSITIVE_INFINITY, config }), true);
  });
});

describe("netRealizedSince", () => {
  const fill = (over: Partial<FuturesFill>): FuturesFill => ({
    fill_id: "f", order_id: "o", symbol: "PF_XBTUSD", side: "sell", size: 0.01, price: 100000,
    fillTime: "2026-10-03T10:00:00.000Z", fillType: "taker", realized_pnl: 0, ...over,
  });

  test("sums realised PnL minus fees (maker 2 bps, taker 5 bps of notional) for fills since the time", () => {
    const fills = [
      fill({ fillTime: "2026-10-03T09:00:00.000Z", realized_pnl: 100 }), // before: ignored
      fill({ fillTime: "2026-10-03T10:00:00.000Z", realized_pnl: 5, fillType: "taker" }), // 5 - 0.5
      fill({ fillTime: "2026-10-03T11:00:00.000Z", realized_pnl: -2, fillType: "maker" }), // -2 - 0.2
    ];
    const since = iso("2026-10-03T09:30:00Z");
    assert.ok(Math.abs(netRealizedSince(fills, since, config) - (4.5 - 2.2)) < 1e-9);
  });

  test("a missing or null realised PnL counts as zero but the fee still counts", () => {
    const fills = [fill({ realized_pnl: null }), fill({ realized_pnl: undefined })];
    assert.ok(Math.abs(netRealizedSince(fills, 0, config) - -1.0) < 1e-9); // two taker fees of 0.5
  });

  test("an unknown fill type is charged the taker fee (the pessimistic one)", () => {
    const fills = [fill({ fillType: "liquidation", realized_pnl: 0 })];
    assert.ok(Math.abs(netRealizedSince(fills, 0, config) - -0.5) < 1e-9);
  });

  test("a fill with an unreadable time is ignored rather than throwing", () => {
    assert.equal(netRealizedSince([fill({ fillTime: "not a time", realized_pnl: -999 })], 0, config), 0);
  });

  test("no fills is zero", () => {
    assert.equal(netRealizedSince([], 0, config), 0);
  });
});

describe("rebuildCounters", () => {
  test("raises counters to what the exchange history shows, per trading day", () => {
    const s = new BotStore(":memory:");
    rebuildCounters(s, config, [
      { placedAtMs: iso("2026-10-03T08:00:00Z"), isEntry: true },
      { placedAtMs: iso("2026-10-03T08:00:01Z"), isEntry: false },
      { placedAtMs: iso("2026-10-03T08:00:02Z"), isEntry: false },
      { placedAtMs: iso("2026-10-04T00:30:00Z"), isEntry: true },
    ]);
    assert.equal(s.getCounter("2026-10-03", "orders"), 3);
    assert.equal(s.getCounter("2026-10-03", "entries"), 1);
    assert.equal(s.getCounter("2026-10-04", "orders"), 1);
    assert.equal(s.getCounter("2026-10-04", "entries"), 1);
  });

  test("never lowers a persisted counter: the higher of persisted and rebuilt wins", () => {
    const s = new BotStore(":memory:");
    s.addCounter(DAY, "orders", 9);
    s.addCounter(DAY, "entries", 2);
    rebuildCounters(s, config, [{ placedAtMs: NOW, isEntry: true }]); // history shows only 1 and 1 (a short window)
    assert.equal(s.getCounter(DAY, "orders"), 9);
    assert.equal(s.getCounter(DAY, "entries"), 2);
  });

  test("running it twice changes nothing (it is a max, not an add)", () => {
    const s = new BotStore(":memory:");
    const history = [{ placedAtMs: NOW, isEntry: true }, { placedAtMs: NOW + 1, isEntry: false }];
    rebuildCounters(s, config, history);
    rebuildCounters(s, config, history);
    assert.equal(s.getCounter(DAY, "orders"), 2);
  });

  test("an empty history or a bad timestamp does nothing and does not throw", () => {
    const s = new BotStore(":memory:");
    rebuildCounters(s, config, []);
    rebuildCounters(s, config, [{ placedAtMs: Number.NaN, isEntry: true }]);
    assert.equal(s.getCounter(DAY, "orders"), 0);
  });

  test("a rebuild that finds the entry budget already used blocks the next entry", () => {
    const s = new BotStore(":memory:");
    rebuildCounters(s, config, [
      { placedAtMs: NOW - 3_000, isEntry: true }, { placedAtMs: NOW - 2_000, isEntry: true },
    ]);
    const r = entryAllowed({ store: s, config, nowMs: NOW, lastClockMs: 0, openRiskPct: 0, newRiskPct: 0.2, openPositions: 0, ordersNeeded: 5 });
    assert.ok(!r.ok);
    assert.equal(r.reason, "max_entries_per_day");
  });
});
