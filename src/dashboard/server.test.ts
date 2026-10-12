import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setLogLevel } from "../core/logger.ts";
import type { FuturesAccountLogEntry, FuturesPosition } from "../providers/kraken/kraken-futures-client.ts";
import { AccountLogStore } from "../trading/account-log.ts";
import { Dashboard } from "./server.ts";

setLogLevel("error");

const LOGS: FuturesAccountLogEntry[] = [
  { id: 1, date: "2026-10-11T10:00:00Z", info: "futures trade", asset: "usd", contract: "pf_xrpusd", old_balance: 100, new_balance: 109, realized_pnl: 10, fee: 1 },
  { id: 2, date: "2026-10-12T07:00:00Z", info: "futures trade", asset: "usd", contract: "pf_dotusd", old_balance: 109, new_balance: 136.2, realized_pnl: 27.6, fee: 0.4 },
];

function fakes(o: { failSync?: boolean; failFx?: boolean } = {}) {
  let now = Date.parse("2026-10-12T09:00:00Z");
  const calls = { log: 0, positions: 0, quotes: 0 };
  const store = new AccountLogStore(":memory:");
  const dashboard = new Dashboard({
    futures: {
      accountLog: async (p: { from?: number }) => {
        calls.log++;
        if (o.failSync) throw new Error("authenticationError");
        return LOGS.filter((e) => e.id >= (p.from ?? 0));
      },
      openPositions: async (): Promise<FuturesPosition[]> => {
        calls.positions++;
        return [{ symbol: "PF_DOTUSD", side: "short", size: 100, price: 4.2, unrealizedPnl: 12.1, unrealizedFunding: 0 }];
      },
    },
    quotes: {
      quotes: async () => {
        calls.quotes++;
        if (o.failFx) throw new Error("http 429");
        return [{ symbol: "USDPLN=X", price: 3.95, marketTime: "2026-10-12T08:55:00Z" }];
      },
    },
    store, currency: "PLN", now: () => now,
  });
  return { dashboard, calls, store, tick: (ms: number) => (now += ms) };
}

test("the payload: stats, the FX rate stored in SQLite, the sync and the open positions", async () => {
  const { dashboard, calls, store } = fakes();
  const p = await dashboard.payload();
  assert.equal(p.currency, "PLN");
  assert.deepEqual(p.fx, { pair: "USDPLN=X", rate: 3.95, time: "2026-10-12T08:55:00.000Z", stale: false });
  assert.deepEqual(store.latestRate("USDPLN=X"), { tMs: Date.parse("2026-10-12T08:55:00Z"), rate: 3.95 });
  assert.equal(p.sync.result?.inserted, 2);
  assert.equal(Number(p.stats.today.net.toFixed(2)), 27.2);
  assert.equal(p.stats.open.unrealized, 12.1);
  assert.deepEqual(calls, { log: 1, positions: 1, quotes: 1 });
});

test("caching: no new sync, quote or position read inside their ages; refresh=1 forces a sync", async () => {
  const { dashboard, calls, tick } = fakes();
  await dashboard.payload();
  tick(20_000);
  await dashboard.payload();
  assert.deepEqual(calls, { log: 1, positions: 1, quotes: 1 });
  await dashboard.payload(true);
  assert.equal(calls.log, 2);
  tick(16 * 60_000);
  await dashboard.payload();
  assert.deepEqual(calls, { log: 3, positions: 2, quotes: 2 });
});

test("concurrent page loads share one sync", async () => {
  const { dashboard, calls } = fakes();
  await Promise.all([dashboard.payload(true), dashboard.payload(true), dashboard.payload(true)]);
  assert.equal(calls.log, 1);
});

test("failures are shown, not thrown: a failed sync keeps the stored data, a failed FX read keeps the last rate", async () => {
  const ok = fakes();
  await ok.dashboard.payload();
  const failing = fakes({ failSync: true, failFx: true });
  const p = await failing.dashboard.payload();
  assert.match(p.sync.error ?? "", /authenticationError/);
  assert.equal(p.fx, undefined); // nothing stored yet in this database
  failing.store.saveRate("USDPLN=X", Date.parse("2026-10-10T20:00:00Z"), 3.9);
  failing.tick(16 * 60_000);
  const q = await failing.dashboard.payload();
  assert.deepEqual({ rate: q.fx?.rate, stale: q.fx?.stale, error: q.fx?.error }, { rate: 3.9, stale: true, error: "http 429" });
});

test("HTTP: the page, the JSON API and 404", async () => {
  const { dashboard } = fakes();
  const server = createServer((req, res) => void dashboard.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /<title>Kraken Futures – wyniki<\/title>/);
    const api = await fetch(`${base}/api/stats`);
    assert.equal(api.status, 200);
    const body = (await api.json()) as { stats: { byInstrument: { instrument: string }[] } };
    assert.deepEqual(body.stats.byInstrument.map((i) => i.instrument), ["DOT", "XRP"]);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});
