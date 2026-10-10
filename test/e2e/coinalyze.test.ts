// coinalyze.test.ts – end-to-end test of the Coinalyze tools against the real API.
// Run: npm run test:coinalyze  (needs MCP_AUTH_TOKEN and COINALYZE_API_KEY in .env)
// Uses about 13 of the 40 calls/min Coinalyze limit. The history cache is in-memory
// so every run really hits the API.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertPoints, assertTable, call, callText, serverTests, useMcpServer } from "./test-helpers.ts";

// History tools and the fields of their `history` points.
const HISTORY_TOOLS: Record<string, string[]> = {
  coinalyze_open_interest_history: ["o", "h", "l", "c"],
  coinalyze_funding_rate_history: ["o", "h", "l", "c"],
  coinalyze_liquidation_history: ["l", "s"],
  coinalyze_long_short_ratio_history: ["r", "l", "s"],
  coinalyze_ohlcv_history: ["o", "h", "l", "c", "v"],
};
const TOOLS = ["coinalyze_exchanges", "coinalyze_future_markets", "coinalyze_current", ...Object.keys(HISTORY_TOOLS)];

describe("Coinalyze", { skip: !process.env.COINALYZE_API_KEY && "COINALYZE_API_KEY not set" }, () => {
  const ctx = useMcpServer({ CACHE_DB_PATH: ":memory:" });

  describe("MCP server", () => serverTests(ctx, TOOLS));

  // Tests run in order; the first two look up the symbols used by the rest.
  describe("endpoints", () => {
    const symbols: string[] = []; // [Binance BTCUSDT perp, BTC perp on another exchange]
    let binanceCode = "";

    test("coinalyze_exchanges", async () => {
      const data = (await call(ctx, "coinalyze_exchanges")) as { name: string; code: string }[];
      assert.ok(Array.isArray(data) && data.length > 0, "Empty exchange list");
      binanceCode = data.find((e) => /binance/i.test(e.name))?.code ?? "";
      assert.ok(binanceCode, `Binance not in the list: ${JSON.stringify(data)}`);
    });

    test("coinalyze_future_markets", async () => {
      const data = (await call(ctx, "coinalyze_future_markets", { base_asset: "BTC" })) as {
        symbol: string;
        exchange: string;
        symbol_on_exchange: string;
      }[];
      assert.ok(Array.isArray(data) && data.length > 0, "No BTC markets");
      const binance = data.find((m) => m.exchange === binanceCode && m.symbol_on_exchange === "BTCUSDT");
      const other = data.find((m) => m.exchange !== binanceCode);
      assert.ok(binance && other, "BTCUSDT on Binance or BTC on another exchange not found");
      symbols.push(binance.symbol, other.symbol);
    });

    for (const metric of ["open_interest", "funding_rate", "predicted_funding_rate"]) {
      test(`coinalyze_current (${metric})`, async () => {
        const data = await call(ctx, "coinalyze_current", { metric, symbols: symbols.slice(0, 1) });
        assertPoints(data, ["value"], "update");
      });
    }

    for (const [name, fields] of Object.entries(HISTORY_TOOLS)) {
      test(name, async () => {
        const data = (await call(ctx, name, { symbols: symbols.slice(0, 1), interval: "4hour", limit: 3 })) as {
          symbol: string;
          history: unknown;
        }[];
        assert.ok(Array.isArray(data) && data.length === 1, `Expected 1 series: ${JSON.stringify(data).slice(0, 200)}`);
        assertPoints(data[0]!.history, fields, "t");
      });
    }

    test("coinalyze_ohlcv_history as a table", async () => {
      const text = await callText(ctx, "coinalyze_ohlcv_history", { symbols: symbols.slice(0, 1), interval: "4hour", limit: 3, format: "table" });
      assertTable(text, ["open", "close", "volume", "taker_buy_share"]);
    });

    test("coinalyze_open_interest_history (aggregate)", async () => {
      const data = (await call(ctx, "coinalyze_open_interest_history", {
        symbols, interval: "4hour", limit: 3, aggregate: true,
      })) as { symbols: string[]; points: unknown };
      assert.deepEqual(data.symbols.sort(), [...symbols].sort());
      assertPoints(data.points, ["c", "n"], "t");
    });
  });
});
