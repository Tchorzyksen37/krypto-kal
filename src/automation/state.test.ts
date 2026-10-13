import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, handledSlots, readLedger, recordSlot } from "./state.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "automation-state-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an empty dir gives an empty ledger", () => {
  withDir((dir) => assert.deepEqual(readLedger(dir), []));
});

test("the latest record per slot wins; failed then handed_off is handled", () => {
  withDir((dir) => {
    recordSlot(dir, { slot: "s1", status: "failed", atMs: 1, detail: "x" });
    recordSlot(dir, { slot: "s1", status: "handed_off", atMs: 2, detail: "ok" });
    assert.equal(readLedger(dir).length, 2);
    assert.ok(handledSlots(readLedger(dir)).has("s1"));
  });
});

test("failed or generated alone is not handled; no_bet and skipped are", () => {
  withDir((dir) => {
    recordSlot(dir, { slot: "a", status: "failed", atMs: 1, detail: "" });
    recordSlot(dir, { slot: "b", status: "generated", atMs: 1, detail: "" });
    recordSlot(dir, { slot: "c", status: "no_bet", atMs: 1, detail: "" });
    recordSlot(dir, { slot: "d", status: "skipped", atMs: 1, detail: "" });
    const handled = handledSlots(readLedger(dir));
    assert.deepEqual([...handled].sort(), ["c", "d"]);
  });
});

test("a corrupt ledger line is ignored", () => {
  withDir((dir) => {
    recordSlot(dir, { slot: "s1", status: "no_bet", atMs: 1, detail: "" });
    appendFileSync(join(dir, "ledger.jsonl"), "{not json\n");
    assert.equal(readLedger(dir).length, 1);
  });
});

test("the lock is exclusive until released", () => {
  withDir((dir) => {
    const now = Date.now();
    const release = acquireLock(dir, now, 15 * 60_000);
    assert.ok(release);
    assert.equal(acquireLock(dir, now, 15 * 60_000), undefined);
    release();
    assert.ok(acquireLock(dir, now, 15 * 60_000));
  });
});

test("a stale lock is replaced", () => {
  withDir((dir) => {
    const now = Date.now();
    writeFileSync(join(dir, "tick.lock"), "old");
    const old = new Date(now - 20 * 60_000);
    utimesSync(join(dir, "tick.lock"), old, old);
    assert.ok(acquireLock(dir, now, 15 * 60_000));
  });
});

test("release by an owner whose lock was replaced keeps the new holder's lock", () => {
  withDir((dir) => {
    const now = Date.now();
    const releaseA = acquireLock(dir, now, 15 * 60_000);
    assert.ok(releaseA);
    const old = new Date(now - 20 * 60_000);
    utimesSync(join(dir, "tick.lock"), old, old);
    const releaseB = acquireLock(dir, now, 15 * 60_000);
    assert.ok(releaseB);
    releaseA();
    assert.ok(existsSync(join(dir, "tick.lock")));
    assert.equal(acquireLock(dir, now, 15 * 60_000), undefined);
    releaseB();
    assert.ok(!existsSync(join(dir, "tick.lock")));
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("releasing twice is harmless", () => {
  withDir((dir) => {
    const now = Date.now();
    const release = acquireLock(dir, now, 1000);
    assert.ok(release);
    release();
    const second = acquireLock(dir, now, 1000);
    assert.ok(second);
    release();
    assert.ok(existsSync(join(dir, "tick.lock")));
  });
});

test("a lock exactly at the stale boundary is not replaced", () => {
  withDir((dir) => {
    const now = 2_000_000_000_000;
    writeFileSync(join(dir, "tick.lock"), "x");
    const t = new Date(now - 15 * 60_000);
    utimesSync(join(dir, "tick.lock"), t, t);
    assert.equal(acquireLock(dir, now, 15 * 60_000), undefined);
  });
});
