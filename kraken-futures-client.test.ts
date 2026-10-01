// kraken-futures-client.test.ts – offline tests of KrakenFuturesClient (fake API, no network, no real keys).
// Run: npm run test:offline

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import {
  type FuturesInstrument, KrakenFuturesClient, KrakenFuturesError, krakenFuturesSignature, roundPrice, roundSize,
} from "./kraken-futures-client.ts";
import { setLogLevel } from "./logger.ts";

setLogLevel("error");

const SECRET = Buffer.from("not-a-real-secret-0123456789").toString("base64");

interface Call {
  url: URL;
  init: RequestInit;
}

let calls: Call[];
let respond: (call: Call) => Promise<Response>;

const ok = (body: Record<string, unknown>) =>
  Promise.resolve(new Response(JSON.stringify({ result: "success", serverTime: "2026-10-01T00:00:00Z", ...body })));

const makeClient = (opts: { maxRetries?: number; withKeys?: boolean; tradingEnabled?: boolean } = {}) =>
  new KrakenFuturesClient({
    maxRetries: opts.maxRetries ?? 0,
    counterMax: 1_000_000,
    tradingEnabled: opts.tradingEnabled ?? false,
    ...(opts.withKeys === false ? { apiKey: "", apiSecret: "" } : { apiKey: "test-key", apiSecret: SECRET }),
  });

const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

const XBT: FuturesInstrument = {
  symbol: "PF_XBTUSD", type: "flexible_futures", tradeable: true, tickSize: 1, contractSize: 1, contractValueTradePrecision: 4,
};

describe("krakenFuturesSignature", () => {
  test("follows the documented steps and strips the /derivatives prefix", () => {
    const postData = "orderType=lmt&symbol=PF_XBTUSD&side=buy&size=0.01&limitPrice=50000";
    const nonce = "1727777777000000";
    const expected = createHmac("sha512", Buffer.from(SECRET, "base64"))
      .update(createHash("sha256").update(postData + nonce + "/api/v3/sendorder").digest())
      .digest("base64");
    assert.equal(krakenFuturesSignature("/derivatives/api/v3/sendorder", nonce, postData, SECRET), expected);
    assert.equal(krakenFuturesSignature("/api/v3/sendorder", nonce, postData, SECRET), expected);
  });
});

describe("rounding helpers", () => {
  test("roundSize floors to the size precision", () => {
    assert.equal(roundSize(XBT, 0.123456), 0.1234);
    assert.equal(roundSize(XBT, 0.1), 0.1); // no float drift down to 0.0999
    assert.equal(roundSize({ ...XBT, contractValueTradePrecision: -3 }, 12_345), 12_000);
  });

  test("roundPrice never gives a worse price than requested", () => {
    assert.equal(roundPrice({ ...XBT, tickSize: 0.5 }, 100.7, "buy"), 100.5);
    assert.equal(roundPrice({ ...XBT, tickSize: 0.5 }, 100.2, "sell"), 100.5);
    assert.equal(roundPrice({ ...XBT, tickSize: 0.01 }, 1.23, "buy"), 1.23);
  });
});

describe("KrakenFuturesClient", () => {
  beforeEach(() => {
    calls = [];
    respond = () => ok({});
    mock.method(globalThis, "fetch", (input: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: new URL(String(input)), init };
      calls.push(call);
      return respond(call);
    });
  });

  afterEach(() => mock.restoreAll());

  test("order book is sorted best-first (Kraken sends bids ascending)", async () => {
    respond = () => ok({ orderBook: { bids: [[1, 52], [99, 1], [100, 2]], asks: [[101, 1], [500, 3]] } });
    const book = await makeClient().orderBook("PF_XBTUSD", 2);
    assert.deepEqual(book.bids, [{ price: 100, size: 2 }, { price: 99, size: 1 }]);
    assert.deepEqual(book.asks, [{ price: 101, size: 1 }, { price: 500, size: 3 }]);
    assert.equal(calls[0]!.url.pathname, "/derivatives/api/v3/orderbook");
  });

  test("candles convert ms timestamps and string prices", async () => {
    respond = () => Promise.resolve(new Response(JSON.stringify({
      candles: [{ time: 1790845200000, open: "83526", high: "83571.0", low: "83514", close: "83559.0", volume: "7.3941" }],
      more_candles: true,
    })));
    const r = await makeClient().candles("PF_XBTUSD", "5m", { from: 1790845000, to: 1790846000 });
    assert.deepEqual(r, { moreCandles: true, candles: [{ t: 1790845200, o: 83526, h: 83571, l: 83514, c: 83559, v: 7.3941 }] });
    assert.equal(calls[0]!.url.pathname, "/api/charts/v1/trade/PF_XBTUSD/5m");
    assert.equal(calls[0]!.url.searchParams.get("from"), "1790845000");
  });

  test("private GET signs the query string and sends APIKey, Nonce and Authent", async () => {
    respond = () => ok({ fills: [] });
    await makeClient().fills("2026-10-01T00:00:00.000Z");
    const call = calls[0]!;
    const query = call.url.search.slice(1);
    assert.equal(query, "lastFillTime=2026-10-01T00%3A00%3A00.000Z");
    assert.equal(header(call, "APIKey"), "test-key");
    assert.equal(header(call, "Authent"), krakenFuturesSignature("/api/v3/fills", header(call, "Nonce")!, query, SECRET));
  });

  test("private POST signs exactly the body that is sent", async () => {
    respond = () => ok({ sendStatus: { status: "placed", order_id: "abc" } });
    await makeClient({ tradingEnabled: true }).sendOrder({
      symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.01, limitPrice: 50000, cliOrdId: "bot-1", reduceOnly: false,
    });
    const call = calls[0]!;
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.body, "symbol=PF_XBTUSD&side=buy&orderType=lmt&size=0.01&limitPrice=50000&cliOrdId=bot-1&reduceOnly=false");
    assert.equal(header(call, "Authent"), krakenFuturesSignature("/api/v3/sendorder", header(call, "Nonce")!, String(call.init.body), SECRET));
  });

  test("nonces strictly increase", async () => {
    respond = () => ok({ openPositions: [] });
    const client = makeClient();
    await Promise.all([client.openPositions(), client.openPositions(), client.openPositions()]);
    const nonces = calls.map((c) => BigInt(header(c, "Nonce")!));
    assert.ok(nonces[0]! < nonces[1]! && nonces[1]! < nonces[2]!);
  });

  test("trading is disabled by default and makes no request", async () => {
    await assert.rejects(
      makeClient().sendOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 0.01 }),
      (e: unknown) => e instanceof KrakenFuturesError && e.kind === "config",
    );
    assert.equal(calls.length, 0);
  });

  test("cancels and the dead-man switch work with trading disabled", async () => {
    respond = (call) => call.url.pathname.endsWith("/cancelallordersafter")
      ? ok({ status: { currentTime: "2026-10-01T00:00:00Z", triggerTime: "2026-10-01T00:01:00Z" } })
      : ok({ cancelStatus: { status: "cancelled" } });
    const client = makeClient();
    assert.deepEqual(await client.deadMansSwitch(60), { currentTime: "2026-10-01T00:00:00Z", triggerTime: "2026-10-01T00:01:00Z" });
    assert.equal(calls[0]!.init.body, "timeout=60");
    assert.equal((await client.cancelOrder({ cliOrdId: "bot-1" })).status, "cancelled");
    assert.equal(calls[1]!.init.body, "cliOrdId=bot-1");
  });

  test("a rejected order with HTTP 200 / result success throws kind 'rejected'", async () => {
    respond = () => ok({ sendStatus: { status: "insufficientAvailableFunds", cliOrdId: "bot-2" } });
    await assert.rejects(
      makeClient({ tradingEnabled: true }).sendOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 1 }),
      (e: unknown) => e instanceof KrakenFuturesError && e.kind === "rejected" && e.code === "insufficientAvailableFunds",
    );
  });

  test("sendOrder is never retried, even on a transient error", async () => {
    respond = () => Promise.resolve(new Response("bad gateway", { status: 502 }));
    await assert.rejects(
      makeClient({ maxRetries: 3, tradingEnabled: true }).sendOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 1 }),
      (e: unknown) => e instanceof KrakenFuturesError && e.kind === "http" && e.status === 502,
    );
    assert.equal(calls.length, 1);
  });

  test("reads retry on apiLimitExceeded", async () => {
    let n = 0;
    respond = () => (n++ === 0
      ? Promise.resolve(new Response(JSON.stringify({ result: "error", error: "apiLimitExceeded" })))
      : ok({ openOrders: [] }));
    const client = new KrakenFuturesClient({ apiKey: "k", apiSecret: SECRET, maxRetries: 1, counterMax: 1e6 });
    // Skip the real backoff delay.
    mock.method(globalThis, "setTimeout", (fn: () => void) => { fn(); return 0; });
    assert.deepEqual(await client.openOrders(), []);
    assert.equal(calls.length, 2);
  });

  test("both error envelopes become KrakenFuturesError with the code", async () => {
    respond = () => Promise.resolve(new Response(JSON.stringify({ result: "error", error: "authenticationError" })));
    await assert.rejects(makeClient().openPositions(), (e: unknown) =>
      e instanceof KrakenFuturesError && e.kind === "api" && e.code === "authenticationError");

    respond = () => Promise.resolve(new Response(
      JSON.stringify({ status: "NOT_FOUND", result: "error", errors: [{ code: 0, message: "404 NOT_FOUND" }] }), { status: 404 },
    ));
    await assert.rejects(makeClient().tickers(), (e: unknown) =>
      e instanceof KrakenFuturesError && e.kind === "http" && e.status === 404 && e.code === "404 NOT_FOUND");
  });

  test("private calls without keys fail before any request", async () => {
    await assert.rejects(makeClient({ withKeys: false }).openPositions(), (e: unknown) =>
      e instanceof KrakenFuturesError && e.kind === "config");
    assert.equal(calls.length, 0);
  });

  test("flexAccount picks the numeric margin fields", async () => {
    respond = () => ok({
      accounts: { flex: { type: "multiCollateralMarginAccount", portfolioValue: 1000.5, availableMargin: 800, currencies: {} } },
    });
    assert.deepEqual(await makeClient().flexAccount(), { portfolioValue: 1000.5, availableMargin: 800 });
  });
});
