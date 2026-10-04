// sizing.ts – pure position sizing and pre-trade validation. The engine calls planTrade(), which rounds the
// levels, sizes the position, checks costs, reward/risk and liquidation distance, and splits the TP ladder in
// one pass. Rounding is never in the bot's favour, and the stop is never moved to make a trade fit: a trade that
// does not fit is rejected (or shrunk), not adjusted.

import type { BotConfig } from "./config.ts";
import type { ResolvedScenario } from "./policy.ts";

export interface Contract {
  tickSize: number; // price step
  sizeStep: number; // size step, in contracts
  minSize: number;
}

export type TradeReject =
  | "invalid_input"
  | "zero_stop_distance"
  | "stop_not_beyond_entry"
  | "stop_inside_noise_floor"
  | "no_target_beyond_entry"
  | "target_within_costs"
  | "size_below_min"
  | "reward_risk_too_low"
  | "liquidation_too_close";

const finitePos = (x: number): boolean => Number.isFinite(x) && x > 0;

// Digits after the decimal point of a step such as 0.0001 or 5e-7 (used to remove float noise after rounding).
function decimals(step: number): number {
  const [mantissa = "", exp] = step.toString().split("e-");
  return (mantissa.split(".")[1]?.length ?? 0) + (exp ? Number(exp) : 0);
}

const snap = (units: number, step: number): number => Number((units * step).toFixed(decimals(step)));

// Rounds to a multiple of `step`. The epsilon keeps 0.004 / 0.0001 = 40.00000000000001 from changing the result.
export function floorTo(x: number, step: number): number {
  return snap(Math.floor(x / step + 1e-9), step);
}

export function ceilTo(x: number, step: number): number {
  return snap(Math.ceil(x / step - 1e-9), step);
}

// Linear from 0.5 (no conviction) to the cap (full conviction).
export function convictionMultiplier(conviction: number, cap: number): number {
  return 0.5 + conviction * (cap - 0.5);
}

// Isolated-margin approximation: liquidation sits 1/leverage - mmr away from the entry (never past the entry).
export function estimateLiquidation(i: { side: "long" | "short"; entry: number; leverage: number; mmr: number }): number {
  const fraction = Math.max(0, 1 / i.leverage - i.mmr);
  return i.side === "long" ? i.entry * (1 - fraction) : i.entry * (1 + fraction);
}

export interface SizeInput {
  capital: number;
  riskBudgetPct: number; // from the policy
  maxRiskPct: number; // hard cap, applied after the conviction multiplier
  conviction: number; // 0..1
  convictionCap: number;
  maxLeverage: number;
  entry: number;
  stop: number;
  contract: Contract;
}

export type SizeResult =
  | { size: number; riskUsd: number; riskPct: number; convictionMult: number }
  | { reject: "size_below_min" | "zero_stop_distance" | "invalid_input" };

export function computeSize(i: SizeInput): SizeResult {
  const { contract } = i;
  const valid =
    [i.capital, i.riskBudgetPct, i.maxRiskPct, i.maxLeverage, i.entry, i.stop, contract.sizeStep, contract.minSize].every(finitePos) &&
    Number.isFinite(i.conviction) && i.conviction >= 0 && i.conviction <= 1 &&
    Number.isFinite(i.convictionCap) && i.convictionCap >= 0.5;
  if (!valid) return { reject: "invalid_input" };

  const distance = Math.abs(i.entry - i.stop);
  if (distance === 0) return { reject: "zero_stop_distance" };

  const convictionMult = convictionMultiplier(i.conviction, i.convictionCap);
  const riskPct = Math.min(i.riskBudgetPct * convictionMult, i.maxRiskPct);
  const byRisk = (i.capital * riskPct) / 100 / distance;
  const byLeverage = (i.capital * i.maxLeverage) / i.entry;
  const size = floorTo(Math.min(byRisk, byLeverage), contract.sizeStep);
  if (size + 1e-12 < contract.minSize) return { reject: "size_below_min" };

  const riskUsd = size * distance;
  return { size, riskUsd, riskPct: (riskUsd / i.capital) * 100, convictionMult };
}

// Splits `size` over the targets (nearest first) in whole size steps, the remainder going to the nearest rung.
// If a rung would fall below the minimum size, only the nearest fewer targets are used.
export function splitLadder(prices: number[], size: number, contract: Contract): { price: number; size: number }[] {
  if (prices.length === 0) return [];
  const units = Math.round(size / contract.sizeStep);
  const minUnits = Math.max(1, Math.ceil(contract.minSize / contract.sizeStep - 1e-9));
  let rungs = prices.length;
  while (rungs > 1 && Math.floor(units / rungs) < minUnits) rungs--;
  const base = Math.floor(units / rungs);
  const remainder = units - base * rungs;
  return prices.slice(0, rungs).map((price, idx) => ({ price, size: snap(base + (idx === 0 ? remainder : 0), contract.sizeStep) }));
}

export interface TradeInput {
  scenario: ResolvedScenario;
  entry: number; // the limit price the engine will use
  atr: number;
  conviction: number; // 0..1, from the effective policy
  riskBudgetPct: number; // from the effective policy
  fundingBpsPerHour: number; // signed: positive means longs pay shorts
  config: BotConfig;
  contract: Contract;
}

export type TradePlan =
  | {
      ok: true;
      size: number;
      riskUsd: number;
      riskPct: number;
      stop: number;
      ladder: { price: number; size: number }[];
      leverage: number; // isolated-margin leverage to use
      rewardRisk: number;
    }
  | { ok: false; reason: TradeReject };

const fail = (reason: TradeReject): TradePlan => ({ ok: false, reason });

export function planTrade(i: TradeInput): TradePlan {
  const { scenario: s, entry, atr, config, contract } = i;

  const numbers = [entry, atr, contract.tickSize, contract.sizeStep, contract.minSize, s.stop, s.entryLow, s.entryHigh, s.horizonHours];
  if (!numbers.every(finitePos) || !s.targets.length || !s.targets.every(finitePos) || !Number.isFinite(i.fundingBpsPerHour)) {
    return fail("invalid_input");
  }

  const long = s.direction === "long";
  const dir = long ? 1 : -1; // +1 when profit means a higher price
  // The stop moves away from the entry and targets move toward it, which is the same direction for a given side.
  const round = long ? floorTo : ceilTo;

  const stop = round(s.stop, contract.tickSize);
  const distance = Math.abs(entry - stop);
  if (distance === 0) return fail("zero_stop_distance");
  if ((stop - entry) * dir > 0) return fail("stop_not_beyond_entry");
  if (distance < config.sl_min_atr_multiple * atr) return fail("stop_inside_noise_floor");

  // Targets: rounded, deduplicated, beyond the entry, and clear of round-trip fees plus expected funding.
  let targets = [...new Set(s.targets.map((t) => round(t, contract.tickSize)))].filter((t) => (t - entry) * dir > 0);
  if (!targets.length) return fail("no_target_beyond_entry");
  const fundingCostBps = Math.max(0, i.fundingBpsPerHour * dir * s.horizonHours); // receipts are never credited
  const requiredMove = (entry * (config.fees_bps.maker + config.fees_bps.taker + fundingCostBps)) / 10_000;
  targets = targets.filter((t) => Math.abs(t - entry) > requiredMove);
  if (!targets.length) return fail("target_within_costs");

  const capital = config.trading_capital_usd;
  const sized = computeSize({
    capital, riskBudgetPct: i.riskBudgetPct, maxRiskPct: config.max_risk_per_trade_pct, conviction: i.conviction,
    convictionCap: config.conviction_multiplier_cap, maxLeverage: config.max_leverage, entry, stop, contract,
  });
  if ("reject" in sized) return fail(sized.reject);

  // Liquidation depends on the leverage, not the size: use the largest leverage that keeps it far enough from the
  // entry, then shrink the position until it fits that leverage. The stop does not move.
  const k = config.liq_distance_min_multiple;
  const leverageLimit = Math.floor((1 / ((k * distance) / entry + config.maintenance_margin_rate)) * 1e4) / 1e4;
  const leverage = Math.min(config.max_leverage, leverageLimit);
  const size = Math.min(sized.size, floorTo((leverage * capital) / entry, contract.sizeStep));
  if (size + 1e-12 < contract.minSize) return fail("liquidation_too_close");

  const ladder = splitLadder(targets, size, contract);
  const rewardRisk = ladder.reduce((sum, r) => sum + r.size * Math.abs(r.price - entry), 0) / size / distance;
  if (rewardRisk + 1e-9 < config.min_reward_risk) return fail("reward_risk_too_low");

  const riskUsd = size * distance;
  return { ok: true, size, riskUsd, riskPct: (riskUsd / capital) * 100, stop, ladder, leverage, rewardRisk };
}
