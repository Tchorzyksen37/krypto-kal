// trader.ts – one cycle of the bot: read the world, ask the pure engine what to do, do it, and record why.
//
//   buildSnapshot  reads the exchange (via the Executor), the market, the store and the persisted engine record;
//   decide         (engine.ts, pure) turns the snapshot into actions;
//   execute        carries the actions out through the Executor and persists the new state.
//
// Safety properties of this layer:
//  - If the exchange cannot be read, the cycle decides nothing (an incident, no orders): a half-built picture is
//    worse than none.
//  - Order of work. An entry order is placed only AFTER the new state is saved (a crash in between leaves ENTERING
//    with no order, which the engine resolves to FLAT; the reverse would leave a resting entry in FLAT). Everything
//    else runs in the engine's order, so cancels and protective orders come before the state change.
//  - A failed journal write blocks new entries but never protection or closing.
//  - A lost ack or a rejected call is an incident, never an abort: the remaining actions of the cycle still run.
//  - The journal gets a row when something happens, when the reason or state changes, and as a heartbeat.

import type { BotStore } from "./bot-store.ts";
import type { Clock } from "./clock.ts";
import type { BotConfig } from "./config.ts";
import { type Action, type PolicyView, type Snapshot, decide } from "./engine.ts";
import { type EngineRecord, loadEngineRecord, saveEngineRecord } from "./engine-state.ts";
import { type Executor, type MarketData, type OrderRole, isBotOrder, parseCliOrdId } from "./executor.ts";
import { atr } from "./indicators.ts";
import { dailyLossBreached, dayStartMs, netRealizedSince, recordPlacedOrder, tradingDay } from "./limits.ts";
import { createLogger } from "../core/logger.ts";
import { effectivePolicy, resolveScenario } from "./policy.ts";
import type { Contract } from "./sizing.ts";

const log = createLogger("trader");

export const JOURNAL_HEARTBEAT_MS = 60_000;
const CONTRACT_CACHE_KEY = "contract:cache";
const JOURNAL_LAST_KEY = "journal:last";
const UNAVAILABLE_KEY = "journal:unavailable";

export interface TraderDeps {
  executor: Executor;
  market: MarketData;
  store: BotStore;
  clock: Clock;
  config: BotConfig;
  configHash: string;
}

// ---- snapshot -------------------------------------------------------------------------------------------------------

// Reads everything the engine needs. Throws when the exchange or the stored state cannot be read: the caller must
// then decide nothing. Market data that cannot be read is not an error: it becomes null, which puts the bot in
// reduce-only mode.
export async function buildSnapshot(d: TraderDeps): Promise<Snapshot> {
  return snapshotFrom(d, loadEngineRecord(d.store));
}

async function snapshotFrom(d: TraderDeps, rec: EngineRecord): Promise<Snapshot> {
  const { executor, market, store, clock, config } = d;
  const nowMs = clock.now();
  const dayStart = dayStartMs(nowMs, config.day_reset_utc_hour);
  const fillsSince = Math.min(dayStart, rec.tradeStartedMs ?? dayStart);

  const [positions, orders, fills, account] = await Promise.all([
    executor.getPositions(), executor.getOpenOrders(), executor.getFills(new Date(fillsSince)), executor.getAccount(),
  ]);
  const position = positions.find((p) => p.symbol === config.symbol) ?? null;
  const openOrders = orders.filter((o) => o.symbol === config.symbol);

  const quote = await attempt(() => market.ticker());
  const price = quote && [quote.last, quote.mark, quote.bid, quote.ask].every((x) => Number.isFinite(x) && x > 0) ? quote : null;
  const priceAgeSec = price ? Math.max(0, (nowMs - price.t) / 1000) : null;

  const candles = await attempt(() => market.candles(config.atr.resolution, config.atr.period + 3));
  const atrValue = candles ? atr(candles, config.atr.period, config.atr.resolution, nowMs) : null;

  const rates = await attempt(() => market.fundingRates());
  const latest = rates?.length ? rates[rates.length - 1]!.rate : 0;
  const fundingBpsPerHour = Number.isFinite(latest) ? latest * 10_000 : 0;

  const contract = await contractOf(d);
  const policy = policyView(d);

  const scenario = policy?.scenario ?? null;
  const fresh = price !== null && priceAgeSec !== null && priceAgeSec <= config.stale_data_max_age_sec;
  const inZone = !!(fresh && scenario && price.last >= scenario.entryLow && price.last <= scenario.entryHigh);

  const day = tradingDay(nowMs, config.day_reset_utc_hour);
  const trade = rec.trade;
  const stop = trade ? (trade.lastStop ?? trade.plan.stop) : 0;
  const dir = trade?.direction === "short" ? -1 : 1;
  const openRiskPct = position && trade
    ? (Math.max(0, (position.price - stop) * dir) * position.size / config.trading_capital_usd) * 100
    : 0;

  return {
    nowMs, lastClockMs: rec.lastClockMs, state: rec.state, stateSinceMs: rec.sinceMs, halt: rec.halt, trade,
    position, openOrders, price, priceAgeSec, atr: atrValue, policy,
    inZoneSinceMs: inZone ? (rec.inZoneSinceMs ?? nowMs) : null,
    reconciled: rec.reconciled,
    foreignExposure: openOrders.some((o) => !isBotOrder(o.cliOrdId)),
    dailyLossBreached: dailyLossBreached({ realized: netRealizedSince(fills, dayStart, config), unrealized: account.unrealizedPnl, config }),
    liquidated: fills.some((f) => /liquidat|adl/i.test(f.fillType) && Date.parse(f.fillTime) > rec.liqAckMs),
    cooldownUntilMs: rec.cooldownUntilMs,
    lastTradePnl: rec.tradeStartedMs !== null ? netRealizedSince(fills, rec.tradeStartedMs, config) : null,
    filledRoles: trade ? filledTargets(fills, trade.policyId) : [],
    counters: { entriesToday: store.getCounter(day, "entries"), ordersToday: store.getCounter(day, "orders") },
    openRiskPct, contract, fundingBpsPerHour,
  };
}

// The target rungs of a trade that have filled, from the fills (an order that is gone from the book could also be cancelled).
export function filledTargets(fills: { cliOrdId?: string | null }[], policyId: number): OrderRole[] {
  const roles = new Set<OrderRole>();
  for (const f of fills) {
    const id = f.cliOrdId ? parseCliOrdId(f.cliOrdId) : undefined;
    if (id && id.policyId === policyId && (id.role === "tp1" || id.role === "tp2" || id.role === "tp3")) roles.add(id.role);
  }
  return [...roles];
}

// The effective policy (tighten at once, loosen after N cycles) with its scenario resolved to prices from the stored menu.
function policyView(d: TraderDeps): PolicyView | null {
  const n = d.config.loosen_confirm_cycles;
  const stored = d.store.latestPolicies(n);
  const effective = effectivePolicy(stored.map((s) => s.policy), n);
  if (!effective || !stored[0]) return null;
  let scenario = null;
  if (effective.scenario) {
    const menu = d.store.getMenu(effective.menu_id);
    // The direction check is bypassed here on purpose: the engine reports "direction_not_allowed" itself.
    const resolved = menu ? resolveScenario(effective.scenario, [effective.scenario.direction], menu, d.config) : "no menu";
    scenario = typeof resolved === "string" ? null : resolved;
  }
  return { id: stored[0].id, policy: effective, scenario };
}

// The contract changes rarely: a failed read falls back to the last good one, and only a bot that has never
// had one cannot build a snapshot.
async function contractOf(d: TraderDeps): Promise<Contract> {
  const fresh = await attempt(() => d.market.contract());
  if (fresh && [fresh.tickSize, fresh.sizeStep, fresh.minSize].every((x) => Number.isFinite(x) && x > 0)) {
    d.store.setKv(CONTRACT_CACHE_KEY, JSON.stringify(fresh));
    return fresh;
  }
  const cached = d.store.getKv(CONTRACT_CACHE_KEY);
  if (cached) return JSON.parse(cached) as Contract;
  throw new Error("the contract specification is unavailable and none is cached");
}

async function attempt<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

// ---- cycle ----------------------------------------------------------------------------------------------------------

export async function runCycle(d: TraderDeps): Promise<Action[]> {
  const { store, config } = d;
  let rec: EngineRecord;
  let snap: Snapshot;
  try {
    rec = loadEngineRecord(store);
    snap = await snapshotFrom(d, rec);
  } catch (e) {
    return snapshotUnavailable(d, e);
  }

  let actions = decide(snap, config);
  if (!writeJournal(d, snap, actions)) actions = withoutEntries(actions);
  await execute(d, snap, rec, actions);
  return actions;
}

// An outage lasts many cycles: it is recorded when it starts, when its cause changes, and as a heartbeat, not every cycle.
function snapshotUnavailable(d: TraderDeps, e: unknown): Action[] {
  const detail = e instanceof Error ? e.message : String(e);
  const nowMs = d.clock.now();
  try {
    const last = JSON.parse(d.store.getKv(UNAVAILABLE_KEY) ?? "null") as { detail: string; tMs: number } | null;
    if (!last || last.detail !== detail || nowMs - last.tMs >= JOURNAL_HEARTBEAT_MS || nowMs < last.tMs) {
      note(d, "cannot_verify", detail);
      d.store.appendJournal({ tMs: nowMs, configHash: d.configHash, kind: "cycle", snapshot: null, decision: "skip:snapshot_unavailable", reason: detail });
      d.store.setKv(UNAVAILABLE_KEY, JSON.stringify({ detail, tMs: nowMs }));
    }
  } catch {
    /* a journal that cannot be written must not hide the fact that nothing was decided */
  }
  return [{ type: "skip", reason: "snapshot_unavailable" }];
}

const describe = (a: Action): string => {
  switch (a.type) {
    case "place": return `place:${a.req.cliOrdId}`;
    case "cancel": return `cancel:${a.cliOrdId}`;
    case "edit": return `edit:${a.cliOrdId}`;
    case "transition": return `transition:${a.to}`;
    case "halt": return `halt:${a.reason}`;
    case "skip": return `skip:${a.reason}`;
  }
};

// Writes a journal row when one is due. Returns false when a write was needed and failed.
function writeJournal(d: TraderDeps, snap: Snapshot, actions: Action[]): boolean {
  const key = actions.map(describe).join(";");
  try {
    const last = JSON.parse(d.store.getKv(JOURNAL_LAST_KEY) ?? "null") as { state: string; key: string; tMs: number } | null;
    const onlySkips = actions.every((a) => a.type === "skip");
    const due = !onlySkips || !last || last.state !== snap.state || last.key !== key
      || snap.nowMs - last.tMs >= JOURNAL_HEARTBEAT_MS || snap.nowMs < last.tMs;
    if (!due) return true;
    d.store.appendJournal({
      tMs: snap.nowMs, configHash: d.configHash, kind: "cycle", snapshot: snap, ...(snap.policy ? { policyId: snap.policy.id } : {}),
      decision: key, reason: actions[0] && "reason" in actions[0] ? actions[0].reason : "",
    });
    d.store.setKv(JOURNAL_LAST_KEY, JSON.stringify({ state: snap.state, key, tMs: snap.nowMs }));
    return true;
  } catch (e) {
    log.error("journal write failed: no new entries until it works", { error: e });
    return false;
  }
}

const isEntryPlace = (a: Action): boolean => a.type === "place" && !a.req.reduceOnly;
const isStateChange = (a: Action): boolean => a.type === "transition" || a.type === "halt";

// Without a journal nothing may open new exposure; protection, closing and cleanup carry on.
function withoutEntries(actions: Action[]): Action[] {
  const kept = actions.filter((a) => !isEntryPlace(a) && !(a.type === "transition" && a.to === "ENTERING"));
  return kept.length === actions.length ? actions : kept.length ? kept : [{ type: "skip", reason: "journal_unavailable" }];
}

async function execute(d: TraderDeps, snap: Snapshot, rec: EngineRecord, actions: Action[]): Promise<void> {
  const { executor, store, config } = d;
  rec.inZoneSinceMs = snap.inZoneSinceMs;

  // An entry is placed only once the new state is saved.
  const ordered = actions.some(isEntryPlace) ? [...actions.filter(isStateChange), ...actions.filter((a) => !isStateChange(a))] : actions;

  for (const a of ordered) {
    try {
      switch (a.type) {
        case "place": {
          recordPlacedOrder(store, config, snap.nowMs, { cliOrdId: a.req.cliOrdId, isEntry: parseCliOrdId(a.req.cliOrdId)?.role === "entry" });
          const ack = await executor.placeOrder(a.req);
          if (!ack.ok) note(d, `order_rejected:${ack.kind}`, `${a.req.cliOrdId}: ${ack.message}`);
          break;
        }
        case "cancel":
          await executor.cancelOrder({ cliOrdId: a.cliOrdId });
          break;
        case "edit": {
          let lost = false;
          let accepted = false;
          try {
            const ack = await executor.editOrder({
              cliOrdId: a.cliOrdId, ...(a.stopPrice !== undefined ? { stopPrice: a.stopPrice } : {}),
              ...(a.size !== undefined ? { size: a.size } : {}),
            });
            accepted = ack.ok;
            if (!ack.ok) note(d, `order_rejected:${ack.kind}`, `${a.cliOrdId}: ${ack.message}`);
          } catch (e) {
            lost = true; // the edit may or may not have taken effect
            note(d, "order_ack_lost", `${a.cliOrdId}: ${e instanceof Error ? e.message : String(e)}`);
          }
          // Remember the tightest stop that may be live, so a re-placed stop is never wider. A tighter record is the safe error.
          if ((accepted || lost) && a.stopPrice !== undefined && rec.trade) {
            rec.trade = { ...rec.trade, lastStop: a.stopPrice };
            saveEngineRecord(store, rec);
          }
          break;
        }
        case "transition":
          applyTransition(rec, a, snap.nowMs);
          saveEngineRecord(store, rec);
          break;
        case "halt":
          rec.state = "HALTED";
          rec.sinceMs = snap.nowMs;
          rec.halt = { reason: a.reason, manualAck: a.manualAck, untilMs: a.untilMs ?? null };
          saveEngineRecord(store, rec);
          note(d, `halt:${a.reason}`, a.manualAck ? "needs manual acknowledgement" : `until ${a.untilMs}`);
          break;
        case "skip":
          break;
      }
    } catch (e) {
      // A lost ack or a failing call must not stop the rest of the cycle: the next cycle reads the exchange back.
      note(d, a.type === "place" ? "order_ack_lost" : "executor_error", `${describe(a)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  rec.lastClockMs = Math.max(rec.lastClockMs, snap.nowMs);
  saveEngineRecord(store, rec);
}

function applyTransition(rec: EngineRecord, a: Extract<Action, { type: "transition" }>, nowMs: number): void {
  rec.state = a.to;
  rec.sinceMs = nowMs;
  if (a.trade !== undefined) rec.trade = a.trade;
  if (a.cooldownUntilMs !== undefined) rec.cooldownUntilMs = a.cooldownUntilMs;
  if (a.to === "ENTERING") rec.tradeStartedMs = nowMs;
  if (a.trade === null) rec.tradeStartedMs = null;
  if (a.to === "FLAT") {
    rec.halt = null;
    rec.cooldownUntilMs = null;
    rec.inZoneSinceMs = null; // an abandoned or finished entry must be confirmed again
  }
}

function note(d: TraderDeps, kind: string, detail: string): void {
  log.warn(kind, { detail });
  try {
    d.store.addIncident({ tMs: d.clock.now(), kind, detail });
  } catch {
    /* the log line above is all that is left */
  }
}
