// yahoo.test.ts – end-to-end test of the Yahoo Finance tools against the real (unofficial) API.
// Run: npm run test:yahoo  (needs MCP_AUTH_TOKEN in .env; no Yahoo key required)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertPoints, call, serverTests, useMcpServer } from "./test-helpers.ts";

const TOOLS = ["yahoo_search", "yahoo_quote", "yahoo_history"];
// One index, one currency pair, one stock.
const SYMBOLS = ["^GSPC", "EURUSD=X", "AAPL"];

describe("Yahoo Finance", { skip: process.env.YAHOO_ENABLED === "false" && "YAHOO_ENABLED=false" }, () => {
  const ctx = useMcpServer({ CACHE_DB_PATH: ":memory:" });

  describe("MCP server", () => serverTests(ctx, TOOLS));

  describe("endpoints", () => {
    test("yahoo_search finds the Nasdaq Composite", async () => {
      const data = (await call(ctx, "yahoo_search", { query: "nasdaq composite" })) as { symbol: string }[];
      assert.ok(data.some((q) => q.symbol === "^IXIC"), `^IXIC not found: ${JSON.stringify(data).slice(0, 300)}`);
    });

    test("yahoo_quote returns prices for an index, a currency and a stock", async () => {
      const data = (await call(ctx, "yahoo_quote", { symbols: SYMBOLS })) as { symbol: string; price: number; currency: string }[];
      assert.deepEqual(data.map((q) => q.symbol), SYMBOLS);
      for (const q of data) assert.ok(q.price > 0 && q.currency, `bad quote: ${JSON.stringify(q)}`);
    });

    test("yahoo_history 1d returns exactly `limit` bars per symbol", async () => {
      const data = (await call(ctx, "yahoo_history", { symbols: SYMBOLS, interval: "1d", limit: 5 })) as {
        symbol: string;
        history: unknown[];
      }[];
      assert.equal(data.length, SYMBOLS.length);
      for (const s of data) {
        assert.equal(s.history.length, 5, `${s.symbol}: ${s.history.length} bars`);
        assertPoints(s.history, ["o", "h", "l", "c", "v"], "t");
      }
    });

    test("yahoo_history 1h returns intraday bars", async () => {
      const [s] = (await call(ctx, "yahoo_history", { symbols: ["AAPL"], interval: "1h", limit: 10 })) as {
        history: unknown[];
      }[];
      assert.equal(s!.history.length, 10);
      assertPoints(s!.history, ["o", "h", "l", "c"], "t");
    });

    test("an unknown symbol is reported as a tool error", async () => {
      const res = await ctx.client.callTool({ name: "yahoo_quote", arguments: { symbols: ["NOPE_XYZ123"] } });
      assert.equal(res.isError, true);
    });
  });
});
