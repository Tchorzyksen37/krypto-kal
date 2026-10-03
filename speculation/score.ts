// speculation/score.ts – scores speculation bets after the fact. Pure core plus a CLI:
//   node speculation/score.ts <output/speculation dir> <input.json> [YYYY-MM-DD]
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
import type { Actual, Bet, Candle, ExitReason, Fill, Hypothetical, LoggedBet } from "./types.ts";

const CANDLE_SEC = 60;
const EPS = 1e-9;

export interface ScoreOptions {
  feeBps: number; // assumed one-way fee (the fills API has no fee field)
  matchTolerance: number; // fraction of price
  exitGraceMs: number; // slack after TTL for a manual close
}

export const DEFAULT_SCORE: ScoreOptions = { feeBps: 5, matchTolerance: 0.003, exitGraceMs: 5 * 60_000 };

const riskOf = (b: Bet) => Math.abs(b.entry - b.stop_loss);
const rOf = (b: Bet, entry: number, exit: number) => ((b.side === "long" ? exit - entry : entry - exit) / riskOf(b));
const feeR = (b: Bet, entry: number, feeBps: number) => (2 * feeBps * entry) / 10_000 / riskOf(b);

// ---- hypothetical outcome ----

// Walks 1m candles. The entry is a limit order: filled when price trades to it before the deadline.
// Conservative intrabar rules: in the touch candle only the stop can trigger (the take-profit extreme may
// have happened before the touch); in any later candle a stop and a take-profit in the same bar count as a stop.
export function resolveBet(bet: Bet, candlesIn: Candle[], feeBps = DEFAULT_SCORE.feeBps): Hypothetical {
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
    return { status, touchedAt: touch.t, exitAt, exitPrice, r: round(r), netR: round(r - feeR(bet, bet.entry, feeBps)) };
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
    slippagePct: round(((long ? m.entry.price - bet.entry : bet.entry - m.entry.price) / bet.entry) * 100),
    size: m.entry.size,
  };
  if (m.exit) {
    const near = (p: number) => Math.abs(m.exit!.price - p) / p <= o.matchTolerance;
    const reason: ExitReason = near(bet.take_profit) ? "tp" : near(bet.stop_loss) ? "sl" : m.exit.ts >= m.entry.ts + bet.ttl_minutes * 60_000 - o.exitGraceMs ? "ttl" : "other";
    a.exitFill = m.exit.price;
    a.exitAt = m.exit.ts;
    a.exitReason = reason;
    a.netR = round(rOf(bet, m.entry.price, m.exit.price) - feeR(bet, m.entry.price, o.feeBps));
  }
  return a;
}

// ---- statistics ----

export interface Stats {
  bets: number; // bets with a final hypothetical outcome
  touched: number;
  notTouched: number;
  wins: number; // touched bets with net R > 0
  winRate?: number;
  meanNetR?: number;
  taken: number;
  takenClosed: number;
  takenMeanNetR?: number;
}

const mean = (xs: number[]) => (xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length) : undefined);

export function summarize(log: LoggedBet[]): Stats {
  const final = log.filter((b) => b.hypothetical && b.hypothetical.status !== "open");
  const touched = final.filter((b) => b.hypothetical!.status !== "not_touched");
  const rs = touched.map((b) => b.hypothetical!.netR ?? 0);
  const closed = log.filter((b) => b.actual?.netR !== undefined);
  const s: Stats = {
    bets: final.length,
    touched: touched.length,
    notTouched: final.length - touched.length,
    wins: rs.filter((r) => r > 0).length,
    taken: log.filter((b) => b.actual).length,
    takenClosed: closed.length,
  };
  if (touched.length) s.winRate = round(s.wins / touched.length);
  const m = mean(rs);
  if (m !== undefined) s.meanNetR = m;
  const tm = mean(closed.map((b) => b.actual!.netR!));
  if (tm !== undefined) s.takenMeanNetR = tm;
  return s;
}

export interface CalibrationBucket {
  range: string;
  n: number;
  stated?: number; // mean stated probability
  realized?: number; // fraction of touched bets with net R > 0
}

// Stated probability vs realised win frequency, over touched bets only (the probability is conditional on the touch).
export function calibration(log: LoggedBet[], edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0001]): CalibrationBucket[] {
  const touched = log.filter((b) => b.hypothetical && ["tp", "sl", "ttl"].includes(b.hypothetical.status));
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]!;
    const inB = touched.filter((b) => b.probability >= lo - EPS && b.probability < hi);
    const bucket: CalibrationBucket = { range: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`, n: inB.length };
    if (inB.length) {
      bucket.stated = mean(inB.map((b) => b.probability));
      bucket.realized = round(inB.filter((b) => (b.hypothetical!.netR ?? 0) > 0).length / inB.length);
    }
    return bucket;
  });
}

// ---- applying everything to a log ----

export interface ScoreInput {
  fills: Fill[];
  candles: Record<string, Candle[]>;
  nowSec: number;
}

export interface ScoreRun {
  log: LoggedBet[];
  resolved: string[];
  matched: string[];
  unmatchedFills: Fill[];
  ambiguous: string[];
}

export function scoreLog(logIn: LoggedBet[], input: ScoreInput, options: Partial<ScoreOptions> = {}): ScoreRun {
  const o = { ...DEFAULT_SCORE, ...options };
  const log = logIn.map((b) => ({ ...b }));
  const resolved: string[] = [];
  for (const b of log) {
    if (b.hypothetical && b.hypothetical.status !== "open") continue;
    const h = resolveBet(b, input.candles[b.futures] ?? [], o.feeBps);
    b.hypothetical = h;
    if (h.status !== "open") resolved.push(b.id);
  }

  const finished = log.filter((b) => !b.actual && Date.parse(b.latest_close) / 1000 <= input.nowSec);
  const res = matchFills(finished, input.fills, o);
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

function statsTable(label: string, s: Stats): string[] {
  const note = s.touched < 30 ? " (too few bets to conclude anything)" : "";
  return [
    `### ${label}`,
    "",
    "| Bets | Entry touched | Never touched | Win rate | Mean net R | Taken by you | Your mean net R |",
    "|---|---|---|---|---|---|---|",
    `| ${s.bets} | ${s.touched} | ${s.notTouched} | ${pct(s.winRate)} (N=${s.touched}) | ${rFmt(s.meanNetR)} | ${s.taken} | ${rFmt(s.takenMeanNetR)} (N=${s.takenClosed}) |`,
    "",
    ...(note ? [`_${note.trim()}_`, ""] : []),
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

export function renderScorecard(log: LoggedBet[], nowSec: number): string {
  const weekAgo = nowSec - 7 * 86_400;
  const recent = log.filter((b) => Date.parse(b.fill_from) / 1000 >= weekAgo);
  const lines = ["# Speculation scorecard", "", ...statsTable("Last 7 days", summarize(recent)), ...statsTable("All time", summarize(log))];

  lines.push("### Calibration (touched bets)", "", "| Stated P | N | Mean stated | Realised win rate |", "|---|---|---|---|");
  for (const c of calibration(log)) lines.push(`| ${c.range} | ${c.n} | ${pct(c.stated)} | ${pct(c.realized)} |`);
  lines.push("");

  for (const [title, key] of [["Symbol", (b: LoggedBet) => b.symbol], ["Side", (b: LoggedBet) => b.side]] as const) {
    lines.push(`### By ${title.toLowerCase()}`, "", `| ${title} | Touched | Win rate | Mean net R |`, "|---|---|---|---|");
    for (const k of [...new Set(log.map(key))].sort()) {
      const s = summarize(log.filter((b) => key(b) === k));
      lines.push(`| ${k} | ${s.touched} | ${pct(s.winRate)} | ${rFmt(s.meanNetR)} |`);
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
  if (!Number.isFinite(f.ts) || !Number.isFinite(f.price) || !Number.isFinite(f.size)) throw new Error(`unreadable fill: ${JSON.stringify(raw)}`);
  return f;
}

export function normalizeCandle(raw: Record<string, unknown>): Candle {
  const t = Number(raw.t ?? raw.time);
  const c: Candle = { t: t > 1e11 ? Math.floor(t / 1000) : t, o: Number(raw.o ?? raw.open), h: Number(raw.h ?? raw.high), l: Number(raw.l ?? raw.low), c: Number(raw.c ?? raw.close) };
  if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)) throw new Error(`unreadable candle: ${JSON.stringify(raw)}`);
  return c;
}

export async function scoreFiles(dir: string, inputPath: string, day?: string, options: Partial<ScoreOptions> = {}): Promise<ScoreRun> {
  const raw = JSON.parse(await readFile(inputPath, "utf8")) as { fills?: Record<string, unknown>[]; candles?: Record<string, Record<string, unknown>[]>; nowSec?: number };
  const input: ScoreInput = {
    fills: (raw.fills ?? []).map(normalizeFill),
    candles: Object.fromEntries(Object.entries(raw.candles ?? {}).map(([k, v]) => [k, v.map(normalizeCandle)])),
    nowSec: raw.nowSec ?? Math.floor(Date.now() / 1000),
  };
  const logPath = join(dir, "bets-log.json");
  const log: LoggedBet[] = existsSync(logPath) ? (JSON.parse(await readFile(logPath, "utf8")) as LoggedBet[]) : [];
  const run = scoreLog(log, input, options);
  await writeFile(logPath, `${JSON.stringify(run.log, null, 2)}\n`, "utf8");
  const d = day ?? new Date(input.nowSec * 1000).toISOString().slice(0, 10);
  await mkdir(join(dir, d), { recursive: true });
  await writeFile(join(dir, d, "_day.md"), renderDay(run.log, d, run), "utf8");
  await writeFile(join(dir, "_scorecard.md"), renderScorecard(run.log, input.nowSec), "utf8");
  return run;
}

export function scoreOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ScoreOptions> {
  const out: Partial<ScoreOptions> = {};
  if (env.SPECULATION_FEE_BPS && Number.isFinite(Number(env.SPECULATION_FEE_BPS))) out.feeBps = Number(env.SPECULATION_FEE_BPS);
  if (env.SPECULATION_MATCH_TOLERANCE && Number.isFinite(Number(env.SPECULATION_MATCH_TOLERANCE))) out.matchTolerance = Number(env.SPECULATION_MATCH_TOLERANCE);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, input, day] = process.argv.slice(2);
  if (!dir || !input) {
    console.error("usage: node speculation/score.ts <output/speculation dir> <input.json> [YYYY-MM-DD]");
    process.exit(2);
  }
  try {
    const r = await scoreFiles(dir, input, day, scoreOptionsFromEnv());
    console.log(`resolved ${r.resolved.length}, matched to your fills ${r.matched.length}, unmatched fills ${r.unmatchedFills.length}, ambiguous ${r.ambiguous.length}`);
    const s = summarize(r.log);
    console.log(`all time: ${s.bets} bets, ${s.touched} touched, win rate ${pct(s.winRate)} (N=${s.touched}), mean net R ${rFmt(s.meanNetR)}`);
  } catch (e) {
    console.error(`score failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
