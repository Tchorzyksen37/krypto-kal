// account-stats.ts – results of a Kraken Futures account from its account log: per UTC day, per instrument and in
// total, split into gross realized PnL, fees and funding, with the net taken from the booked balance change. Pure:
// the entries and the open positions are passed in.
//
// Reading of an entry (field meanings from Kraken's docs, unverified against a real account):
//   gross   = realized_pnl
//   fees    = |fee| + |liquidation_fee|                     (a cost, shown as a positive number)
//   funding = realized_funding; for a funding entry without it, the balance change
//   net     = new_balance - old_balance when both are given (what really happened to the account), else
//             gross - fees + funding
// An entry whose gross - fees + funding differs from its balance change by more than 0.01 is counted as a mismatch,
// so a wrong reading of a sign shows up on the page instead of hiding in the totals. Only USD-denominated entries are
// counted; other assets are listed. Transfers, conversions and other non-trading bookings are excluded.

import type { FuturesAccountLogEntry, FuturesPosition } from "../providers/kraken/kraken-futures-client.ts";

export type BookingKind = "trade" | "liquidation" | "funding" | "other";

export interface Booking {
  id: number;
  tMs: number;
  day: string; // UTC YYYY-MM-DD
  kind: BookingKind;
  instrument: string; // XRP, ETH, BTC, ... ("" when the entry names no contract)
  gross: number;
  fees: number;
  funding: number;
  net: number;
  closing: boolean; // a trade that realized PnL (it closed or reduced a position)
  mismatch: boolean;
}

export interface Totals {
  gross: number;
  fees: number;
  funding: number;
  net: number;
}

export interface InstrumentStats extends Totals {
  instrument: string;
  closing: number; // closing trades (the count shown next to the instrument)
  wins: number;
}

export interface DayStats extends Totals {
  day: string;
}

export interface OpenPosition {
  symbol: string;
  instrument: string;
  side: "long" | "short";
  size: number;
  entry: number;
  unrealizedPnl: number | undefined;
  unrealizedFunding: number | undefined;
}

export interface AccountStats {
  asOf: string;
  since: string | undefined; // the first booking: when the account log starts
  until: string | undefined;
  total: Totals & { closing: number; wins: number; losses: number; winRate: number | undefined; profitFactor: number | undefined };
  today: Totals & { day: string; byInstrument: InstrumentStats[] };
  byDay: DayStats[];
  byInstrument: InstrumentStats[];
  open: { positions: OpenPosition[]; unrealized: number; unrealizedFunding: number; available: boolean };
  quality: {
    entries: number;
    counted: number; // USD trade, liquidation and funding entries
    excluded: Record<string, number>; // info -> count, for bookings that are not trading results
    otherAssets: Record<string, number>; // asset -> count of trading entries not in USD (not converted)
    mismatches: number;
    mismatchIds: number[]; // the first few
  };
}

const finite = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : undefined);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const zero = (): Totals => ({ gross: 0, fees: 0, funding: 0, net: 0 });
const add = (t: Totals, b: Pick<Totals, keyof Totals>) => {
  t.gross += b.gross;
  t.fees += b.fees;
  t.funding += b.funding;
  t.net += b.net;
};

export function kindOf(info: string): BookingKind {
  const i = info.toLowerCase();
  if (i.includes("funding")) return "funding";
  if (i.includes("liquidation")) return "liquidation";
  if (i.includes("futures trade") || i.includes("assignor") || i.includes("assignee") || i.includes("unwind")) return "trade";
  return "other";
}

// pf_xrpusd -> XRP, pf_xbtusd -> BTC, fi_xbtusd_260327 -> BTC; anything else upper-cased as it is.
export function instrumentOf(contract: string | null | undefined): string {
  if (!contract) return "";
  const m = /^(?:pf|pi|fi|ff|fv)_([a-z0-9]+?)usd(?:_\d+)?$/i.exec(contract);
  if (!m) return contract.toUpperCase();
  const base = m[1]!.toUpperCase();
  return base === "XBT" ? "BTC" : base;
}

export function toBooking(e: FuturesAccountLogEntry): Booking | undefined {
  const tMs = Date.parse(e.date);
  if (!Number.isFinite(tMs)) return undefined;
  const kind = kindOf(e.info ?? "");
  const gross = finite(e.realized_pnl) ?? 0;
  const fees = Math.abs(finite(e.fee) ?? 0) + Math.abs(finite(e.liquidation_fee) ?? 0);
  const oldB = finite(e.old_balance);
  const newB = finite(e.new_balance);
  const delta = oldB !== undefined && newB !== undefined ? newB - oldB : undefined;
  const reportedFunding = finite(e.realized_funding);
  const funding = reportedFunding ?? (kind === "funding" && delta !== undefined ? delta : 0);
  const parts = gross - fees + funding;
  const net = delta ?? parts;
  return {
    id: e.id, tMs, day: utcDay(tMs), kind, instrument: instrumentOf(e.contract), gross, fees, funding, net,
    closing: (kind === "trade" || kind === "liquidation") && gross !== 0,
    mismatch: delta !== undefined && Math.abs(delta - parts) > Math.max(0.01, 1e-6 * Math.abs(delta)),
  };
}

export function accountStats(entries: FuturesAccountLogEntry[], positions: FuturesPosition[] | undefined, asOfMs: number): AccountStats {
  const quality: AccountStats["quality"] = { entries: entries.length, counted: 0, excluded: {}, otherAssets: {}, mismatches: 0, mismatchIds: [] };
  const bookings: Booking[] = [];
  for (const e of [...entries].sort((a, b) => a.id - b.id)) {
    const kind = kindOf(e.info ?? "");
    if (kind === "other") {
      const key = e.info || "unknown";
      quality.excluded[key] = (quality.excluded[key] ?? 0) + 1;
      continue;
    }
    const asset = (e.asset ?? "usd").toLowerCase();
    if (asset !== "usd") {
      quality.otherAssets[asset] = (quality.otherAssets[asset] ?? 0) + 1;
      continue;
    }
    const b = toBooking(e);
    if (!b) continue;
    bookings.push(b);
    quality.counted++;
    if (b.mismatch) {
      quality.mismatches++;
      if (quality.mismatchIds.length < 5) quality.mismatchIds.push(b.id);
    }
  }

  const total = { ...zero(), closing: 0, wins: 0, losses: 0, winRate: undefined as number | undefined, profitFactor: undefined as number | undefined };
  let won = 0;
  let lost = 0;
  const days = new Map<string, DayStats>();
  const instruments = new Map<string, InstrumentStats>();
  const today = utcDay(asOfMs);
  const todayTotals = zero();
  const todayInstruments = new Map<string, InstrumentStats>();
  const inst = (map: Map<string, InstrumentStats>, name: string) => {
    let s = map.get(name);
    if (!s) map.set(name, (s = { instrument: name || "account", ...zero(), closing: 0, wins: 0 }));
    return s;
  };
  for (const b of bookings) {
    add(total, b);
    const d = days.get(b.day) ?? { day: b.day, ...zero() };
    add(d, b);
    days.set(b.day, d);
    const s = inst(instruments, b.instrument);
    add(s, b);
    if (b.day === today) {
      add(todayTotals, b);
      add(inst(todayInstruments, b.instrument), b);
    }
    if (b.closing) {
      total.closing++;
      s.closing++;
      if (b.gross > 0) {
        total.wins++;
        s.wins++;
        won += b.gross;
      } else {
        total.losses++;
        lost -= b.gross;
      }
      if (b.day === today) {
        const t = inst(todayInstruments, b.instrument);
        t.closing++;
        if (b.gross > 0) t.wins++;
      }
    }
  }
  total.winRate = total.closing ? total.wins / total.closing : undefined;
  total.profitFactor = lost > 0 ? won / lost : undefined;

  const open: AccountStats["open"] = { positions: [], unrealized: 0, unrealizedFunding: 0, available: positions !== undefined };
  for (const p of positions ?? []) {
    const u = finite(p.unrealizedPnl);
    const f = finite(p.unrealizedFunding);
    open.positions.push({ symbol: p.symbol, instrument: instrumentOf(p.symbol), side: p.side, size: p.size, entry: p.price, unrealizedPnl: u, unrealizedFunding: f });
    open.unrealized += u ?? 0;
    open.unrealizedFunding += f ?? 0;
  }

  const byNet = (a: InstrumentStats, b: InstrumentStats) => b.net - a.net || a.instrument.localeCompare(b.instrument);
  return {
    asOf: new Date(asOfMs).toISOString(),
    since: bookings[0] ? new Date(bookings[0].tMs).toISOString() : undefined,
    until: bookings.length ? new Date(bookings[bookings.length - 1]!.tMs).toISOString() : undefined,
    total,
    today: { day: today, ...todayTotals, byInstrument: [...todayInstruments.values()].sort(byNet) },
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byInstrument: [...instruments.values()].sort(byNet),
    open,
    quality,
  };
}
