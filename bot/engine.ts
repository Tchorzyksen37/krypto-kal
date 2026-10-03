// engine.ts – the pure decision function of the bot's state machine (spec section 4). decide(snapshot, config)
// returns the actions for ONE cycle and does no I/O: the trader (trader.ts) builds the snapshot, runs the actions,
// confirms by reading the exchange back, and persists the new state. Every cycle returns at least one action; doing
// nothing is a `skip` with a reason, so the journal always records why.
//
// Order ids. A retry after a lost ack must reuse the id (the exchange then sees one order), but an id whose order
// is finished cannot be reused to place a new one. So repairs use a fresh sequence number: `protectSeq` (bumped when
// a stop goes missing) for stops and targets, and an attempt number derived from elapsed time for close orders.
//
// Reduce-only mode is not a state: stale data, no policy or an expired policy only blocks entries. Positions keep
// their stops (which may be tightened and never widened) and are not closed because a policy lapsed.

import type { BotConfig } from "./config.ts";
import {
  type FuturesOpenOrder, type FuturesPosition, type OrderRequest, type OrderRole, type PriceEvent, isBotOrder,
  makeCliOrdId, parseCliOrdId,
} from "./executor.ts";
import { checkEntryLimits, cooldownUntil, dayStartMs } from "./limits.ts";
import type { Policy, ResolvedScenario } from "./policy.ts";
import { type Contract, ceilTo, floorTo, planTrade, splitLadder } from "./sizing.ts";

export type EngineState = "FLAT" | "ENTERING" | "PROTECTING" | "OPEN" | "REDUCING" | "COOLDOWN" | "HALTED";

// The trade in progress, decided in FLAT and persisted by the trader until the position is gone.
export interface TradeRecord {
  policyId: number;
  direction: "long" | "short";
  entryCliOrdId: string;
  entryPrice: number; // the limit price of the entry, the basis of 1R
  plan: { size: number; stop: number; ladder: { price: number; size: number }[]; leverage: number };
  horizonEndMs: number; // the time-stop
  protectSeq: number; // sequence number of the current stop and targets
  lastStop?: number; // the stop as last moved by the trailing logic; a re-placed stop must not be wider than this
}

export interface PolicyView {
  id: number; // the store's id of the newest policy
  policy: Policy; // the EFFECTIVE policy (tighten at once, loosen after N cycles)
  scenario: ResolvedScenario | null; // its scenario, resolved to prices
}

export interface Snapshot {
  nowMs: number;
  lastClockMs: number; // the newest time seen before this cycle
  state: EngineState;
  stateSinceMs: number;
  halt: { reason: string; manualAck: boolean; untilMs: number | null } | null;
  trade: TradeRecord | null;
  position: FuturesPosition | null; // on the configured symbol
  openOrders: FuturesOpenOrder[]; // on the configured symbol
  price: PriceEvent | null;
  priceAgeSec: number | null;
  atr: number | null;
  policy: PolicyView | null;
  inZoneSinceMs: number | null; // since when the last price has been continuously inside the entry zone
  reconciled: boolean;
  foreignExposure: boolean; // a position or order on the symbol that the bot did not create
  dailyLossBreached: boolean;
  liquidated: boolean;
  cooldownUntilMs: number | null;
  lastTradePnl: number | null; // net PnL of the trade that just ended; null is treated as a loss
  filledRoles: OrderRole[]; // target rungs of this trade that have already filled; they are never placed again
  counters: { entriesToday: number; ordersToday: number };
  openRiskPct: number;
  contract: Contract;
  fundingBpsPerHour: number;
}

export type Action =
  | { type: "place"; req: OrderRequest; reason: string }
  | { type: "cancel"; cliOrdId: string; reason: string }
  | { type: "edit"; cliOrdId: string; stopPrice?: number; size?: number; reason: string }
  | { type: "transition"; to: EngineState; reason: string; trade?: TradeRecord | null; cooldownUntilMs?: number }
  | { type: "halt"; reason: string; manualAck: boolean; untilMs?: number }
  | { type: "skip"; reason: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const EPS = 1e-9;

const skip = (reason: string): Action => ({ type: "skip", reason });
const cancel = (cliOrdId: string, reason: string): Action => ({ type: "cancel", cliOrdId, reason });
const place = (req: OrderRequest, reason: string): Action => ({ type: "place", req, reason });
const halt = (reason: string, manualAck: boolean, untilMs?: number): Action =>
  untilMs === undefined ? { type: "halt", reason, manualAck } : { type: "halt", reason, manualAck, untilMs };
const go = (to: EngineState, reason: string, extra: { trade?: TradeRecord | null; cooldownUntilMs?: number } = {}): Action => ({
  type: "transition", to, reason, ...extra,
});

// Why entries are blocked right now, or null. Stale data, no policy or an expired policy puts the bot in reduce-only mode.
export function reduceOnlyReason(s: Snapshot, config: BotConfig): string | null {
  if (!s.price || s.priceAgeSec === null) return "no_price";
  if (s.priceAgeSec > config.stale_data_max_age_sec) return "stale_data";
  if (!s.policy) return "no_policy";
  if (Date.parse(s.policy.policy.valid_until) <= s.nowMs) return "policy_expired";
  return null;
}

export function decide(s: Snapshot, config: BotConfig): Action[] {
  if (s.nowMs < s.lastClockMs) return timeUntrusted(s, config);
  if (s.liquidated) return [halt("liquidation_or_adl", true)];
  if (s.dailyLossBreached && s.state !== "HALTED") {
    // Halt until the next reset hour. Existing protection stays; only a resting entry is withdrawn.
    const entry = s.state === "ENTERING" && s.trade ? byId(s, s.trade.entryCliOrdId) : undefined;
    return [
      ...(entry ? [cancel(entry.cliOrdId, "daily_loss_limit")] : []),
      halt("daily_loss_limit", false, dayStartMs(s.nowMs, config.day_reset_utc_hour) + DAY_MS),
    ];
  }

  switch (s.state) {
    case "FLAT": return flat(s, config);
    case "ENTERING": return entering(s, config);
    case "PROTECTING": return protecting(s, config);
    case "OPEN": return open(s, config);
    case "REDUCING": return reducing(s, config);
    case "COOLDOWN": return cooldown(s, config);
    case "HALTED": return halted(s, config);
  }
}

// The clock moved backwards, so everything that depends on the time (entries, timeouts, the time-stop, cooldowns, trailing, a
// policy's expiry, the end of a halt) cannot be judged. Protecting a position does not depend on the time, so a missing
// stop is still put back, and nothing else is done.
function timeUntrusted(s: Snapshot, config: BotConfig): Action[] {
  const trade = s.trade;
  if (s.position && trade && !wrongSide(s.position, trade)) {
    if (s.state === "PROTECTING") {
      const missing = protectionActions(s, trade, config);
      if (missing.length) return missing;
    }
    if (s.state === "OPEN") {
      const stop = findRole(s, trade, "sl");
      if (!stop) return [go("PROTECTING", "sl_missing", { trade: { ...trade, protectSeq: trade.protectSeq + 1 } })];
      if (sizeDiffers(stop, s.position.size)) return [{ type: "edit", cliOrdId: stop.cliOrdId, size: s.position.size, reason: "resize_stop" }];
    }
  }
  return [skip("clock_went_backwards")];
}

// ---- FLAT -----------------------------------------------------------------------------------------------------------

function flat(s: Snapshot, config: BotConfig): Action[] {
  if (s.foreignExposure) return [skip("foreign_exposure")];
  if (s.position) return [halt("position_in_flat_state", true)];
  if (!s.reconciled) return [skip("not_reconciled")];
  const blocked = reduceOnlyReason(s, config);
  if (blocked) return [skip(blocked)];

  const p = s.policy!;
  const sc = p.scenario;
  if (!sc) return [skip("no_scenario")];
  if (!p.policy.allowed_directions.includes(sc.direction)) return [skip("direction_not_allowed")];
  const dir = sc.direction === "long" ? 1 : -1;
  if (p.policy.bias * dir < 0) return [skip("bias_conflict")];
  if (s.atr === null) return [skip("no_atr")];
  const price = s.price!;
  if (price.last < sc.entryLow || price.last > sc.entryHigh) return [skip("price_outside_zone")];
  if (s.inZoneSinceMs === null || s.nowMs - s.inZoneSinceMs < config.entry_confirm_sec * 1000) return [skip("awaiting_confirmation")];

  // A resting limit on the passive side of the book, kept inside the zone.
  const raw = Math.min(Math.max(dir > 0 ? price.bid : price.ask, sc.entryLow), sc.entryHigh);
  const entry = dir > 0 ? floorTo(raw, s.contract.tickSize) : ceilTo(raw, s.contract.tickSize);
  const plan = planTrade({
    scenario: sc, entry, atr: s.atr, conviction: p.policy.conviction, riskBudgetPct: p.policy.risk_budget_pct,
    fundingBpsPerHour: s.fundingBpsPerHour, config, contract: s.contract,
  });
  if (!plan.ok) return [skip(`plan:${plan.reason}`)];

  const limits = checkEntryLimits({
    config, nowMs: s.nowMs, lastClockMs: s.lastClockMs, entriesToday: s.counters.entriesToday, ordersToday: s.counters.ordersToday,
    openRiskPct: s.openRiskPct, newRiskPct: plan.riskPct, openPositions: 0, ordersNeeded: 2 + plan.ladder.length,
  });
  if (!limits.ok) return [skip(`limit:${limits.reason}`)];

  const cliOrdId = makeCliOrdId(p.id, "entry", s.counters.entriesToday);
  const trade: TradeRecord = {
    policyId: p.id, direction: sc.direction, entryCliOrdId: cliOrdId, entryPrice: entry,
    plan: { size: plan.size, stop: plan.stop, ladder: plan.ladder, leverage: plan.leverage },
    horizonEndMs: s.nowMs + sc.horizonHours * HOUR_MS, protectSeq: 0,
  };
  return [
    place({
      symbol: config.symbol, side: dir > 0 ? "buy" : "sell", orderType: "lmt", size: plan.size, limitPrice: entry,
      reduceOnly: false, cliOrdId, processBefore: new Date(s.nowMs + config.entry_timeout_sec * 1000).toISOString(),
    }, "entry"),
    go("ENTERING", "entry_placed", { trade }),
  ];
}

// ---- ENTERING -------------------------------------------------------------------------------------------------------

function entering(s: Snapshot, config: BotConfig): Action[] {
  const trade = s.trade;
  if (!trade) return [go("FLAT", "no_trade_record", { trade: null })];
  const resting = byId(s, trade.entryCliOrdId);

  if (s.position) {
    if (wrongSide(s.position, trade)) return [halt("position_on_wrong_side", true)];
    // Still resting: the filled size is not final until the remainder is cancelled and confirmed.
    if (resting) return [cancel(resting.cliOrdId, "cancel_remainder"), go("PROTECTING", "partial_fill")];
    return [...protectionActions(s, trade, config), go("PROTECTING", "entry_filled")];
  }

  if (!resting) return [go("FLAT", "entry_vanished", { trade: null })];
  const why = abandonReason(s, config, trade);
  if (why) return [cancel(resting.cliOrdId, why), go("FLAT", why, { trade: null })];
  return [skip("entry_resting")];
}

// Why a resting entry should be withdrawn, or null.
function abandonReason(s: Snapshot, config: BotConfig, trade: TradeRecord): string | null {
  if (s.nowMs - s.stateSinceMs > config.entry_timeout_sec * 1000) return "entry_timeout";
  const blocked = reduceOnlyReason(s, config);
  if (blocked) return blocked;
  const dir = trade.direction === "long" ? 1 : -1;
  const p = s.policy!;
  if (!p.policy.allowed_directions.includes(trade.direction)) return "direction_not_allowed";
  if (p.policy.bias * dir < 0) return "bias_conflict";
  const sc = p.scenario;
  const last = s.price!.last;
  if (sc && (last < sc.entryLow || last > sc.entryHigh)) return "left_zone";
  return null;
}

// ---- PROTECTING -----------------------------------------------------------------------------------------------------

function protecting(s: Snapshot, config: BotConfig): Action[] {
  const trade = s.trade;
  if (!trade) return [halt("missing_trade_record", true)];
  if (!s.position) return [go("REDUCING", "position_gone_before_protected")];
  if (wrongSide(s.position, trade)) return [halt("position_on_wrong_side", true)];

  const missing = protectionActions(s, trade, config);
  if (missing.length === 0) return [go("OPEN", "protected")]; // confirmed by the exchange, not by an ack
  if (s.nowMs - s.stateSinceMs > config.protect_timeout_sec * 1000) {
    return [closeAction(s, config, 0, "protect_timeout"), go("REDUCING", "protect_timeout")];
  }
  return missing;
}

// The orders that still have to be placed or resized so that the stop and the target ladder match the position.
function protectionActions(s: Snapshot, trade: TradeRecord, config: BotConfig): Action[] {
  const pos = s.position!;
  const closing = pos.side === "long" ? "sell" : "buy";
  const out: Action[] = [];

  const stop = findRole(s, trade, "sl");
  if (!stop) {
    out.push(place({
      symbol: config.symbol, side: closing, orderType: "stp", size: pos.size, stopPrice: trade.lastStop ?? trade.plan.stop,
      reduceOnly: true, triggerSignal: "mark", cliOrdId: makeCliOrdId(trade.policyId, "sl", trade.protectSeq),
    }, "protect_stop"));
  } else if (sizeDiffers(stop, pos.size)) {
    out.push({ type: "edit", cliOrdId: stop.cliOrdId, size: pos.size, reason: "resize_stop" });
  }

  // Rungs keep their original role (tp1, tp2, ...); the ones that already filled are left out.
  const done = new Set(s.filledRoles);
  const remaining = trade.plan.ladder.map((r, i) => ({ role: `tp${i + 1}` as OrderRole, price: r.price })).filter((r) => !done.has(r.role));
  const rungs = splitLadder(remaining.map((r) => r.price), pos.size, s.contract);
  rungs.forEach((rung, i) => {
    const role = remaining[i]!.role;
    const existing = findRole(s, trade, role);
    if (!existing) {
      out.push(place({
        symbol: config.symbol, side: closing, orderType: "lmt", size: rung.size, limitPrice: rung.price, reduceOnly: true,
        cliOrdId: makeCliOrdId(trade.policyId, role, trade.protectSeq),
      }, "protect_target"));
    } else if (sizeDiffers(existing, rung.size)) {
      out.push({ type: "edit", cliOrdId: existing.cliOrdId, size: rung.size, reason: "resize_target" });
    }
  });
  return out;
}

// ---- OPEN -----------------------------------------------------------------------------------------------------------

function open(s: Snapshot, config: BotConfig): Action[] {
  const trade = s.trade;
  if (!trade) return [halt("missing_trade_record", true)];
  if (!s.position) return [go("REDUCING", "position_closed")];
  if (wrongSide(s.position, trade)) return [halt("position_on_wrong_side", true)];

  const stop = findRole(s, trade, "sl");
  // The stop disappeared: protect again under a new id (the old one is finished and cannot be reused).
  if (!stop) return [go("PROTECTING", "sl_missing", { trade: { ...trade, protectSeq: trade.protectSeq + 1 } })];

  if (s.nowMs >= trade.horizonEndMs) return [closeAction(s, config, 0, "time_stop"), go("REDUCING", "time_stop")];

  // An expired policy is not authoritative: it never closes a position. A live one can.
  if (s.policy && Date.parse(s.policy.policy.valid_until) > s.nowMs) {
    const dir = trade.direction === "long" ? 1 : -1;
    if (!s.policy.policy.allowed_directions.includes(trade.direction)) return [closeAction(s, config, 0, "policy_void"), go("REDUCING", "policy_void")];
    if (s.policy.policy.bias * dir < 0) return [closeAction(s, config, 0, "policy_flip"), go("REDUCING", "policy_flip")];
  }

  if (sizeDiffers(stop, s.position.size)) {
    return [{ type: "edit", cliOrdId: stop.cliOrdId, size: s.position.size, reason: "resize_stop" }];
  }
  const trail = trailingStop(s, trade, stop, config);
  return trail ? [trail] : [skip("holding")];
}

// Moves the stop toward the price, never away from it. Starts once the trade is trail_start_r in profit and needs
// fresh data. The candidate is rounded away from the price and must be at least one tick tighter than the stop.
function trailingStop(s: Snapshot, trade: TradeRecord, stop: BotOrder, config: BotConfig): Action | null {
  if (!s.position || !s.price || s.atr === null || s.priceAgeSec === null || s.priceAgeSec > config.stale_data_max_age_sec) return null;
  const dir = trade.direction === "long" ? 1 : -1;
  const tick = s.contract.tickSize;
  const last = s.price.last;
  const oneR = Math.abs(trade.entryPrice - trade.plan.stop);
  if (!(oneR > 0) || (last - s.position.price) * dir < config.trail_start_r * oneR - EPS) return null;

  const raw = last - dir * config.trail_atr_multiple * s.atr;
  const candidate = dir > 0 ? floorTo(raw, tick) : ceilTo(raw, tick);
  const current = stop.stopPrice;
  if (current === undefined || !Number.isFinite(candidate)) return null;
  if ((candidate - current) * dir < tick - EPS) return null; // not tighter
  if ((last - candidate) * dir < tick - EPS) return null; // would sit on the price
  return { type: "edit", cliOrdId: stop.cliOrdId, stopPrice: candidate, reason: "trail" };
}

// ---- REDUCING / COOLDOWN / HALTED -----------------------------------------------------------------------------------

function reducing(s: Snapshot, config: BotConfig): Action[] {
  if (s.position) {
    if (findRoleAny(s, "close")) return [skip("closing")];
    // A fresh id per protect_timeout interval: retries inside one interval are the same order, a later one is new.
    const attempt = Math.floor(Math.max(0, s.nowMs - s.stateSinceMs) / (config.protect_timeout_sec * 1000));
    return [closeAction(s, config, attempt, "close_position")];
  }
  const leftovers = botOrders(s, config);
  if (leftovers.length) return leftovers.map((o) => cancel(o.cliOrdId, "leftover_after_close"));
  const lossy = s.lastTradePnl === null || s.lastTradePnl < 0;
  return [go("COOLDOWN", "flat_and_clean", {
    trade: null, cooldownUntilMs: cooldownUntil({ closedAtMs: s.nowMs, lossy, config }),
  })];
}

function cooldown(s: Snapshot, config: BotConfig): Action[] {
  if (s.position) return [halt("position_in_cooldown", true)];
  const leftovers = botOrders(s, config);
  if (leftovers.length) return leftovers.map((o) => cancel(o.cliOrdId, "leftover_in_cooldown"));
  if (s.cooldownUntilMs === null || s.nowMs >= s.cooldownUntilMs) return [go("FLAT", "cooldown_over")];
  return [skip("cooldown")];
}

function halted(s: Snapshot, config: BotConfig): Action[] {
  const out: Action[] = [];
  for (const o of botOrders(s, config)) {
    if (parseCliOrdId(o.cliOrdId)?.role === "entry") out.push(cancel(o.cliOrdId, "halted_withdraw_entry"));
  }
  if (s.position) {
    // A position the bot opened (it has a trade record) keeps its stop; without one it is closed rather than left
    // bare. A position with no trade record may be the user's own: it is never touched.
    if (s.trade && !findRole(s, s.trade, "sl")) out.push(closeAction(s, config, 0, "halted_without_stop"));
  } else if (s.halt && !s.halt.manualAck && s.halt.untilMs !== null && s.nowMs >= s.halt.untilMs) {
    out.push(go("FLAT", "halt_expired"));
  }
  return out.length ? out : [skip("halted")];
}

// ---- helpers --------------------------------------------------------------------------------------------------------

function closeAction(s: Snapshot, config: BotConfig, attempt: number, reason: string): Action {
  const pos = s.position!;
  return place({
    symbol: config.symbol, side: pos.side === "long" ? "sell" : "buy", orderType: "mkt", size: pos.size, reduceOnly: true,
    cliOrdId: makeCliOrdId(s.trade?.policyId ?? 0, "close", attempt),
  }, reason);
}

const wrongSide = (pos: FuturesPosition, trade: TradeRecord): boolean => pos.side !== trade.direction;

// An open order that is known by its client id (every order the bot creates is).
type BotOrder = FuturesOpenOrder & { cliOrdId: string };
const hasId = (o: FuturesOpenOrder): o is BotOrder => typeof o.cliOrdId === "string";

function byId(s: Snapshot, cliOrdId: string): BotOrder | undefined {
  return s.openOrders.filter(hasId).find((o) => o.cliOrdId === cliOrdId);
}

// The bot's open order with this role for this trade, whatever its sequence number.
function findRole(s: Snapshot, trade: TradeRecord, role: OrderRole): BotOrder | undefined {
  return s.openOrders.filter(hasId).find((o) => {
    const id = parseCliOrdId(o.cliOrdId);
    return id?.policyId === trade.policyId && id.role === role;
  });
}

function findRoleAny(s: Snapshot, role: OrderRole): BotOrder | undefined {
  return s.openOrders.filter(hasId).find((o) => parseCliOrdId(o.cliOrdId)?.role === role);
}

// Open orders the bot created on the symbol. Anything else (a manual order) is never touched.
function botOrders(s: Snapshot, config: BotConfig): BotOrder[] {
  return s.openOrders.filter(hasId).filter((o) => isBotOrder(o.cliOrdId) && o.symbol === config.symbol);
}

// An order whose remaining size differs from `size`. An exchange that omits the field is taken to be right.
function sizeDiffers(o: FuturesOpenOrder, size: number): boolean {
  return o.unfilledSize !== undefined && Math.abs(o.unfilledSize - size) > EPS;
}
