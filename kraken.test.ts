// kraken.test.ts – end-to-end test of the Kraken tools against the real API.
// Run: npm run test:kraken  (needs MCP_AUTH_TOKEN in .env; account tests also need
// KRAKEN_API_KEY and KRAKEN_API_SECRET and are skipped without them)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertPoints, call, serverTests, useMcpServer } from "./test-helpers.ts";

const TOOLS = ["kraken_ticker", "kraken_ohlc", "kraken_order_book", "kraken_system_status"];
const HAS_KEYS = Boolean(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET);

describe("Kraken", { skip: process.env.KRAKEN_ENABLED === "false" && "KRAKEN_ENABLED=false" }, () => {
  const ctx = useMcpServer();

  describe("MCP server", () => serverTests(ctx, TOOLS));

  describe("public endpoints", () => {
    test("kraken_system_status", async () => {
      const data = (await call(ctx, "kraken_system_status")) as { status: string };
      assert.ok(["online", "maintenance", "cancel_only", "post_only"].includes(data.status), JSON.stringify(data));
    });

    test("kraken_ticker", async () => {
      const data = await call(ctx, "kraken_ticker", { pairs: ["XBTUSD", "ETHEUR"] });
      assertPoints(data, ["ask", "bid", "last", "volume24h"], "trades24h");
      assert.equal((data as unknown[]).length, 2);
    });

    test("kraken_ohlc returns `limit` candles", async () => {
      const data = (await call(ctx, "kraken_ohlc", { pair: "XBTUSD", interval: "60", limit: 5 })) as { candles: unknown[] };
      assert.equal(data.candles.length, 5);
      assertPoints(data.candles, ["o", "h", "l", "c", "v"], "t");
    });

    test("kraken_order_book", async () => {
      const data = (await call(ctx, "kraken_order_book", { pair: "XBTUSD", count: 5 })) as { asks: unknown[]; bids: unknown[] };
      assertPoints(data.asks, ["price", "volume"], "t");
      assertPoints(data.bids, ["price", "volume"], "t");
    });

    test("an unknown pair is reported as a tool error", async () => {
      const res = await ctx.client.callTool({ name: "kraken_ticker", arguments: { pairs: ["NOPEPAIR"] } });
      assert.equal(res.isError, true);
    });
  });

  describe("account (read-only)", { skip: !HAS_KEYS && "KRAKEN_API_KEY/KRAKEN_API_SECRET not set" }, () => {
    test("kraken_balance", async () => {
      const data = await call(ctx, "kraken_balance");
      assert.equal(typeof data, "object");
    });

    test("kraken_open_orders", async () => {
      const data = (await call(ctx, "kraken_open_orders")) as { open: unknown };
      assert.equal(typeof data.open, "object");
    });
  });
});
