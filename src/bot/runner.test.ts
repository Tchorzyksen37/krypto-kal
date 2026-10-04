// runner.test.ts – the launcher's steps with a fake clock and market: alerts reach the sinks once, the report lands in
// the vault, funding is charged hourly, startup reconciles, and the market adapter maps Kraken's data.
// Run: node --test src/bot/runner.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type Alert, type AlertSink, VaultAlertSink, collectAlerts, dispatch } from "./alerts.ts";
import { BotStore } from "./bot-store.ts";
import { FakeClock } from "./clock.ts";
import { defaultEngineRecord, loadEngineRecord, saveEngineRecord } from "./engine-state.ts";
import { FeedingMarket, KrakenMarketData, type FuturesPublicApi } from "./market-data.ts";
import { type Runtime, loop, startup, traderStep, watchdogStep } from "./runner.ts";
import { T0, px } from "./sim-fixtures.ts";
import { world } from "./trader-fixtures.ts";

class Capture implements AlertSink {
  got: Alert[] = [];
  async send(a: Alert[]) {
    this.got.push(...a);
  }
}

const runtime = (o: { brainDir?: string } = {}) => {
  const w = world();
  const sink = new Capture();
  const rt: Runtime = { deps: w.deps, sim: w.ex, sinks: [sink], ...(o.brainDir ? { brainDir: o.brainDir } : {}) };
  return { w, sink, rt };
};

describe("alerts", () => {
  test("each incident alerts once, across calls", () => {
    const store = new BotStore(":memory:");
    store.addIncident({ tMs: T0, kind: "no_sl", detail: "long without a stop" });
    assert.deepEqual(collectAlerts(store, T0).map((a) => [a.level, a.kind]), [["incident", "no_sl"]]);
    assert.deepEqual(collectAlerts(store, T0 + 1), []);
    store.addIncident({ tMs: T0 + 2, kind: "cannot_verify", detail: "exchange down" });
    assert.deepEqual(collectAlerts(store, T0 + 3).map((a) => a.kind), ["cannot_verify"]);
  });

  test("a halt alerts once, says how to clear it, and its end alerts as recovered", () => {
    const store = new BotStore(":memory:");
    saveEngineRecord(store, { ...defaultEngineRecord(), state: "HALTED", sinceMs: T0, halt: { reason: "missing_trade_record", manualAck: true, untilMs: null } });
    const first = collectAlerts(store, T0);
    assert.equal(first.length, 1);
    assert.match(first[0]!.detail, /HALTED; needs `npm run bot -- ack-halt`/);
    assert.deepEqual(collectAlerts(store, T0 + 1), []);
    saveEngineRecord(store, { ...defaultEngineRecord(), state: "FLAT" });
    assert.deepEqual(collectAlerts(store, T0 + 2).map((a) => a.level), ["recovered"]);
    assert.deepEqual(collectAlerts(store, T0 + 3), []);
  });

  test("an unreadable engine record is an alert", () => {
    const store = new BotStore(":memory:");
    store.setKv("engine:record", "{broken");
    assert.equal(collectAlerts(store, T0)[0]!.kind, "engine_record_unreadable");
  });

  test("the vault sink appends to output/bot/alerts.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-vault-"));
    const sink = new VaultAlertSink(dir);
    await sink.send([{ tMs: T0, level: "incident", kind: "no_sl", detail: "a\\nb" }]);
    await sink.send([{ tMs: T0 + 1000, level: "halt", kind: "daily_loss_limit", detail: "halted" }]);
    const text = readFileSync(join(dir, "output", "bot", "alerts.md"), "utf8");
    assert.match(text, /^# Bot alerts \(dry-run\)/);
    assert.match(text, /\*\*INCIDENT\*\* `no_sl`/);
    assert.match(text, /\*\*HALT\*\* `daily_loss_limit`: halted\n$/);
  });

  test("a failing sink does not stop the others", async () => {
    const good = new Capture();
    await dispatch([{ tMs: T0, level: "incident", kind: "x", detail: "y" }], [{ send: async () => { throw new Error("disk full"); } }, good]);
    assert.equal(good.got.length, 1);
  });
});

describe("runner steps", () => {
  test("startup reconciles and allows entries on a clean world", async () => {
    const { w, rt } = runtime();
    saveEngineRecord(w.store, { ...defaultEngineRecord(), reconciled: false });
    const r = await startup(rt);
    assert.equal(r.clean, true);
    assert.equal(loadEngineRecord(w.store).reconciled, true);
  });

  test("a trader step runs a cycle, charges funding once per hour and marks it, and alerts incidents", async () => {
    const { w, rt, sink } = runtime();
    w.tick(99250);
    await traderStep(rt);
    assert.ok(w.store.listJournal(0, "cycle").length >= 1);
    assert.equal(w.store.listDocs("funding_mark", 0).length, 1);
    await traderStep(rt);
    assert.equal(w.store.listDocs("funding_mark", 0).length, 1, "same hour: no second charge");

    w.wrapped.unreadable = true; // the exchange cannot be read: an incident, then an alert
    await traderStep(rt);
    assert.ok(sink.got.some((a) => a.kind === "cannot_verify"));
  });

  test("an unreachable funding endpoint is one incident per cause and hour, not one per step", async () => {
    const { w, rt } = runtime();
    w.market.fundingRates = async () => { throw new Error("HTTP 403"); };
    for (let i = 0; i < 5; i++) {
      w.tick(99250);
      await traderStep(rt);
    }
    assert.equal(w.store.listIncidents(0).filter((i) => i.kind === "funding_unavailable").length, 1);
    w.clock.advance(3_600_000);
    await traderStep(rt);
    assert.equal(w.store.listIncidents(0).filter((i) => i.kind === "funding_unavailable").length, 2);
    w.market.fundingRates = async () => [{ t: w.clock.now() - 1000, rate: 0.0001 }];
    await traderStep(rt);
    assert.ok(w.store.listDocs("funding_mark", 0).length >= 1, "recovers and marks again");
  });

  test("a trader step writes today's report into the vault, hourly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-vault-"));
    const { w, rt } = runtime({ brainDir: dir });
    w.tick(99250);
    await traderStep(rt);
    const path = join(dir, "output", "bot", "report-2026-10-03.md");
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf8"), /# Bot report \(dry-run\)/);
  });

  test("a watchdog step never throws, even when the exchange cannot be read", async () => {
    const { w } = runtime();
    w.wrapped.unreadable = true;
    await watchdogStep(w.deps);
    assert.ok(w.store.listIncidents(0).length >= 1);
  });

  test("loop runs steps until stopped and does not stack them", async () => {
    let n = 0;
    const slept: number[] = [];
    await loop(async () => void n++, 5000, { stop: () => n >= 3, sleep: async (ms) => void slept.push(ms) });
    assert.equal(n, 3);
    assert.deepEqual(slept, [5000, 5000]);
  });
});

describe("market data", () => {
  const api = (): FuturesPublicApi & { ranges: unknown[] } => {
    const ranges: unknown[] = [];
    return {
      ranges,
      async tickers() {
        return [{ symbol: "PF_XBTUSD", last: 100000, markPrice: 100010, bid: 99995, ask: 100005, vol24h: 1, openInterest: 1, suspended: false }];
      },
      async candles(_s, _r, range) {
        ranges.push(range);
        return { candles: Array.from({ length: 20 }, (_, i) => ({ t: i, o: 1, h: 2, l: 0.5, c: 1, v: 1 })) };
      },
      async instrument() {
        return { symbol: "PF_XBTUSD", type: "flexible_futures", tradeable: true, tickSize: 1, contractSize: 1, contractValueTradePrecision: 4 };
      },
      async fundingRates() {
        return [{ t: 1_700_000_000, fundingRate: 1, relativeFundingRate: 0.00001 }];
      },
    };
  };

  test("maps the ticker, candles, contract and funding of the configured symbol", async () => {
    const clock = new FakeClock(T0);
    const a = api();
    const m = new KrakenMarketData(a, "PF_XBTUSD", clock);
    assert.deepEqual(await m.ticker(), { t: T0, mark: 100010, last: 100000, bid: 99995, ask: 100005 });
    assert.equal((await m.candles("1h", 15)).length, 15);
    assert.deepEqual(a.ranges[0], { from: T0 / 1000 - 16 * 3600, to: T0 / 1000 });
    assert.deepEqual(await m.contract(), { tickSize: 1, sizeStep: 0.0001, minSize: 0.0001 });
    assert.deepEqual(await m.fundingRates(), [{ t: 1_700_000_000_000, rate: 0.00001 }]);
    await assert.rejects(() => m.candles("7m", 3), /unknown resolution/);
  });

  test("a suspended or missing symbol is an error, not a price", async () => {
    const clock = new FakeClock(T0);
    const a = api();
    a.tickers = async () => [{ symbol: "PF_XBTUSD", last: 1, markPrice: 1, bid: 1, ask: 1, vol24h: 0, openInterest: 0, suspended: true }];
    await assert.rejects(() => new KrakenMarketData(a, "PF_XBTUSD", clock).ticker(), /suspended/);
    a.tickers = async () => [];
    await assert.rejects(() => new KrakenMarketData(a, "PF_XBTUSD", clock).ticker(), /no ticker/);
  });

  test("FeedingMarket hands every quote to the simulator and survives a feed error", async () => {
    const clock = new FakeClock(T0);
    const fed: number[] = [];
    const inner = new KrakenMarketData(api(), "PF_XBTUSD", clock);
    const m = new FeedingMarket(inner, { onPrice: (e) => void fed.push(e.last) });
    assert.equal((await m.ticker()).last, 100000);
    assert.deepEqual(fed, [100000]);
    const errors: unknown[] = [];
    const broken = new FeedingMarket(inner, { onPrice: () => { throw new Error("db locked"); } });
    broken.onFeedError = (e) => void errors.push(e);
    assert.equal((await broken.ticker()).last, 100000);
    assert.equal(errors.length, 1);
    assert.ok(px(1, 1)); // fixtures stay importable
  });
});
