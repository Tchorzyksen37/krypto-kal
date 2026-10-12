import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { appendRunLog, buildDeps, exitCodeFor, runScore, scoreArgs, statusText } from "./cli.ts";
import { recordSlot } from "./state.ts";

const NOW = Date.UTC(2026, 9, 12, 10, 5);
const CONFIG = join(import.meta.dirname, "..", "..", "config", "bot.auto.json");

// Point the home directory at a temp dir, so ~/.krypto-kal/automation never touches the real one.
let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => {
  home = mkdtempSync(join(tmpdir(), "auto-cli-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const tempBrain = (): string => mkdtempSync(join(tmpdir(), "auto-cli-brain-"));

describe("buildDeps", () => {
  test("throws naming BRAIN_DIR when it is unset", () => {
    assert.throws(() => buildDeps({}, NOW), /BRAIN_DIR/);
  });

  test("wires the timeout, the state dir and the brain dir", () => {
    const brain = tempBrain();
    const d = buildDeps({ BRAIN_DIR: brain, BOT_CONFIG: CONFIG }, NOW);
    assert.equal(d.timeoutMs, 900_000);
    assert.match(d.stateDir, /automation$/);
    assert.ok(d.stateDir.startsWith(home), d.stateDir);
    assert.ok(existsSync(d.stateDir));
    assert.equal(d.brainDir, brain);
    assert.equal(d.nowMs, NOW);
  });

  test("the alert appends an INCIDENT line with the kind to the vault alerts", async () => {
    const brain = tempBrain();
    const d = buildDeps({ BRAIN_DIR: brain, BOT_CONFIG: CONFIG }, NOW);
    await d.alert("automation_generate_failed", "claude exit code 1");
    const text = readFileSync(join(brain, "output", "bot", "alerts.md"), "utf8");
    assert.match(text, /INCIDENT.*automation_generate_failed.*claude exit code 1/);
  });
});

describe("run log and exit codes", () => {
  test("appendRunLog writes one JSON line per tick", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-cli-state-"));
    appendRunLog(dir, NOW, { slot: "20261012-1000Z", status: "no_bet", detail: "x" });
    appendRunLog(dir, NOW + 1, { status: "nothing_due", detail: "no slot due" });
    const lines = readFileSync(join(dir, "run-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { at: new Date(NOW).toISOString(), slot: "20261012-1000Z", status: "no_bet", detail: "x" });
    assert.equal(lines[1].status, "nothing_due");
  });

  test("only failed exits with 1", () => {
    for (const s of ["handed_off", "no_bet", "nothing_due", "busy"] as const) assert.equal(exitCodeFor(s), 0);
    assert.equal(exitCodeFor("failed"), 1);
  });
});

describe("status", () => {
  test("shows the last 12 records and the next slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-cli-state-"));
    for (let i = 0; i < 14; i++) recordSlot(dir, { slot: `S${i}`, status: "no_bet", atMs: NOW, detail: `d${i}` });
    const text = statusText(dir, NOW);
    assert.ok(!text.includes("S1 "), text);
    assert.ok(text.includes("S2 ") && text.includes("S13 "), text);
    assert.match(text, /next slot: 2026-10-12T12:00:00\.000Z/);
  });

  test("an empty ledger says so", () => {
    const dir = join(tmpdir(), "auto-cli-missing-dir");
    assert.match(statusText(dir, NOW), /no ledger records/);
    assert.ok(!existsSync(dir));
  });
});

describe("score", () => {
  test("scoreArgs keep the tick allowlist and allow writing the scorecard", () => {
    const args = scoreArgs("C:\\vault");
    assert.equal(args[0], "-p");
    assert.ok(args.includes("Write(C:/vault/output/speculation/**)"));
    assert.ok(args.includes("mcp__krypto-kal__*"));
  });

  test("runs the score prompt and alerts on failure", async () => {
    const alerts: string[] = [];
    let prompt = "";
    const r = await runScore({
      brainDir: "C:\\vault",
      runner: async (p) => {
        prompt = p;
        return { ok: false, exitCode: 2, timedOut: false, output: "boom" };
      },
      alert: async (kind, detail) => void alerts.push(`${kind}: ${detail}`),
      timeoutMs: 1000,
    });
    assert.equal(prompt, "Run the speculation-score skill.");
    assert.equal(r.ok, false);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!, /^automation_score_failed: .*exit code 2.*boom/);
  });

  test("a successful score does not alert", async () => {
    const alerts: string[] = [];
    const r = await runScore({
      brainDir: "C:\\vault",
      runner: async () => ({ ok: true, exitCode: 0, timedOut: false, output: "scored 3 bets" }),
      alert: async (kind) => void alerts.push(kind),
      timeoutMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.match(r.detail, /scored 3 bets/);
    assert.equal(alerts.length, 0);
  });
});
