// guards.test.ts – iteration 1 cannot place a real order: the live executor cannot be built, the launcher refuses
// live mode, nothing in the bot enables trading on the exchange client, and the approval decorator gates entries only.
// Run: node --test src/bot/guards.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { ApprovingExecutor, describeOrder } from "./approving-executor.ts";
import { buildRuntime } from "./cli.ts";
import { defaultConfig } from "./config.ts";
import type { OrderRequest } from "./executor.ts";
import { LIVE_NOT_IMPLEMENTED, LiveExecutor, assertDryRunOnly } from "./live-executor.ts";
import { Wrapped, world } from "./trader-fixtures.ts";

const entry = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.004, limitPrice: 99245, reduceOnly: false, cliOrdId: "bot-2-entry-0", ...over,
});

describe("no real orders in iteration 1", () => {
  test("LiveExecutor cannot be constructed, even with a live config", () => {
    assert.throws(() => new LiveExecutor(), { message: LIVE_NOT_IMPLEMENTED });
    assert.throws(() => new LiveExecutor({ ...defaultConfig(), mode: "live", live_enabled: true }), { message: LIVE_NOT_IMPLEMENTED });
  });

  test("the launcher refuses any mode but dry-run", async () => {
    assert.throws(() => assertDryRunOnly({ mode: "live" }), /not available in iteration 1/);
    assert.doesNotThrow(() => assertDryRunOnly({ mode: "dry-run" }));
    await assert.rejects(() => buildRuntime({ ...defaultConfig(), mode: "live", live_enabled: true }, "h", { feed: true }), /not available in iteration 1/);
  });

  test("no bot source enables trading on the exchange client or builds a live executor", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    assert.ok(sources.length > 10);
    for (const f of sources) {
      const text = readFileSync(join(dir, f), "utf8");
      assert.ok(!/tradingEnabled\s*:\s*true/.test(text), `${f} enables trading`);
      if (f !== "live-executor.ts") assert.ok(!/new\s+LiveExecutor\s*\(/.test(text), `${f} constructs a LiveExecutor`);
    }
  });

  test("the launcher's exchange client gets empty keys, so trading keys in the environment are never picked up", () => {
    const text = readFileSync(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf8");
    const clients = text.match(/new KrakenFuturesClient\([^)]*\)/g) ?? [];
    assert.ok(clients.length > 0);
    for (const c of clients) assert.match(c, /apiKey: "", apiSecret: ""/);
  });
});

describe("ApprovingExecutor", () => {
  const setup = (answer: boolean | Error) => {
    const w = world();
    const asked: string[] = [];
    const ex = new ApprovingExecutor(w.wrapped, async (summary) => {
      asked.push(summary);
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const placed: string[] = [];
    w.wrapped.onPlace = (r) => placed.push(r.cliOrdId);
    return { w, ex, asked, placed };
  };

  test("forwards an approved entry", async () => {
    const { ex, asked, placed } = setup(true);
    const ack = await ex.placeOrder(entry());
    assert.equal(ack.ok, true);
    assert.deepEqual(placed, ["bot-2-entry-0"]);
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /BUY 0.004 PF_XBTUSD lmt limit 99245 \(bot-2-entry-0\)/);
  });

  test("a denied entry is a rejection that shows what was denied, and nothing reaches the exchange", async () => {
    const { ex, placed } = setup(false);
    const ack = await ex.placeOrder(entry());
    assert.deepEqual(ack, { ok: false, kind: "unknown", message: `denied by the user: ${describeOrder(entry())}` });
    assert.deepEqual(placed, []);
  });

  test("a question that fails counts as a no", async () => {
    const { ex, placed } = setup(new Error("no terminal"));
    assert.equal((await ex.placeOrder(entry())).ok, false);
    assert.deepEqual(placed, []);
  });

  test("never asks before risk-reducing calls: reduce-only orders, edits, cancels and reads", async () => {
    const { ex, asked, w } = setup(false);
    await ex.placeOrder(entry({ cliOrdId: "bot-2-sl-0", side: "sell", orderType: "stp", stopPrice: 98000, limitPrice: undefined, reduceOnly: true }));
    await ex.editOrder({ cliOrdId: "bot-2-sl-0", stopPrice: 98500 });
    await ex.cancelOrder({ cliOrdId: "bot-2-sl-0" });
    await ex.cancelAll("PF_XBTUSD");
    await Promise.all([ex.getPositions(), ex.getOpenOrders(), ex.getFills(new Date(0)), ex.getOrderHistory(new Date(0)), ex.getAccount()]);
    assert.deepEqual(asked, []);
    assert.ok(w.wrapped instanceof Wrapped);
  });

  test("keeps the inner executor's kind", () => {
    const { ex } = setup(true);
    assert.equal(ex.kind, "dry-run");
  });
});
