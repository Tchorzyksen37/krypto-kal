import type { LoggedBet } from "./types.ts";

// Bets in fill_from order, minus any bet whose hold window overlaps an earlier kept bet
// on the same symbol and side (consecutive reports often repeat one market view).
export function withoutOverlaps(log: LoggedBet[]): LoggedBet[] {
  const sorted = [...log].sort((a, b) => Date.parse(a.fill_from) - Date.parse(b.fill_from) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept: LoggedBet[] = [];
  for (const b of sorted) {
    const bStart = Date.parse(b.fill_from);
    const bEnd = Date.parse(b.latest_close);
    const clash = kept.some(
      (k) => k.symbol === b.symbol && k.side === b.side && Date.parse(k.fill_from) < bEnd && bStart < Date.parse(k.latest_close),
    );
    if (!clash) kept.push(b);
  }
  return kept;
}
