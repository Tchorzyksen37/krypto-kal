// automation/cli.ts – `npm run auto -- <tick|status|score>`: the scheduled speculation run.
//   tick    one idempotent tick (generate, check, hand off to the dry-run bot); exit 1 only when it failed
//   status  the last 12 ledger records and the next slot start
//   score   run the speculation-score skill headless; alerts when it fails
// Dry-run only: the bot store gets policies, never orders.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VaultAlertSink } from "../bot/alerts.ts";
import { BotStore, expandHome } from "../bot/bot-store.ts";
import { resolveConfig } from "../bot/cli.ts";
import { assertDryRunOnly } from "../bot/live-executor.ts";
import { optionsFromEnv, runCheck } from "../speculation/check.ts";
import type { MarketSource } from "../speculation/check.ts";
import { handoff } from "./handoff.ts";
import { claudeArgs, realClaudeRunner } from "./run-claude.ts";
import type { ClaudeRunner } from "./run-claude.ts";
import { SLOT_MS, slotAt } from "./slots.ts";
import { readLedger } from "./state.ts";
import { tick } from "./tick.ts";
import type { TickDeps, TickResult } from "./tick.ts";

const STATE_DIR = "~/.krypto-kal/automation";
const TIMEOUT_MS = 900_000;
const SCORE_PROMPT = "Run the speculation-score skill.";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function alertTo(brainDir: string, nowMs: number): (kind: string, detail: string) => Promise<void> {
  const sink = new VaultAlertSink(brainDir);
  return (kind, detail) => sink.send([{ tMs: nowMs, level: "incident", kind, detail }]);
}

function brainDirOf(env: NodeJS.ProcessEnv): string {
  const dir = env.BRAIN_DIR;
  if (!dir) throw new Error("BRAIN_DIR is not set: the automation needs the vault root");
  return dir;
}

export function stateDirPath(): string {
  return expandHome(STATE_DIR);
}

export function buildDeps(env: NodeJS.ProcessEnv, nowMs: number): TickDeps {
  const brainDir = brainDirOf(env);
  const { config } = resolveConfig(env.BOT_CONFIG);
  assertDryRunOnly(config);
  const stateDir = stateDirPath();
  mkdirSync(stateDir, { recursive: true });

  // Opened on the first handoff only, so ticks with nothing due never touch the bot database.
  let store: BotStore | undefined;
  const botStore = (): BotStore => (store ??= new BotStore(config.db_path));

  return {
    nowMs,
    stateDir,
    brainDir,
    runner: realClaudeRunner,
    async check(metaPath) {
      let market: MarketSource | undefined;
      if (env.SPECULATION_VERIFY?.toLowerCase() !== "false") {
        const { KrakenFuturesClient } = await import("../providers/kraken/kraken-futures-client.ts");
        market = new KrakenFuturesClient({ apiKey: "", apiSecret: "" }); // public endpoints only
      }
      await runCheck(metaPath, optionsFromEnv(env), market);
    },
    handoff: (meta, at, source) => handoff(botStore(), config, meta, at, source),
    alert: alertTo(brainDir, nowMs),
    timeoutMs: TIMEOUT_MS,
  };
}

export function appendRunLog(stateDir: string, nowMs: number, r: TickResult): void {
  mkdirSync(stateDir, { recursive: true });
  const line = { at: new Date(nowMs).toISOString(), ...(r.slot ? { slot: r.slot } : {}), status: r.status, detail: r.detail };
  appendFileSync(join(stateDir, "run-log.jsonl"), JSON.stringify(line) + "\n");
}

export function exitCodeFor(status: TickResult["status"]): number {
  return status === "failed" ? 1 : 0;
}

// Read-only: never creates the state dir.
export function statusText(stateDir: string, nowMs: number): string {
  const records = readLedger(stateDir).slice(-12);
  const lines = records.length
    ? records.map((r) => `${r.slot} ${r.status.padEnd(10)} ${new Date(r.atMs).toISOString()}  ${r.detail.replace(/\r?\n/g, " ").slice(0, 160)}`)
    : ["no ledger records yet"];
  const next = new Date(slotAt(nowMs).startMs + SLOT_MS).toISOString();
  return [`state: ${stateDir}`, ...lines, `next slot: ${next}`].join("\n");
}

// The tick allowlist, plus the score script the skill falls back to. The scorecard lives under
// output/speculation/, which the tick's Write entry already covers; it is added only if missing.
export function scoreArgs(brainDir: string): string[] {
  const args = claudeArgs(brainDir);
  const write = `Write(${brainDir.replace(/\\/g, "/").replace(/\/+$/, "")}/output/speculation/**)`;
  if (!args.includes(write)) args.push(write);
  args.push("Bash(node src/speculation/score.ts:*)", "Bash(node --env-file-if-exists=.env src/speculation/score.ts:*)");
  return args;
}

export interface ScoreDeps {
  brainDir: string;
  runner: ClaudeRunner;
  alert(kind: string, detail: string): Promise<void>;
  timeoutMs: number;
}

export async function runScore(d: ScoreDeps): Promise<{ ok: boolean; detail: string }> {
  let detail: string;
  try {
    const run = await d.runner(SCORE_PROMPT, scoreArgs(d.brainDir), d.timeoutMs);
    if (run.ok) return { ok: true, detail: run.output.trim().slice(-2000) };
    detail = `claude ${run.timedOut ? "timed out" : `exit code ${run.exitCode}`}: ${run.output.slice(-500)}`;
  } catch (e) {
    detail = `runner threw: ${message(e)}`;
  }
  try {
    await d.alert("automation_score_failed", detail);
  } catch {
    // an alert sink failure must not hide the score failure
  }
  return { ok: false, detail };
}

async function main(argv: string[]): Promise<number> {
  // The Bash(node src/...) allowlist entries are relative to the repo root.
  process.chdir(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const now = Date.now();
  switch (argv[0]) {
    case "tick": {
      const deps = buildDeps(process.env, now);
      const r = await tick(deps);
      try {
        appendRunLog(deps.stateDir, now, r);
      } catch (e) {
        console.error(`run log not written: ${message(e)}`);
      }
      console.log(`${r.slot ?? "-"} ${r.status}: ${r.detail.replace(/\r?\n/g, " ")}`);
      return exitCodeFor(r.status);
    }
    case "status":
      console.log(statusText(stateDirPath(), now));
      return 0;
    case "score": {
      const brainDir = brainDirOf(process.env);
      const r = await runScore({ brainDir, runner: realClaudeRunner, alert: alertTo(brainDir, now), timeoutMs: TIMEOUT_MS });
      console.log(`score ${r.ok ? "ok" : "failed"}: ${r.detail}`);
      return r.ok ? 0 : 1;
    }
    default:
      console.error("usage: npm run auto -- <tick|status|score>");
      return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(message(e));
      process.exitCode = 1;
    },
  );
}
