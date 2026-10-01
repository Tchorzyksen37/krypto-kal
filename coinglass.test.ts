// coinglass.test.ts – end-to-end test of the Coinglass tools against the real API.
// Run: npm run test:coinglass  (needs MCP_AUTH_TOKEN and COINGLASS_API_KEY in .env)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertPoints, call, serverTests, useMcpServer } from "./test-helpers.ts";

// Expected fields in every data point.
const TOOLS: Record<string, string[]> = {
  coinglass_funding_rate_history: ["open", "high", "low", "close"],
  coinglass_open_interest_history: ["open", "high", "low", "close"],
  coinglass_liquidation_history: ["long_liquidation_usd", "short_liquidation_usd"],
};
const ARGS = { exchange: "Binance", symbol: "BTCUSDT", interval: "4h", limit: 3 };

describe("Coinglass", { skip: !process.env.COINGLASS_API_KEY && "COINGLASS_API_KEY not set" }, () => {
  const ctx = useMcpServer();

  describe("MCP server", () => serverTests(ctx, Object.keys(TOOLS)));

  describe("endpoints", () => {
    for (const [name, fields] of Object.entries(TOOLS)) {
      test(name, async () => {
        const data = await call(ctx, name, ARGS);
        assertPoints(data, fields, "time");
        assert.ok((data as unknown[]).length <= ARGS.limit, "More points than the limit");
      });
    }
  });
});
