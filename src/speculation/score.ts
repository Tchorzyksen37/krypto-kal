// speculation/score.ts – scores speculation bets after the fact. Pure core plus a CLI:
//   node src/speculation/score.ts <output/speculation dir> <input.json> [YYYY-MM-DD]
// input.json = { fills: [...], candles: { "PF_XRPUSD": [...] }, nowSec?: number } as returned by the Kraken
// Futures tools. The CLI resolves every finished bet, matches fills to bets automatically, updates
// bets-log.json and writes <day>/_day.md and _scorecard.md.
//
// Two separate questions are answered:
//  * hypothetical outcome (from 1m candles, for EVERY bet): was the speculation right?
//  * actual outcome (from the user's fills, for bets they took): how did the execution go?

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDrivers, scoreDrivers } from "./drivers.ts";
import { wilson, type Interval } from "./stats.ts";
import type { Actual, Bet, BiasOutcome, Candle, ExitReason, Fill, Hypothetical, LoggedBet, MoveResult, ReportLogEntry } from "./types.ts";

export { wilson, type Interval };

const CANDLE_SEC = 60;
const EPS = 1e-9;

export interface ScoreOptions {
  makerFeeBps: number; // one-way fee of a resting (maker) fill: limit entries and take-profit limits
  takerFeeBps: number; // one-way fee of an aggressive (taker) fill: stops and market closes
  matchTolerance: number; // fraction of price
  exitGraceMs: number; // slack after TTL for a manual close
}

// Kraken Futures base-tier fees (0.02% maker, 0.05% taker). The fills API has no fee amount, only the fill type.
export const DEFAULT_SCORE: ScoreOptions = { makerFeeBps: 2, takerFeeBps: 5, matchTolerance: 0.003, exitGraceMs: 5 * 60_000 };

const riskOf = (b: Bet) => Math.abs(b.entry - b.stop_loss);
const rOf = (b: Bet, entry: number, exit: number) => ((b.side === "long" ? exit - entry : entry - exit) / riskOf(b));
// Fees of both legs in units of the bet's risk.
const feeR = (b: Bet, entry: number, entryBps: number, exit: number, exitBps: number) => (entry * entryBps + exit * exitBps) / 10_000 / riskOf(b);
const isMaker = (fillType: string | undefined) => /^maker/i.test(fillType ?? "");
const feeBpsOf = (fillType: string | undefined, o: ScoreOptions) => (isMaker(fillType) ? o.makerFeeBps : o.takerFeeBps);

// ---- hypothetical outcome ----

// Walks 1m candles. The entry is a limit order: filled when price trades to it before the deadline.
// Conservative intrabar rules: in the touch candle only the stop can trigger (the take-profit extreme may
// have happened before the touch); in any later candle a stop and a take-profit in the same bar count as a stop.
// Fees: the limit entry and a take-profit limit are maker fills; a stop or a close at the time limit is taker.
export function resolveBet(bet: Bet, candlesIn: Candle[], options: Partial<ScoreOptions> = {}): Hypothetical {
  const o = { ...DEFAULT_SCORE, ...options };
  const candles = [...candlesIn].sort((a, b) => a.t - b.t);
  const fillFrom = Date.parse(bet.fill_from) / 1000;
  const deadline = Date.parse(bet.entry_deadline) / 1000;
  const long = bet.side === "long";
  const slHit = (c: Candle) => (long ? c.l <= bet.stop_loss : c.h >= bet.stop_loss);
  const tpHit = (c: Candle) => (long ? c.h >= bet.take_profit : c.l <= bet.take_profit);
  const touches = (c: Candle) => (long ? c.l <= bet.entry : c.h >= bet.entry);

  const window = candles.filter((c) => c.t >= fillFrom);
  const touchIdx = window.findIndex((c) => c.t < deadline && touches(c));
  if (touchIdx < 0) {
    const last = window[window.length - 1];
    const coveredUntil = last ? last.t + CANDLE_SEC : fillFrom;
    return { status: coveredUntil >= deadline ? "not_touched" : "open" };
  }

  const touch = window[touchIdx]!;
  const expiry = touch.t + bet.ttl_minutes * 60;
  const done = (status: "tp" | "sl" | "ttl", exitAt: number, exitPrice: number): Hypothetical => {
    const r = rOf(bet, bet.entry, exitPrice);
    const exitBps = status === "tp" ? o.makerFeeBps : o.takerFeeBps;
    return { status, touchedAt: touch.t, exitAt, exitPrice, r: round(r), netR: round(r - feeR(bet, bet.entry, o.makerFeeBps, exitPrice, exitBps)) };
  };

  if (slHit(touch)) return done("sl", touch.t, bet.stop_loss);
  let lastSeen = touch;
  for (const c of window.slice(touchIdx + 1)) {
    if (c.t >= expiry) break;
    if (slHit(c)) return done("sl", c.t, bet.stop_loss); // stop wins a same-bar tie
    if (tpHit(c)) return done("tp", c.t, bet.take_profit);
    lastSeen = c;
  }
  if (lastSeen.t + CANDLE_SEC >= expiry) return done("ttl", expiry, lastSeen.c);
  return { status: "open", touchedAt: touch.t };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

// ---- fills: grouping and matching ----

// Partial fills of one order become a single volume-weighted fill.
export function groupFills(fills: Fill[]): Fill[] {
  const groups = new Map<string, Fill[]>();
  const out: Fill[] = [];
  for (const f of fills) {
    if (!f.orderId) {
      out.push(f);
      continue;
    }
    const g = groups.get(f.orderId) ?? [];
    g.push(f);
    groups.set(f.orderId, g);
  }
  for (const [orderId, g] of groups) {
    const size = g.reduce((s, f) => s + f.size, 0);
    const first = g.reduce((a, f) => (f.ts < a.ts ? f : a));
    out.push({
      id: g.map((f) => f.id).join("+"),
      orderId,
      ...(g.some((f) => f.fillType) ? { fillType: g.every((f) => isMaker(f.fillType)) ? "maker" : "taker" } : {}),
      symbol: first.symbol,
      side: first.side,
      size,
      price: g.reduce((s, f) => s + f.price * f.size, 0) / size,
      ts: first.ts,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface Match {
  betId: string;
  entry: Fill;
  exit?: Fill;
}

export interface MatchResult {
  matches: Match[];
  unmatchedFills: Fill[]; // fills that belong to no bet ("not from a report")
  ambiguous: string[]; // bet ids whose entry fill also fits another bet equally well; never guessed
}

export function matchFills(bets: Bet[], fillsIn: Fill[], options: Partial<ScoreOptions> = {}): MatchResult {
  const o = { ...DEFAULT_SCORE, ...options };
  const fills = groupFills(fillsIn);
  const dist = (b: Bet, f: Fill) => Math.abs(f.price - b.entry) / b.entry;
  const eligible = (b: Bet, f: Fill) =>
    f.symbol === b.futures &&
    f.side === (b.side === "long" ? "buy" : "sell") &&
    f.ts >= Date.parse(b.fill_from) &&
    f.ts <= Date.parse(b.entry_deadline) + 60_000 &&
    dist(b, f) <= o.matchTolerance;

  const ambiguous = new Set<string>();
  const skipFill = new Set<string>();
  for (const f of fills) {
    const fits = bets.filter((b) => eligible(b, f)).sort((a, b) => dist(a, f) - dist(b, f));
    if (fits.length >= 2 && dist(fits[1]!, f) - dist(fits[0]!, f) < 1e-6) {
      skipFill.add(f.id);
      for (const b of fits) ambiguous.add(b.id);
    }
  }

  const pairs: { bet: Bet; fill: Fill; d: number }[] = [];
  for (const b of bets) for (const f of fills) if (!skipFill.has(f.id) && eligible(b, f)) pairs.push({ bet: b, fill: f, d: dist(b, f) });
  pairs.sort((a, b) => a.d - b.d || a.fill.ts - b.fill.ts);

  const usedBets = new Set<string>();
  const usedFills = new Set<string>();
  const matches: Match[] = [];
  for (const p of pairs) {
    if (usedBets.has(p.bet.id) || usedFills.has(p.fill.id)) continue;
    usedBets.add(p.bet.id);
    usedFills.add(p.fill.id);
    matches.push({ betId: p.bet.id, entry: p.fill });
  }

  // Exit: the earliest opposite-side fill on the same contract after the entry, within TTL plus grace.
  for (const m of matches) {
    const bet = bets.find((b) => b.id === m.betId)!;
    const limit = m.entry.ts + bet.ttl_minutes * 60_000 + o.exitGraceMs;
    const exit = fills.find(
      (f) => !usedFills.has(f.id) && f.symbol === bet.futures && f.side !== m.entry.side && f.ts > m.entry.ts && f.ts <= limit,
    );
    if (exit) {
      m.exit = exit;
      usedFills.add(exit.id);
    }
  }
  return { matches, unmatchedFills: fills.filter((f) => !usedFills.has(f.id)), ambiguous: [...ambiguous] };
}

export function actualOutcome(bet: Bet, m: Match, options: Partial<ScoreOptions> = {}): Actual {
  const o = { ...DEFAULT_SCORE, ...options };
  const long = bet.side === "long";
  const a: Actual = {
    entryFill: m.entry.price,
    entryAt: m.entry.ts,
    entryFillId: m.entry.id,
    slippagePct: round(((long ? m.entry.price - bet.entry : bet.entry - m.entry.price) / bet.entry) * 100),
    size: m.entry.size,
  };
  if (m.exit) {
    const near = (p: number) => Math.abs(m.exit!.price - p) / p <= o.matchTolerance;
    const reason: ExitReason = near(bet.take_profit) ? "tp" : near(bet.stop_loss) ? "sl" : m.exit.ts >= m.entry.ts + bet.ttl_minutes * 60_000 - o.exitGraceMs ? "ttl" : "other";
    a.exitFill = m.exit.price;
    a.exitAt = m.exit.ts;
    a.exitFillId = m.exit.id;
    a.exitReason = reason;
    // Unknown fill type counts as taker (the dearer case).
    const fr = feeR(bet, m.entry.price, feeBpsOf(m.entry.fillType, o), m.exit.price, feeBpsOf(m.exit.fillType, o));
    a.feeR = round(fr);
    a.netR = round(rOf(bet, m.entry.price, m.exit.price) - fr);
  }
  return a;
}

// ---- statistics ----

export interface Stats {
  bets: number; // bets with a final hypothetical outcome
  touched: number;
  notTouched: number;
  wins: number; // touched bets with net R > 0 (profitable, including profitable time-outs)
  winRate?: number;
  tp: number; // touched bets that reached their take profit: the event the stated probability is about
  tpRate?: number;
  tpRateCI?: Interval; // 95% Wilson interval
  meanStated?: number; // mean stated probability of the touched bets
  meanChance?: number; // mean chance baseline of the touched bets
  brier?: number; // mean (stated P - hit)^2; lower is better
  brierChance?: number; // the same with the chance baseline as the forecast
  skill?: number; // 1 - brier / brierChance: > 0 means the stated P beat chance
  meanNetR?: number;
  meanNetRCI?: Interval; // 95%, normal approximation
  taken: number;
  takenClosed: number;
  takenMeanNetR?: number;
}

const mean = (xs: number[]) => (xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length) : undefined);

// Chance baseline: in a market without drift, price hits a level `risk` away before one `reward` away with
// probability reward/(risk+reward), so the take profit comes first with probability risk/(risk+reward) = 1/(1+RR).
// Time-outs lower both; this is the bar a stated probability has to clear to claim any edge.
export const chanceOfTp = (b: Bet) => 1 / (1 + Math.abs(b.take_profit - b.entry) / riskOf(b));

// 95% interval of a mean (normal approximation; needs at least 2 values).
export function meanCI(xs: number[], z = 1.96): Interval | undefined {
  if (xs.length < 2) return undefined;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  const h = (z * sd) / Math.sqrt(xs.length);
  return { lo: round(m - h), hi: round(m + h) };
}

const isTouched = (b: LoggedBet) => b.hypothetical !== undefined && ["tp", "sl", "ttl"].includes(b.hypothetical.status);

export function summarize(log: LoggedBet[]): Stats {
  const final = log.filter((b) => b.hypothetical && b.hypothetical.status !== "open");
  const touched = final.filter(isTouched);
  const rs = touched.map((b) => b.hypothetical!.netR ?? 0);
  const hits = touched.map((b) => (b.hypothetical!.status === "tp" ? 1 : 0));
  const closed = log.filter((b) => b.actual?.netR !== undefined);
  const s: Stats = {
    bets: final.length,
    touched: touched.length,
    notTouched: final.length - touched.length,
    wins: rs.filter((r) => r > 0).length,
    tp: hits.reduce<number>((a, h) => a + h, 0),
    taken: log.filter((b) => b.actual).length,
    takenClosed: closed.length,
  };
  if (touched.length) {
    s.winRate = round(s.wins / touched.length);
    s.tpRate = round(s.tp / touched.length);
    s.tpRateCI = wilson(s.tp, touched.length);
    s.meanStated = mean(touched.map((b) => b.probability));
    s.meanChance = mean(touched.map(chanceOfTp));
    const brier = touched.reduce((a, b, i) => a + (b.probability - hits[i]!) ** 2, 0) / touched.length;
    const brierChance = touched.reduce((a, b, i) => a + (chanceOfTp(b) - hits[i]!) ** 2, 0) / touched.length;
    s.brier = round(brier);
    s.brierChance = round(brierChance);
    if (brierChance > 0) s.skill = round(1 - brier / brierChance);
  }
  const m = mean(rs);
  if (m !== undefined) s.meanNetR = m;
  const ci = meanCI(rs);
  if (ci) s.meanNetRCI = ci;
  const tm = mean(closed.map((b) => b.actual!.netR!));
  if (tm !== undefined) s.takenMeanNetR = tm;
  return s;
}

export interface CalibrationBucket {
  range: string;
  n: number;
  stated?: number; // mean stated probability
  chance?: number; // mean chance baseline
  realized?: number; // fraction of touched bets that reached take profit
}

// Stated probability vs how often the take profit was actually reached, over touched bets only (the probability
// is conditional on the touch). The chance column is what a coin-flip market would have given these bets.
export function calibration(log: LoggedBet[], edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0001]): CalibrationBucket[] {
  const touched = log.filter(isTouched);
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]!;
    const inB = touched.filter((b) => b.probability >= lo - EPS && b.probability < hi);
    const bucket: CalibrationBucket = { range: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`, n: inB.length };
    if (inB.length) {
      bucket.stated = mean(inB.map((b) => b.probability));
      bucket.chance = mean(inB.map(chanceOfTp));
      bucket.realized = round(inB.filter((b) => b.hypothetical!.status === "tp").length / inB.length);
    }
    return bucket;
  });
}

// ---- bias: was the stated lean right over the session? ----

export const BIAS_DEAD_ZONE_ATR = 0.25; // a session move below 0.25 x 1h ATR x sqrt(hours) counts as flat

// Session move of each symbol from the first trade of the window to the last close before it ends. Undefined
// until the candles cover the whole window. The headline bias is judged on BTC (the market leader), or on the
// first symbol when BTC is not in the report.
export function resolveBias(entry: ReportLogEntry, candles: Record<string, Candle[]>): BiasOutcome | undefined {
  const start = Date.parse(entry.window[0]) / 1000;
  const end = Date.parse(entry.window[1]) / 1000;
  const hours = (end - start) / 3600;
  const symbols: BiasOutcome["symbols"] = [];
  for (const sym of entry.symbols) {
    const inWindow = (candles[sym.futures] ?? []).filter((c) => c.t >= start && c.t < end).sort((a, b) => a.t - b.t);
    const first = inWindow[0];
    const last = inWindow[inWindow.length - 1];
    if (!first || !last || last.t + 60 < end) return undefined; // not covered yet
    const deadZone = BIAS_DEAD_ZONE_ATR * sym.atr_1h * Math.sqrt(Math.max(1, hours));
    const move = last.c - first.o;
    const result: MoveResult = Math.abs(move) < deadZone ? "flat" : move > 0 ? "up" : "down";
    const out: BiasOutcome["symbols"][number] = {
      symbol: sym.symbol, open: first.o, close: last.c,
      movePct: round((move / first.o) * 100), deadZonePct: round((deadZone / first.o) * 100), result,
    };
    if (sym.bias) {
      out.lean = sym.bias;
      out.correct = leanCorrect(sym.bias, result);
    }
    symbols.push(out);
  }
  const lead = symbols.find((x) => x.symbol === "BTC") ?? symbols[0];
  if (!lead) return { symbols };
  return {
    symbols,
    headline: {
      symbol: lead.symbol, direction: entry.bias.direction,
      ...(entry.bias.probability !== undefined ? { probability: entry.bias.probability } : {}),
      result: lead.result, correct: leanCorrect(entry.bias.direction, lead.result),
    },
  };
}

const leanCorrect = (lean: string, result: MoveResult) => (lean === "long" ? result === "up" : lean === "short" ? result === "down" : result === "flat");

export interface BiasStats {
  reports: number; // scored reports
  directional: number; // headline calls that were LONG or SHORT
  correct: number;
  hitRate?: number;
  hitRateCI?: Interval;
  flatShare?: number; // share of scored sessions that ended flat (a directional call cannot win those)
  brier?: number; // directional calls with a probability: mean (p - correct)^2; 0.25 is a coin flip at 50%
  neutral: number;
  neutralCorrect: number;
  leans: number; // per-symbol LONG/SHORT leans
  leansCorrect: number;
}

export function biasStats(entries: ReportLogEntry[]): BiasStats {
  const scored = entries.filter((e) => e.outcome?.headline);
  const heads = scored.map((e) => e.outcome!.headline!);
  const dir = heads.filter((h) => h.direction !== "neutral");
  const neutral = heads.filter((h) => h.direction === "neutral");
  const withP = dir.filter((h) => h.probability !== undefined);
  const leans = scored.flatMap((e) => e.outcome!.symbols).filter((x) => x.lean === "long" || x.lean === "short");
  const st: BiasStats = {
    reports: scored.length, directional: dir.length, correct: dir.filter((h) => h.correct).length,
    neutral: neutral.length, neutralCorrect: neutral.filter((h) => h.correct).length,
    leans: leans.length, leansCorrect: leans.filter((x) => x.correct).length,
  };
  if (dir.length) {
    st.hitRate = round(st.correct / dir.length);
    st.hitRateCI = wilson(st.correct, dir.length);
  }
  if (heads.length) st.flatShare = round(heads.filter((h) => h.result === "flat").length / heads.length);
  if (withP.length) st.brier = round(withP.reduce((a, h) => a + (h.probability! - (h.correct ? 1 : 0)) ** 2, 0) / withP.length);
  return st;
}

export function scoreReports(entries: ReportLogEntry[], candles: Record<string, Candle[]>, nowSec: number): { entries: ReportLogEntry[]; scored: string[] } {
  const scored: string[] = [];
  const out = entries.map((e) => {
    if (e.outcome || Date.parse(e.window[1]) / 1000 > nowSec) return e;
    const outcome = resolveBias(e, candles);
    if (!outcome) return e;
    scored.push(e.report);
    return { ...e, outcome };
  });
  return { entries: out, scored };
}

export function renderBias(st: BiasStats): string[] {
  if (!st.reports) return ["### Bias", "", "No session has been scored yet.", ""];
  const chance = st.flatShare === undefined ? "-" : pct((1 - st.flatShare) / 2);
  return [
    "### Bias (headline call, judged on BTC)",
    "",
    "| Scored sessions | LONG/SHORT calls | Right [95%] | Chance | Flat sessions | Brier (0.25 = coin flip) | NEUTRAL right | Per-symbol leans right |",
    "|---|---|---|---|---|---|---|---|",
    `| ${st.reports} | ${st.directional} | ${pct(st.hitRate)}${ci(st.hitRateCI, pct)} | ${chance} | ${pct(st.flatShare)} | ${st.brier === undefined ? "-" : st.brier.toFixed(3)} | ${st.neutralCorrect}/${st.neutral} | ${st.leansCorrect}/${st.leans} |`,
    "",
    `_A session counts as flat when it moved less than ${BIAS_DEAD_ZONE_ATR} x 1h ATR x sqrt(hours); a LONG or SHORT call loses a flat session. Chance = (1 - flat share) / 2._`,
    "",
  ];
}

// ---- applying everything to a log ----

export interface ScoreInput {
  fills: Fill[];
  candles: Record<string, Candle[]>;
  drivers?: Record<string, Candle[]>; // Yahoo 15m bars of the macro drivers (see drivers.ts), keyed by Yahoo symbol
  nowSec: number;
}

export interface ScoreRun {
  log: LoggedBet[];
  resolved: string[];
  matched: string[];
  unmatchedFills: Fill[];
  ambiguous: string[];
  reportsScored?: string[]; // reports whose bias was scored in this run
  driversScored?: string[]; // reports whose macro drivers were scored in this run
}

export function scoreLog(logIn: LoggedBet[], input: ScoreInput, options: Partial<ScoreOptions> = {}): ScoreRun {
  const o = { ...DEFAULT_SCORE, ...options };
  const log = logIn.map((b) => ({ ...b }));
  const resolved: string[] = [];
  for (const b of log) {
    if (b.hypothetical && b.hypothetical.status !== "open") continue;
    const h = resolveBet(b, input.candles[b.futures] ?? [], o);
    b.hypothetical = h;
    if (h.status !== "open") resolved.push(b.id);
  }

  // Fills matched in an earlier run belong to their bet already; they are neither re-matched nor reported as stray.
  const used = new Set(log.flatMap((b) => [b.actual?.entryFillId, b.actual?.exitFillId]).filter(Boolean).flatMap((id) => id!.split("+")));
  const fresh = input.fills.filter((f) => !used.has(f.id));
  const finished = log.filter((b) => !b.actual && Date.parse(b.latest_close) / 1000 <= input.nowSec);
  const res = matchFills(finished, fresh, o);
  const matched: string[] = [];
  for (const m of res.matches) {
    const b = log.find((x) => x.id === m.betId)!;
    b.actual = actualOutcome(b, m, o);
    matched.push(b.id);
  }
  return { log, resolved, matched, unmatchedFills: res.unmatchedFills, ambiguous: res.ambiguous };
}

// ---- Markdown ----

const pct = (x: number | undefined) => (x === undefined ? "-" : `${Math.round(x * 100)}%`);
const rFmt = (x: number | undefined) => (x === undefined ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`);

const ci = (i: Interval | undefined, f: (x: number) => string) => (i ? ` [${f(i.lo)}, ${f(i.hi)}]` : "");

// One line that answers "is there an edge?": take-profit rate against the stated P and the chance baseline.
export function edgeLine(s: Stats): string {
  if (!s.touched) return "No touched bets yet: nothing to compare with chance.";
  const verdict =
    s.touched < 30 ? "too few bets to conclude anything"
      : s.tpRateCI && s.meanChance !== undefined && s.tpRateCI.lo > s.meanChance ? "take-profit rate is above chance (95%)"
      : s.tpRateCI && s.meanChance !== undefined && s.tpRateCI.hi < s.meanChance ? "take-profit rate is BELOW chance (95%)"
      : "not distinguishable from chance yet";
  return `Take profit reached ${pct(s.tpRate)}${ci(s.tpRateCI, pct)} of ${s.touched} touched bets; stated ${pct(s.meanStated)}, chance ${pct(s.meanChance)}. Brier skill vs chance ${s.skill === undefined ? "-" : `${s.skill >= 0 ? "+" : ""}${s.skill.toFixed(2)}`}: ${verdict}.`;
}

function statsTable(label: string, s: Stats): string[] {
  return [
    `### ${label}`,
    "",
    "| Bets | Entry touched | Never touched | TP rate [95%] | Stated P | Chance | Brier skill | Mean net R [95%] | Profitable | Taken by you | Your mean net R |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    `| ${s.bets} | ${s.touched} | ${s.notTouched} | ${pct(s.tpRate)}${ci(s.tpRateCI, pct)} (N=${s.touched}) | ${pct(s.meanStated)} | ${pct(s.meanChance)} | ${s.skill === undefined ? "-" : s.skill.toFixed(2)} | ${rFmt(s.meanNetR)}${ci(s.meanNetRCI, rFmt)} | ${pct(s.winRate)} | ${s.taken} | ${rFmt(s.takenMeanNetR)} (N=${s.takenClosed}) |`,
    "",
    `_${edgeLine(s)}_`,
    "",
  ];
}

const dayOf = (b: LoggedBet) => b.fill_from.slice(0, 10);

export function renderDay(log: LoggedBet[], day: string, run?: Pick<ScoreRun, "unmatchedFills" | "ambiguous">): string {
  const bets = log.filter((b) => dayOf(b) === day);
  const lines = [`# Speculation scorecard ${day}`, "", ...statsTable(`Day ${day}`, summarize(bets)), "### Bets", ""];
  if (bets.length === 0) lines.push("No bets issued this day.", "");
  else {
    lines.push("| Id | Side | Entry | Hypothetical | Net R | You took it | Exit | Net R (yours) | Slippage |", "|---|---|---|---|---|---|---|---|---|");
    for (const b of bets) {
      const h = b.hypothetical;
      lines.push(
        `| ${b.id} | ${b.side} | ${b.entry} | ${h ? h.status : "pending"} | ${rFmt(h?.netR)} | ${b.actual ? "yes" : "no"} | ${b.actual?.exitReason ?? "-"} | ${rFmt(b.actual?.netR)} | ${b.actual ? `${b.actual.slippagePct}%` : "-"} |`,
      );
    }
    lines.push("");
  }
  if (run && run.unmatchedFills.length) {
    lines.push("### Fills that belong to no report", "");
    for (const f of run.unmatchedFills) lines.push(`- ${new Date(f.ts).toISOString()} ${f.symbol} ${f.side} ${f.size} @ ${f.price}`);
    lines.push("");
  }
  if (run && run.ambiguous.length) lines.push("### Ambiguous matches (not assigned)", "", ...run.ambiguous.map((id) => `- ${id}`), "");
  return `${lines.join("\n")}\n`;
}

export function renderScorecard(log: LoggedBet[], nowSec: number, reports: ReportLogEntry[] = []): string {
  const weekAgo = nowSec - 7 * 86_400;
  const recent = log.filter((b) => Date.parse(b.fill_from) / 1000 >= weekAgo);
  const lines = [
    "# Speculation scorecard", "",
    ...statsTable("Last 7 days", summarize(recent)), ...statsTable("All time", summarize(log)),
    ...renderBias(biasStats(reports)),
    ...renderDrivers(reports),
  ];

  lines.push("### Calibration (touched bets)", "", "| Stated P | N | Mean stated | Chance | Take profit reached |", "|---|---|---|---|---|");
  for (const c of calibration(log)) lines.push(`| ${c.range} | ${c.n} | ${pct(c.stated)} | ${pct(c.chance)} | ${pct(c.realized)} |`);
  lines.push("");

  const groups: [string, (b: LoggedBet) => string][] = [
    ["Session", (b) => b.session ?? "(none)"],
    ["Symbol", (b) => b.symbol],
    ["Side", (b) => b.side],
    ["Vs bias", (b) => b.vs_bias ?? "(none)"],
  ];
  for (const [title, key] of groups) {
    lines.push(`### By ${title.toLowerCase()}`, "", `| ${title} | Touched | TP rate | Chance | Mean net R |`, "|---|---|---|---|---|");
    for (const k of [...new Set(log.map(key))].sort()) {
      const s = summarize(log.filter((b) => key(b) === k));
      lines.push(`| ${k} | ${s.touched} | ${pct(s.tpRate)} | ${pct(s.meanChance)} | ${rFmt(s.meanNetR)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---- input normalisation (accepts the tools' raw shapes) ----

export function normalizeFill(raw: Record<string, unknown>): Fill {
  const ts = typeof raw.ts === "number" ? raw.ts : Date.parse(String(raw.fillTime));
  const f: Fill = {
    id: String(raw.id ?? raw.fill_id),
    symbol: String(raw.symbol),
    side: raw.side === "sell" ? "sell" : "buy",
    size: Number(raw.size),
    price: Number(raw.price),
    ts,
  };
  const orderId = raw.orderId ?? raw.order_id;
  if (orderId) f.orderId = String(orderId);
  const fillType = raw.fillType ?? raw.fill_type;
  if (fillType) f.fillType = String(fillType);
  if (!Number.isFinite(f.ts) || !Number.isFinite(f.price) || !Number.isFinite(f.size)) throw new Error(`unreadable fill: ${JSON.stringify(raw)}`);
  return f;
}

export function normalizeCandle(raw: Record<string, unknown>): Candle {
  const t = Number(raw.t ?? raw.time);
  const c: Candle = { t: t > 1e11 ? Math.floor(t / 1000) : t, o: Number(raw.o ?? raw.open), h: Number(raw.h ?? raw.high), l: Number(raw.l ?? raw.low), c: Number(raw.c ?? raw.close) };
  if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)) throw new Error(`unreadable candle: ${JSON.stringify(raw)}`);
  return c;
}

export const readLog = async (dir: string): Promise<LoggedBet[]> => {
  const logPath = join(dir, "bets-log.json");
  return existsSync(logPath) ? (JSON.parse(await readFile(logPath, "utf8")) as LoggedBet[]) : [];
};

// Offline mode: candles and fills come from a JSON file (tests, or data gathered by hand).
export async function scoreFiles(dir: string, inputPath: string, day?: string, options: Partial<ScoreOptions> = {}): Promise<ScoreRun> {
  const raw = JSON.parse(await readFile(inputPath, "utf8")) as { fills?: Record<string, unknown>[]; candles?: Record<string, Record<string, unknown>[]>; nowSec?: number };
  const input: ScoreInput = {
    fills: (raw.fills ?? []).map(normalizeFill),
    candles: Object.fromEntries(Object.entries(raw.candles ?? {}).map(([k, v]) => [k, v.map(normalizeCandle)])),
    nowSec: raw.nowSec ?? Math.floor(Date.now() / 1000),
  };
  return scoreDir(dir, input, day, options);
}

// Scores the log in `dir` with `input` and writes the log, the day note and the scorecard.
export const readReports = async (dir: string): Promise<ReportLogEntry[]> => {
  const path = join(dir, "reports-log.json");
  return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as ReportLogEntry[]) : [];
};

export async function scoreDir(dir: string, input: ScoreInput, day?: string, options: Partial<ScoreOptions> = {}): Promise<ScoreRun> {
  const logPath = join(dir, "bets-log.json");
  const log = await readLog(dir);
  const run = scoreLog(log, input, options);
  const reports = scoreReports(await readReports(dir), input.candles, input.nowSec);
  run.reportsScored = reports.scored;
  const drivers = input.drivers ? scoreDrivers(reports.entries, input.drivers, input.nowSec) : { entries: reports.entries, scored: [] };
  run.driversScored = drivers.scored;
  if (drivers.entries.length) await writeFile(join(dir, "reports-log.json"), `${JSON.stringify(drivers.entries, null, 2)}\n`, "utf8");
  await writeFile(logPath, `${JSON.stringify(run.log, null, 2)}\n`, "utf8");
  const d = day ?? new Date(input.nowSec * 1000).toISOString().slice(0, 10);
  await mkdir(join(dir, d), { recursive: true });
  await writeFile(join(dir, d, "_day.md"), renderDay(run.log, d, run), "utf8");
  await writeFile(join(dir, "_scorecard.md"), renderScorecard(run.log, input.nowSec, drivers.entries), "utf8");
  return run;
}

export function scoreOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ScoreOptions> {
  const out: Partial<ScoreOptions> = {};
  const num = (k: string) => (env[k] && Number.isFinite(Number(env[k])) ? Number(env[k]) : undefined);
  const maker = num("SPECULATION_MAKER_FEE_BPS");
  const taker = num("SPECULATION_TAKER_FEE_BPS");
  if (maker !== undefined) out.makerFeeBps = maker;
  if (taker !== undefined) out.takerFeeBps = taker;
  if (env.SPECULATION_MATCH_TOLERANCE && Number.isFinite(Number(env.SPECULATION_MATCH_TOLERANCE))) out.matchTolerance = Number(env.SPECULATION_MATCH_TOLERANCE);
  return out;
}

// CLI:
//   node --env-file-if-exists=.env src/speculation/score.ts <output/speculation dir> [--day YYYY-MM-DD]
//       fetches futures candles (public) and your fills (KRAKEN_FUTURES_RO_API_KEY/_SECRET) itself;
//   node src/speculation/score.ts <output/speculation dir> --input <input.json> [--day YYYY-MM-DD]
//       uses candles and fills from a file instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = args[0];
  if (!dir || dir.startsWith("--")) {
    console.error("usage: node --env-file-if-exists=.env src/speculation/score.ts <output/speculation dir> [--input <input.json>] [--day YYYY-MM-DD]");
    process.exit(2);
  }
  try {
    const input = flag("--input");
    const day = flag("--day");
    let r: ScoreRun;
    if (input) r = await scoreFiles(dir, input, day, scoreOptionsFromEnv());
    else {
      const { liveInput } = await import("./fetch.ts");
      const live = await liveInput(await readLog(dir), Math.floor(Date.now() / 1000), process.env, await readReports(dir));
      for (const w of live.warnings) console.warn(`warning: ${w}`);
      r = await scoreDir(dir, live.input, day, scoreOptionsFromEnv());
    }
    console.log(`bias scored for ${r.reportsScored?.length ?? 0} report(s)`);
    console.log(`resolved ${r.resolved.length}, matched to your fills ${r.matched.length}, unmatched fills ${r.unmatchedFills.length}, ambiguous ${r.ambiguous.length}`);
    const s = summarize(r.log);
    console.log(`all time: ${s.bets} bets, ${s.touched} touched, win rate ${pct(s.winRate)} (N=${s.touched}), mean net R ${rFmt(s.meanNetR)}`);
  } catch (e) {
    console.error(`score failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
