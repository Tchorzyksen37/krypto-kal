import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportMeta } from "../speculation/types.ts";
import type { HandoffResult } from "./handoff.ts";
import type { ClaudeRun } from "./run-claude.ts";
import { slotAt } from "./slots.ts";
import { acquireLock, readLedger } from "./state.ts";
import { tick } from "./tick.ts";
import type { TickDeps } from "./tick.ts";

const NOW = Date.UTC(2026, 9, 12, 14, 1); // one minute into the 14:00Z slot
const SLOT = slotAt(NOW);
const OK_RUN: ClaudeRun = { ok: true, exitCode: 0, timedOut: false, output: "done" };

interface Harness {
  deps: TickDeps;
  stateDir: string;
  metaPath: string;
  prompts: string[];
  checks: string[];
  handoffs: { meta: ReportMeta; nowMs: number; source: string }[];
  alerts: { kind: string; detail: string }[];
}

function writeMeta(path: string, validated: boolean): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const meta: Record<string, unknown> = { bets: [] };
  if (validated) meta.validated = [];
  writeFileSync(path, JSON.stringify(meta));
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "automation-tick-"));
  const stateDir = join(root, "state");
  const brainDir = join(root, "brain");
  const metaPath = join(brainDir, "output", "speculation", "2026-10-12", "1400Z.meta.json");
  const h: Harness = { stateDir, metaPath, prompts: [], checks: [], handoffs: [], alerts: [], deps: undefined as unknown as TickDeps };
  h.deps = {
    nowMs: NOW,
    stateDir,
    brainDir,
    timeoutMs: 60_000,
    runner: async (prompt) => {
      h.prompts.push(prompt);
      writeMeta(metaPath, false);
      return OK_RUN;
    },
    check: async (path) => {
      h.checks.push(path);
      writeMeta(path, true);
    },
    handoff: (meta, nowMs, source): HandoffResult => {
      h.handoffs.push({ meta, nowMs, source });
      return { status: "handed_off", betId: "b1", detail: "stored" };
    },
    alert: async (kind, detail) => {
      h.alerts.push({ kind, detail });
    },
  };
  try {
    await fn(h);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const latest = (stateDir: string, slot: string) => readLedger(stateDir).filter((r) => r.slot === slot).at(-1);

test("happy path: the slot is handed off and the runner gets the slot id", async () => {
  await withHarness(async (h) => {
    const r = await tick(h.deps);
    assert.equal(r.status, "handed_off");
    assert.equal(r.slot, SLOT.id);
    assert.equal(h.prompts.length, 1);
    assert.match(h.prompts[0]!, new RegExp(SLOT.id));
    assert.deepEqual(h.checks, [h.metaPath]);
    assert.equal(h.handoffs.length, 1);
    assert.equal(h.handoffs[0]!.source, h.metaPath);
    assert.ok(Array.isArray(h.handoffs[0]!.meta.validated));
    assert.equal(latest(h.stateDir, SLOT.id)?.status, "handed_off");
    assert.equal(h.alerts.length, 0);
  });
});

test("missed slots are recorded as skipped once", async () => {
  await withHarness(async (h) => {
    await tick(h.deps);
    const skipped = readLedger(h.stateDir).filter((r) => r.status === "skipped").length;
    assert.equal(skipped, 12);
    await tick(h.deps);
    assert.equal(readLedger(h.stateDir).filter((r) => r.status === "skipped").length, 12);
  });
});

test("a second tick for the same slot has nothing due", async () => {
  await withHarness(async (h) => {
    await tick(h.deps);
    const r = await tick(h.deps);
    assert.equal(r.status, "nothing_due");
    assert.equal(h.prompts.length, 1);
  });
});

test("a failed run is recorded, alerted and retried by the next tick", async () => {
  await withHarness(async (h) => {
    const good = h.deps.runner;
    h.deps.runner = async (prompt) => {
      h.prompts.push(prompt);
      return { ok: false, exitCode: 1, timedOut: false, output: "boom" };
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.equal(latest(h.stateDir, SLOT.id)?.status, "failed");
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_generate_failed"]);
    assert.equal(h.handoffs.length, 0);
    h.deps.runner = good;
    const again = await tick(h.deps);
    assert.equal(again.status, "handed_off");
    assert.equal(h.prompts.length, 2);
  });
});

test("an ok run without a meta file fails and does not hand off", async () => {
  await withHarness(async (h) => {
    h.deps.runner = async () => OK_RUN;
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_generate_failed"]);
    assert.equal(h.checks.length, 0);
    assert.equal(h.handoffs.length, 0);
  });
});

test("a meta file with invalid JSON fails generation", async () => {
  await withHarness(async (h) => {
    h.deps.runner = async () => {
      mkdirSync(join(h.metaPath, ".."), { recursive: true });
      writeFileSync(h.metaPath, "{not json");
      return OK_RUN;
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_generate_failed"]);
    assert.equal(h.handoffs.length, 0);
  });
});

test("a throwing check fails the slot and does not hand off", async () => {
  await withHarness(async (h) => {
    h.deps.check = async () => {
      throw new Error("checker down");
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.equal(latest(h.stateDir, SLOT.id)?.status, "failed");
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_check_failed"]);
    assert.match(h.alerts[0]!.detail, /checker down/);
    assert.equal(h.handoffs.length, 0);
  });
});

test("a check that leaves no validated array fails the slot", async () => {
  await withHarness(async (h) => {
    h.deps.check = async () => {};
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_check_failed"]);
    assert.equal(h.handoffs.length, 0);
  });
});

test("no_bet ends the slot without an alert", async () => {
  await withHarness(async (h) => {
    h.deps.handoff = () => ({ status: "no_bet", detail: "no usable bet" });
    const r = await tick(h.deps);
    assert.equal(r.status, "no_bet");
    assert.equal(latest(h.stateDir, SLOT.id)?.status, "no_bet");
    assert.equal(h.alerts.length, 0);
    assert.equal((await tick(h.deps)).status, "nothing_due");
  });
});

test("a failed handoff is recorded and alerted", async () => {
  await withHarness(async (h) => {
    h.deps.handoff = () => ({ status: "failed", detail: "bot store error" });
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.equal(latest(h.stateDir, SLOT.id)?.status, "failed");
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_handoff_failed"]);
  });
});

test("a held lock makes the tick busy", async () => {
  await withHarness(async (h) => {
    const release = acquireLock(h.stateDir, NOW, 1_000_000);
    assert.ok(release);
    const r = await tick(h.deps);
    assert.equal(r.status, "busy");
    assert.equal(h.prompts.length, 0);
    release();
  });
});

test("the lock is released after a throwing runner", async () => {
  await withHarness(async (h) => {
    h.deps.runner = async () => {
      throw new Error("spawn exploded");
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_generate_failed"]);
    assert.equal(existsSync(join(h.stateDir, "tick.lock")), false);
  });
});

test("a throwing alert does not make the tick throw", async () => {
  await withHarness(async (h) => {
    h.deps.runner = async () => ({ ok: false, exitCode: 1, timedOut: false, output: "x" });
    h.deps.alert = async () => {
      throw new Error("alert sink down");
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.equal(existsSync(join(h.stateDir, "tick.lock")), false);
  });
});

test("a stale unvalidated meta does not pass as this run's report", async () => {
  await withHarness(async (h) => {
    writeMeta(h.metaPath, false);
    h.deps.runner = async (prompt) => {
      h.prompts.push(prompt);
      return OK_RUN;
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.equal(h.prompts.length, 1);
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_generate_failed"]);
    assert.equal(h.checks.length, 0);
    assert.equal(h.handoffs.length, 0);
  });
});

test("a stale unvalidated meta is replaced by the run's new one", async () => {
  await withHarness(async (h) => {
    mkdirSync(join(h.metaPath, ".."), { recursive: true });
    writeFileSync(h.metaPath, JSON.stringify({ bets: [], marker: "old" }));
    h.deps.runner = async () => {
      writeFileSync(h.metaPath, JSON.stringify({ bets: [], marker: "new" }), { flag: "wx" });
      return OK_RUN;
    };
    let seen: unknown;
    h.deps.check = async (path) => {
      seen = JSON.parse(readFileSync(path, "utf8")).marker;
      writeFileSync(path, JSON.stringify({ bets: [], marker: "new", validated: [] }));
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "handed_off");
    assert.equal(seen, "new");
  });
});

test("a throwing handoff fails the slot, alerts and releases the lock", async () => {
  await withHarness(async (h) => {
    h.deps.handoff = () => {
      throw new Error("handoff exploded");
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.equal(latest(h.stateDir, SLOT.id)?.status, "failed");
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_handoff_failed"]);
    assert.match(h.alerts[0]!.detail, /handoff exploded/);
    assert.equal(existsSync(join(h.stateDir, "tick.lock")), false);
  });
});

test("a ledger write failure after a successful handoff does not throw", async () => {
  await withHarness(async (h) => {
    const ledger = join(h.stateDir, "ledger.jsonl");
    h.deps.handoff = (meta, nowMs, source) => {
      h.handoffs.push({ meta, nowMs, source });
      rmSync(ledger, { force: true });
      mkdirSync(ledger); // appending to a directory fails
      return { status: "handed_off", betId: "b1", detail: "stored" };
    };
    const r = await tick(h.deps);
    assert.equal(r.status, "failed");
    assert.equal(h.handoffs.length, 1);
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_handoff_failed"]);
    assert.equal(existsSync(join(h.stateDir, "tick.lock")), false);
  });
});

test("a lock error is alerted and the tick does not run", async () => {
  await withHarness(async (h) => {
    mkdirSync(join(h.stateDir, ".."), { recursive: true });
    writeFileSync(h.stateDir, "not a dir");
    const r = await tick(h.deps);
    assert.equal(r.status, "busy");
    assert.equal(h.prompts.length, 0);
    assert.deepEqual(h.alerts.map((a) => a.kind), ["automation_generate_failed"]);
  });
});

test("a current slot past its entry cutoff is nothing_due", async () => {
  await withHarness(async (h) => {
    h.deps.nowMs = SLOT.entryCutoffMs;
    const r = await tick(h.deps);
    assert.equal(r.status, "nothing_due");
    assert.equal(h.prompts.length, 0);
  });
});

test("an already validated meta skips the runner and the check", async () => {
  await withHarness(async (h) => {
    writeMeta(h.metaPath, true);
    const r = await tick(h.deps);
    assert.equal(r.status, "handed_off");
    assert.equal(h.prompts.length, 0);
    assert.equal(h.checks.length, 0);
    assert.equal(h.handoffs.length, 1);
  });
});
