// yahoo-client.test.ts – offline tests of YahooClient (fake API, no network).
// Run: npm run test:offline

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { HistoryStore } from "./history-store.ts";
import { setLogLevel } from "./logger.ts";
import { YahooClient, YahooError } from "./yahoo-client.ts";

setLogLevel("error");

const H = 3600;
const now = () => Math.floor(Date.now() / 1000);
// Stock-like hourly bars start at :30 (e.g. 13:30 UTC), so they are NOT epoch-aligned.
const barStart = (t: number) => Math.ceil((t - 1800) / H) * H + 1800;

interface FakeApi {
  calls: URL[];
  splits: Record<string, number[]>; // symbol -> split dates returned with every chart response
}

let api: FakeApi;

function chartBody(symbol: string, from: number, to: number, splits: number[]) {
  const timestamp: number[] = [];
  for (let t = barStart(from); t < to; t += H) timestamp.push(t);
  const quote = { open: timestamp.map((t) => t), high: timestamp.map((t) => t + 1), low: timestamp.map((t) => t - 1), close: timestamp.map((t) => t), volume: timestamp.map(() => 10) };
  return {
    chart: {
      result: [{
        meta: { symbol, currency: "USD", instrumentType: "EQUITY", regularMarketPrice: 110, regularMarketTime: now(), previousClose: 100, shortName: symbol },
        timestamp,
        events: splits.length ? { splits: Object.fromEntries(splits.map((d) => [String(d), { date: d }])) } : undefined,
        indicators: { quote: [quote] },
      }],
      error: null,
    },
  };
}

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input));
  api.calls.push(url);
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const symbol = decodeURIComponent(url.pathname.split("/").at(-1)!);
  if (symbol === "NOPE") {
    return json({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }, 404);
  }
  const q = url.searchParams;
  if (q.get("range") === "1d") return json(chartBody(symbol, now() - 3 * H, now(), []));
  return json(chartBody(symbol, Number(q.get("period1")), Number(q.get("period2")), api.splits[symbol] ?? []));
}

const makeClient = (store?: HistoryStore) =>
  new YahooClient({ msPerCall: 0, quoteTtlMs: 0, maxRetries: 0, settleSeconds: 0, ...(store ? { store } : {}) });

describe("YahooClient", () => {
  let store: HistoryStore;

  beforeEach(() => {
    api = { calls: [], splits: {} };
    mock.method(globalThis, "fetch", fakeFetch);
    store = new HistoryStore(":memory:");
  });

  afterEach(() => {
    mock.restoreAll();
    store.close();
  });

  test("history parses bars and skips null closes", async () => {
    const [t1, t2, t3] = [now() - 5 * H, now() - 4 * H, now() - 3 * H];
    mock.restoreAll();
    mock.method(globalThis, "fetch", () =>
      Promise.resolve(new Response(JSON.stringify({
        chart: {
          result: [{
            meta: { symbol: "AAPL" },
            timestamp: [t1, t2, t3],
            indicators: { quote: [{ open: [1, null, 3], high: [1, null, 3], low: [1, null, 3], close: [1, null, 3], volume: [5, null, null] }] },
          }],
          error: null,
        },
      }))),
    );
    const [res] = await makeClient().history({ symbols: ["AAPL"], interval: "1h", from: now() - 10 * H, to: now() });
    assert.deepEqual(res!.history, [{ t: t1, o: 1, h: 1, l: 1, c: 1, v: 5 }, { t: t3, o: 3, h: 3, l: 3, c: 3, v: 0 }]);
  });

  test("closed bars are served from the cache on the next request", async () => {
    const client = makeClient(store);
    const p = { symbols: ["AAPL"], interval: "1h" as const, from: now() - 30 * H, to: now() - 10 * H };

    const first = await client.history(p);
    const second = await client.history(p);

    assert.equal(api.calls.length, 1);
    assert.deepEqual(second, first);
    assert.equal(first[0]!.history.length, 20);
    assert.ok(first[0]!.history.every((b) => b.t % H === 1800), "bars keep their :30 timestamps");
  });

  test("a split after cached bars rebuilds the symbol's history", async () => {
    const client = makeClient(store);
    const base = { symbols: ["AAPL"], interval: "1h" as const };
    await client.history({ ...base, from: now() - 30 * H, to: now() - 10 * H });

    api.splits.AAPL = [now() - 5 * H]; // a split newer than the cached bars
    api.calls = [];
    const res = await client.history({ ...base, from: now() - 30 * H, to: now() - 2 * H });

    // 1 request for the new range (sees the split) + 1 full refetch after wiping the stale series.
    assert.equal(api.calls.length, 2);
    assert.equal(Number(api.calls[1]!.searchParams.get("period1")), now() - 30 * H);
    assert.equal(res[0]!.history.length, 28);
  });

  test("an old split (before any cached bar) does not trigger a rebuild", async () => {
    const client = makeClient(store);
    api.splits.AAPL = [now() - 1000 * H];
    await client.history({ symbols: ["AAPL"], interval: "1h", from: now() - 30 * H, to: now() - 10 * H });
    assert.equal(api.calls.length, 1);
  });

  test("long 1m ranges are split into requests of at most 7 days", async () => {
    await makeClient().history({ symbols: ["AAPL"], interval: "1m", from: now() - 20 * 86400, to: now() });
    assert.equal(api.calls.length, 3);
    for (const url of api.calls) {
      const span = Number(url.searchParams.get("period2")) - Number(url.searchParams.get("period1"));
      assert.ok(span <= 7 * 86400, `span ${span}s exceeds 7 days`);
    }
  });

  test("`from` is clamped to what Yahoo still serves", async () => {
    await makeClient().history({ symbols: ["AAPL"], interval: "5m", from: now() - 365 * 86400, to: now() });
    const period1 = Number(api.calls[0]!.searchParams.get("period1"));
    assert.ok(period1 >= now() - 60 * 86400, "5m data must not be requested beyond 60 days");
  });

  test("an unknown symbol raises YahooError with Yahoo's description", async () => {
    await assert.rejects(makeClient().quotes(["NOPE"]), (e: unknown) => {
      assert.ok(e instanceof YahooError);
      assert.equal(e.status, 404);
      assert.match(e.message, /No data found/);
      return true;
    });
  });

  test("quotes computes the change against the previous close", async () => {
    const [q] = await makeClient().quotes(["AAPL"]);
    assert.equal(q!.price, 110);
    assert.equal(q!.change, 10);
    assert.equal(q!.changePercent, 10);
  });
});
