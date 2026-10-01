// coinalyze-cache.test.ts – offline test of the persistent history cache (fake API, no key or network).
// Run: npm run test:cache

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { CoinalyzeClient, INTERVAL_SECONDS, type OhlcPoint } from "./coinalyze-client.ts";
import { HistoryStore, mergeRanges, subtractRanges } from "./history-store.ts";
import { setLogLevel } from "./logger.ts";

setLogLevel("warn");

const H = INTERVAL_SECONDS["1hour"];
const SYMBOL = "BTCUSDT_PERP.A";

interface ApiCall {
  path: string;
  symbols: string[];
  from: number;
  to: number;
}

let calls: ApiCall[];

// Fake API: for every symbol returns one point per hour in [from, to]; value = t (easy to check).
function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input));
  const q = url.searchParams;
  const call: ApiCall = {
    path: url.pathname.split("/").at(-1)!,
    symbols: q.get("symbols")!.split(","),
    from: Number(q.get("from")),
    to: Number(q.get("to")),
  };
  calls.push(call);
  const sec = INTERVAL_SECONDS[q.get("interval") as "1hour"];
  const body = call.symbols.map((symbol) => {
    const history: OhlcPoint[] = [];
    for (let t = Math.ceil(call.from / sec) * sec; t <= call.to; t += sec) {
      history.push({ t, o: t, h: t, l: t, c: t });
    }
    return { symbol, history };
  });
  return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
}

function makeClient(store: HistoryStore) {
  // No throttle and no memory cache – only the persistent cache is under test.
  return new CoinalyzeClient({ apiKey: "test", msPerCall: 0, cacheTtlMs: 0, settleSeconds: 0, store });
}

// Hour-aligned timestamp fully in the past (a closed interval).
const hoursAgo = (n: number) => Math.floor(Date.now() / 1000 / H) * H - n * H;

describe("ranges", () => {
  test("mergeRanges merges overlapping and adjacent ranges", () => {
    assert.deepEqual(
      mergeRanges([{ from: 10, to: 20 }, { from: 0, to: 5 }, { from: 21, to: 30 }, { from: 6, to: 7 }]),
      [{ from: 0, to: 7 }, { from: 10, to: 30 }],
    );
  });

  test("subtractRanges returns the gaps", () => {
    assert.deepEqual(
      subtractRanges({ from: 0, to: 100 }, [{ from: 10, to: 20 }, { from: 50, to: 60 }]),
      [{ from: 0, to: 9 }, { from: 21, to: 49 }, { from: 61, to: 100 }],
    );
    assert.deepEqual(subtractRanges({ from: 10, to: 20 }, [{ from: 0, to: 30 }]), []);
  });
});

describe("CoinalyzeClient with HistoryStore", () => {
  let store: HistoryStore;

  beforeEach(() => {
    calls = [];
    mock.method(globalThis, "fetch", fakeFetch);
    store = new HistoryStore(":memory:");
  });

  afterEach(() => {
    mock.restoreAll();
    store.close();
  });

  test("a repeated request for a closed range does not hit the API", async () => {
    const client = makeClient(store);
    const p = { symbols: [SYMBOL], interval: "1hour" as const, from: hoursAgo(10), to: hoursAgo(5) };

    const first = await client.fundingRateHistory(p);
    const second = await client.fundingRateHistory(p);

    assert.equal(calls.length, 1);
    assert.deepEqual(second, first);
    assert.deepEqual(first[0]!.history.map((pt) => pt.t), [10, 9, 8, 7, 6, 5].map(hoursAgo));
  });

  test("extending the range fetches only the missing part", async () => {
    const client = makeClient(store);
    const base = { symbols: [SYMBOL], interval: "1hour" as const };

    await client.fundingRateHistory({ ...base, from: hoursAgo(10), to: hoursAgo(5) });
    const res = await client.fundingRateHistory({ ...base, from: hoursAgo(20), to: hoursAgo(5) });

    assert.equal(calls.length, 2);
    assert.deepEqual({ from: calls[1]!.from, to: calls[1]!.to }, { from: hoursAgo(20), to: hoursAgo(10) - 1 });
    assert.equal(res[0]!.history.length, 16);
  });

  test("the open tail is fetched every time and never cached", async () => {
    const client = makeClient(store);
    const p = { symbols: [SYMBOL], interval: "1hour" as const, from: hoursAgo(3), to: Math.floor(Date.now() / 1000) };

    const first = await client.fundingRateHistory(p);
    const second = await client.fundingRateHistory(p);

    // 1st: the missing closed range and the tail in ONE request; 2nd: the tail only.
    const closedUntil = client.closedUntil("1hour");
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.from === hoursAgo(3) && calls[0]!.to > closedUntil, "closed range + tail in one call");
    assert.equal(calls[1]!.from, closedUntil + 1);
    assert.deepEqual(second, first);
    const key = { kind: "funding-rate-history", symbol: SYMBOL, interval: "1hour" };
    assert.ok(store.coverage(key).every((r) => r.to <= closedUntil), "the tail is not in coverage");
  });

  test("an older gap and the tail are fetched separately", async () => {
    const client = makeClient(store);
    const base = { symbols: [SYMBOL], interval: "1hour" as const };

    await client.fundingRateHistory({ ...base, from: hoursAgo(5), to: Math.floor(Date.now() / 1000) });
    calls = [];
    await client.fundingRateHistory({ ...base, from: hoursAgo(10), to: Math.floor(Date.now() / 1000) });

    // The gap [10h, 5h) does not touch the tail, so: gap request + tail request.
    assert.equal(calls.length, 2);
    assert.deepEqual({ from: calls[0]!.from, to: calls[0]!.to }, { from: hoursAgo(10), to: hoursAgo(5) - 1 });
    assert.equal(calls[1]!.from, client.closedUntil("1hour") + 1);
  });

  test("a gap too small to hold any interval start costs no API call", async () => {
    const client = makeClient(store);
    const base = { symbols: [SYMBOL], interval: "1hour" as const, to: hoursAgo(5) };

    await client.fundingRateHistory({ ...base, from: hoursAgo(10) - 1800 }); // mid-interval start
    const res = await client.fundingRateHistory({ ...base, from: hoursAgo(10) - 3000 }); // 20 min earlier

    assert.equal(calls.length, 1);
    assert.equal(res[0]!.history.length, 6);
  });

  test("symbols missing the same range share one request", async () => {
    const client = makeClient(store);
    const base = { interval: "1hour" as const, from: hoursAgo(10), to: hoursAgo(5) };

    await client.fundingRateHistory({ ...base, symbols: ["A.A"] });
    const res = await client.fundingRateHistory({ ...base, symbols: ["A.A", "B.A", "C.A"] });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]!.symbols, ["B.A", "C.A"]);
    assert.deepEqual(res.map((s) => s.history.length), [6, 6, 6]);
  });

  test("convert_to_usd is a separate cached series", async () => {
    const client = makeClient(store);
    const p = { symbols: [SYMBOL], interval: "1hour" as const, from: hoursAgo(10), to: hoursAgo(5) };

    await client.openInterestHistory({ ...p, convertToUsd: true });
    await client.openInterestHistory({ ...p, convertToUsd: false });
    await client.openInterestHistory({ ...p, convertToUsd: true });

    assert.equal(calls.length, 2);
  });
});

test("the cache survives a restart (SQLite file)", async () => {
  calls = [];
  mock.method(globalThis, "fetch", fakeFetch);
  const dir = mkdtempSync(join(tmpdir(), "krypto-kal-"));
  const path = join(dir, "cache.db");
  const p = { symbols: [SYMBOL], interval: "1hour" as const, from: hoursAgo(10), to: hoursAgo(5) };
  try {
    const s1 = new HistoryStore(path);
    await makeClient(s1).liquidationHistory(p);
    s1.close();

    const s2 = new HistoryStore(path);
    const res = await makeClient(s2).liquidationHistory(p);
    s2.close();

    assert.equal(calls.length, 1);
    assert.equal(res[0]!.history.length, 6);
  } finally {
    mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
