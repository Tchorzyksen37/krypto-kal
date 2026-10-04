// limits.ts – the bot's daily budget and risk limits. Limits only ever block ENTRIES; reducing and closing are
// always allowed. Counters are persisted in the BotStore and rebuilt from the exchange's order history after a restart
// (the higher value wins), so a restart cannot reset a day's budget. A new policy never touches any of this.

import type { FuturesFill } from "../providers/kraken/kraken-futures-client.ts";
import type { BotStore } from "./bot-store.ts";
import type { BotConfig } from "./config.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const EPS = 1e-9;

// The trading day an instant belongs to, as YYYY-MM-DD. Days start at `resetHourUtc`, so with reset hour 6 the
// instant 05:59 UTC still belongs to the previous date's day.
export function tradingDay(nowMs: number, resetHourUtc: number): string {
  return new Date(nowMs - resetHourUtc * HOUR_MS).toISOString().slice(0, 10);
}

// The most recent reset instant at or before `nowMs`.
export function dayStartMs(nowMs: number, resetHourUtc: number): number {
  return Math.floor((nowMs - resetHourUtc * HOUR_MS) / DAY_MS) * DAY_MS + resetHourUtc * HOUR_MS;
}

// Counts a placed order toward today's budget, once per cliOrdId: a retry after a lost ack reuses the id and must not
// be counted twice. Returns whether this call counted it. Placed orders count, not just filled ones.
export function recordPlacedOrder(
  store: BotStore, config: BotConfig, nowMs: number, o: { cliOrdId: string; isEntry: boolean },
): boolean {
  return store.transaction(() => {
    const marker = `counted:${o.cliOrdId}`;
    if (store.getKv(marker) !== undefined) return false;
    const day = tradingDay(nowMs, config.day_reset_utc_hour);
    store.setKv(marker, day);
    store.addCounter(day, "orders", 1);
    if (o.isEntry) store.addCounter(day, "entries", 1);
    return true;
  });
}

// The pure core of the gate: the counters are passed in, so the engine can call it without touching the store.
export interface EntryLimitsCheck {
  config: BotConfig;
  nowMs: number;
  lastClockMs: number; // the newest time seen so far; a clock that went backwards blocks entries
  entriesToday: number;
  ordersToday: number;
  openRiskPct: number; // risk already open, % of trading capital
  newRiskPct: number; // risk this entry would add, % of trading capital
  openPositions: number;
  ordersNeeded: number; // every order the entry will place: the entry, the stop and each target
}

export interface EntryCheck {
  store: BotStore;
  config: BotConfig;
  nowMs: number;
  lastClockMs: number; // the newest time seen so far; a clock that went backwards blocks entries
  openRiskPct: number; // risk already open, % of trading capital
  newRiskPct: number; // risk this entry would add, % of trading capital
  openPositions: number;
  ordersNeeded: number; // every order the entry will place: the entry, the stop and each target
}

export type EntryLimit =
  | "invalid_input"
  | "clock_went_backwards"
  | "max_entries_per_day"
  | "max_orders_per_day"
  | "max_open_positions"
  | "max_positions_per_asset"
  | "max_risk_per_trade"
  | "max_total_open_risk";

// Whether a new entry may start, reading today's counters from the store.
export function entryAllowed(i: EntryCheck): { ok: true } | { ok: false; reason: EntryLimit } {
  const day = Number.isFinite(i.nowMs) ? tradingDay(i.nowMs, i.config.day_reset_utc_hour) : "";
  return checkEntryLimits({
    config: i.config, nowMs: i.nowMs, lastClockMs: i.lastClockMs, openRiskPct: i.openRiskPct, newRiskPct: i.newRiskPct,
    openPositions: i.openPositions, ordersNeeded: i.ordersNeeded,
    entriesToday: day ? i.store.getCounter(day, "entries") : 0, ordersToday: day ? i.store.getCounter(day, "orders") : 0,
  });
}

// The order budget is checked against the whole bundle (entry + stop + targets): the protective orders must never
// be the ones a limit blocks.
export function checkEntryLimits(i: EntryLimitsCheck): { ok: true } | { ok: false; reason: EntryLimit } {
  const { config } = i;
  const bad = (reason: EntryLimit) => ({ ok: false as const, reason });
  const numbersOk =
    Number.isFinite(i.nowMs) && Number.isFinite(i.lastClockMs) && Number.isFinite(i.openRiskPct) && i.openRiskPct >= 0 &&
    Number.isFinite(i.newRiskPct) && i.newRiskPct > 0 && Number.isInteger(i.openPositions) && i.openPositions >= 0 &&
    Number.isInteger(i.ordersNeeded) && i.ordersNeeded >= 0 && Number.isFinite(i.entriesToday) && Number.isFinite(i.ordersToday);
  if (!numbersOk) return bad("invalid_input");
  if (i.nowMs < i.lastClockMs) return bad("clock_went_backwards");

  if (i.entriesToday >= config.max_entries_per_day) return bad("max_entries_per_day");
  if (i.ordersToday + i.ordersNeeded > config.max_orders_per_day) return bad("max_orders_per_day");
  if (i.openPositions >= config.max_open_positions) return bad("max_open_positions");
  if (i.openPositions >= config.max_positions_per_asset) return bad("max_positions_per_asset");
  if (i.newRiskPct > config.max_risk_per_trade_pct + EPS) return bad("max_risk_per_trade");
  if (i.openRiskPct + i.newRiskPct > config.max_total_open_risk_pct + EPS) return bad("max_total_open_risk");
  return { ok: true };
}

// When the cooldown after a close ends. After a loss it is never shorter than after a normal close.
export function cooldownUntil(i: { closedAtMs: number; lossy: boolean; config: BotConfig }): number {
  const { config } = i;
  const minutes = i.lossy ? Math.max(config.cooldown_after_loss_min, config.cooldown_after_close_min) : config.cooldown_after_close_min;
  return i.closedAtMs + minutes * 60_000;
}

// True once today's net loss (realised + unrealised, after fees) reaches the daily limit. Numbers that cannot be
// evaluated count as breached: halting on garbage is the safe failure.
export function dailyLossBreached(i: { realized: number; unrealized: number; config: BotConfig }): boolean {
  const net = i.realized + i.unrealized;
  if (!Number.isFinite(net)) return true;
  const limitUsd = (i.config.trading_capital_usd * i.config.daily_loss_limit_pct) / 100;
  return -net >= limitUsd - EPS;
}

// Realised PnL of the fills since `sinceMs`, minus estimated fees. The same calculation serves dry-run and live,
// because live fills carry no fee field: maker or taker bps of the notional, and anything unknown (for example a
// liquidation) is charged the taker fee. Funding is not included. Fills with an unreadable time are ignored.
export function netRealizedSince(fills: FuturesFill[], sinceMs: number, config: BotConfig): number {
  let net = 0;
  for (const f of fills) {
    const t = Date.parse(f.fillTime);
    if (Number.isNaN(t) || t < sinceMs) continue;
    const bps = f.fillType === "maker" ? config.fees_bps.maker : config.fees_bps.taker;
    net += (f.realized_pnl ?? 0) - (f.size * f.price * bps) / 10_000;
  }
  return net;
}

// Raises the persisted counters to what the exchange's order history shows. It is a max, not an add: running it
// twice changes nothing, and a history window shorter than the day can never lower a count.
export function rebuildCounters(
  store: BotStore, config: BotConfig, history: { placedAtMs: number; isEntry: boolean }[],
): void {
  const perDay = new Map<string, { orders: number; entries: number }>();
  for (const h of history) {
    if (!Number.isFinite(h.placedAtMs)) continue;
    const day = tradingDay(h.placedAtMs, config.day_reset_utc_hour);
    const c = perDay.get(day) ?? { orders: 0, entries: 0 };
    c.orders++;
    if (h.isEntry) c.entries++;
    perDay.set(day, c);
  }
  store.transaction(() => {
    for (const [day, c] of perDay) {
      store.raiseCounter(day, "orders", c.orders);
      store.raiseCounter(day, "entries", c.entries);
    }
  });
}
