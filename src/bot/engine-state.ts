// engine-state.ts – the state machine's persisted record, shared by the trader, the watchdog, reconciliation and the
// CLI. It lives in the BotStore as one JSON value, so a change is atomic and a restart resumes exactly where it was.

import type { BotStore } from "./bot-store.ts";
import type { EngineState, TradeRecord } from "./engine.ts";

export interface HaltRecord {
  reason: string;
  manualAck: boolean; // true: only the user (CLI) can clear it
  untilMs: number | null; // a daily-loss halt clears itself at this time
}

export interface EngineRecord {
  state: EngineState;
  sinceMs: number; // when the current state began
  halt: HaltRecord | null;
  trade: TradeRecord | null;
  cooldownUntilMs: number | null;
  reconciled: boolean; // reconciliation has run cleanly since the last start
  lastClockMs: number; // the newest time seen; a clock that goes backwards is detected against this
  tradeStartedMs: number | null; // when the current trade began, for its PnL
  inZoneSinceMs: number | null; // since when the price has been continuously inside the entry zone
  liqAckMs: number; // liquidation fills at or before this time were acknowledged by the user
}

const KEY = "engine:record";
const STATES: readonly string[] = ["FLAT", "ENTERING", "PROTECTING", "OPEN", "REDUCING", "COOLDOWN", "HALTED"];

export function defaultEngineRecord(): EngineRecord {
  return {
    state: "FLAT", sinceMs: 0, halt: null, trade: null, cooldownUntilMs: null, reconciled: false, lastClockMs: 0,
    tradeStartedMs: null, inZoneSinceMs: null, liqAckMs: 0,
  };
}

// A missing record is a fresh FLAT engine. A record that cannot be read throws: guessing a state is worse than stopping.
export function loadEngineRecord(store: BotStore): EngineRecord {
  const raw = store.getKv(KEY);
  if (raw === undefined) return defaultEngineRecord();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("engine record is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !STATES.includes((parsed as { state?: unknown }).state as string)) {
    throw new Error("engine record has an unknown state");
  }
  return { ...defaultEngineRecord(), ...(parsed as Partial<EngineRecord>) }; // fields added later get their defaults
}

export function saveEngineRecord(store: BotStore, rec: EngineRecord): void {
  store.setKv(KEY, JSON.stringify(rec));
}
