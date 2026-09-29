// coinalyze.test.ts – test end-to-end narzędzi Coinalyze na prawdziwym API.
// Uruchom: npm run test:coinalyze  (wymaga MCP_AUTH_TOKEN i COINALYZE_API_KEY w .env)
// Zużywa ok. 13 z 40 wywołań/min limitu Coinalyze.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertPoints, call, serverTests, useMcpServer } from "./test-helpers.ts";

// Narzędzia historyczne i pola w punktach `history`.
const HISTORY_TOOLS: Record<string, string[]> = {
  coinalyze_open_interest_history: ["o", "h", "l", "c"],
  coinalyze_funding_rate_history: ["o", "h", "l", "c"],
  coinalyze_liquidation_history: ["l", "s"],
  coinalyze_long_short_ratio_history: ["r", "l", "s"],
  coinalyze_ohlcv_history: ["o", "h", "l", "c", "v"],
};
const TOOLS = ["coinalyze_exchanges", "coinalyze_future_markets", "coinalyze_current", ...Object.keys(HISTORY_TOOLS)];

describe("Coinalyze", { skip: !process.env.COINALYZE_API_KEY && "brak COINALYZE_API_KEY" }, () => {
  const ctx = useMcpServer();

  describe("serwer MCP", () => serverTests(ctx, TOOLS));

  // Testy wykonują się po kolei; dwa pierwsze wyszukują symbole do pozostałych.
  describe("endpointy", () => {
    const symbols: string[] = []; // [Binance BTCUSDT perp, BTC perp z innej giełdy]
    let binanceCode = "";

    test("coinalyze_exchanges", async () => {
      const data = (await call(ctx, "coinalyze_exchanges")) as { name: string; code: string }[];
      assert.ok(Array.isArray(data) && data.length > 0, "Pusta lista giełd");
      binanceCode = data.find((e) => /binance/i.test(e.name))?.code ?? "";
      assert.ok(binanceCode, `Brak Binance na liście: ${JSON.stringify(data)}`);
    });

    test("coinalyze_future_markets", async () => {
      const data = (await call(ctx, "coinalyze_future_markets", { base_asset: "BTC" })) as {
        symbol: string;
        exchange: string;
        symbol_on_exchange: string;
      }[];
      assert.ok(Array.isArray(data) && data.length > 0, "Brak rynków BTC");
      const binance = data.find((m) => m.exchange === binanceCode && m.symbol_on_exchange === "BTCUSDT");
      const other = data.find((m) => m.exchange !== binanceCode);
      assert.ok(binance && other, "Nie znaleziono BTCUSDT na Binance lub BTC na innej giełdzie");
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
        assert.ok(Array.isArray(data) && data.length === 1, `Oczekiwano 1 serii: ${JSON.stringify(data).slice(0, 200)}`);
        assertPoints(data[0]!.history, fields, "t");
      });
    }

    test("coinalyze_open_interest_history (aggregate)", async () => {
      const data = (await call(ctx, "coinalyze_open_interest_history", {
        symbols, interval: "4hour", limit: 3, aggregate: true,
      })) as { symbols: string[]; points: unknown };
      assert.deepEqual(data.symbols.sort(), [...symbols].sort());
      assertPoints(data.points, ["c", "n"], "t");
    });
  });
});
