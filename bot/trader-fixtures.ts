// trader-fixtures.ts – a complete test world for the trader, reconciliation, watchdog and property tests: the real
// store and DryRunExecutor, a fake market, and wrappers that make the exchange misbehave (not a test file itself).
//
// The world: a long policy (id 2, the newer of two identical ones, because the effective policy needs N = 2), entry
// zone 99000..99500, stop 98000, targets 102000 and 104000, ATR 800, capital 1000. Ids of the bot's orders are
// bot-2-<role>-<seq>. tick(p) moves the market and feeds the executor; cycle() runs one trader cycle.

import assert from "node:assert/strict";
import type { FuturesCandle } from "../kraken-futures-client.ts";
import { setLogLevel } from "../logger.ts";
import { BotStore } from "./bot-store.ts";
import { FakeClock } from "./clock.ts";
import { DryRunExecutor } from "./dry-run-executor.ts";
import type { Action } from "./engine.ts";
import { defaultEngineRecord, loadEngineRecord, saveEngineRecord } from "./engine-state.ts";
import type {
  AccountState, Executor, FuturesFill, FuturesOpenOrder, FuturesPosition, MarketData, OrderAck, OrderEdit, OrderRequest,
  PlacedOrder, PriceEvent,
} from "./executor.ts";
import type { LevelMenu, Policy } from "./policy.ts";
import { T0, config, px } from "./sim-fixtures.ts";
import type { Contract } from "./sizing.ts";
import { type TraderDeps, runCycle } from "./trader.ts";

setLogLevel("error"); // the tests provoke warnings on purpose

export const MIN = 60_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const contract: Contract = { tickSize: 0.5, sizeStep: 0.0001, minSize: 0.0001 };

export const MENU: LevelMenu = {
  id: "m1", symbol: "PF_XBTUSD", createdAtMs: T0 - MIN,
  levels: [
    { id: "sup1", price: 98000, kind: "swing_low" }, { id: "e_lo", price: 99000, kind: "atr_band" },
    { id: "e_hi", price: 99500, kind: "atr_band" }, { id: "res1", price: 102000, kind: "swing_high" },
    { id: "res2", price: 104000, kind: "swing_high" },
  ],
};
export const longPolicy = (): Policy => ({
  schema_version: 1, menu_id: "m1", symbol: "PF_XBTUSD", bias: 0.6, conviction: 1, risk_budget_pct: 0.5, allowed_directions: ["long"],
  scenario: { direction: "long", entry_zone: { from: "e_lo", to: "e_hi" }, targets: ["res1", "res2"], invalidation: "sup1", horizon_hours: 24 },
  valid_until: iso(T0 + 6 * 60 * MIN), rationale: "r", sources: [],
});

export class FakeMarket implements MarketData {
  last = 99250;
  ageMs = 0; // how old the quote is
  failTicker = false;
  failContract = false;
  failCandles = false;
  rate = 0.0001;
  minuteCandles: FuturesCandle[] = []; // what candles("1m", n) returns (a test sets the downtime it wants replayed)
  readonly clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }
  async ticker(): Promise<PriceEvent> {
    if (this.failTicker) throw new Error("ticker down");
    return px(this.last, this.clock.now() - this.ageMs);
  }
  async candles(resolution: string): Promise<FuturesCandle[]> {
    if (this.failCandles) throw new Error("candles down");
    if (resolution === "1m") return this.minuteCandles;
    const hour = Math.floor(this.clock.now() / 3_600_000) * 3600; // seconds; sixteen closed hourly candles, each with a range of 800
    return Array.from({ length: 16 }, (_, i) => ({ t: hour - (16 - i) * 3600, o: 100000, h: 100400, l: 99600, c: 100000, v: 1 }));
  }
  async contract(): Promise<Contract> {
    if (this.failContract) throw new Error("instruments down");
    return contract;
  }
  async fundingRates() {
    return [{ t: this.clock.now() - 1000, rate: this.rate }];
  }
}

// An executor that can misbehave in ways the real DryRunExecutor cannot on its own.
export class Wrapped implements Executor {
  readonly kind = "dry-run" as const;
  readonly inner: DryRunExecutor;
  lie: (r: OrderRequest) => boolean = () => false; // acknowledge without doing anything
  refuse: (r: OrderRequest) => boolean = () => false; // reject for good
  onPlace: (r: OrderRequest) => void = () => {}; // sees every order just before it reaches the exchange
  unreadable = false;
  onRead: () => void = () => {}; // called whenever the positions are read
  extraFills: FuturesFill[] = [];
  constructor(inner: DryRunExecutor) {
    this.inner = inner;
  }
  async placeOrder(r: OrderRequest): Promise<OrderAck> {
    this.onPlace(r);
    if (this.refuse(r)) return { ok: false, kind: "unknown", message: "refused" };
    if (this.lie(r)) return { ok: true, orderId: "fake" };
    return this.inner.placeOrder(r);
  }
  editOrder(e: OrderEdit) { return this.inner.editOrder(e); }
  cancelOrder(id: { cliOrdId: string } | { orderId: string }) { return this.inner.cancelOrder(id); }
  cancelAll(symbol: string) { return this.inner.cancelAll(symbol); }
  async getPositions(): Promise<FuturesPosition[]> {
    this.onRead();
    if (this.unreadable) throw new Error("exchange down");
    return this.inner.getPositions();
  }
  getOpenOrders(): Promise<FuturesOpenOrder[]> { return this.inner.getOpenOrders(); }
  async getFills(since: Date): Promise<FuturesFill[]> {
    return [...(await this.inner.getFills(since)), ...this.extraFills.filter((f) => Date.parse(f.fillTime) >= since.getTime())];
  }
  async getOrderHistory(since: Date): Promise<PlacedOrder[]> {
    if (this.unreadable) throw new Error("exchange down");
    return this.inner.getOrderHistory(since);
  }
  getAccount(): Promise<AccountState> { return this.inner.getAccount(); }
}

export class FailingJournalStore extends BotStore {
  override appendJournal(): void {
    throw new Error("disk full");
  }
}

export function world(o: { store?: BotStore; policies?: number; reconciled?: boolean } = {}) {
  const store = o.store ?? new BotStore(":memory:");
  const clock = new FakeClock(T0);
  const ex = new DryRunExecutor({ store, clock, config });
  const wrapped = new Wrapped(ex);
  const market = new FakeMarket(clock);
  const deps: TraderDeps = { executor: wrapped, market, store, clock, config, configHash: "h1" };
  store.putMenu(MENU);
  for (let i = 0; i < (o.policies ?? 2); i++) store.putPolicy(longPolicy(), T0 - 120_000 + i * MIN);
  saveEngineRecord(store, { ...defaultEngineRecord(), reconciled: o.reconciled ?? true });
  const tick = (p: number) => {
    clock.advance(1000);
    market.last = p;
    ex.onPrice(px(p, clock.now()));
  };
  return {
    store, clock, ex, wrapped, market, deps, tick,
    cycle: () => runCycle(deps), rec: () => loadEngineRecord(store),
    ids: async () => (await ex.getOpenOrders()).map((x) => x.cliOrdId).sort(),
    order: async (id: string) => (await ex.getOpenOrders()).find((x) => x.cliOrdId === id),
  };
}
export type World = ReturnType<typeof world>;

export const reasons = (a: Action[]) => a.map((x) => x.reason);
export const E = "bot-2-entry-0";
export const SL = "bot-2-sl-0";
export const TP1 = "bot-2-tp1-0";
export const TP2 = "bot-2-tp2-0";

// Price into the zone, wait out the confirmation, and run the cycle that places the entry. Returns that cycle's actions.
export async function arm(w: World): Promise<Action[]> {
  w.tick(99250);
  const first = await w.cycle();
  assert.deepEqual(reasons(first), ["awaiting_confirmation"]);
  w.clock.advance(31_000);
  w.tick(99250);
  return w.cycle();
}

// Arms, fills the entry (0.004 BTC at 99245) and runs the cycles until the position is OPEN.
export async function openPosition(w: World) {
  await arm(w);
  w.tick(99244); // trades through the 99245 limit
  await w.cycle(); // ENTERING -> PROTECTING, protective orders placed
  await w.cycle(); // PROTECTING -> OPEN once the exchange shows them
  assert.equal(w.rec().state, "OPEN");
}
