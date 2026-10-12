import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvocation, claudeArgs, spawnOutput, speculatePrompt } from "./run-claude.ts";
import type { Slot } from "./slots.ts";

const slot: Slot = {
  id: "20261012-1400Z",
  startMs: Date.parse("2026-10-12T14:00:00Z"),
  endMs: Date.parse("2026-10-12T16:00:00Z"),
  session: "us",
  entryCutoffMs: Date.parse("2026-10-12T15:00:00Z"),
};

test("speculatePrompt names the slot, window, session and file name", () => {
  const p = speculatePrompt(slot);
  assert.ok(p.includes("20261012-1400Z"));
  assert.ok(p.includes("2026-10-12T14:00:00.000Z"));
  assert.ok(p.includes("2026-10-12T16:00:00.000Z"));
  assert.ok(p.includes("session us"));
  assert.ok(p.includes("HHMMZ=1400Z"));
  assert.ok(p.includes("Do not offer to hand bets to the bot."));
});

test("claudeArgs has the allowlist and no bypass flag", () => {
  const args = claudeArgs("C:/v");
  assert.equal(args[0], "-p");
  assert.ok(args.includes("--allowedTools"));
  for (const pat of [
    "mcp__krypto-kal__*",
    "Read",
    "Write(C:/v/output/speculation/**)",
    "Edit(C:/v/output/speculation/**)",
    "Bash(node src/speculation/check.ts:*)",
    "Bash(node src/speculation/sessions.ts:*)",
  ]) assert.ok(args.includes(pat), pat);
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
