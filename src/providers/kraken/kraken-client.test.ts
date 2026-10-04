// kraken-client.test.ts – offline tests of KrakenClient (fake API, no network, no real keys).
// Run: npm run test:offline

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { KrakenClient, KrakenError, krakenSignature } from "./kraken-client.ts";
import { setLogLevel } from "../../core/logger.ts";

setLogLevel("error");

// Example from Kraken's REST authentication docs.
const DOCS_SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==";

interface Call {
  url: URL;
  init: RequestInit;
}

let calls: Call[];
let respond: (call: Call) => Promise<Response>;

const ok = (result: unknown) => Promise.resolve(new Response(JSON.stringify({ error: [], result })));
const fail = (...error: string[]) => Promise.resolve(new Response(JSON.stringify({ error, result: null })));

const makeClient = (opts: { maxRetries?: number; withKeys?: boolean } = {}) =>
  new KrakenClient({
    publicMsPerCall: 0,
    maxRetries: opts.maxRetries ?? 0,
    counterMax: 1000,
    ...(opts.withKeys === false ? { apiKey: "", apiSecret: "" } : { apiKey: "test-key", apiSecret: DOCS_SECRET }),
  });

describe("KrakenClient", () => {
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

  test("signature matches the example from Kraken's docs", () => {
    assert.equal(
      krakenSignature(
        "/0/private/AddOrder",
        "1616492376594",
        "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25",
        DOCS_SECRET,
      ),
      "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==",
    );
  });

  test("ticker maps Kraken's arrays to named fields", async () => {
    respond = () =>
      ok({
        XXBTZUSD: {
          a: ["101.5", "1", "1.000"], b: ["101.0", "1", "1.000"], c: ["101.2", "0.1"], v: ["10", "20"],
          p: ["100", "99"], t: [5, 7], l: ["90", "89"], h: ["110", "111"], o: "95",
        },
      });
    const [t] = await makeClient().ticker(["XBTUSD"]);
    assert.deepEqual(t, {
      pair: "XXBTZUSD", ask: 101.5, bid: 101, last: 101.2, open: 95,
      high24h: 111, low24h: 89, volume24h: 20, vwap24h: 99, trades24h: 7,
    });
    assert.equal(calls[0]!.url.searchParams.get("pair"), "XBTUSD");
  });

  test("an error array becomes a KrakenError with the codes", async () => {
    respond = () => fail("EQuery:Unknown asset pair");
    await assert.rejects(makeClient().ticker(["NOPE"]), (e: unknown) => {
      assert.ok(e instanceof KrakenError);
      assert.deepEqual(e.errors, ["EQuery:Unknown asset pair"]);
      return true;
    });
  });

  test("public calls retry on EService errors", async () => {
    let n = 0;
    respond = () => (n++ === 0 ? fail("EService:Unavailable") : ok({ unixtime: 1, rfc1123: "x" }));
    const res = await makeClient({ maxRetries: 1 }).serverTime();
    assert.equal(res.unixtime, 1);
    assert.equal(calls.length, 2);
  });

  test("private calls are signed, form-encoded and start with the nonce", async () => {
    respond = () => ok({ ZUSD: "10.0" });
    await makeClient().balance();

    const { url, init } = calls[0]!;
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    const nonce = new URLSearchParams(body).get("nonce")!;
    assert.equal(url.pathname, "/0/private/Balance");
    assert.equal(init.method, "POST");
    assert.match(body, /^nonce=\d+/);
    assert.equal(headers["API-Key"], "test-key");
    assert.equal(headers["API-Sign"], krakenSignature("/0/private/Balance", nonce, body, DOCS_SECRET));
  });

  test("nonces strictly increase", async () => {
    const client = makeClient();
    await Promise.all([client.balance(), client.balance(), client.openOrders()]);
    const nonces = calls.map((c) => Number(new URLSearchParams(String(c.init.body)).get("nonce")));
    assert.ok(nonces[0]! < nonces[1]! && nonces[1]! < nonces[2]!, `nonces: ${nonces.join(", ")}`);
  });

  test("addOrder only validates unless validate:false is passed", async () => {
    respond = () => ok({ descr: { order: "buy 1.25 XBTUSD @ limit 37500" } });
    const client = makeClient();
    const order = { pair: "XBTUSD", type: "buy", ordertype: "limit", volume: "1.25", price: "37500" } as const;

    await client.addOrder(order);
    await client.addOrder(order, { validate: false });

    assert.equal(new URLSearchParams(String(calls[0]!.init.body)).get("validate"), "true");
    assert.equal(new URLSearchParams(String(calls[1]!.init.body)).get("validate"), null);
  });

  test("addOrder is never retried, even on a network error", async () => {
    respond = () => Promise.reject(new TypeError("fetch failed"));
    await assert.rejects(
      makeClient({ maxRetries: 3 }).addOrder({ pair: "XBTUSD", type: "buy", ordertype: "market", volume: "1" }),
      (e: unknown) => e instanceof KrakenError && e.kind === "network",
    );
    assert.equal(calls.length, 1);
  });

  test("private calls without keys fail without hitting the API", async () => {
    await assert.rejects(makeClient({ withKeys: false }).balance(), /KRAKEN_API_KEY/);
    assert.equal(calls.length, 0);
  });
});
