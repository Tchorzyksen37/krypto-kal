import assert from "node:assert/strict";
import { test } from "node:test";
import type { FuturesAccountLogEntry } from "../providers/kraken/kraken-futures-client.ts";
import { setLogLevel } from "../core/logger.ts";
import { AccountLogStore, syncAccountLog } from "./account-log.ts";
import { accountStats, instrumentOf, kindOf, toBooking } from "./account-stats.ts";

setLogLevel("error");

let balance = 1000;
let nextId = 1;
// A booking whose balance change is exactly gross - fee + funding, as Kraken books it.
function entry(date: string, info: string, contract: string | null, p: { pnl?: number; fee?: number; funding?: number; asset?: string; skew?: number } = {}): FuturesAccountLogEntry {
  const old = balance;
  balance += (p.pnl ?? 0) - (p.fee ?? 0) + (p.funding ?? 0) + (p.skew ?? 0);
  return {
    id: nextId++, date, info, asset: p.asset ?? "usd", contract, old_balance: old, new_balance: balance,
    realized_pnl: p.pnl ?? 0, fee: p.fee ?? 0, ...(p.funding !== undefined ? { realized_funding: p.funding } : {}),
  };
}

function history(): FuturesAccountLogEntry[] {
  balance = 1000;
  nextId = 1;
  return [
    entry("2026-10-07T08:00:00Z", "transfer", null, { pnl: 0 }), // a deposit: not a result
    entry("2026-10-07T09:00:00Z", "futures trade", "pf_xrpusd", { fee: 0.5 }), // opening fill: fee only
    entry("2026-10-07T12:00:00Z", "futures trade", "pf_xrpusd", { pnl: 42, fee: 0.6 }),
    entry("2026-10-07T16:00:00Z", "funding rate change", "pf_xrpusd", { funding: -0.3 }),
    entry("2026-10-08T10:00:00Z", "futures trade", "pf_ethusd", { pnl: -20, fee: 1 }),
    entry("2026-10-08T11:00:00Z", "futures trade", "pf_xbtusd", { pnl: 66, fee: 2 }),
    entry("2026-10-12T07:00:00Z", "futures trade", "pf_dotusd", { pnl: 27.6, fee: 0.4 }),
    entry("2026-10-12T08:00:00Z", "funding rate change", "pf_dotusd", { funding: 0.1 }),
    entry("2026-10-12T08:30:00Z", "futures trade", "pf_xrpusd", { pnl: -5, fee: 0.2, asset: "eur" }), // not converted
  ];
}

const AS_OF = Date.parse("2026-10-12T09:00:00Z");

test("info kinds and instrument names", () => {
  assert.deepEqual(["futures trade", "Funding Rate Change", "futures liquidation", "transfer", "conversion", "futures assignee"].map(kindOf), ["trade", "funding", "liquidation", "other", "other", "trade"]);
  assert.deepEqual(["pf_xbtusd", "PF_XRPUSD", "fi_xbtusd_260327", "pi_ethusd", "weird", null].map(instrumentOf), ["BTC", "XRP", "BTC", "ETH", "WEIRD", ""]);
});

test("a booking: gross, fees as a cost, funding, net from the balance change", () => {
  balance = 1000;
  const b = toBooking(entry("2026-10-07T12:00:00Z", "futures trade", "pf_xrpusd", { pnl: 42, fee: -0.6 }))!; // fee sign does not matter
  assert.deepEqual({ gross: b.gross, fees: b.fees, funding: b.funding, closing: b.closing, mismatch: b.mismatch }, { gross: 42, fees: 0.6, funding: 0, closing: true, mismatch: true });
  assert.equal(Number(b.net.toFixed(6)), 42.6); // the balance moved by 42 - (-0.6): the net trusts the balance, and the mismatch flags it
  const f = toBooking({ id: 9, date: "2026-10-07T16:00:00Z", info: "funding rate change", asset: "usd", contract: "pf_xrpusd", old_balance: 10, new_balance: 9.7 })!;
  assert.deepEqual({ kind: f.kind, funding: Number(f.funding.toFixed(6)), net: Number(f.net.toFixed(6)), mismatch: f.mismatch }, { kind: "funding", funding: -0.3, net: -0.3, mismatch: false });
});

test("totals, days, instruments, today, wins and profit factor", () => {
  const s = accountStats(history(), [], AS_OF);
  const r2 = (x: number) => Number(x.toFixed(2));
  assert.equal(s.since, "2026-10-07T09:00:00.000Z");
  assert.deepEqual({ gross: r2(s.total.gross), fees: r2(s.total.fees), funding: r2(s.total.funding), net: r2(s.total.net) }, { gross: 115.6, fees: 4.5, funding: -0.2, net: 110.9 });
  assert.deepEqual({ closing: s.total.closing, wins: s.total.wins, losses: s.total.losses }, { closing: 4, wins: 3, losses: 1 });
  assert.equal(s.total.winRate, 0.75);
  assert.equal(r2(s.total.profitFactor!), r2((42 + 66 + 27.6) / 20));
  assert.deepEqual(s.byDay.map((d) => [d.day, r2(d.net)]), [["2026-10-07", 40.6], ["2026-10-08", 43], ["2026-10-12", 27.3]]);
  assert.deepEqual(s.byInstrument.map((i) => [i.instrument, i.closing, r2(i.net)]), [["BTC", 1, 64], ["XRP", 1, 40.6], ["DOT", 1, 27.3], ["ETH", 1, -21]]);
  assert.deepEqual({ day: s.today.day, gross: r2(s.today.gross), net: r2(s.today.net) }, { day: "2026-10-12", gross: 27.6, net: 27.3 });
  assert.deepEqual(s.today.byInstrument.map((i) => i.instrument), ["DOT"]);
  assert.deepEqual(s.quality.excluded, { transfer: 1 });
  assert.deepEqual(s.quality.otherAssets, { eur: 1 });
  assert.equal(s.quality.mismatches, 0);
});

test("a booking that does not add up is counted, and the net still follows the balance", () => {
  balance = 1000;
  nextId = 1;
  const s = accountStats([entry("2026-10-12T07:00:00Z", "futures trade", "pf_dotusd", { pnl: 10, fee: 1, skew: -2 })], undefined, AS_OF);
  assert.equal(s.quality.mismatches, 1);
  assert.deepEqual(s.quality.mismatchIds, [1]);
  assert.equal(s.total.net, 7);
  assert.equal(s.open.available, false);
});

test("open positions: unrealized PnL and funding summed", () => {
  const s = accountStats([], [
    { symbol: "PF_DOTUSD", side: "short", size: 100, price: 4.2, unrealizedPnl: 12.1, unrealizedFunding: -0.05 },
    { symbol: "PF_XRPUSD", side: "long", size: 50, price: 0.52, unrealizedFunding: null },
  ], AS_OF);
  assert.equal(s.open.unrealized, 12.1);
  assert.equal(s.open.unrealizedFunding, -0.05);
  assert.deepEqual(s.open.positions.map((p) => [p.instrument, p.side, p.unrealizedPnl]), [["DOT", "short", 12.1], ["XRP", "long", undefined]]);
  assert.equal(s.since, undefined);
});

test("sync: the first run reads everything page by page, later runs only what is new", async () => {
  const all = history();
  const calls: { from?: number; count?: number }[] = [];
  const source = {
    accountLog: async (p: { from?: number; count?: number }) => {
      calls.push(p);
      return all.filter((e) => e.id >= (p.from ?? 0)).slice(0, p.count);
    },
  };
  const store = new AccountLogStore(":memory:");
  const first = await syncAccountLog(source, store, 4);
  assert.deepEqual({ pages: first.pages, inserted: first.inserted, total: first.total, complete: first.complete }, { pages: 3, inserted: 9, total: 9, complete: true });
  assert.deepEqual(calls.map((c) => c.from), [0, 5, 9]);
  calls.length = 0;
  const again = await syncAccountLog(source, store, 4);
  assert.deepEqual({ pages: again.pages, inserted: again.inserted }, { pages: 1, inserted: 0 });
  assert.deepEqual(calls.map((c) => c.from), [10]);
  assert.deepEqual(store.entries().map((e) => e.id), all.map((e) => e.id));
  store.saveRate("USDPLN=X", 2000, 3.9);
  store.saveRate("USDPLN=X", 1000, 3.8);
  assert.deepEqual(store.latestRate("USDPLN=X"), { tMs: 2000, rate: 3.9 });
  assert.equal(store.latestRate("USDEUR=X"), undefined);
  store.close();
});

test("sync stops at the page limit and says so", async () => {
  const all = history();
  const store = new AccountLogStore(":memory:");
  const r = await syncAccountLog({ accountLog: async (p) => all.filter((e) => e.id >= (p.from ?? 0)).slice(0, p.count) }, store, 2, 2);
  assert.deepEqual({ inserted: r.inserted, complete: r.complete }, { inserted: 4, complete: false });
  store.close();
});
