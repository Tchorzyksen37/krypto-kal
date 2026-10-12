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

export function handoff(store: BotStore, config: BotConfig, meta: ReportMeta, nowMs: number, source: string): HandoffResult {
  if (!Array.isArray(meta.validated)) return { status: "failed", detail: "the checker has not run on this report (no validated bets)" };

  const conv = fixturesFromSpeculation(meta, config, nowMs, source);
  const notes = [
    ...conv.skipped.map((s) => `skipped ${s.betId}: ${s.reason}`),
    ...conv.warnings.map((w) => `warning: ${w}`),
  ];
  if (conv.fixtures.length !== 1 || conv.warnings.length) {
    return { status: "no_bet", detail: notes.join("\n") || "no usable bet in this report" };
  }

  const { added, text } = addFromSpeculation(store, config, meta, nowMs, { source });
  if (added !== 1) return { status: "failed", detail: text };
  return { status: "handed_off", betId: conv.fixtures[0]!.betId, detail: [text, ...notes].join("\n") };
}
