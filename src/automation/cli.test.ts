import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { appendRunLog, buildDeps, exitCodeFor, main, probeTcp, runScore, scoreArgs, stateDirPath, statusText } from "./cli.ts";
import { claudeArgs } from "./run-claude.ts";
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
    assert.equal(d.serverPort, 3000);
    assert.equal(typeof d.probeServer, "function");
    const t = d.now();
    assert.ok(Math.abs(t - Date.now()) < 5_000);
  });

  test("the server port comes from PORT", () => {
    const d = buildDeps({ BRAIN_DIR: tempBrain(), BOT_CONFIG: CONFIG, PORT: "3456" }, NOW);
    assert.equal(d.serverPort, 3456);
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

describe("server probe", () => {
  test("probeTcp is true for a listening port and false for a closed one", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      assert.equal(await probeTcp("127.0.0.1", port, 3_000), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.equal(await probeTcp("127.0.0.1", port, 3_000), false);
  });
});

describe("configuration errors", () => {
  const lastRunLog = (): Record<string, unknown> => {
    const lines = readFileSync(join(stateDirPath(), "run-log.jsonl"), "utf8").trim().split("\n");
    return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  };

  test("a tick without BRAIN_DIR exits 1 and leaves a config_error line in the run log", async () => {
    const code = await main(["tick"], {});
    assert.equal(code, 1);
    const line = lastRunLog();
    assert.equal(line.command, "tick");
    assert.equal(line.status, "config_error");
    assert.match(String(line.detail), /BRAIN_DIR/);
    assert.ok(typeof line.t === "string" && !Number.isNaN(Date.parse(line.t)));
  });

  test("a bad BOT_CONFIG is logged too", async () => {
    const code = await main(["tick"], { BRAIN_DIR: tempBrain(), BOT_CONFIG: join(tmpdir(), "no-such-bot-config.json") });
    assert.equal(code, 1);
    assert.equal(lastRunLog().status, "config_error");
  });

  test("a score without BRAIN_DIR is logged as well", async () => {
    assert.equal(await main(["score"], {}), 1);
    const line = lastRunLog();
    assert.equal(line.command, "score");
    assert.equal(line.status, "config_error");
  });

  test("status shows the last run-log entry", async () => {
    await main(["tick"], {});
    const text = statusText(stateDirPath(), NOW);
    assert.match(text, /last run: .*config_error.*BRAIN_DIR/);
  });
});

describe("status", () => {
  test("shows the last 12 records and the next slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-cli-state-"));
    for (let i = 0; i < 14; i++) recordSlot(dir, { slot: `S${i}`, status: "no_bet", atMs: NOW, detail: `d${i}` });
    const text = statusText(dir, NOW);
    assert.ok(!text.includes("S1 "), text);
    assert.ok(text.includes("S2 ") && text.includes("S13 "), text);
    assert.match(text, /next slot: 2026-10-12T10:30:00\.000Z/);
  });

  test("the last run-log line is shown on one line", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-cli-state-"));
    appendRunLog(dir, NOW, { slot: "S1", status: "failed", detail: "a\nb" });
    writeFileSync(join(dir, "run-log.jsonl"), readFileSync(join(dir, "run-log.jsonl"), "utf8") + "\n");
    const text = statusText(dir, NOW);
    const last = text.split("\n").find((l) => l.startsWith("last run: "));
    assert.ok(last && last.includes('"status":"failed"'), text);
  });

  test("an empty ledger says so", () => {
    const dir = join(tmpdir(), "auto-cli-missing-dir");
    assert.match(statusText(dir, NOW), /no ledger records/);
    assert.ok(!existsSync(dir));
  });
});

describe("score", () => {
  test("scoreArgs are the tick allowlist plus only the score skill's MCP tools, with no wider Bash and no bypass flag", () => {
    const args = scoreArgs("C:\\vault");
    const base = claudeArgs("C:\\vault");
    const extra = args.filter((a) => !base.includes(a));
    assert.deepEqual(extra.sort(), ["mcp__krypto-kal__kraken_futures_fills", "mcp__krypto-kal__speculation_score"]);
    assert.ok(base.every((a) => args.includes(a)));
    assert.ok(!args.includes("mcp__krypto-kal__*"));
    assert.ok(!args.includes("mcp__krypto-kal__brain_write"));
    const deny = args.slice(args.indexOf("--disallowedTools") + 1);
    assert.deepEqual(deny, ["Read(./.env)", "Read(./.env.*)"]);
    assert.ok(!args.some((a) => a.startsWith("Bash(node src/speculation/score.ts")), args.join(" "));
    assert.ok(!args.some((a) => a === "Bash" || /^Bash\(\s*\*?\s*(:\*)?\s*\)$/.test(a)), args.join(" "));
    assert.ok(!args.some((a) => /dangerously/i.test(a)), args.join(" "));
  });

  test("runs the score prompt with scoreArgs and alerts on failure", async () => {
    const alerts: string[] = [];
    let prompt = "";
    let passed: string[] = [];
    const r = await runScore({
      brainDir: "C:\\vault",
      runner: async (p, a) => {
        prompt = p;
        passed = a;
        return { ok: false, exitCode: 2, timedOut: false, output: "boom" };
      },
      alert: async (kind, detail) => void alerts.push(`${kind}: ${detail}`),
      timeoutMs: 1000,
    });
    assert.ok(prompt.includes("BRAIN is C:\\vault") && prompt.endsWith("Run the speculation-score skill."));
    assert.deepEqual(passed, scoreArgs("C:\\vault"));
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
