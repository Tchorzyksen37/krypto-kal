// speculation/check.ts – validates the bets of a speculation report and rewrites its "Best bets" block.
// Pure core (validateBets, renderBestBets, patchReport) plus a CLI:
//   node speculation/check.ts <HH00Z.meta.json>
// The CLI validates, writes `validated`/`dropped` back into the meta file, replaces the "## Best bets"
// section of the sibling .md, and appends the validated bets to bets-log.json (two levels above the meta file).

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bet, BetInput, DroppedBet, LoggedBet, MetaSymbol, ReportMeta } from "./types.ts";

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
  const dev = Math.abs(b.entry - s.last) / s.last;
  if (dev > o.maxEntryDeviation) return `entry ${(dev * 100).toFixed(2)}% away from last price (max ${(o.maxEntryDeviation * 100).toFixed(2)}%)`;
  const risk = Math.abs(b.entry - b.stop_loss);
  const reward = Math.abs(b.take_profit - b.entry);
  if (s.atr_1h > 0 && risk < o.minStopAtr * s.atr_1h) return `stop inside noise (${(risk / s.atr_1h).toFixed(2)} ATR < ${o.minStopAtr})`;
  const costFrac = (2 * o.feeBps + (s.spread_bps ?? 0)) / 10_000;
  if (reward / b.entry < o.costMultiple * costFrac) return `take profit does not clear costs (needs ${(o.costMultiple * costFrac * 100).toFixed(3)}%)`;
  if (reward / risk < o.minRewardRisk) return `reward:risk ${(reward / risk).toFixed(2)} < ${o.minRewardRisk}`;
  if (b.ttl_minutes < o.minTtl || b.ttl_minutes > o.maxTtl) return `ttl ${b.ttl_minutes} outside ${o.minTtl}..${o.maxTtl} min`;
  return undefined;
}

export function validateBets(meta: ReportMeta, options: Partial<CheckOptions> = {}): CheckResult {
  const o = { ...DEFAULT_CHECK, ...options };
  const bySymbol = new Map(meta.symbols.map((s) => [s.symbol, s]));
  const dropped: DroppedBet[] = [];
  const ok: (BetInput & { rr: number; score: number })[] = [];

  for (const b of meta.bets) {
    const reason = reasonToDrop(b, bySymbol.get(b.symbol), o);
    if (reason) {
      dropped.push({ bet: b, reason });
      continue;
    }
    const rr = Math.abs(b.take_profit - b.entry) / Math.abs(b.entry - b.stop_loss);
    ok.push({ ...b, rr, score: b.probability * rr });
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

  const start = Date.parse(meta.window[0]);
  const d = new Date(start);
  const prefix = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}Z`;
  const deadline = start + o.entryDeadlineMinutes * MIN;
  const bets: Bet[] = kept.map((b, i) => {
    const { score: _score, ...rest } = b;
    return {
      ...rest,
      id: `${prefix}-${b.symbol}-${i + 1}`,
      futures: bySymbol.get(b.symbol)!.futures,
      rr: Math.round(b.rr * 100) / 100,
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

export function renderBestBets(result: CheckResult, meta: ReportMeta): string {
  const lines = ["## Best bets (next 1h)", ""];
  if (result.bets.length === 0) {
    lines.push("> [!note] No bet this hour. Nothing passed validation, or nothing had an edge worth stating.", "");
  } else {
    lines.push(
      "| # | Symbol | Side | Entry (limit) | SL | TP | Fill by | Hold max | Latest close | P | R:R |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    );
    result.bets.forEach((b, i) =>
      lines.push(
        `| ${i + 1} | ${b.symbol} | ${b.side} | ${fmtPrice(b.entry)} | ${fmtPrice(b.stop_loss)} | ${fmtPrice(b.take_profit)} | ${clock(Date.parse(b.entry_deadline))} | ${b.ttl_minutes} min | ${clock(Date.parse(b.latest_close))} | ${Math.round(b.probability * 100)}% | ${b.rr.toFixed(2)} |`,
      ),
    );
    lines.push("");
    result.bets.forEach((b, i) => {
      lines.push(
        `> [!tip] ${i + 1}. ${b.symbol} ${b.side} · wait for ${fmtPrice(b.entry)} · SL ${fmtPrice(b.stop_loss)} · TP ${fmtPrice(b.take_profit)}`,
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
  lines.push(`_Speculation, not advice. Generated ${meta.generated}. The levels above were validated by code; the model's reasoning may still be wrong._`, "");
  return lines.join("\n");
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

export async function runCheck(metaPath: string, options: Partial<CheckOptions> = {}): Promise<CheckResult> {
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as ReportMeta;
  if (!Array.isArray(meta.symbols) || !Array.isArray(meta.bets) || !Array.isArray(meta.window)) {
    throw new Error("meta file needs symbols[], bets[] and window[]");
  }
  const result = validateBets(meta, options);
  meta.validated = result.bets;
  meta.dropped = result.dropped;
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  const mdPath = join(dirname(metaPath), basename(metaPath).replace(/\.meta\.json$/, ".md"));
  const md = existsSync(mdPath) ? await readFile(mdPath, "utf8") : `# Speculation ${meta.window[0]}\n`;
  await writeFile(mdPath, patchReport(md, renderBestBets(result, meta)), "utf8");

  const logPath = join(dirname(dirname(metaPath)), "bets-log.json");
  const log: LoggedBet[] = existsSync(logPath) ? (JSON.parse(await readFile(logPath, "utf8")) as LoggedBet[]) : [];
  const known = new Set(log.map((b) => b.id));
  for (const b of result.bets) if (!known.has(b.id)) log.push({ ...b, report: mdPath, generated: meta.generated });
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node speculation/check.ts <HH00Z.meta.json>");
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
