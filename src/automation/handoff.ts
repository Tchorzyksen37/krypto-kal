// handoff.ts – stores the best clean bet of a validated report as a policy for the dry-run bot.
// "Clean" = exactly one usable bet and no warning from the converter; anything doubtful stores nothing.

import type { BotConfig } from "../bot/config.ts";
import type { BotStore } from "../bot/bot-store.ts";
import { addFromSpeculation } from "../bot/cli.ts";
import { fixturesFromSpeculation } from "../bot/from-speculation.ts";
import type { ReportMeta } from "../speculation/types.ts";

export type HandoffResult =
  | { status: "handed_off"; betId: string; detail: string }
  | { status: "no_bet"; detail: string }
  | { status: "failed"; detail: string };

// Thrown inside the store transaction to roll back a partly stored bet.
class RollbackError extends Error {}

export function handoff(store: BotStore, config: BotConfig, meta: ReportMeta, nowMs: number, source: string, ratio = 1): HandoffResult {
  if (!Array.isArray(meta.validated)) return { status: "failed", detail: "the checker has not run on this report (no validated bets)" };

  const conv = fixturesFromSpeculation(meta, config, nowMs, source, ratio);
  const notes = [
    ...conv.skipped.map((s) => `skipped ${s.betId}: ${s.reason}`),
    ...conv.warnings.map((w) => `warning: ${w}`),
  ];
  if (conv.fixtures.length !== 1 || conv.warnings.length) {
    const none = conv.fixtures.length > 1 ? `${conv.fixtures.length} bets, expected exactly one` : "no usable bet in this report";
    return { status: "no_bet", detail: notes.join("\n") || none };
  }

  // All copies or none: a throw rolls the whole transaction back.
  try {
    const text = store.transaction(() => {
      const r = addFromSpeculation(store, config, meta, nowMs, { source, ratio });
      if (r.added !== 1) throw new RollbackError(r.text);
      return r.text;
    });
    return { status: "handed_off", betId: conv.fixtures[0]!.betId, detail: text };
  } catch (e) {
    if (e instanceof RollbackError) return { status: "failed", detail: e.message };
    return { status: "failed", detail: `bot store error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
