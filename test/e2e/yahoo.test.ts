// yahoo.test.ts – end-to-end test of the Yahoo Finance tools against the real (unofficial) API.
// Run: npm run test:yahoo  (needs MCP_AUTH_TOKEN in .env; no Yahoo key required)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertPoints, assertTable, call, callText, serverTests, useMcpServer } from "./test-helpers.ts";

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
      const data = (await call(ctx, "yahoo_quote", { symbols: SYMBOLS, format: "raw" })) as { symbol: string; price: number; currency: string }[];
      assert.deepEqual(data.map((q) => q.symbol), SYMBOLS);
      for (const q of data) assert.ok(q.price > 0 && q.currency, `bad quote: ${JSON.stringify(q)}`);
    });

    test("yahoo_quote as a table: one row per symbol with a freshness state", async () => {
      const text = await callText(ctx, "yahoo_quote", { symbols: SYMBOLS });
      const lines = text.split("\n");
      assert.match(lines[0]!, /^yahoo_quote: 3 quotes; as of /);
      const rows = lines.filter((l) => SYMBOLS.some((s) => l.startsWith(`${s},`)));
      assert.equal(rows.length, 3, text);
      for (const r of rows) assert.match(r, /,(fresh|stale \(last price (Sun|Mon|Tue|Wed|Thu|Fri|Sat)\))$/);
    });

    test("yahoo_history as a table: breaks, not gaps, and one block per symbol", async () => {
      const text = await callText(ctx, "yahoo_history", { symbols: ["^GSPC"], interval: "1h", limit: 20 });
      assert.match(text, /^yahoo_history \^GSPC 1h \(Yahoo Finance bars\): 20 bars, /);
      assert.match(text, /\nbreaks: /);
      assertTable(text, ["open", "high", "low", "close", "volume"], 20);
    });

    test("yahoo_history 1d returns exactly `limit` bars per symbol", async () => {
      const data = (await call(ctx, "yahoo_history", { symbols: SYMBOLS, interval: "1d", limit: 5, format: "raw" })) as {
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
      const [s] = (await call(ctx, "yahoo_history", { symbols: ["AAPL"], interval: "1h", limit: 10, format: "raw" })) as {
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
