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

interface SpawnOptions {
  shell?: boolean;
  input?: string; // written to stdin (used instead of an argument when a shell is involved)
}

// Generic spawn helper: never throws, caps output, kills the whole process tree on timeout.
export function spawnOutput(cmd: string, args: string[], timeoutMs: number, opts: SpawnOptions = {}): Promise<ClaudeRun> {
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
      if (output.length < OUTPUT_CAP) output = (output + chunk.toString("utf8")).slice(0, OUTPUT_CAP);
    };
    let child;
    try {
      child = spawn(cmd, args, { shell: opts.shell ?? false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, exitCode: null, timedOut: false, output: String(e instanceof Error ? e.message : e) });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
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

const isEnoent = (r: ClaudeRun): boolean => r.exitCode === null && /ENOENT/.test(r.output);

// cmd.exe quoting is not reliable for these characters, so refuse instead of guessing.
const cmdUnsafe = /["%\r\n]/;

export const realClaudeRunner: ClaudeRunner = async (prompt, args, timeoutMs) => {
  const direct = await spawnOutput("claude", [...args, prompt], timeoutMs);
  if (process.platform !== "win32" || !isEnoent(direct)) return direct;
  // claude.cmd can only be started through a shell. The fixed flags are double-quoted; the prompt goes
  // through stdin so it is never part of the command line.
  if (args.some((a) => cmdUnsafe.test(a))) {
    return { ok: false, exitCode: null, timedOut: false, output: "claude.cmd fallback refused: an argument has characters unsafe for cmd.exe" };
  }
  return spawnOutput("claude.cmd", args.map((a) => `"${a}"`), timeoutMs, { shell: true, input: prompt });
};
