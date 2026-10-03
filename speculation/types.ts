// speculation/types.ts – shared types of the speculation mode (see docs/superpowers/plans/2026-10-03-speculation-mode.md).
// The report itself is Markdown; these types describe only the small machine-readable parts.

export type Side = "long" | "short";
export type Direction = "long" | "short" | "neutral";

// The report's headline call: is the market leaning long or short over the session?
export interface Bias {
  direction: Direction;
  probability?: number; // 0..1 chance the lean is right over the session (optional for neutral)
  summary?: string; // one line
}

// One symbol of a report: written by the `speculate` skill into the meta sidecar.
export interface MetaSymbol {
  symbol: string; // short name, e.g. "XRP"
  futures: string; // Kraken Futures contract, e.g. "PF_XRPUSD"
  last: number; // last price at generation time
  atr_1h: number; // 1h ATR in price units
  spread_bps?: number; // optional, used for the round-trip cost floor
  why?: string; // "core" or "screen: <reason>"
  bias?: Direction; // per-symbol lean
}

// A bet as the model proposes it (unvalidated).
export interface BetInput {
  symbol: string;
  side: Side;
  entry: number; // limit price
  stop_loss: number;
  take_profit: number;
  ttl_minutes: number; // how long to hold after the entry is touched
  probability: number; // 0..1, chance the bet reaches take profit (given the entry is touched)
  rationale?: string;
}

// `HH00Z.meta.json`
export interface ReportMeta {
  session?: string; // SessionId from sessions.ts; sets the bet limits
  bias?: Bias; // REQUIRED by the checker: every report states long, short or neutral
  generated: string; // ISO
  window: [string, string]; // ISO start, end of the 60-minute window
  symbols: MetaSymbol[];
  bets: BetInput[];
  // Written back by the checker:
  validated?: Bet[];
  dropped?: DroppedBet[];
}

// A bet that passed validation.
export interface Bet extends BetInput {
  id: string; // YYYYMMDD-HHMMZ-SYMBOL-n
  session?: string;
  vs_bias?: "with" | "against" | "neutral"; // the bet's side relative to the symbol's bias
  futures: string;
  rr: number; // reward:risk
  fill_from: string; // ISO, window start
  entry_deadline: string; // ISO, the bet is void if the entry is not touched by then
  latest_close: string; // ISO, entry_deadline + ttl: the latest moment the position can still be open
}

export interface DroppedBet {
  bet: BetInput;
  reason: string;
}

// ---- scoring ----

export interface Candle {
  t: number; // epoch seconds, interval start
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Fill {
  id: string;
  orderId?: string;
  symbol: string; // futures contract
  side: "buy" | "sell";
  size: number;
  price: number;
  ts: number; // epoch ms
}

export type ExitReason = "tp" | "sl" | "ttl" | "other";
export type HypotheticalStatus = "tp" | "sl" | "ttl" | "not_touched" | "open";

export interface Hypothetical {
  status: HypotheticalStatus;
  touchedAt?: number; // epoch seconds (start of the touching candle)
  exitAt?: number; // epoch seconds
  exitPrice?: number;
  r?: number; // gross R
  netR?: number; // after the assumed round-trip fee
}

export interface Actual {
  entryFill: number; // VWAP of the matched entry fill(s)
  entryAt: number; // epoch ms
  slippagePct: number; // positive = worse than the suggested entry
  size: number;
  exitFill?: number;
  exitAt?: number;
  exitReason?: ExitReason;
  netR?: number;
}

export interface LoggedBet extends Bet {
  report: string; // vault path of the report
  generated: string;
  hypothetical?: Hypothetical; // set once final
  actual?: Actual;
}
