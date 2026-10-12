// Automation state files: an append-only slot ledger (ledger.jsonl) and an exclusive tick lock (tick.lock).
// Sync fs calls on purpose: the files are tiny and the tick is a short-lived process.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SlotStatus = "generated" | "handed_off" | "no_bet" | "failed" | "skipped";

export interface SlotRecord {
  slot: string;
  status: SlotStatus;
  atMs: number;
  detail: string;
}

const LEDGER = "ledger.jsonl";
const LOCK = "tick.lock";

// All records in file order; corrupt lines are skipped. A missing file is an empty ledger.
export function readLedger(dir: string): SlotRecord[] {
  const file = join(dir, LEDGER);
  if (!existsSync(file)) return [];
  const out: SlotRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SlotRecord;
      if (r && typeof r.slot === "string" && typeof r.status === "string") out.push(r);
    } catch {
      // ignore a partial or corrupt line
    }
  }
  return out;
}

export function recordSlot(dir: string, r: SlotRecord): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, LEDGER), JSON.stringify(r) + "\n");
}

// Slots whose latest record is final; failed and generated slots are retried.
export function handledSlots(records: SlotRecord[]): Set<string> {
  const latest = new Map<string, SlotStatus>();
  for (const r of records) latest.set(r.slot, r.status);
  const handled = new Set<string>();
  for (const [slot, status] of latest) {
    if (status === "handed_off" || status === "no_bet" || status === "skipped") handled.add(slot);
  }
  return handled;
}

// Creates the lock exclusively; a lock older than staleMs (by mtime) is replaced.
// Returns the release function, or undefined when another tick holds the lock.
export function acquireLock(dir: string, nowMs: number, staleMs: number): (() => void) | undefined {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, LOCK);
  const release = () => {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(nowMs), { flag: "wx" });
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age: number;
      try {
        age = nowMs - statSync(file).mtimeMs;
      } catch {
        continue; // vanished between the two calls: try again
      }
      if (age <= staleMs) return undefined;
      release();
    }
  }
  return undefined;
}
