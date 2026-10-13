// automation/slots.ts – the 2-hour UTC report slots of the scheduled speculation run, and the catch-up rule:
// a slot is due only while its bets could still fill (before its entry cutoff); older unhandled slots are
// only reported as missed so the caller can record them as skipped.

import { pickSession, sessionById, sessionOptionsFromEnv } from "../speculation/sessions.ts";
import type { SessionId } from "../speculation/sessions.ts";

export const SLOT_MS = 7_200_000;
const MISSED_LOOKBACK_SLOTS = 12; // the last 24 hours

export interface Slot {
  id: string; // YYYYMMDD-HHMMZ of the start (UTC)
  startMs: number;
  endMs: number;
  session: SessionId;
  entryCutoffMs: number; // last instant a report for this slot may still be generated
}

const slotId = (startMs: number): string => new Date(startMs).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-") + "Z";

function slotStarting(startMs: number): Slot {
  const { tz } = sessionOptionsFromEnv();
  const id = pickSession(startMs, tz, 0).session.id;
  const endMs = startMs + SLOT_MS;
  return { id: slotId(startMs), startMs, endMs, session: id, entryCutoffMs: Math.min(startMs + sessionById(id)!.entryDeadlineMinutes * 60_000, endMs) };
}

// The slot containing `nowMs`.
export function slotAt(nowMs: number): Slot {
  return slotStarting(Math.floor(nowMs / SLOT_MS) * SLOT_MS);
}

export function dueSlot(nowMs: number, handled: ReadonlySet<string>): { due?: Slot; missed: Slot[] } {
  const current = slotAt(nowMs);
  const missed: Slot[] = [];
  for (let i = MISSED_LOOKBACK_SLOTS; i >= 1; i--) {
    const s = slotStarting(current.startMs - i * SLOT_MS);
    if (!handled.has(s.id)) missed.push(s);
  }
  const due = !handled.has(current.id) && nowMs < current.entryCutoffMs ? current : undefined;
  return due ? { due, missed } : { missed };
}
