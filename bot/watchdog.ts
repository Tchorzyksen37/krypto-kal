// watchdog.ts – the second pair of eyes. It runs as its own process, knows nothing of the policy or the state machine,
// and checks the one invariant that matters: every position of the bot has a stop and targets of the right size. When
// the engine does not keep that invariant (it hung, crashed, or is being slow) the watchdog repairs it or closes.
//
//  - It only READS the engine's record. Two processes doing read-modify-write on one value would lose each other's
//    updates, so the watchdog keeps its own state under its own key.
//  - It waits 2 x protect_timeout_sec after first seeing a problem, so the engine always goes first.
//  - Everything it places is reduce-only: it can never open a position, only reduce or protect one.
//  - It never touches a position it has no trade record for (it may be the user's), nor an order the bot did not create.
//  - A missing stop is re-placed once; if it is still missing on the next tick the position is closed at market.
//    A missing or short target is re-placed but never makes the watchdog close anything.
//  - Its repair orders use sequence numbers from 100 up (the engine uses small ones) and count up, so an id is never
//    reused by a finished order. At worst the engine and the watchdog briefly both place a reduce-only stop; the second
//    finds nothing to reduce.
//  - What it cannot read it cannot verify, and it says so; a pending repair keeps its clock meanwhile.

import { createLogger } from "../logger.ts";
import type { BotStore } from "./bot-store.ts";
import type { BotConfig } from "./config.ts";
import type { TradeRecord } from "./engine.ts";
import { loadEngineRecord } from "./engine-state.ts";
import { type FuturesOpenOrder, type FuturesPosition, type OrderRole, isBotOrder, makeCliOrdId, parseCliOrdId } from "./executor.ts";
import { filledTargets, type TraderDeps } from "./trader.ts";

const log = createLogger("watchdog");

export type IssueKind =
  | "no_sl" | "wrong_sl_size" | "no_tp" | "wrong_tp_size" | "orphan_reduce_only"
  | "unexplained_position" | "position_on_wrong_side" | "cannot_verify";

export interface ProtectionIssue {
  kind: IssueKind;
  detail: string;
}

export interface ProtectionInput {
  position: FuturesPosition | null;
  orders: FuturesOpenOrder[]; // on the traded symbol
  trade: TradeRecord | null; // the engine's record of the trade, if any
  filledRoles: OrderRole[]; // target rungs that already filled
  config: BotConfig;
}

type BotOrder = FuturesOpenOrder & { cliOrdId: string };
const EPS = 1e-9;
const SL_SEQ_BASE = 100;
const TP_SEQ_BASE = 100;
const CLOSE_SEQ_BASE = 1000;
const NOTE_REPEAT_MS = 60_000;

// What is wrong with the protection of the position, judged only from what is on the exchange. Pure.
export function checkProtection(i: ProtectionInput): ProtectionIssue[] {
  const { position, trade } = i;
  const mine = i.orders.filter((o): o is BotOrder => typeof o.cliOrdId === "string" && isBotOrder(o.cliOrdId));

  // Nothing is open: reduce-only orders left behind could close a later position.
  if (!position) return mine.filter((o) => o.reduceOnly).map((o) => ({ kind: "orphan_reduce_only", detail: o.cliOrdId }));

  if (!trade) return [{ kind: "unexplained_position", detail: `${position.side} ${position.size}: no trade record, so nothing to verify against` }];
  if (position.side !== trade.direction) {
    return [{ kind: "position_on_wrong_side", detail: `the trade is ${trade.direction} but the position is ${position.side}` }];
  }

  const own = mine.filter((o) => o.reduceOnly && parseCliOrdId(o.cliOrdId)?.policyId === trade.policyId);
  const roleOf = (o: BotOrder) => parseCliOrdId(o.cliOrdId)?.role;
  const issues: ProtectionIssue[] = [];

  const stops = own.filter((o) => roleOf(o) === "sl");
  if (stops.length === 0) {
    issues.push({ kind: "no_sl", detail: `a ${position.side} position of ${position.size} has no stop` });
  } else if (!stops.some((o) => matches(o, position.size))) {
    issues.push({ kind: "wrong_sl_size", detail: `no stop covers exactly ${position.size} (${stops.map((o) => o.unfilledSize).join(", ")})` });
  }

  const done = new Set<string>(i.filledRoles);
  const expected = trade.plan.ladder.map((_, n) => `tp${n + 1}`).filter((role) => !done.has(role));
  if (expected.length > 0) {
    const targets = own.filter((o) => roleOf(o)?.startsWith("tp"));
    if (targets.length === 0) {
      issues.push({ kind: "no_tp", detail: `no target for a position of ${position.size}` });
    } else if (targets.every((o) => o.unfilledSize !== undefined)) {
      const coverage = targets.reduce((sum, o) => sum + (o.unfilledSize ?? 0), 0);
      if (Math.abs(coverage - position.size) > EPS) {
        issues.push({ kind: "wrong_tp_size", detail: `targets cover ${coverage} of a position of ${position.size}` });
      }
    }
  }
  return issues;
}

// An order whose remaining size is `size`. An exchange that omits the field is taken to be right.
const matches = (o: FuturesOpenOrder, size: number): boolean => o.unfilledSize === undefined || Math.abs(o.unfilledSize - size) <= EPS;

// ---- the loop ---------------------------------------------------------------------------------------------------------

interface WatchdogState {
  sinceMs: number | null; // when the current problem was first seen
  failedRepairs: number; // consecutive stop repairs that did not produce a stop
  slAttempts: number; // counters that only ever grow, so repair ids are never reused
  tpAttempts: number;
  closeAttempts: number;
  lastKey: string; // the issues last reported
  lastNoteMs: number;
}

const WD_KEY = "watchdog:state";
const freshState = (): WatchdogState => ({ sinceMs: null, failedRepairs: 0, slAttempts: 0, tpAttempts: 0, closeAttempts: 0, lastKey: "", lastNoteMs: 0 });

function loadState(store: BotStore): WatchdogState {
  const raw = store.getKv(WD_KEY);
  if (!raw) return freshState();
  try {
    return { ...freshState(), ...(JSON.parse(raw) as Partial<WatchdogState>) };
  } catch {
    return freshState();
  }
}

// One check, and the repair it calls for. Returns the issues it found.
export async function watchdogTick(d: TraderDeps): Promise<ProtectionIssue[]> {
  const { executor, store, clock, config } = d;
  const now = clock.now();
  const wd = loadState(store);

  let rec;
  let position: FuturesPosition | null;
  let orders: FuturesOpenOrder[];
  let filledRoles: OrderRole[] = [];
  try {
    rec = loadEngineRecord(store);
    const [positions, open] = await Promise.all([executor.getPositions(), executor.getOpenOrders()]);
    position = positions.find((p) => p.symbol === config.symbol) ?? null;
    orders = open.filter((o) => o.symbol === config.symbol);
    if (rec.trade) {
      const fills = await executor.getFills(new Date(rec.tradeStartedMs ?? now - 24 * 3_600_000));
      filledRoles = filledTargets(fills, rec.trade.policyId);
    }
  } catch (e) {
    const issues: ProtectionIssue[] = [{ kind: "cannot_verify", detail: e instanceof Error ? e.message : String(e) }];
    report(d, wd, issues, [], now);
    saveState(store, wd);
    return issues; // the clock of a pending repair keeps running
  }

  const issues = checkProtection({ position, orders, trade: rec.trade, filledRoles, config });
  if (issues.length === 0) {
    wd.sinceMs = null;
    wd.failedRepairs = 0;
    wd.lastKey = "";
    saveState(store, wd);
    return [];
  }

  if (wd.sinceMs === null || now < wd.sinceMs) wd.sinceMs = now; // a clock that went backwards restarts the wait
  const graceMs = config.protect_timeout_sec * 2 * 1000;
  const actions = now - wd.sinceMs >= graceMs ? await repair(d, wd, issues, position, orders, rec.trade, filledRoles) : [];
  report(d, wd, issues, actions, now);
  saveState(store, wd);
  return issues;
}

async function repair(
  d: TraderDeps, wd: WatchdogState, issues: ProtectionIssue[], position: FuturesPosition | null, orders: FuturesOpenOrder[],
  trade: TradeRecord | null, filledRoles: OrderRole[],
): Promise<string[]> {
  const { executor, config } = d;
  const actions: string[] = [];
  const has = (k: IssueKind) => issues.some((i) => i.kind === k);
  const attempt = async (label: string, f: () => Promise<unknown>) => {
    try {
      const ack = (await f()) as { ok?: boolean; kind?: string } | undefined;
      actions.push(ack && ack.ok === false ? `${label}(rejected:${ack.kind})` : label);
      return ack?.ok !== false;
    } catch (e) {
      actions.push(`${label}(lost:${e instanceof Error ? e.message : String(e)})`);
      return false;
    }
  };

  // Nothing is open: remove what the bot left behind.
  if (!position) {
    for (const issue of issues) {
      if (issue.kind === "orphan_reduce_only") await attempt(`cancel:${issue.detail}`, () => executor.cancelOrder({ cliOrdId: issue.detail }));
    }
    return actions;
  }
  // Only a position the bot has a trade record for is its to look after.
  if (!trade || has("unexplained_position") || has("position_on_wrong_side")) return actions;

  const closing = position.side === "long" ? "sell" : "buy";
  const mine = orders.filter((o): o is BotOrder => typeof o.cliOrdId === "string" && isBotOrder(o.cliOrdId));
  const own = mine.filter((o) => o.reduceOnly && parseCliOrdId(o.cliOrdId)?.policyId === trade.policyId);

  if (has("no_sl")) {
    if (wd.failedRepairs === 0) {
      // First try: put the stop back, at the last trailed value (never wider than what was live).
      const id = makeCliOrdId(trade.policyId, "sl", SL_SEQ_BASE + wd.slAttempts++);
      wd.failedRepairs++;
      await attempt(`place:${id}`, () => executor.placeOrder({
        symbol: config.symbol, side: closing, orderType: "stp", size: position.size, stopPrice: trade.lastStop ?? trade.plan.stop,
        reduceOnly: true, triggerSignal: "mark", cliOrdId: id,
      }));
    } else {
      // It did not work: a position with no stop is closed.
      const id = makeCliOrdId(trade.policyId, "close", CLOSE_SEQ_BASE + wd.closeAttempts++);
      await attempt(`place:${id}`, () => executor.placeOrder({
        symbol: config.symbol, side: closing, orderType: "mkt", size: position.size, reduceOnly: true, cliOrdId: id,
      }));
    }
    return actions;
  }
  wd.failedRepairs = 0;

  if (has("wrong_sl_size")) {
    const stop = own.find((o) => parseCliOrdId(o.cliOrdId)?.role === "sl");
    if (stop) await attempt(`edit:${stop.cliOrdId}`, () => executor.editOrder({ cliOrdId: stop.cliOrdId, size: position.size }));
  }

  if (has("no_tp") || has("wrong_tp_size")) {
    // Re-place the first rung that has no order, for the size that is not covered. Never a reason to close.
    const done = new Set<string>(filledRoles);
    const open = new Set(own.map((o) => parseCliOrdId(o.cliOrdId)?.role as string));
    const rungs = trade.plan.ladder.map((r, n) => ({ role: `tp${n + 1}` as OrderRole, price: r.price })).filter((r) => !done.has(r.role));
    const rung = rungs.find((r) => !open.has(r.role));
    const covered = own.filter((o) => parseCliOrdId(o.cliOrdId)?.role?.startsWith("tp")).reduce((s, o) => s + (o.unfilledSize ?? 0), 0);
    const missing = Number((position.size - covered).toFixed(10));
    if (rung && missing > EPS) {
      const id = makeCliOrdId(trade.policyId, rung.role, TP_SEQ_BASE + wd.tpAttempts++);
      await attempt(`place:${id}`, () => executor.placeOrder({
        symbol: config.symbol, side: closing, orderType: "lmt", size: missing, limitPrice: rung.price, reduceOnly: true, cliOrdId: id,
      }));
    }
  }
  return actions;
}

// An incident when the set of issues changes (or every minute it persists), and a journal row when something was done
// or the set changed. Neither may stop a repair: protection comes first.
function report(d: TraderDeps, wd: WatchdogState, issues: ProtectionIssue[], actions: string[], now: number): void {
  const key = issues.map((i) => i.kind).join(",");
  const changed = key !== wd.lastKey;
  if (changed || now - wd.lastNoteMs >= NOTE_REPEAT_MS) {
    wd.lastKey = key;
    wd.lastNoteMs = now;
    log.warn(key, { actions: actions.join(";") });
    try {
      d.store.addIncident({ tMs: now, kind: `watchdog:${issues[0]?.kind ?? "unknown"}`, detail: issues.map((i) => `${i.kind}: ${i.detail}`).join("; ") });
    } catch {
      /* the log line above is all that is left */
    }
  }
  if (changed || actions.length > 0) {
    try {
      d.store.appendJournal({
        tMs: now, configHash: d.configHash, kind: "watchdog", snapshot: { issues }, decision: actions.join(";") || "none", reason: key,
      });
    } catch {
      /* a failing journal never stops a repair */
    }
  }
}

function saveState(store: BotStore, wd: WatchdogState): void {
  try {
    store.setKv(WD_KEY, JSON.stringify(wd));
  } catch (e) {
    log.error("cannot save the watchdog state", { error: e });
  }
}
