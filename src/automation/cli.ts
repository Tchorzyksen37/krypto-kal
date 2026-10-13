// automation/cli.ts – `npm run auto -- <tick|status|score>`: the scheduled speculation run.
//   tick    one idempotent tick (generate, check, hand off to the dry-run bot); exit 1 only when it failed
//   status  the last 12 ledger records, the last run-log entry and the next slot start
// A configuration error (BRAIN_DIR unset, bad BOT_CONFIG, a live bot config) is logged to run-log.jsonl, exit 1.
//   score   run the speculation-score skill headless; alerts when it fails
// Dry-run only: the bot store gets policies, never orders.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
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
const PROBE_TIMEOUT_MS = 3_000;
const RUN_LOG = "run-log.jsonl";
const SCORE_PROMPT = "Run the speculation-score skill.";
// MCP tools the speculation-score skill calls beyond the speculate allowlist: the scorer itself, and the fills
// for its fallback when the tool is unavailable (kraken_futures_candles is already in the base list).
const SCORE_MCP_TOOLS = ["speculation_score", "kraken_futures_fills"];

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function alertTo(brainDir: string): (kind: string, detail: string) => Promise<void> {
  const sink = new VaultAlertSink(brainDir);
  return (kind, detail) => sink.send([{ tMs: Date.now(), level: "incident", kind, detail }]);
}

function brainDirOf(env: NodeJS.ProcessEnv): string {
  const dir = env.BRAIN_DIR;
  if (!dir) throw new Error("BRAIN_DIR is not set: the automation needs the vault root");
  return dir;
}

export function stateDirPath(): string {
  return expandHome(STATE_DIR);
}

// True when a TCP connection to host:port opens within timeoutMs. Never throws.
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function buildDeps(env: NodeJS.ProcessEnv, nowMs: number): TickDeps {
  const brainDir = brainDirOf(env);
  const { config } = resolveConfig(env.BOT_CONFIG);
  assertDryRunOnly(config);
  const stateDir = stateDirPath();
  mkdirSync(stateDir, { recursive: true });
  const serverPort = Number(env.PORT ?? 3000);

  // Opened on the first handoff only, so ticks with nothing due never touch the bot database.
  let store: BotStore | undefined;
  const botStore = (): BotStore => (store ??= new BotStore(config.db_path));

  return {
    nowMs,
    now: () => Date.now(),
    stateDir,
    brainDir,
    serverPort,
    probeServer: () => probeTcp("127.0.0.1", serverPort, PROBE_TIMEOUT_MS),
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
    alert: alertTo(brainDir),
    timeoutMs: TIMEOUT_MS,
  };
}

export function appendRunLog(stateDir: string, nowMs: number, r: TickResult): void {
  mkdirSync(stateDir, { recursive: true });
  const line = { at: new Date(nowMs).toISOString(), ...(r.slot ? { slot: r.slot } : {}), status: r.status, detail: r.detail };
  appendFileSync(join(stateDir, RUN_LOG), JSON.stringify(line) + "\n");
}

// A setup error (BRAIN_DIR unset, bad BOT_CONFIG, a live bot config) before any tick could run. The state dir does
// not depend on BRAIN_DIR. Never throws: the error is still printed and the exit code is 1.
export function appendConfigError(stateDir: string, nowMs: number, command: string, detail: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const line = { t: new Date(nowMs).toISOString(), command, status: "config_error", detail };
    appendFileSync(join(stateDir, RUN_LOG), JSON.stringify(line) + "\n");
  } catch (e) {
    console.error(`run log not written: ${message(e)}`);
  }
}

// The last non-empty line of the run log, or undefined. Never throws.
function lastRunLogLine(stateDir: string): string | undefined {
  try {
    const file = join(stateDir, RUN_LOG);
    if (!existsSync(file)) return undefined;
    return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).at(-1);
  } catch {
    return undefined;
  }
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
  const last = lastRunLogLine(stateDir);
  return [`state: ${stateDir}`, ...lines, `last run: ${last ? last.slice(0, 300) : "none"}`, `next slot: ${next}`].join("\n");
}

// The tick allowlist (with the scorecard's Edit path) plus only the score skill's MCP tools; no Bash entry for score.ts.
export function scoreArgs(brainDir: string): string[] {
  return claudeArgs(brainDir, SCORE_MCP_TOOLS);
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

// Builds what a command needs; a failure is a configuration error, logged to the run log and exit code 1.
function setup<T>(command: string, now: number, build: () => T): T | undefined {
  try {
    return build();
  } catch (e) {
    const detail = message(e);
    appendConfigError(stateDirPath(), now, command, detail);
    console.error(`${command}: configuration error: ${detail}`);
    return undefined;
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // The Bash(node src/...) allowlist entries and the Read(./.env) deny rules are relative to the repo root.
  process.chdir(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const now = Date.now();
  switch (argv[0]) {
    case "tick": {
      const deps = setup("tick", now, () => buildDeps(env, now));
      if (!deps) return 1;
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
      const brainDir = setup("score", now, () => brainDirOf(env));
      if (!brainDir) return 1;
      const r = await runScore({ brainDir, runner: realClaudeRunner, alert: alertTo(brainDir), timeoutMs: TIMEOUT_MS });
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
