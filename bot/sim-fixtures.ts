// sim-fixtures.ts – shared helpers for tests that run against a DryRunExecutor (not a test file itself).
// px(p) builds a quote around p (bid p-5, ask p+5). Slippage is 0 unless a test sets it, so fill prices are exact.

import assert from "node:assert/strict";
import { BotStore } from "./bot-store.ts";
import { FakeClock } from "./clock.ts";
import { type BotConfig, defaultConfig } from "./config.ts";
import { DryRunExecutor } from "./dry-run-executor.ts";
import type { OrderRequest, PriceEvent } from "./executor.ts";

export const T0 = Date.parse("2026-10-03T12:00:00Z");
export const config: BotConfig = { ...defaultConfig(), slippage_cap_bps: 0 }; // capital 1000, max_leverage 2, fees 2/5 bps

export const closeTo = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} to be within ${eps} of ${expected}`);

export const px = (p: number, t: number): PriceEvent => ({ t, mark: p, last: p, bid: p - 5, ask: p + 5 });

export function setup(cfg: BotConfig = config, opts: { sleep?: (ms: number) => void } = {}) {
  const store = new BotStore(":memory:");
  const clock = new FakeClock(T0);
  const ex = new DryRunExecutor({ store, clock, config: cfg, ...opts });
  // Moves time on by one second and feeds a quote; `over` overrides single fields of the event.
  const tick = (p: number, over: Partial<PriceEvent> = {}) => {
    clock.advance(1000);
    ex.onPrice({ ...px(p, clock.now()), ...over });
  };
  return { store, clock, ex, tick };
}
export type World = ReturnType<typeof setup>;

let seq = 0;
export const req = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  symbol: "PF_XBTUSD", side: "buy", orderType: "mkt", size: 0.01, reduceOnly: false, cliOrdId: `bot-1-entry-${seq++}`, ...over,
});

// Places an order that must be accepted and returns its exchange order id.
export async function place(w: World, over: Partial<OrderRequest> = {}): Promise<string> {
  const r = await w.ex.placeOrder(req(over));
  assert.ok(r.ok, r.ok ? "" : `rejected: ${r.kind} ${r.message}`);
  return r.orderId;
}

// A long position of `size` bought at the ask of a quote around `p`.
export async function goLong(w: World, p = 100000, size = 0.01) {
  w.tick(p);
  await place(w, { side: "buy", orderType: "mkt", size });
}
