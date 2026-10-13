// automation/run-claude.ts – runs a headless `claude -p` for one report slot, with a tool allowlist and a timeout.

import { spawn, spawnSync } from "node:child_process";
import type { Slot } from "./slots.ts";

export interface ClaudeRun {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export type ClaudeRunner = (prompt: string, args: string[], timeoutMs: number) => Promise<ClaudeRun>;

const OUTPUT_CAP = 20_000;

// The run is denied Read(./.env), so the skill's "BRAIN is BRAIN_DIR from .env" cannot be resolved by the model;
// the prompt states it. brain_write is not allowed in a run, so files are written with Edit/Write under BRAIN.
export function speculatePrompt(slot: Slot, brainDir: string): string {
  const hhmm = new Date(slot.startMs).toISOString().slice(11, 16).replace(":", "");
  return (
    `BRAIN is ${brainDir} (do not read .env; brain_write is not available, so write the report and meta files ` +
    `with the Edit or Write tool under BRAIN/output/speculation/). ` +
    `Run the speculate skill for the 2-hour slot ${slot.id}: window start ${new Date(slot.startMs).toISOString()}, ` +
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
    let output = "";
    let timedOut = false;
    let settled = false;
    const done = (run: ClaudeRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const add = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_CAP); // keep the tail: it holds the result or error
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, exitCode: null, timedOut: false, output: String(e instanceof Error ? e.message : e) });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      done({ ok: false, exitCode: null, timedOut: true, output }); // do not wait for pipes to close
    }, timeoutMs);
    child.stdout.on("data", add);
    child.stderr.on("data", add);
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

export const realClaudeRunner: ClaudeRunner = (prompt, args, timeoutMs) => {
  const inv = buildInvocation(prompt, args);
  return spawnOutput(inv.cmd, inv.args, timeoutMs, inv.input);
};
