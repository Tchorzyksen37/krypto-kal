// automation/tick.ts – one idempotent run of the scheduler: take the lock, pick the due slot, generate the
// report with `claude`, check it, hand the best bet to the dry-run bot and record the outcome in the ledger.
// Never throws: every failure is recorded as `failed` and alerted, so a later tick retries within the cutoff.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ReportMeta } from "../speculation/types.ts";
import type { HandoffResult } from "./handoff.ts";
import { claudeArgs, speculatePrompt } from "./run-claude.ts";
import type { ClaudeRunner } from "./run-claude.ts";
import { dueSlot } from "./slots.ts";
import type { Slot } from "./slots.ts";
import { acquireLock, handledSlots, readLedger, recordSlot } from "./state.ts";
import type { SlotStatus } from "./state.ts";

export interface TickDeps {
  nowMs: number;
  stateDir: string;
  brainDir: string;
  runner: ClaudeRunner;
  check(metaPath: string): Promise<void>;
  handoff(meta: ReportMeta, nowMs: number, source: string): HandoffResult;
  alert(kind: string, detail: string): Promise<void>;
  timeoutMs: number;
}

export interface TickResult {
  slot?: string;
  status: SlotStatus | "busy" | "nothing_due";
  detail: string;
}

// <brainDir>/output/speculation/<YYYY-MM-DD>/<HHMM>Z.meta.json, all from the slot start in UTC.
export function reportMetaPath(brainDir: string, slot: Slot): string {
  const iso = new Date(slot.startMs).toISOString();
  const hhmm = iso.slice(11, 16).replace(":", "");
  return join(brainDir, "output", "speculation", iso.slice(0, 10), `${hhmm}Z.meta.json`);
}

// The parsed meta, or undefined when the file is missing or not a JSON object.
function readMeta(path: string): ReportMeta | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as ReportMeta) : undefined;
  } catch {
    return undefined;
  }
}

const isValidated = (meta: ReportMeta | undefined): meta is ReportMeta => !!meta && Array.isArray(meta.validated);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function tick(d: TickDeps): Promise<TickResult> {
  let release: (() => void) | undefined;
  try {
    release = acquireLock(d.stateDir, d.nowMs, d.timeoutMs + 60_000);
  } catch (e) {
    const detail = `lock error: ${message(e)}`;
    try {
      await d.alert("automation_generate_failed", detail);
    } catch {
      // an alert sink failure must not break the tick
    }
    return { status: "busy", detail };
  }
  if (!release) return { status: "busy", detail: "another tick holds the lock" };

  let slot: Slot | undefined;
  const fail = async (kind: string, detail: string): Promise<TickResult> => {
    try {
      if (slot) recordSlot(d.stateDir, { slot: slot.id, status: "failed", atMs: d.nowMs, detail });
    } catch {
      // the ledger is unwritable; the alert still goes out
    }
    try {
      await d.alert(kind, slot ? `${slot.id}: ${detail}` : detail);
    } catch {
      // an alert sink failure must not break the tick
    }
    return { ...(slot ? { slot: slot.id } : {}), status: "failed", detail };
  };

  try {
    const { due, missed } = dueSlot(d.nowMs, handledSlots(readLedger(d.stateDir)));
    for (const m of missed) recordSlot(d.stateDir, { slot: m.id, status: "skipped", atMs: d.nowMs, detail: "missed: past its entry cutoff" });
    if (!due) return { status: "nothing_due", detail: missed.length ? `${missed.length} missed slot(s) skipped` : "no slot due" };
    slot = due;

    const metaPath = reportMetaPath(d.brainDir, due);
    let meta = readMeta(metaPath);
    if (!isValidated(meta)) {
      // A validated meta means a crash after the check: go straight to the handoff.
      // An unvalidated one is left over from a failed attempt; remove it so it cannot pass as this run's.
      if (existsSync(metaPath)) {
        try {
          unlinkSync(metaPath);
        } catch (e) {
          return await fail("automation_generate_failed", `cannot remove the stale meta ${metaPath}: ${message(e)}`);
        }
      }
      let run;
      try {
        run = await d.runner(speculatePrompt(due), claudeArgs(d.brainDir), d.timeoutMs);
      } catch (e) {
        return await fail("automation_generate_failed", `runner threw: ${message(e)}`);
      }
      if (!run.ok) {
        const why = run.timedOut ? "timed out" : `exit code ${run.exitCode}`;
        return await fail("automation_generate_failed", `claude ${why}: ${run.output.slice(-500)}`);
      }
      if (!readMeta(metaPath)) return await fail("automation_generate_failed", `no valid report meta at ${metaPath}`);

      try {
        await d.check(metaPath);
      } catch (e) {
        return await fail("automation_check_failed", `check threw: ${message(e)}`);
      }
      meta = readMeta(metaPath);
      if (!isValidated(meta)) return await fail("automation_check_failed", `the check left no validated bets in ${metaPath}`);
    }

    const r = d.handoff(meta, d.nowMs, metaPath);
    if (r.status === "failed") return await fail("automation_handoff_failed", r.detail);
    recordSlot(d.stateDir, { slot: due.id, status: r.status, atMs: d.nowMs, detail: r.detail });
    return { slot: due.id, status: r.status, detail: r.detail };
  } catch (e) {
    return await fail(slot ? "automation_handoff_failed" : "automation_generate_failed", `tick error: ${message(e)}`);
  } finally {
    release();
  }
}
