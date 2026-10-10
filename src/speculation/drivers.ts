// speculation/drivers.ts – scores the macro drivers of speculation reports (Nasdaq, US yields, the dollar, oil).
//
// A report stores the levels it was based on (`macro`), its view of each driver (`drivers`: what it expects and how
// much the call leans on it) and the BTC betas it assumed for altcoins (`betas`). After the window the scorer
// measures what each driver did (Yahoo 15m bars) and asks:
//  * did the driver do what the report expected?
//  * did it move the way the "risk" reading says, given what BTC did (Nasdaq up with BTC up; yields, dollar and oil up
//    with BTC down)?
//  * how much of BTC's session move does each driver account for (a one-factor fit through the origin over all scored
//    sessions: beta and R²)? The fits are univariate and the drivers are correlated, so the shares overlap and do not
//    add up; with fewer than MIN_FIT_N sessions only the alignment is shown.
// Pure functions; fetching the bars is in fetch.ts.

import { round3, wilson, type Interval } from "./stats.ts";
import type { Candle, DriverId, DriverMove, DriverOutcome, MoveResult, ReportLogEntry } from "./types.ts";

export interface DriverDef {
  id: DriverId;
  label: string;
  symbol: string; // Yahoo symbol (CME futures trade almost around the clock; yields only in Cboe hours)
  unit: "pct" | "bp";
  deadZone: number; // moves smaller than this (in `unit`) count as flat
  riskSign: 1 | -1; // +1: a rise is risk-on (Nasdaq); -1: a rise is risk-off (yields, dollar, oil)
}

export const DRIVERS: DriverDef[] = [
  { id: "nasdaq", label: "Nasdaq (NQ=F)", symbol: "NQ=F", unit: "pct", deadZone: 0.15, riskSign: 1 },
  { id: "yields", label: "US 10y yield (^TNX)", symbol: "^TNX", unit: "bp", deadZone: 1.5, riskSign: -1 },
  { id: "dollar", label: "Dollar index (DX-Y.NYB)", symbol: "DX-Y.NYB", unit: "pct", deadZone: 0.1, riskSign: -1 },
  { id: "oil", label: "WTI oil (CL=F)", symbol: "CL=F", unit: "pct", deadZone: 0.5, riskSign: -1 },
];
export const DRIVER_SYMBOLS = DRIVERS.map((d) => d.symbol);

export const MIN_FIT_N = 8; // sessions needed before a beta / R² is shown
const BAR_SEC = 900; // the driver bars are 15m
const COVER_SEC = 30 * 60; // bars starting later / ending earlier than this at either end make the move "partial"
const MIN_COVER = 0.5; // the bars must cover at least half of the window

const resultOf = (move: number, deadZone: number): MoveResult => (Math.abs(move) < deadZone ? "flat" : move > 0 ? "up" : "down");
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// What one driver did between the start and the end of a window; undefined when the bars do not cover it
// (for example yields outside Cboe hours).
export function driverMove(def: DriverDef, barsIn: Candle[], window: [number, number]): Pick<DriverMove, "open" | "close" | "move" | "result" | "partial"> | undefined {
  const [start, end] = window;
  const bars = barsIn.filter((c) => c.t >= start && c.t < end).sort((a, b) => a.t - b.t);
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last || (last.t + BAR_SEC - first.t) / (end - start) < MIN_COVER) return undefined;
  const move = def.unit === "pct" ? (last.c / first.o - 1) * 100 : (last.c - first.o) * 100;
  const partial = first.t - start > COVER_SEC || end - (last.t + BAR_SEC) > COVER_SEC;
  return { open: first.o, close: last.c, move: round3(move), result: resultOf(move, def.deadZone), ...(partial ? { partial: true } : {}) };
}

// The drivers' moves over a report's window, set against the leader's (BTC) move and the report's own view.
// Needs the bias outcome (the leader's move) and bars of at least one driver.
export function resolveDrivers(entry: ReportLogEntry, bars: Record<string, Candle[]>): DriverOutcome | undefined {
  const head = entry.outcome?.headline;
  if (!head) return undefined;
  const lead = entry.outcome!.symbols.find((s) => s.symbol === head.symbol);
  if (!lead) return undefined;
  const window: [number, number] = [Date.parse(entry.window[0]) / 1000, Date.parse(entry.window[1]) / 1000];
  const out: DriverOutcome = { leader: { symbol: lead.symbol, movePct: lead.movePct, result: lead.result }, drivers: [] };
  for (const def of DRIVERS) {
    const m = driverMove(def, bars[def.symbol] ?? [], window);
    if (!m) continue;
    const dm: DriverMove = { driver: def.id, symbol: def.symbol, unit: def.unit, ...m };
    const view = entry.drivers?.find((v) => v.driver === def.id);
    if (view) {
      dm.expected = view.expect;
      dm.expectedCorrect = view.expect === m.result;
    }
    if (m.result !== "flat" && lead.result !== "flat") dm.aligned = sgn(def.riskSign * m.move) === sgn(lead.movePct);
    out.drivers.push(dm);
  }
  if (!out.drivers.length) return undefined;
  const nq = out.drivers.find((d) => d.driver === "nasdaq");
  const dir = entry.bias.direction;
  out.biasVsNasdaq = nq && nq.result !== "flat" && dir !== "neutral" ? ((dir === "long") === (nq.result === "up") ? "agreed" : "disagreed") : "n/a";
  return out;
}

// Adds `driverOutcome` to every finished report that has a bias outcome and driver bars covering its window.
export function scoreDrivers(entries: ReportLogEntry[], bars: Record<string, Candle[]>, nowSec: number): { entries: ReportLogEntry[]; scored: string[] } {
  const scored: string[] = [];
  const out = entries.map((e) => {
    if (e.driverOutcome || Date.parse(e.window[1]) / 1000 > nowSec) return e;
    const driverOutcome = resolveDrivers(e, bars);
    if (!driverOutcome) return e;
    scored.push(e.report);
    return { ...e, driverOutcome };
  });
  return { entries: out, scored };
}

// ---- statistics over all scored sessions ----

export interface DriverStat {
  driver: DriverId;
  label: string;
  unit: "pct" | "bp";
  n: number; // sessions with the driver's move and the leader's move
  pairs: number; // of those, sessions where both moved (neither flat)
  aligned: number;
  alignedRate?: number;
  alignedCI?: Interval;
  beta?: number; // leader % move per 1 unit of driver move (per 1% or per 1 bp), through the origin; only with n >= MIN_FIT_N
  r2?: number; // share of the squared leader moves the driver alone accounts for
  viewStated: number;
  viewRight: number;
}

export interface AltBetaStat {
  symbol: string;
  n: number;
  realized?: number; // % move of the symbol per 1% move of BTC, through the origin; only with n >= MIN_FIT_N
  assumed?: number; // mean beta the reports assumed
  assumedN: number;
}

export interface DriverStats {
  sessions: number;
  drivers: DriverStat[];
  alts: AltBetaStat[];
  biasVsNasdaq: { agreed: number; agreedRight: number; disagreed: number; disagreedRight: number };
}

// One-factor fit through the origin: y = beta * x.
function fit(xs: number[], ys: number[]): { beta: number; r2: number } | undefined {
  const sxx = xs.reduce((a, x) => a + x * x, 0);
  const syy = ys.reduce((a, y) => a + y * y, 0);
  const sxy = xs.reduce((a, x, i) => a + x * ys[i]!, 0);
  if (sxx === 0 || syy === 0) return undefined;
  return { beta: round3(sxy / sxx), r2: round3((sxy * sxy) / (sxx * syy)) };
}

export function driverStats(entries: ReportLogEntry[]): DriverStats {
  const scored = entries.filter((e) => e.driverOutcome?.leader);
  const drivers: DriverStat[] = DRIVERS.map((def) => {
    const rows = scored.flatMap((e) => {
      const m = e.driverOutcome!.drivers.find((d) => d.driver === def.id);
      return m ? [{ m, lead: e.driverOutcome!.leader! }] : [];
    });
    const both = rows.filter((r) => r.m.aligned !== undefined);
    const aligned = both.filter((r) => r.m.aligned).length;
    const st: DriverStat = {
      driver: def.id, label: def.label, unit: def.unit, n: rows.length, pairs: both.length, aligned,
      viewStated: rows.filter((r) => r.m.expected !== undefined).length,
      viewRight: rows.filter((r) => r.m.expectedCorrect).length,
    };
    if (both.length) {
      st.alignedRate = round3(aligned / both.length);
      const ci = wilson(aligned, both.length);
      if (ci) st.alignedCI = ci;
    }
    if (rows.length >= MIN_FIT_N) {
      const f = fit(rows.map((r) => r.m.move), rows.map((r) => r.lead.movePct));
      if (f) {
        st.beta = f.beta;
        st.r2 = f.r2;
      }
    }
    return st;
  });

  const symbols = new Set(scored.flatMap((e) => e.outcome?.symbols.map((s) => s.symbol) ?? []));
  symbols.delete("BTC");
  const alts: AltBetaStat[] = [...symbols].sort().map((symbol) => {
    const rows = scored.flatMap((e) => {
      const btc = e.outcome?.symbols.find((s) => s.symbol === "BTC");
      const alt = e.outcome?.symbols.find((s) => s.symbol === symbol);
      return btc && alt ? [{ x: btc.movePct, y: alt.movePct, assumed: e.betas?.[symbol] }] : [];
    });
    const assumed = rows.flatMap((r) => (r.assumed === undefined ? [] : [r.assumed]));
    const st: AltBetaStat = { symbol, n: rows.length, assumedN: assumed.length };
    if (rows.length >= MIN_FIT_N) {
      const f = fit(rows.map((r) => r.x), rows.map((r) => r.y));
      if (f) st.realized = f.beta;
    }
    if (assumed.length) st.assumed = round3(assumed.reduce((a, b) => a + b, 0) / assumed.length);
    return st;
  });

  const vs = { agreed: 0, agreedRight: 0, disagreed: 0, disagreedRight: 0 };
  for (const e of scored) {
    const k = e.driverOutcome!.biasVsNasdaq;
    const right = e.outcome?.headline?.correct === true;
    if (k === "agreed") {
      vs.agreed++;
      if (right) vs.agreedRight++;
    } else if (k === "disagreed") {
      vs.disagreed++;
      if (right) vs.disagreedRight++;
    }
  }
  return { sessions: scored.length, drivers, alts, biasVsNasdaq: vs };
}

// ---- Markdown ----

const pct = (x: number | undefined) => (x === undefined ? "-" : `${Math.round(x * 100)}%`);
const ci = (i: Interval | undefined) => (i ? ` [${pct(i.lo)}, ${pct(i.hi)}]` : "");
const signed = (x: number, digits = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;
const unitText = (d: { unit: "pct" | "bp" }) => (d.unit === "pct" ? "%" : " bp");

export function renderDrivers(entries: ReportLogEntry[]): string[] {
  const st = driverStats(entries);
  if (!st.sessions) return ["### Macro drivers", "", "No session has driver data yet (needs a scored bias and Yahoo 15m bars of the window).", ""];
  const lines = [
    `### Macro drivers (BTC session move against each driver, ${st.sessions} sessions)`,
    "",
    "| Driver | N | Moved the risk-way with BTC [95%] | Beta (BTC % per unit) | Share of BTC move (R²) | Report's view right |",
    "|---|---|---|---|---|---|",
  ];
  for (const d of st.drivers) {
    const beta = d.beta === undefined ? `- (N<${MIN_FIT_N})` : `${signed(d.beta)} per 1${unitText(d)}`;
    lines.push(`| ${d.label} | ${d.n} | ${d.aligned}/${d.pairs} = ${pct(d.alignedRate)}${ci(d.alignedCI)} | ${beta} | ${d.r2 === undefined ? "-" : pct(d.r2)} | ${d.viewRight}/${d.viewStated} |`);
  }
  const v = st.biasVsNasdaq;
  lines.push(
    "",
    `Headline call against Nasdaq's direction: agreed with it ${v.agreedRight}/${v.agreed} right, disagreed with it ${v.disagreedRight}/${v.disagreed} right.`,
    "",
    `_Aligned = the driver moved the way the risk reading says for BTC's move (Nasdaq up with BTC up; yields, dollar and oil up with BTC down), skipping sessions where either was flat. Beta and R² are one-factor fits through the origin over ${st.sessions} sessions and overlap between drivers (they do not add up). Under ${MIN_FIT_N} sessions no fit is shown, and under 30 nothing here is a conclusion. A * marks a move measured over part of the window (the 10y trades only in Cboe hours)._`,
    "",
  );

  const alts = st.alts.filter((a) => a.n > 0);
  if (alts.length) {
    lines.push("### Altcoin beta to BTC", "", "| Symbol | N | Realized beta | Assumed by the reports (N) |", "|---|---|---|---|");
    for (const a of alts) lines.push(`| ${a.symbol} | ${a.n} | ${a.realized === undefined ? `- (N<${MIN_FIT_N})` : a.realized.toFixed(2)} | ${a.assumed === undefined ? "-" : a.assumed.toFixed(2)} (${a.assumedN}) |`);
    lines.push("");
  }

  const recent = entries.filter((e) => e.driverOutcome?.leader).sort((a, b) => b.window[0].localeCompare(a.window[0])).slice(0, 8);
  lines.push("### Last sessions", "", "| Session | BTC | Nasdaq | 10y | Dollar | Oil | Call | Largest implied driver |", "|---|---|---|---|---|---|---|---|");
  const betas = new Map(st.drivers.filter((d) => d.beta !== undefined).map((d) => [d.driver, d.beta!]));
  for (const e of recent) {
    const o = e.driverOutcome!;
    const cell = (id: DriverId) => {
      const m = o.drivers.find((d) => d.driver === id);
      return m ? `${signed(m.move)}${unitText(m)}${m.partial ? "*" : ""}` : "n/a";
    };
    let main = "-";
    let best = 0;
    for (const m of o.drivers) {
      const b = betas.get(m.driver);
      if (b !== undefined && Math.abs(b * m.move) > best) {
        best = Math.abs(b * m.move);
        main = `${m.driver} (${signed(b * m.move)}% of BTC)`;
      }
    }
    const call = e.outcome?.headline ? `${e.bias.direction} ${e.outcome.headline.correct ? "right" : "wrong"}` : e.bias.direction;
    lines.push(`| ${e.window[0].slice(0, 16)}Z | ${signed(o.leader!.movePct)}% | ${cell("nasdaq")} | ${cell("yields")} | ${cell("dollar")} | ${cell("oil")} | ${call} | ${main} |`);
  }
  lines.push("");
  return lines;
}
