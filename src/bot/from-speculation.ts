// from-speculation.ts – turns the best bet of a checked speculation report (HHMMZ.meta.json, after
// src/speculation/check.ts has written `validated`) into a bot policy that trades only inside the speculation's time:
//
//   not_before   = the bet's fill_from        no entry before the speculation window opens
//   valid_until  = the bet's entry_deadline   no entry after the bet's "fill by" time (an expired policy never
//                                             closes a position, so protection carries on)
//   horizon      = the bet's ttl_minutes      the bot's time-stop closes the position at most this long after the
//                                             entry, so it is flat by the bet's latest_close at the latest
//   entry zone   = a thin band on the waiting side of the bet's limit ([entry - 0.1 ATR, entry] for a long), so the
//                  bot enters only when price comes to the bet's level, as the user would with a limit order
//   stop, target = the bet's stop loss and take profit
//   conviction   = the bet's stated probability
//
// The bot trades one symbol (config.symbol); bets on other contracts are skipped with a reason. Its own hard limits
// still apply at entry time (stop >= sl_min_atr_multiple x ATR, reward:risk >= min_reward_risk, risk per trade, daily
// caps), so a bet the speculation checker accepted can still be refused by the bot: the warnings say when that is likely.

import type { Bet, ReportMeta } from "../speculation/types.ts";
import type { PolicyFixture } from "./cli.ts";
import type { BotConfig } from "./config.ts";

export const ZONE_ATR = 0.1; // width of the entry band, in 1h ATRs

export interface SpeculationConversion {
  fixtures: { betId: string; fixture: PolicyFixture; window: { notBefore: string; entryUntil: string; closeBy: string } }[];
  skipped: { betId: string; reason: string }[];
  warnings: string[];
}

const minutes = (ms: number) => Math.round(ms / 60_000);

export function fixturesFromSpeculation(meta: ReportMeta, config: BotConfig, nowMs: number, source = "speculation"): SpeculationConversion {
  const out: SpeculationConversion = { fixtures: [], skipped: [], warnings: [] };
  if (!Array.isArray(meta.validated)) {
    out.warnings.push("the report has no validated bets: run `node src/speculation/check.ts <meta.json>` first");
    return out;
  }
  if (!meta.validated.length) {
    out.warnings.push("the report has no bets (\"no bet\" this session): nothing for the bot");
    return out;
  }

  // Validated bets are ranked by expected value; the bot holds one position, so only the best eligible one is used.
  for (const bet of meta.validated) {
    const reason = skipReason(bet, config, nowMs, out.fixtures.length > 0);
    if (reason) {
      out.skipped.push({ betId: bet.id, reason });
      continue;
    }
    const atr = meta.symbols.find((s) => s.symbol === bet.symbol)?.atr_1h;
    if (!atr || !(atr > 0)) {
      out.skipped.push({ betId: bet.id, reason: "the report has no 1h ATR for this symbol" });
      continue;
    }
    out.fixtures.push(toFixture(bet, atr, config, nowMs, source, out.warnings));
  }
  return out;
}

function skipReason(bet: Bet, config: BotConfig, nowMs: number, haveOne: boolean): string | undefined {
  if (bet.futures.toUpperCase() !== config.symbol.toUpperCase()) return `the bot trades ${config.symbol}, this bet is on ${bet.futures}`;
  if (Date.parse(bet.entry_deadline) <= nowMs) return `its entry window closed at ${bet.entry_deadline}`;
  if (haveOne) return "the bot holds one position at a time; a better bet on this symbol was taken";
  return undefined;
}

function toFixture(
  bet: Bet, atr: number, config: BotConfig, nowMs: number, source: string, warnings: string[],
): SpeculationConversion["fixtures"][number] {
  const long = bet.side === "long";
  const risk = Math.abs(bet.entry - bet.stop_loss);
  const reward = Math.abs(bet.take_profit - bet.entry);
  // The band must stay clear of the stop: at most a quarter of the stop distance.
  const band = Math.min(ZONE_ATR * atr, risk / 4);
  const zoneLow = long ? bet.entry - band : bet.entry;
  const zoneHigh = long ? bet.entry : bet.entry + band;
  const menuId = `spec-${bet.id}`;

  const startMs = Math.max(nowMs, Date.parse(bet.fill_from));
  const untilMs = Date.parse(bet.entry_deadline);
  const ttlHours = bet.ttl_minutes / 60;

  if (risk < config.sl_min_atr_multiple * atr) {
    warnings.push(`${bet.id}: the stop is ${(risk / atr).toFixed(2)} ATR away; the bot refuses stops under sl_min_atr_multiple (${config.sl_min_atr_multiple} ATR), so it will not enter`);
  }
  if (reward / risk < config.min_reward_risk) {
    warnings.push(`${bet.id}: reward:risk ${(reward / risk).toFixed(2)} is below the bot's min_reward_risk ${config.min_reward_risk}; it will not enter`);
  }
  if (minutes(untilMs - nowMs) > config.max_policy_ttl_min) {
    warnings.push(`${bet.id}: the entry window lasts ${minutes(untilMs - nowMs)} min but policies live at most max_policy_ttl_min (${config.max_policy_ttl_min} min); raise it in the bot config or the bot stops looking for the entry early`);
  }
  if (ttlHours > config.max_hold_hours) {
    warnings.push(`${bet.id}: the hold time ${bet.ttl_minutes} min exceeds max_hold_hours (${config.max_hold_hours} h); the policy will be refused`);
  }

  const fixture: PolicyFixture = {
    menu: {
      id: menuId, symbol: config.symbol, createdAtMs: nowMs,
      levels: [
        { id: "zone_lo", price: zoneLow, kind: "speculation_entry" },
        { id: "zone_hi", price: zoneHigh, kind: "speculation_entry" },
        { id: "stop", price: bet.stop_loss, kind: "speculation_stop" },
        { id: "tp1", price: bet.take_profit, kind: "speculation_target" },
      ],
    },
    policy: {
      schema_version: 1, menu_id: menuId, symbol: config.symbol,
      bias: (long ? 1 : -1) * Math.min(1, Math.max(0.05, bet.probability)),
      conviction: Math.min(1, Math.max(0, bet.probability)),
      risk_budget_pct: config.max_risk_per_trade_pct,
      allowed_directions: [bet.side],
      scenario: {
        direction: bet.side, entry_zone: { from: "zone_lo", to: "zone_hi" }, targets: ["tp1"], invalidation: "stop",
        horizon_hours: ttlHours,
      },
      valid_until: new Date(untilMs).toISOString(),
      ...(startMs > nowMs ? { not_before: new Date(startMs).toISOString() } : {}),
      rationale: `speculation bet ${bet.id}: ${bet.rationale ?? ""}`.slice(0, 1000),
      sources: [source, bet.id],
    },
  };
  return {
    betId: bet.id, fixture,
    window: {
      notBefore: new Date(startMs).toISOString(),
      entryUntil: new Date(untilMs).toISOString(),
      closeBy: new Date(untilMs + bet.ttl_minutes * 60_000).toISOString(),
    },
  };
}
