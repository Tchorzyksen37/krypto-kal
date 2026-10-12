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

export function speculatePrompt(slot: Slot): string {
  const hhmm = new Date(slot.startMs).toISOString().slice(11, 16).replace(":", "");
  return (
    `Run the speculate skill for the 2-hour slot ${slot.id}: window start ${new Date(slot.startMs).toISOString()}, ` +
    `window end ${new Date(slot.endMs).toISOString()}, session ${slot.session}. ` +
    `Use exactly this window as the report's window and file name HHMMZ=${hhmm}Z. Do not offer to hand bets to the bot.`
  );
}

// No bypass flag: anything outside this list is denied in headless mode.
// The Windows form of the Write/Edit path patterns is unverified; the first real `claude -p` run checks it.
export function claudeArgs(brainDir: string): string[] {
  const dir = brainDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return [
    "-p",
    "--allowedTools",
    "mcp__krypto-kal__*",
    "Read",
    `Write(${dir}/output/speculation/**)`,
    `Edit(${dir}/output/speculation/**)`,
    "Bash(node src/speculation/check.ts:*)",
    "Bash(node src/speculation/sessions.ts:*)",
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
