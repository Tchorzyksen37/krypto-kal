// automation/tick.ts – one idempotent run of the scheduler: take the lock, pick the due slot, generate the
// report with `claude`, check it, hand the best bet to the dry-run bot and record the outcome in the ledger.
// Never throws: every failure is recorded as `failed` and alerted, so a later tick retries within the cutoff.
// Limits per slot: after MAX_FAILED_ATTEMPTS counted failures the slot is skipped (one `automation_gave_up` alert);
// `server_down` and `foreign_report` failures cost no claude run, do not count, and alert once per slot each.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { normalizeWindow } from "../speculation/check.ts";
import type { ReportMeta } from "../speculation/types.ts";
import type { HandoffResult } from "./handoff.ts";
import { claudeArgs, speculatePrompt } from "./run-claude.ts";
import type { ClaudeRunner } from "./run-claude.ts";
import { dueSlot } from "./slots.ts";
import type { Slot } from "./slots.ts";
import { acquireLock, handledSlots, readLedger, recordSlot } from "./state.ts";
import type { SlotRecord, SlotStatus } from "./state.ts";

export interface TickDeps {
  nowMs: number; // the tick start: slot choice and ledger times
  now(): number; // the current time, read again after the run for the handoff
  stateDir: string;
  brainDir: string;
  serverPort: number;
  probeServer(): Promise<boolean>; // is the MCP server reachable? called only before a claude run
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

export const MAX_FAILED_ATTEMPTS = 2;
const SERVER_DOWN = "server_down";
const FOREIGN_REPORT = "foreign_report";
const LOCK_GRACE_MS = 300_000;

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
    return meta && typeof meta === "object" && !Array.isArray(meta) ? normalizeWindow(meta as ReportMeta) : undefined;
  } catch {
    return undefined;
  }
}

// A slot report has exactly the slot's window (compared as instants) and the slot's session. A manual
// session report can have the same file name (session start = slot start), but not the slot's window.
export function metaMatchesSlot(meta: ReportMeta, slot: Slot): boolean {
  const w = meta.window as unknown;
  if (!Array.isArray(w) || w.length !== 2 || typeof w[0] !== "string" || typeof w[1] !== "string") return false;
  return Date.parse(w[0]) === slot.startMs && Date.parse(w[1]) === slot.endMs && meta.session === slot.session;
}

const describeMeta = (meta: ReportMeta): string =>
  `window ${JSON.stringify(meta.window ?? null)}, session ${JSON.stringify(meta.session ?? null)}`;
const isValidated = (meta: ReportMeta | undefined): meta is ReportMeta => !!meta && Array.isArray(meta.validated);
// The end of what claude printed, on one line (the alert log is one bullet per line). A run that exits 0 without
// writing its report usually says why there (a denied tool, a question, a login prompt).
const OUTPUT_TAIL_CHARS = 500;
export function outputTail(output: string): string {
  const flat = output.replace(/\s+/g, " ").trim();
  if (!flat) return "(empty)";
  return flat.length > OUTPUT_TAIL_CHARS ? `...${flat.slice(-OUTPUT_TAIL_CHARS)}` : flat;
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Failures that cost a claude run (or a check or a handoff) and therefore count toward the cap.
const countedFailure = (r: SlotRecord): boolean =>
  r.status === "failed" && !r.detail.startsWith(SERVER_DOWN) && !r.detail.startsWith(FOREIGN_REPORT);

export async function tick(d: TickDeps): Promise<TickResult> {
  let release: (() => void) | undefined;
  try {
    release = acquireLock(d.stateDir, d.nowMs, d.timeoutMs + LOCK_GRACE_MS);
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
  let history: SlotRecord[] = []; // the due slot's earlier ledger records
  const alert = async (kind: string, detail: string): Promise<void> => {
    try {
      await d.alert(kind, slot ? `${slot.id}: ${detail}` : detail);
    } catch {
      // an alert sink failure must not break the tick
    }
  };
  // Records the slot as failed and alerts; with `alertOnce`, only when no earlier failure of the slot has that prefix.
  const fail = async (kind: string, detail: string, alertOnce?: string): Promise<TickResult> => {
    try {
      if (slot) recordSlot(d.stateDir, { slot: slot.id, status: "failed", atMs: d.nowMs, detail });
    } catch {
      // the ledger is unwritable; the alert still goes out
    }
    const alerted = alertOnce !== undefined && history.some((r) => r.status === "failed" && r.detail.startsWith(alertOnce));
    if (!alerted) await alert(kind, detail);
    return { ...(slot ? { slot: slot.id } : {}), status: "failed", detail };
  };

  try {
    const ledger = readLedger(d.stateDir);
    const { due, missed } = dueSlot(d.nowMs, handledSlots(ledger));
    for (const m of missed) recordSlot(d.stateDir, { slot: m.id, status: "skipped", atMs: d.nowMs, detail: "missed: past its entry cutoff" });
    if (!due) return { status: "nothing_due", detail: missed.length ? `${missed.length} missed slot(s) skipped` : "no slot due" };
    slot = due;
    history = ledger.filter((r) => r.slot === due.id);

    if (history.filter(countedFailure).length >= MAX_FAILED_ATTEMPTS) {
      const detail = `gave up after ${MAX_FAILED_ATTEMPTS} failed attempts`;
      recordSlot(d.stateDir, { slot: due.id, status: "skipped", atMs: d.nowMs, detail });
      await alert("automation_gave_up", detail);
      return { slot: due.id, status: "skipped", detail };
    }

    const metaPath = reportMetaPath(d.brainDir, due);
    let meta = readMeta(metaPath);
    if (meta && !metaMatchesSlot(meta, due)) {
      // Not this slot's report (most likely a manual /speculate with the same file name): keep it, and do not
      // run claude, which would overwrite it.
      return await fail(
        "automation_report_mismatch",
        `${FOREIGN_REPORT}: ${metaPath} has ${describeMeta(meta)}, not this slot's; left untouched`,
        FOREIGN_REPORT,
      );
    }
    if (!isValidated(meta)) {
      // A validated meta means a crash after the check: go straight to the handoff.
      // Without the MCP server the run would have no market data: do not spend it.
      if (!(await d.probeServer())) {
        return await fail("automation_server_down", `${SERVER_DOWN}: MCP server not reachable on port ${d.serverPort}`, SERVER_DOWN);
      }
      // An unvalidated meta of this slot, or an unreadable file, is left over from a failed attempt; remove it so
      // it cannot pass as this run's.
      if (existsSync(metaPath)) {
        try {
          unlinkSync(metaPath);
        } catch (e) {
          return await fail("automation_generate_failed", `cannot remove the stale meta ${metaPath}: ${message(e)}`);
        }
      }
      let run;
      try {
        run = await d.runner(speculatePrompt(due, d.brainDir), claudeArgs(d.brainDir), d.timeoutMs);
      } catch (e) {
        return await fail("automation_generate_failed", `runner threw: ${message(e)}`);
      }
      if (!run.ok) {
        const why = run.timedOut ? "timed out" : `exit code ${run.exitCode}`;
        return await fail("automation_generate_failed", `claude ${why}: ${run.output.slice(-500)}`);
      }
      const written = readMeta(metaPath);
      if (!written) {
        return await fail("automation_generate_failed", `no valid report meta at ${metaPath}; claude output: ${outputTail(run.output)}`);
      }
      if (!metaMatchesSlot(written, due)) {
        return await fail(
          "automation_report_mismatch",
          `the run wrote ${describeMeta(written)} to ${metaPath}, not this slot's; claude output: ${outputTail(run.output)}`,
        );
      }

      try {
        await d.check(metaPath);
      } catch (e) {
        return await fail("automation_check_failed", `check threw: ${message(e)}`);
      }
      meta = readMeta(metaPath);
      if (!isValidated(meta)) return await fail("automation_check_failed", `the check left no validated bets in ${metaPath}`);
    }

    // The run can take up to the timeout: the entry window and the policy time use the clock after it.
    const r = d.handoff(meta, d.now(), metaPath);
    if (r.status === "failed") return await fail("automation_handoff_failed", r.detail);
    recordSlot(d.stateDir, { slot: due.id, status: r.status, atMs: d.nowMs, detail: r.detail });
    return { slot: due.id, status: r.status, detail: r.detail };
  } catch (e) {
    return await fail(slot ? "automation_handoff_failed" : "automation_generate_failed", `tick error: ${message(e)}`);
  } finally {
    release();
  }
}
