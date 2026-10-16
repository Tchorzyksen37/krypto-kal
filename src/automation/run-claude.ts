// automation/run-claude.ts – runs a headless `claude -p` for one report slot, with a tool allowlist and a timeout.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Slot } from "./slots.ts";

export interface ClaudeRun {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  // The text a person reads: the tail of stdout + stderr, or the `result` of claude's JSON when it printed one.
  output: string;
  // The raw streams, separately (each capped at RAW_CAP). Optional: test fakes need not set them.
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  // Tool calls claude was denied (`permission_denials` of its JSON result); empty when none or no JSON.
  denials?: unknown[];
}

export type ClaudeRunner = (prompt: string, args: string[], timeoutMs: number) => Promise<ClaudeRun>;

const OUTPUT_CAP = 20_000;
const RAW_CAP = 2_000_000;
const KEEP_RUN_LOGS = 300;

// The run is denied Read(./.env), so the skill's "BRAIN is BRAIN_DIR from .env" cannot be resolved by the model;
// the prompt states it. brain_write is not allowed in a run, so files are written with Edit/Write under BRAIN.
export function speculatePrompt(slot: Slot, brainDir: string): string {
  const hhmm = new Date(slot.startMs).toISOString().slice(11, 16).replace(":", "");
  return (
    `BRAIN is ${brainDir} (do not read .env; brain_write is not available, so write the report and meta files ` +
    `with the Edit or Write tool under BRAIN/output/speculation/). ` +
    `Run the speculate skill for the 30-minute slot ${slot.id}: window start ${new Date(slot.startMs).toISOString()}, ` +
    `window end ${new Date(slot.endMs).toISOString()}, session ${slot.session}. ` +
    `Use exactly this window as the report's window and file name HHMMZ=${hhmm}Z. Do not offer to hand bets to the bot.`
  );
}

// A directory in the form Claude Code's Read/Edit rules use for an absolute path (docs: "Configure permissions"):
// a `//` prefix anchors at the filesystem root, and on Windows paths are normalized to POSIX form first
// (`C:\Users\alice` -> `/c/Users/alice`). A UNC path keeps its `//server/share` form, which is unverified.
export function absoluteRulePath(dir: string): string {
  const p = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(p);
  if (drive) return `//${drive[1]!.toLowerCase()}${drive[2] ?? ""}`;
  return "//" + p.replace(/^\/+/, "");
}

// Read-only MCP tools the speculate skill calls. Deliberately absent: every writer or budget spender
// (brain_write, brain_ingest_mark, x_sync, server_stats with reset, speculation_score) and the account tools
// (kraken_futures_positions/open_orders/fills/pnl, bot_status): a slot report does not need the user's positions.
const SPECULATE_MCP_TOOLS = [
  "speculation_context",
  "market_view",
  "kraken_futures_candles",
  "kraken_ticker",
  "kraken_order_book",
  "yahoo_quote",
  "yahoo_history",
  "yahoo_search",
  "coinalyze_current",
  "coinalyze_future_markets",
  "coinalyze_ohlcv_history",
  "coinalyze_open_interest_history",
  "coinalyze_funding_rate_history",
  "coinalyze_long_short_ratio_history",
  "coinalyze_liquidation_history",
  "coinalyze_liquidation_heatmap_estimate",
  "x_recent",
  "brain_list",
  "brain_read",
  "brain_search",
  "brain_related",
];

export const mcpTool = (name: string): string => `mcp__krypto-kal__${name}`;

// No bypass flag: anything outside the allowlist is denied in headless mode, and deny rules win over allow rules.
// File writes are checked against Edit(path) rules only (a Write(path) rule is never consulted), so the one Edit
// rule is what lets the run write its report. Read(./.env) is relative to the working directory, the repo root.
// WebSearch and WebFetch are not allowed: calendar items the run cannot read are reported as unknown.
export function claudeArgs(brainDir: string, extraMcpTools: string[] = []): string[] {
  return [
    "-p",
    "--allowedTools",
    ...SPECULATE_MCP_TOOLS.concat(extraMcpTools).map(mcpTool),
    "Read",
    `Edit(${absoluteRulePath(brainDir)}/output/speculation/**)`,
    "Bash(node src/speculation/check.ts:*)",
    "Bash(node src/speculation/sessions.ts:*)",
    "--disallowedTools",
    "Read(./.env)",
    "Read(./.env.*)",
  ];
}

// Generic spawn helper: never throws, caps output, kills the whole process tree on timeout.
export function spawnOutput(cmd: string, args: string[], timeoutMs: number, input = ""): Promise<ClaudeRun> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let output = "";
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (run: Omit<ClaudeRun, "stdout" | "stderr" | "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, stdout, stderr, durationMs: Date.now() - t0 });
    };
    const add = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_CAP); // keep the tail: it holds the result or error
    };
    // Raw streams keep the head: a JSON result must stay whole, and past the cap it is cut anyway.
    const addStdout = (chunk: Buffer): void => {
      add(chunk);
      if (stdout.length < RAW_CAP) stdout += chunk.toString("utf8");
    };
    const addStderr = (chunk: Buffer): void => {
      add(chunk);
      if (stderr.length < RAW_CAP) stderr += chunk.toString("utf8");
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, exitCode: null, timedOut: false, output: String(e instanceof Error ? e.message : e), stdout, stderr, durationMs: 0 });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      done({ ok: false, exitCode: null, timedOut: true, output }); // do not wait for pipes to close
    }, timeoutMs);
    child.stdout.on("data", addStdout);
    child.stderr.on("data", addStderr);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", (e) => done({ ok: false, exitCode: null, timedOut, output: (e as Error).message }));
    child.on("close", (code) => done({ ok: !timedOut && code === 0, exitCode: code, timedOut, output }));
  });
}

// On Windows child.kill() leaves grandchildren (claude.cmd -> node), so kill the tree.
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// The prompt travels on stdin only: --allowedTools is variadic and would swallow a trailing positional.
export function buildInvocation(prompt: string, args: string[]): { cmd: string; args: string[]; input: string } {
  return { cmd: "claude", args, input: prompt };
}

// What `claude -p --output-format json` printed: the final result object, or (older versions) the array of messages
// that ends with it. Undefined when stdout is not that JSON (a crash, a login prompt, a timeout).
export function parseClaudeJson(stdout: string): { result?: string; denials: unknown[] } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (Array.isArray(v)) v = [...v].reverse().find((m) => m && typeof m === "object" && (m as { type?: unknown }).type === "result");
  if (!v || typeof v !== "object") return undefined;
  const o = v as { result?: unknown; permission_denials?: unknown };
  return {
    ...(typeof o.result === "string" ? { result: o.result } : {}),
    denials: Array.isArray(o.permission_denials) ? o.permission_denials : [],
  };
}

// A run's raw output, one JSON file per run in `dir`, newest KEEP_RUN_LOGS kept. The prompt is not logged. Never throws:
// a log that cannot be written must not fail the run.
export function writeRunLog(dir: string, kind: string, prompt: string, run: ClaudeRun, atMs = Date.now()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const slot = /\bslot (\d{8}-\d{4}Z)/.exec(prompt)?.[1];
    const at = new Date(atMs).toISOString();
    const body = {
      at,
      kind,
      ...(slot ? { slot } : {}),
      ok: run.ok,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs ?? null,
      denials: run.denials ?? [],
      stdout: run.stdout ?? "",
      stderr: run.stderr ?? "",
    };
    writeFileSync(join(dir, `${at.replace(/[:.]/g, "-")}-${kind}.json`), JSON.stringify(body, null, 2));
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUN_LOGS))) unlinkSync(join(dir, f));
  } catch (e) {
    console.error(`run log not written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// The runner used by the tick and the score: claude prints JSON (its `result` becomes `output`, so alerts stay
// readable, and its permission denials are surfaced), and every run is written to `logDir` as one file.
export function makeClaudeRunner(opts: { logDir: string; kind: string }): ClaudeRunner {
  return async (prompt, args, timeoutMs) => {
    const inv = buildInvocation(prompt, ["-p", "--output-format", "json", ...args.slice(1)]);
    const raw = await spawnOutput(inv.cmd, inv.args, timeoutMs, inv.input);
    const parsed = parseClaudeJson(raw.stdout ?? "");
    const run: ClaudeRun = {
      ...raw,
      ...(parsed?.result !== undefined ? { output: parsed.result } : {}),
      denials: parsed?.denials ?? [],
    };
    writeRunLog(opts.logDir, opts.kind, prompt, run);
    return run;
  };
}
