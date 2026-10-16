import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absoluteRulePath, buildInvocation, claudeArgs, parseClaudeJson, spawnOutput, speculatePrompt, writeRunLog } from "./run-claude.ts";
import type { ClaudeRun } from "./run-claude.ts";
import type { Slot } from "./slots.ts";

const slot: Slot = {
  id: "20261012-1400Z",
  startMs: Date.parse("2026-10-12T14:00:00Z"),
  endMs: Date.parse("2026-10-12T14:30:00Z"),
  session: "us",
  entryCutoffMs: Date.parse("2026-10-12T14:30:00Z"),
};

test("speculatePrompt names the slot, window, session and file name", () => {
  const p = speculatePrompt(slot, "C:\\vault\\brain");
  assert.ok(p.includes("20261012-1400Z"));
  assert.ok(p.includes("2026-10-12T14:00:00.000Z"));
  assert.ok(p.includes("2026-10-12T14:30:00.000Z"));
  assert.ok(p.includes("30-minute slot"));
  assert.ok(p.includes("session us"));
  assert.ok(p.includes("HHMMZ=1400Z"));
  assert.ok(p.includes("Do not offer to hand bets to the bot."));
});

test("speculatePrompt states BRAIN, because the run may not read .env", () => {
  const p = speculatePrompt(slot, "C:\\vault\\brain");
  assert.ok(p.includes("BRAIN is C:\\vault\\brain"));
  assert.ok(p.includes("write the report and meta files with the Edit or Write tool"));
});

// The values of a variadic flag: everything after it up to the next `--flag`.
function flagValues(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const rest = args.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
}

test("absoluteRulePath turns Windows paths into the // POSIX form of permission rules", () => {
  assert.equal(absoluteRulePath("C:\\vault"), "//c/vault");
  assert.equal(absoluteRulePath("C:/vault"), "//c/vault");
  assert.equal(absoluteRulePath("C:\\Users\\a b\\My Vault\\"), "//c/Users/a b/My Vault");
  assert.equal(absoluteRulePath("D:\\x\\y"), "//d/x/y");
  assert.equal(absoluteRulePath("/home/u/vault/"), "//home/u/vault");
  assert.equal(absoluteRulePath("\\\\server\\share\\vault"), "//server/share/vault");
});

test("claudeArgs allows Edit of the speculation folder by an absolute // rule and no Write rule", () => {
  for (const [dir, want] of [
    ["C:\\vault", "Edit(//c/vault/output/speculation/**)"],
    ["C:/vault", "Edit(//c/vault/output/speculation/**)"],
    ["C:\\Users\\mtchorze\\OneDrive\\Documents\\my vault", "Edit(//c/Users/mtchorze/OneDrive/Documents/my vault/output/speculation/**)"],
  ] as const) {
    const allowed = flagValues(claudeArgs(dir), "--allowedTools");
    assert.ok(allowed.includes(want), `${dir}: ${allowed.join(" ")}`);
    assert.equal(allowed.filter((a) => a.startsWith("Edit(")).length, 1);
    assert.ok(!allowed.some((a) => a.startsWith("Write")), allowed.join(" "));
  }
});

test("claudeArgs has a narrow allowlist, denies .env and has no bypass flag", () => {
  const args = claudeArgs("C:/v");
  assert.equal(args[0], "-p");
  const allowed = flagValues(args, "--allowedTools");
  for (const pat of [
    "mcp__krypto-kal__speculation_context",
    "mcp__krypto-kal__kraken_futures_candles",
    "mcp__krypto-kal__yahoo_quote",
    "mcp__krypto-kal__yahoo_history",
    "mcp__krypto-kal__coinalyze_ohlcv_history",
    "mcp__krypto-kal__x_recent",
    "mcp__krypto-kal__brain_read",
    "mcp__krypto-kal__brain_related",
    "Read",
    "Bash(node src/speculation/check.ts:*)",
    "Bash(node src/speculation/sessions.ts:*)",
  ]) assert.ok(allowed.includes(pat), pat);
  assert.ok(!allowed.some((a) => a.includes("*") && a.startsWith("mcp__")), "no MCP wildcard");
  for (const banned of [
    "brain_write",
    "brain_ingest_mark",
    "x_sync",
    "server_stats",
    "speculation_score",
    "kraken_futures_positions",
    "kraken_futures_open_orders",
    "kraken_futures_fills",
    "kraken_futures_pnl",
    "bot_status",
  ]) assert.ok(!allowed.includes(`mcp__krypto-kal__${banned}`), banned);
  assert.ok(!allowed.includes("WebSearch") && !allowed.includes("WebFetch"));
  assert.deepEqual(flagValues(args, "--disallowedTools"), ["Read(./.env)", "Read(./.env.*)"]);
  assert.ok(!args.join(" ").includes("dangerously"));
});

test("spawnOutput returns output of a successful command", async () => {
  const r = await spawnOutput(process.execPath, ["-e", "console.log('hi')"], 10_000);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.trim(), "hi");
});

test("spawnOutput reports a non-zero exit code", async () => {
  const r = await spawnOutput(process.execPath, ["-e", "process.exit(3)"], 10_000);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
});

test("spawnOutput kills a command on timeout", async () => {
  const t0 = Date.now();
  const r = await spawnOutput(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 200);
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 4000);
});

test("spawnOutput caps output and never throws on a missing command", async () => {
  const big = await spawnOutput(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], 10_000);
  assert.ok(big.output.length <= 20_000);
  const r = await spawnOutput("definitely-not-a-command-xyz", [], 5_000);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.ok(r.output.length > 0);
});

test("spawnOutput passes input on stdin", async () => {
  const code = "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('got:'+d))";
  const r = await spawnOutput(process.execPath, ["-e", code], 10_000, "hello prompt");
  assert.equal(r.output, "got:hello prompt");
});

test("spawnOutput keeps the tail when capping", async () => {
  const r = await spawnOutput(process.execPath, ["-e", "process.stdout.write('a'.repeat(30000)+'END')"], 10_000);
  assert.equal(r.output.length, 20_000);
  assert.ok(r.output.endsWith("END"));
});

test("buildInvocation keeps the prompt out of the arguments", () => {
  const args = claudeArgs("C:/v");
  const inv = buildInvocation("my prompt", args);
  assert.equal(inv.cmd, "claude");
  assert.deepEqual(inv.args, args);
  assert.ok(!inv.args.includes("my prompt"));
  assert.equal(inv.input, "my prompt");
});

test("spawnOutput returns stdout and stderr separately, and the duration", async () => {
  const r = await spawnOutput(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err')"], 10_000);
  assert.equal(r.stdout, "out");
  assert.equal(r.stderr, "err");
  assert.ok((r.durationMs ?? -1) >= 0);
});

test("spawnOutput caps the raw stdout but keeps its head", async () => {
  const r = await spawnOutput(process.execPath, ["-e", "process.stdout.write('H'+'x'.repeat(3000000))"], 20_000);
  assert.ok(r.stdout!.startsWith("H"));
  assert.ok(r.stdout!.length < 2_100_000);
});

test("parseClaudeJson reads the result and the permission denials", () => {
  const obj = { type: "result", result: "done", permission_denials: [{ tool_name: "Glob" }] };
  assert.deepEqual(parseClaudeJson(JSON.stringify(obj)), { result: "done", denials: [{ tool_name: "Glob" }] });
  assert.deepEqual(parseClaudeJson(JSON.stringify([{ type: "system" }, obj])), { result: "done", denials: [{ tool_name: "Glob" }] });
  assert.deepEqual(parseClaudeJson('{"type":"result"}'), { denials: [] });
  assert.equal(parseClaudeJson("not json"), undefined);
  assert.equal(parseClaudeJson(""), undefined);
});

test("writeRunLog writes one file per run with the streams, the slot and no prompt", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "runlog-")), "runs");
  const run: ClaudeRun = { ok: false, exitCode: 1, timedOut: false, output: "x", stdout: "OUT", stderr: "ERR", durationMs: 5, denials: [{ tool_name: "Glob" }] };
  writeRunLog(dir, "tick", "Run the speculate skill for the 30-minute slot 20261015-1400Z: secret prompt", run, Date.parse("2026-10-15T14:00:01Z"));
  const files = readdirSync(dir);
  assert.deepEqual(files, ["2026-10-15T14-00-01-000Z-tick.json"]);
  const text = readFileSync(join(dir, files[0]!), "utf8");
  const body = JSON.parse(text);
  assert.equal(body.slot, "20261015-1400Z");
  assert.equal(body.stdout, "OUT");
  assert.equal(body.stderr, "ERR");
  assert.deepEqual(body.denials, [{ tool_name: "Glob" }]);
  assert.ok(!text.includes("secret prompt"));
});

test("writeRunLog keeps the newest 300 files and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "runlog-prune-"));
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 305; i++) writeFileSync(join(dir, `2026-01-01T00-00-${String(i).padStart(3, "0")}Z-tick.json`), "{}");
  writeRunLog(dir, "tick", "p", { ok: true, exitCode: 0, timedOut: false, output: "" }, Date.parse("2026-10-15T00:00:00Z"));
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 300);
  assert.ok(files.at(-1)!.startsWith("2026-10-15"));
  // an unwritable location (a file where the directory should be) is swallowed
  const blocker = join(mkdtempSync(join(tmpdir(), "runlog-bad-")), "file");
  writeFileSync(blocker, "x");
  assert.doesNotThrow(() => writeRunLog(join(blocker, "runs"), "tick", "p", { ok: true, exitCode: 0, timedOut: false, output: "" }));
});
