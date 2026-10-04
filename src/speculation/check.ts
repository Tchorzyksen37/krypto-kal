// speculation/check.ts – validates the bets of a speculation report and rewrites its "Best bets" block.
// Pure core (validateBets, renderBestBets, patchReport) plus a CLI:
//   node src/speculation/check.ts <HH00Z.meta.json>
// The CLI validates, writes `validated`/`dropped` back into the meta file, replaces the "## Best bets"
// section of the sibling .md, and appends the validated bets to bets-log.json (two levels above the meta file).

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionById } from "./sessions.ts";
import type { Bet, BetInput, Bias, DroppedBet, LoggedBet, MetaSymbol, ReportMeta } from "./types.ts";

export interface CheckOptions {
  maxBets: number;
  maxEntryDeviation: number; // fraction of last price
  feeBps: number; // taker fee, one way
  minRewardRisk: number;
  minStopAtr: number; // minimum stop distance in 1h ATRs
  costMultiple: number; // take-profit distance must be >= this x round-trip cost
  entryDeadlineMinutes: number;
  minTtl: number;
  maxTtl: number;
  maxFeeR: number; // round-trip fees may cost at most this fraction of the risk
  minEdgeR: number; // expected value per bet, in R after fees, must be above this
}

export const DEFAULT_CHECK: CheckOptions = {
  maxBets: 3,
  maxEntryDeviation: 0.005,
  feeBps: 5,
  minRewardRisk: 1.2,
  minStopAtr: 0.15,
  costMultiple: 3,
  entryDeadlineMinutes: 30,
  minTtl: 5,
  maxTtl: 60,
  maxFeeR: 0.2,
  minEdgeR: 0,
};

// Round-trip fee in units of risk (taker on both legs: the conservative case).
export const feeR = (b: BetInput, feeBps: number) => (2 * feeBps * b.entry) / 10_000 / Math.abs(b.entry - b.stop_loss);

// Expected value in R, treating the bet as binary (TP with `probability`, otherwise SL), after fees.
// Equivalent to "probability beats the break-even rate 1 / (1 + R:R)". Time-outs make the real result less extreme.
export const expectedR = (b: BetInput, feeBps: number) => {
  const rr = Math.abs(b.take_profit - b.entry) / Math.abs(b.entry - b.stop_loss);
  return b.probability * rr - (1 - b.probability) - feeR(b, feeBps);
};

// The win rate a bet needs to break even after fees: p·RR − (1 − p) − fee = 0.
export const breakEven = (b: BetInput, feeBps: number) => {
  const rr = Math.abs(b.take_profit - b.entry) / Math.abs(b.entry - b.stop_loss);
  return (1 + feeR(b, feeBps)) / (1 + rr);
};

export interface CheckResult {
  bets: Bet[];
  dropped: DroppedBet[];
}

const MIN = 60_000;
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => `${pad(new Date(ms).getUTCHours())}:${pad(new Date(ms).getUTCMinutes())}Z`;

// Readable price with enough digits for both BTC (65000.5) and sub-dollar coins (0.5123).
export function fmtPrice(p: number): string {
  const a = Math.abs(p);
  const digits = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : 5;
  return p.toFixed(digits);
}

function reasonToDrop(b: BetInput, s: MetaSymbol | undefined, o: CheckOptions): string | undefined {
  if (!s) return `unknown symbol ${b.symbol}`;
  const nums = [b.entry, b.stop_loss, b.take_profit, b.ttl_minutes, b.probability];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)) return "missing or non-positive numbers";
  if (b.side !== "long" && b.side !== "short") return `invalid side ${String(b.side)}`;
  if (b.probability > 1) return "probability above 1";
  const long = b.side === "long";
  const ordered = long ? b.stop_loss < b.entry && b.entry < b.take_profit : b.take_profit < b.entry && b.entry < b.stop_loss;
  if (!ordered) return long ? "long needs SL < entry < TP" : "short needs TP < entry < SL";
  // Entries are limit orders that wait for a touch: a long limit above the market (or a short below) would fill at once.
  if (long ? b.entry > s.last : b.entry < s.last) return `${b.side} limit ${long ? "above" : "below"} the last price ${s.last} would fill immediately (not a limit entry)`;
  const dev = Math.abs(b.entry - s.last) / s.last;
  if (dev > o.maxEntryDeviation) return `entry ${(dev * 100).toFixed(2)}% away from last price (max ${(o.maxEntryDeviation * 100).toFixed(2)}%)`;
  const risk = Math.abs(b.entry - b.stop_loss);
  const reward = Math.abs(b.take_profit - b.entry);
  const minStop = o.minStopAtr * s.atr_1h * Math.sqrt(Math.max(1, b.ttl_minutes / 60)); // longer holds need wider stops
  if (s.atr_1h > 0 && risk < minStop) return `stop inside noise (${(risk / s.atr_1h).toFixed(2)} ATR < ${(minStop / s.atr_1h).toFixed(2)})`;
  const costFrac = (2 * o.feeBps + (s.spread_bps ?? 0)) / 10_000;
  if (reward / b.entry < o.costMultiple * costFrac) return `take profit does not clear costs (needs ${(o.costMultiple * costFrac * 100).toFixed(3)}%)`;
  const fr = feeR(b, o.feeBps);
  if (fr > o.maxFeeR) return `fees cost ${fr.toFixed(2)}R per round trip (max ${o.maxFeeR}R): stop too tight for the fees`;
  if (reward / risk < o.minRewardRisk) return `reward:risk ${(reward / risk).toFixed(2)} < ${o.minRewardRisk}`;
  if (b.ttl_minutes < o.minTtl || b.ttl_minutes > o.maxTtl) return `ttl ${b.ttl_minutes} outside ${o.minTtl}..${o.maxTtl} min`;
  const ev = expectedR(b, o.feeBps);
  if (ev <= o.minEdgeR) {
    return `no edge: probability ${Math.round(b.probability * 100)}% is below the break-even ${Math.round(breakEven(b, o.feeBps) * 100)}% for this R:R after fees (EV ${ev.toFixed(2)}R)`;
  }
  return undefined;
}

// Limits of the report's session (if any) sit between the defaults and explicit options.
export function optionsFor(meta: ReportMeta, options: Partial<CheckOptions> = {}): CheckOptions {
  const sd = meta.session ? sessionById(meta.session) : undefined;
  const fromSession: Partial<CheckOptions> = sd
    ? { maxBets: sd.maxBets, maxEntryDeviation: sd.maxEntryDeviation, minRewardRisk: sd.minRewardRisk, entryDeadlineMinutes: sd.entryDeadlineMinutes, maxTtl: sd.maxTtlMinutes }
    : {};
  return { ...DEFAULT_CHECK, ...fromSession, ...options };
}

export function validateBets(meta: ReportMeta, options: Partial<CheckOptions> = {}): CheckResult {
  const o = optionsFor(meta, options);
  const bySymbol = new Map(meta.symbols.map((s) => [s.symbol, s]));
  const dropped: DroppedBet[] = [];
  const ok: (BetInput & { rr: number; score: number })[] = []; // score = expected R after fees

  for (const b of meta.bets) {
    const reason = reasonToDrop(b, bySymbol.get(b.symbol), o);
    if (reason) {
      dropped.push({ bet: b, reason });
      continue;
    }
    const rr = Math.abs(b.take_profit - b.entry) / Math.abs(b.entry - b.stop_loss);
    ok.push({ ...b, rr, score: expectedR(b, o.feeBps) });
  }

  ok.sort((a, b) => b.score - a.score);
  const kept: typeof ok = [];
  const seen = new Set<string>();
  for (const b of ok) {
    if (seen.has(b.symbol)) dropped.push({ bet: stripExtras(b), reason: `second bet for ${b.symbol}` });
    else if (kept.length >= o.maxBets) dropped.push({ bet: stripExtras(b), reason: `over the limit of ${o.maxBets} bets` });
    else {
      seen.add(b.symbol);
      kept.push(b);
    }
  }

  const windowStart = Date.parse(meta.window[0]);
  const d = new Date(windowStart);
  const prefix = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
  // A manual run after the window opened can only be filled from the moment it was generated.
  const start = Math.max(windowStart, Date.parse(meta.generated) || windowStart);
  const deadline = start + o.entryDeadlineMinutes * MIN;
  const bets: Bet[] = kept.map((b, i) => {
    const { score: _score, ...rest } = b;
    const symBias = bySymbol.get(b.symbol)!.bias ?? "neutral";
    return {
      ...rest,
      ...(meta.session ? { session: meta.session } : {}),
      vs_bias: (symBias === "neutral" ? "neutral" : symBias === b.side ? "with" : "against") as Bet["vs_bias"],
      id: `${prefix}-${b.symbol}-${i + 1}`,
      futures: bySymbol.get(b.symbol)!.futures,
      rr: Math.round(b.rr * 100) / 100,
      ev_r: Math.round(b.score * 100) / 100,
      break_even: Math.round(breakEven(b, o.feeBps) * 1000) / 1000,
      fill_from: new Date(start).toISOString(),
      entry_deadline: new Date(deadline).toISOString(),
      latest_close: new Date(deadline + b.ttl_minutes * MIN).toISOString(),
    };
  });
  return { bets, dropped };
}

function stripExtras(b: BetInput & { rr?: number; score?: number }): BetInput {
  const { rr: _rr, score: _score, ...rest } = b;
  return rest;
}

const sessionLabel = (meta: ReportMeta) => (meta.session ? sessionById(meta.session)?.label : undefined) ?? "next 1h";

export function renderBestBets(result: CheckResult, meta: ReportMeta): string {
  const lines = [`## Best bets (${sessionLabel(meta)})`, ""];
  if (result.bets.length === 0) {
    lines.push("> [!note] No bet this session. Nothing passed validation, or nothing had an edge worth stating.", "");
  } else {
    lines.push(
      "| # | Symbol | Side | Entry (limit) | SL | TP | Fill by | Hold max | Latest close | P | Break-even | R:R | EV |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    result.bets.forEach((b, i) =>
      lines.push(
        `| ${i + 1} | ${b.symbol} | ${b.side} | ${fmtPrice(b.entry)} | ${fmtPrice(b.stop_loss)} | ${fmtPrice(b.take_profit)} | ${clock(Date.parse(b.entry_deadline))} | ${b.ttl_minutes} min | ${clock(Date.parse(b.latest_close))} | ${Math.round(b.probability * 100)}% | ${Math.round(b.break_even * 100)}% | ${b.rr.toFixed(2)} | ${b.ev_r >= 0 ? "+" : ""}${b.ev_r.toFixed(2)}R |`,
      ),
    );
    lines.push("");
    result.bets.forEach((b, i) => {
      lines.push(
        `> [!tip] ${i + 1}. ${b.symbol} ${b.side} · wait for ${fmtPrice(b.entry)} · SL ${fmtPrice(b.stop_loss)} · TP ${fmtPrice(b.take_profit)}`,
        ...(b.vs_bias === "against" ? ["> [!warning] Counter-bias: this bet goes against the symbol's lean stated at the top of the report."] : []),
        `> If ${fmtPrice(b.entry)} is not touched by ${clock(Date.parse(b.entry_deadline))}, drop it. After the touch, close within ${b.ttl_minutes} min (latest ${clock(Date.parse(b.latest_close))}). Id \`${b.id}\`.`,
      );
      if (b.rationale) lines.push(`> Why: ${b.rationale.replace(/\r?\n/g, " ")}`);
      lines.push("");
    });
  }
  if (result.dropped.length > 0) {
    lines.push("### Dropped bets", "");
    for (const d of result.dropped) lines.push(`- ${d.bet.symbol} ${d.bet.side}: ${d.reason}`);
    lines.push("");
  }
  if (result.bets.length > 0) {
    lines.push("_Break-even is the win rate the bet needs after fees; P above it is the model's claimed edge. EV assumes TP or SL, nothing in between._", "");
  }
  lines.push(`_Speculation, not advice. Generated ${meta.generated}. The levels above were validated by code; the model's reasoning may still be wrong._`, "");
  return lines.join("\n");
}

// ---- bias: every report must say whether it leans long or short ----

const DIRS = ["long", "short", "neutral"];

export function biasError(meta: ReportMeta): string | undefined {
  const b = meta.bias;
  if (!b || !DIRS.includes(b.direction)) return 'report must state its bias: meta.bias.direction = "long" | "short" | "neutral"';
  if (b.direction !== "neutral" && !(typeof b.probability === "number" && b.probability > 0 && b.probability <= 1)) return "a long/short bias needs a probability in (0, 1]";
  for (const s of meta.symbols) if (s.bias !== undefined && !DIRS.includes(s.bias)) return `invalid bias for ${s.symbol}`;
  return undefined;
}

const upper = (d: string) => d.toUpperCase();

export function renderBias(meta: ReportMeta): string {
  const b = meta.bias!;
  const p = b.probability !== undefined ? ` (${Math.round(b.probability * 100)}%)` : "";
  const head = b.direction === "neutral" ? "NEUTRAL, no directional edge" : `${upper(b.direction)}${p}`;
  const per = meta.symbols.filter((s) => s.bias).map((s) => `${s.symbol} ${upper(s.bias!)}`).join(" · ");
  return [`> [!abstract] Bias: ${head}${b.summary ? `. ${b.summary.replace(/\r?\n/g, " ")}` : ""}`, ...(per ? [`> Per symbol: ${per}`] : [])].join("\n");
}

const BIAS_START = "<!-- bias:start -->";
const BIAS_END = "<!-- bias:end -->";

// Puts the bias callout (between markers) after the first heading, or at the top, and mirrors it in the frontmatter.
export function patchBias(md: string, meta: ReportMeta): string {
  const block = `${BIAS_START}\n${renderBias(meta)}\n${BIAS_END}`;
  let out = md;
  const a = out.indexOf(BIAS_START);
  const z = out.indexOf(BIAS_END);
  if (a >= 0 && z > a) out = out.slice(0, a) + block + out.slice(z + BIAS_END.length);
  else {
    const h1 = /^# .*$/m.exec(out);
    const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(out);
    const at = h1 ? h1.index + h1[0].length : fm ? fm[0].length : 0;
    out = `${out.slice(0, at)}\n\n${block}\n${out.slice(at)}`;
  }
  const dir = meta.bias!.direction;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(out);
  if (fm) {
    const body = /^bias:.*$/m.test(fm[1]!) ? fm[1]!.replace(/^bias:.*$/m, `bias: ${dir}`) : `${fm[1]}\nbias: ${dir}`;
    out = out.replace(fm[0], `---\n${body}\n---`);
  } else out = `---\ntype: speculation\nbias: ${dir}\n---\n\n${out}`;
  return out;
}

// Replaces the "## Best bets" section (up to the next "## " heading or the end) or appends it.
export function patchReport(md: string, bestBets: string): string {
  const lines = md.replace(/\s+$/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Best bets\b/.test(l));
  if (start < 0) return `${lines.join("\n")}\n\n${bestBets}`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${bestBets}${after ? `\n${after}\n` : ""}`;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<CheckOptions> {
  const num = (k: string) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : undefined);
  const out: Partial<CheckOptions> = {};
  const maxBets = num("SPECULATION_MAX_BETS");
  const dev = num("SPECULATION_MAX_ENTRY_DEVIATION");
  const fee = num("SPECULATION_FEE_BPS");
  if (maxBets !== undefined && Number.isFinite(maxBets)) out.maxBets = maxBets;
  if (dev !== undefined && Number.isFinite(dev)) out.maxEntryDeviation = dev;
  if (fee !== undefined && Number.isFinite(fee)) out.feeBps = fee;
  return out;
}

// A rerun of the checker replaces this report's bets in the log, so corrected levels win. Bets that were
// already scored (an outcome or a matched fill) are frozen: they are kept as they are and never overwritten.
export function upsertReportBets(log: LoggedBet[], bets: Bet[], report: string, generated: string): LoggedBet[] {
  const scored = (b: LoggedBet) => (b.hypothetical !== undefined && b.hypothetical.status !== "open") || b.actual !== undefined;
  const kept = log.filter((b) => b.report !== report || scored(b));
  const frozen = new Set(kept.map((b) => b.id));
  return [...kept, ...bets.filter((b) => !frozen.has(b.id)).map((b) => ({ ...b, report, generated }))];
}

export async function runCheck(metaPath: string, options: Partial<CheckOptions> = {}): Promise<CheckResult> {
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as ReportMeta;
  if (!Array.isArray(meta.symbols) || !Array.isArray(meta.bets) || !Array.isArray(meta.window)) {
    throw new Error("meta file needs symbols[], bets[] and window[]");
  }
  const err = biasError(meta);
  if (err) throw new Error(err);
  const result = validateBets(meta, options);
  meta.validated = result.bets;
  meta.dropped = result.dropped;
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  const mdPath = join(dirname(metaPath), basename(metaPath).replace(/\.meta\.json$/, ".md"));
  const md = existsSync(mdPath) ? await readFile(mdPath, "utf8") : `# Speculation ${meta.window[0]}\n`;
  await writeFile(mdPath, patchReport(patchBias(md, meta), renderBestBets(result, meta)), "utf8");

  const logPath = join(dirname(dirname(metaPath)), "bets-log.json");
  const log: LoggedBet[] = existsSync(logPath) ? (JSON.parse(await readFile(logPath, "utf8")) as LoggedBet[]) : [];
  await writeFile(logPath, `${JSON.stringify(upsertReportBets(log, result.bets, mdPath, meta.generated), null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node src/speculation/check.ts <HH00Z.meta.json>");
    process.exit(2);
  }
  try {
    const r = await runCheck(path, optionsFromEnv());
    console.log(`bets kept: ${r.bets.length}, dropped: ${r.dropped.length}`);
    for (const b of r.bets) console.log(`  ${b.id} ${b.side} entry ${b.entry} SL ${b.stop_loss} TP ${b.take_profit} P ${b.probability} R:R ${b.rr}`);
    for (const d of r.dropped) console.log(`  dropped ${d.bet.symbol} ${d.bet.side}: ${d.reason}`);
  } catch (e) {
    console.error(`check failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
