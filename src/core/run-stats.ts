// run-stats.ts – statistics collected while the server runs, to measure what the model actually reads:
//   - per tool call: duration, success, size of the result text (characters and a rough token estimate) and how many
//     series points it carried;
//   - per history request (cachedSeries): points served from the SQLite cache vs fetched from the API, and how many API
//     requests that took, attributed to the tool call that caused it.
// Kept in memory for the MCP tool `server_stats`, and appended as one JSON line per event to a log file for later
// analysis. Summarise a log (all of it, or from a time on):
//   node src/core/run-stats.ts [~/.krypto-kal/tool-stats.jsonl] [--since 2026-10-06T00:00Z]
// Nothing here stores tool results or secrets: only sizes, counts, timings and the call's arguments (truncated).

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.ts";

const log = createLogger("run-stats");

export const DEFAULT_STATS_LOG = join(homedir(), ".krypto-kal", "tool-stats.jsonl");
const CHARS_PER_TOKEN = 3; // rough: numeric JSON tokenises worse than prose; good for comparisons, not for billing
const DURATION_SAMPLES = 500; // most recent durations kept per tool for percentiles
const MAX_ARGS_CHARS = 300;

export interface ToolEvent {
  type: "tool";
  at: string; // ISO
  tool: string;
  ok: boolean;
  ms: number;
  chars: number; // length of the text handed to the model
  estTokens: number; // chars / CHARS_PER_TOKEN, rounded
  points: number; // series points in the result (objects with a numeric `t` or `ts`)
  args: string; // JSON of the arguments, truncated
  error?: string;
}

export interface CacheEvent {
  type: "cache";
  at: string;
  tool?: string; // the tool call that caused it, when inside one
  kind: string;
  interval: string;
  symbols: number;
  served: number; // points returned
  fromStore: number; // closed points read from the SQLite cache
  fetched: number; // closed points fetched from the API and saved
  tail: number; // points of the open tail, always fetched live
  requests: number; // API requests made for this call
}

export type StatsEvent = ToolEvent | CacheEvent;

export interface ToolSummary {
  tool: string;
  calls: number;
  errors: number;
  msP50: number;
  msP95: number;
  msMax: number;
  charsMean: number;
  charsMax: number;
  charsTotal: number;
  estTokensTotal: number;
  pointsMean: number;
  pointsMax: number;
}

export interface CacheSummary {
  kind: string;
  interval: string;
  calls: number;
  served: number;
  fromStore: number;
  fetched: number;
  tail: number;
  requests: number;
  storeShare: number; // fromStore / served, 0..1
}

export interface StatsSnapshot {
  since: string;
  until: string;
  tools: ToolSummary[]; // largest total output first
  cache: CacheSummary[]; // most points served first
  totals: { calls: number; errors: number; chars: number; estTokens: number; apiRequests: number };
}

interface ToolAcc {
  calls: number;
  errors: number;
  ms: number[];
  msMax: number;
  chars: number;
  charsMax: number;
  points: number;
  pointsMax: number;
}

type CacheAcc = Omit<CacheSummary, "storeShare">;

export interface RunStatsOptions {
  logPath?: string | undefined; // undefined: in memory only
  now?: () => number;
}

export class RunStats {
  private readonly tools = new Map<string, ToolAcc>();
  private readonly caches = new Map<string, CacheAcc>();
  private readonly context = new AsyncLocalStorage<string>();
  private logPath: string | undefined;
  private now: () => number;
  private since: number;
  private dirReady: Promise<unknown> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private writeFailed = false;

  constructor(o: RunStatsOptions = {}) {
    this.logPath = o.logPath;
    this.now = o.now ?? Date.now;
    this.since = this.now();
  }

  configure(o: RunStatsOptions): void {
    if ("logPath" in o) this.logPath = o.logPath;
    if (o.now) this.now = o.now;
  }

  // Runs `fn` as the tool call `tool`: cache events inside it are attributed to the tool.
  inTool<T>(tool: string, fn: () => Promise<T>): Promise<T> {
    return this.context.run(tool, fn);
  }

  // Measures one tool call around the text that goes to the model.
  recordTool(e: { tool: string; ok: boolean; ms: number; text: string; data?: unknown; points?: number | undefined; args?: unknown; error?: string }): ToolEvent {
    const event: ToolEvent = {
      type: "tool", at: new Date(this.now()).toISOString(), tool: e.tool, ok: e.ok, ms: Math.round(e.ms),
      chars: e.text.length, estTokens: Math.round(e.text.length / CHARS_PER_TOKEN),
      points: e.points ?? (e.data === undefined ? 0 : countPoints(e.data)), // presented text says how many it holds
      args: truncate(safeJson(e.args ?? {}), MAX_ARGS_CHARS),
      ...(e.error ? { error: truncate(e.error, MAX_ARGS_CHARS) } : {}),
    };
    this.apply(event);
    this.write(event);
    return event;
  }

  recordCache(e: Omit<CacheEvent, "type" | "at" | "tool">): CacheEvent {
    const tool = this.context.getStore();
    const event: CacheEvent = { type: "cache", at: new Date(this.now()).toISOString(), ...(tool ? { tool } : {}), ...e };
    this.apply(event);
    this.write(event);
    return event;
  }

  // Adds an event to the in-memory totals (also used to replay a log file).
  apply(event: StatsEvent): void {
    if (event.type === "tool") {
      const a = this.tools.get(event.tool) ?? { calls: 0, errors: 0, ms: [], msMax: 0, chars: 0, charsMax: 0, points: 0, pointsMax: 0 };
      a.calls++;
      if (!event.ok) a.errors++;
      a.ms.push(event.ms);
      if (a.ms.length > DURATION_SAMPLES) a.ms.shift();
      a.msMax = Math.max(a.msMax, event.ms);
      a.chars += event.chars;
      a.charsMax = Math.max(a.charsMax, event.chars);
      a.points += event.points;
      a.pointsMax = Math.max(a.pointsMax, event.points);
      this.tools.set(event.tool, a);
    } else {
      const key = `${event.kind}|${event.interval}`;
      const a = this.caches.get(key) ?? { kind: event.kind, interval: event.interval, calls: 0, served: 0, fromStore: 0, fetched: 0, tail: 0, requests: 0 };
      a.calls++;
      a.served += event.served;
      a.fromStore += event.fromStore;
      a.fetched += event.fetched;
      a.tail += event.tail;
      a.requests += event.requests;
      this.caches.set(key, a);
    }
  }

  snapshot(): StatsSnapshot {
    const tools: ToolSummary[] = [...this.tools.entries()].map(([tool, a]) => {
      const sorted = [...a.ms].sort((x, y) => x - y);
      return {
        tool, calls: a.calls, errors: a.errors,
        msP50: percentile(sorted, 0.5), msP95: percentile(sorted, 0.95), msMax: a.msMax,
        charsMean: Math.round(a.chars / a.calls), charsMax: a.charsMax, charsTotal: a.chars,
        estTokensTotal: Math.round(a.chars / CHARS_PER_TOKEN),
        pointsMean: Math.round(a.points / a.calls), pointsMax: a.pointsMax,
      };
    }).sort((x, y) => y.charsTotal - x.charsTotal || x.tool.localeCompare(y.tool));
    const cache: CacheSummary[] = [...this.caches.values()]
      .map((a) => ({ ...a, storeShare: a.served ? round3(a.fromStore / a.served) : 0 }))
      .sort((x, y) => y.served - x.served || x.kind.localeCompare(y.kind) || x.interval.localeCompare(y.interval));
    const chars = tools.reduce((s, t) => s + t.charsTotal, 0);
    return {
      since: new Date(this.since).toISOString(), until: new Date(this.now()).toISOString(), tools, cache,
      totals: {
        calls: tools.reduce((s, t) => s + t.calls, 0), errors: tools.reduce((s, t) => s + t.errors, 0),
        chars, estTokens: Math.round(chars / CHARS_PER_TOKEN), apiRequests: cache.reduce((s, c) => s + c.requests, 0),
      },
    };
  }

  reset(): void {
    this.tools.clear();
    this.caches.clear();
    this.since = this.now();
  }

  // Waits for pending log writes (tests and shutdown).
  async flush(): Promise<void> {
    await this.pending;
  }

  private write(event: StatsEvent): void {
    const path = this.logPath;
    if (!path) return;
    this.dirReady ??= mkdir(dirname(path), { recursive: true });
    // Chained, so lines keep their order; a failing disk never fails a tool call, it is reported once.
    this.pending = this.pending
      .then(() => this.dirReady)
      .then(() => appendFile(path, JSON.stringify(event) + "\n", "utf8"))
      .catch((e: unknown) => {
        if (!this.writeFailed) log.warn("cannot write the stats log", { path, error: e instanceof Error ? e.message : String(e) });
        this.writeFailed = true;
      });
  }
}

// The process-wide instance: the server configures its log file, cachedSeries and toResult record into it.
export const runStats = new RunStats();

export function statsLogPathFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.STATS_LOG?.toLowerCase() === "false") return undefined;
  return env.STATS_LOG_PATH || DEFAULT_STATS_LOG;
}

// Series points anywhere in a result: array elements that are objects with a numeric `t` (seconds) or `ts` (ms).
export function countPoints(value: unknown, depth = 0): number {
  if (depth > 6 || value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    let n = 0;
    for (const v of value) {
      if (v && typeof v === "object" && !Array.isArray(v) && (typeof (v as { t?: unknown }).t === "number" || typeof (v as { ts?: unknown }).ts === "number")) n++;
      else n += countPoints(v, depth + 1);
    }
    return n;
  }
  let n = 0;
  for (const v of Object.values(value)) n += countPoints(v, depth + 1);
  return n;
}

// Nearest-rank percentile of an ascending array.
export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

// Reads a JSONL stats log into a fresh RunStats (bad lines are skipped and counted).
export async function readStatsLog(path: string, sinceMs = 0): Promise<{ stats: RunStats; events: number; skipped: number }> {
  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim());
  const events: StatsEvent[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as StatsEvent;
      if ((e.type === "tool" || e.type === "cache") && Date.parse(e.at) >= sinceMs) events.push(e);
      else if (e.type !== "tool" && e.type !== "cache") skipped++;
    } catch {
      skipped++;
    }
  }
  const first = events.length ? Date.parse(events[0]!.at) : Date.now();
  const last = events.length ? Date.parse(events.at(-1)!.at) : first;
  let clock = first;
  const stats = new RunStats({ now: () => clock });
  for (const e of events) stats.apply(e);
  clock = last;
  return { stats, events: events.length, skipped };
}

export function renderSnapshot(s: StatsSnapshot): string {
  const pad = (v: string | number, n: number) => String(v).padStart(n);
  const out = [
    `stats ${s.since} .. ${s.until}`,
    `calls ${s.totals.calls}, errors ${s.totals.errors}, output ${s.totals.chars} chars (~${s.totals.estTokens} tokens, chars/${CHARS_PER_TOKEN}), API requests from the history cache ${s.totals.apiRequests}`,
    "",
    "tool                                     calls  err   p50ms   p95ms  mean chars   max chars  ~tokens total  mean pts  max pts",
  ];
  for (const t of s.tools) {
    out.push(`${t.tool.padEnd(40)} ${pad(t.calls, 5)} ${pad(t.errors, 4)} ${pad(t.msP50, 7)} ${pad(t.msP95, 7)} ${pad(t.charsMean, 11)} ${pad(t.charsMax, 11)} ${pad(t.estTokensTotal, 14)} ${pad(t.pointsMean, 9)} ${pad(t.pointsMax, 8)}`);
  }
  if (s.cache.length) {
    out.push("", "history cache (kind / interval)                       calls    served  from store   fetched     tail  requests  store share");
    for (const c of s.cache) {
      out.push(`${`${c.kind} / ${c.interval}`.padEnd(52)} ${pad(c.calls, 6)} ${pad(c.served, 9)} ${pad(c.fromStore, 11)} ${pad(c.fetched, 9)} ${pad(c.tail, 8)} ${pad(c.requests, 9)} ${pad((c.storeShare * 100).toFixed(1) + "%", 12)}`);
    }
  }
  return out.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const sinceIdx = argv.indexOf("--since");
  const sinceMs = sinceIdx >= 0 ? Date.parse(argv[sinceIdx + 1] ?? "") : 0;
  if (Number.isNaN(sinceMs)) throw new Error("--since needs an ISO time, e.g. 2026-10-06T00:00Z");
  const path = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--since") ?? statsLogPathFromEnv() ?? DEFAULT_STATS_LOG;
  const { stats, events, skipped } = await readStatsLog(path, sinceMs);
  console.log(`${path}: ${events} events${skipped ? `, ${skipped} unreadable lines skipped` : ""}`);
  console.log(renderSnapshot(stats.snapshot()));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
