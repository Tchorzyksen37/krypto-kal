// coinglass.test.ts – test end-to-end narzędzi Coinglass na prawdziwym API.
// Uruchom: npm run test:coinglass  (wymaga MCP_AUTH_TOKEN i COINGLASS_API_KEY w .env)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertPoints, call, serverTests, useMcpServer } from "./test-helpers.ts";

// Oczekiwane pola w każdym punkcie danych.
const TOOLS: Record<string, string[]> = {
  coinglass_funding_rate_history: ["open", "high", "low", "close"],
  coinglass_open_interest_history: ["open", "high", "low", "close"],
  coinglass_liquidation_history: ["long_liquidation_usd", "short_liquidation_usd"],
};
const ARGS = { exchange: "Binance", symbol: "BTCUSDT", interval: "4h", limit: 3 };

describe("Coinglass", { skip: !process.env.COINGLASS_API_KEY && "brak COINGLASS_API_KEY" }, () => {
  const ctx = useMcpServer();

  describe("serwer MCP", () => serverTests(ctx, Object.keys(TOOLS)));

  describe("endpointy", () => {
    for (const [name, fields] of Object.entries(TOOLS)) {
      test(name, async () => {
        const data = await call(ctx, name, ARGS);
        assertPoints(data, fields, "time");
        assert.ok((data as unknown[]).length <= ARGS.limit, "Więcej punktów niż limit");
      });
    }
  });
});
