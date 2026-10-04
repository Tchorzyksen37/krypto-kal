// policy.ts – the policy contract between the analyst (LLM) and the engine: schema, validation against the
// level menu, and the "effective" policy (tighten instantly, loosen only after N confirming cycles).
// The LLM picks level IDs from a menu built by code; this module turns them into prices. Invalid output
// is rejected with a reason, never repaired.

import { z } from "zod";
import type { BotConfig } from "./config.ts";
import { formatIssues } from "./zod-issues.ts";

export type LevelId = string;

export interface Level {
  id: LevelId;
  price: number;
  kind: string;
}

export interface LevelMenu {
  id: string;
  symbol: string;
  createdAtMs: number;
  levels: Level[];
}

const levelId = z.string().min(1);
const direction = z.enum(["long", "short"]);

export const PolicySchema = z.strictObject({
  schema_version: z.literal(1),
  menu_id: z.string().min(1),
  symbol: z.string().min(1),
  bias: z.number().min(-1).max(1),
  conviction: z.number().min(0).max(1),
  risk_budget_pct: z.number().positive(),
  allowed_directions: z.array(direction),
  scenario: z
    .strictObject({
      direction,
      entry_zone: z.strictObject({ from: levelId, to: levelId }),
      targets: z.array(levelId).min(1).max(3),
      invalidation: levelId,
      horizon_hours: z.number().positive(),
    })
    .nullable(),
  valid_until: z.iso.datetime({ offset: true }),
  rationale: z.string().max(1000), // journal only, never parsed
  sources: z.array(z.string()),
});

export type Policy = z.infer<typeof PolicySchema>;

// A scenario with every level ID replaced by its price. entryLow <= entryHigh.
export interface ResolvedScenario {
  direction: "long" | "short";
  entryLow: number;
  entryHigh: number;
  targets: number[]; // nearest first
  stop: number;
  horizonHours: number;
}

export interface PolicyContext {
  config: BotConfig;
  getMenu(id: string): LevelMenu | undefined;
  nowMs: number;
}

export type PolicyResult =
  | { ok: true; policy: Policy; scenario: ResolvedScenario | null }
  | { ok: false; reason: string };

const reject = (reason: string): PolicyResult => ({ ok: false, reason });

// Checks one raw object (the LLM's output) and resolves its scenario. Never throws on bad input.
export function validatePolicy(raw: unknown, ctx: PolicyContext): PolicyResult {
  const { config, nowMs } = ctx;

  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) return reject(formatIssues(parsed.error));
  const policy = parsed.data;

  if (policy.symbol !== config.symbol) return reject(`symbol ${policy.symbol} is not the configured ${config.symbol}`);
  if (policy.risk_budget_pct > config.max_risk_per_trade_pct) {
    return reject(`risk_budget_pct ${policy.risk_budget_pct} exceeds max_risk_per_trade_pct ${config.max_risk_per_trade_pct}`);
  }

  const menu = ctx.getMenu(policy.menu_id);
  if (!menu) return reject(`unknown menu ${policy.menu_id}`);
  if (menu.symbol !== config.symbol) return reject(`menu ${menu.id} is for symbol ${menu.symbol}, not ${config.symbol}`);
  const menuAgeMs = nowMs - menu.createdAtMs;
  if (menuAgeMs < 0) return reject(`menu ${menu.id} was created in the future`);
  if (menuAgeMs > config.max_menu_age_min * 60_000) return reject(`menu ${menu.id} is older than max_menu_age_min`);

  const untilMs = Date.parse(policy.valid_until);
  if (untilMs <= nowMs) return reject("valid_until is not in the future");
  const ttlEndMs = nowMs + config.max_policy_ttl_min * 60_000;
  const out: Policy = untilMs > ttlEndMs ? { ...policy, valid_until: new Date(ttlEndMs).toISOString() } : policy;

  if (!policy.scenario) return { ok: true, policy: out, scenario: null };
  const scenario = resolveScenario(policy.scenario, policy.allowed_directions, menu, config);
  return typeof scenario === "string" ? reject(scenario) : { ok: true, policy: out, scenario };
}

// Returns the resolved scenario, or the reason it is unusable.
export function resolveScenario(
  s: NonNullable<Policy["scenario"]>,
  allowed: Policy["allowed_directions"],
  menu: LevelMenu,
  config: BotConfig,
): ResolvedScenario | string {
  if (!allowed.includes(s.direction)) return `scenario direction ${s.direction} is not in allowed_directions`;
  if (s.horizon_hours > config.max_hold_hours) return `horizon_hours ${s.horizon_hours} exceeds max_hold_hours ${config.max_hold_hours}`;

  const price = (id: LevelId): number | string => {
    const level = menu.levels.find((l) => l.id === id);
    if (!level) return `level ${id} is not in menu ${menu.id}`;
    return Number.isFinite(level.price) && level.price > 0 ? level.price : `level ${id} has an invalid price`;
  };
  const resolved = (ids: LevelId[]): number[] | string => {
    const prices: number[] = [];
    for (const id of ids) {
      const p = price(id);
      if (typeof p === "string") return p;
      prices.push(p);
    }
    return prices;
  };

  const zone = resolved([s.entry_zone.from, s.entry_zone.to]);
  if (typeof zone === "string") return zone;
  const [entryLow, entryHigh] = zone as [number, number];
  if (entryLow > entryHigh) return "entry_zone.from is above entry_zone.to";

  const stop = price(s.invalidation);
  if (typeof stop === "string") return stop;
  const targets = resolved(s.targets);
  if (typeof targets === "string") return targets;

  const long = s.direction === "long";
  // Profit direction: +1 for a long, -1 for a short. Everything must lie "beyond" the zone in that direction.
  const dir = long ? 1 : -1;
  if (long ? stop >= entryLow : stop <= entryHigh) {
    return `invalidation must be ${long ? "below" : "above"} the entry zone for a ${s.direction}`;
  }
  const edge = long ? entryHigh : entryLow;
  let previous = edge;
  for (const t of targets) {
    if ((t - previous) * dir <= 0) {
      return `targets must lie ${long ? "above" : "below"} the entry zone and move strictly ${long ? "up" : "down"}`;
    }
    previous = t;
  }

  return { direction: s.direction, entryLow, entryHigh, targets, stop, horizonHours: s.horizon_hours };
}

// The policy the engine acts on. `history` is newest first. A field is the most conservative value over the
// newest `n` policies, so tightening shows at once and loosening needs n agreeing cycles. Returns null until
// n policies exist (an unconfirmed first policy is not acted on).
export function effectivePolicy(history: Policy[], n: number): Policy | null {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
  if (history.length < n) return null;
  const window = history.slice(0, n);
  const newest = window[0] as Policy;

  const positive = window.every((p) => p.bias > 0);
  const negative = window.every((p) => p.bias < 0);
  const bias = positive
    ? Math.min(...window.map((p) => p.bias))
    : negative
      ? Math.max(...window.map((p) => p.bias))
      : 0; // opposite signs (or a zero) means no directional view

  const earliest = window.reduce((a, b) => (Date.parse(b.valid_until) < Date.parse(a.valid_until) ? b : a));
  const sameScenario = window.every((p) => p.scenario && p.scenario.direction === newest.scenario?.direction);

  return {
    ...newest,
    bias,
    conviction: Math.min(...window.map((p) => p.conviction)),
    risk_budget_pct: Math.min(...window.map((p) => p.risk_budget_pct)),
    allowed_directions: newest.allowed_directions.filter((d) => window.every((p) => p.allowed_directions.includes(d))),
    valid_until: earliest.valid_until,
    scenario: sameScenario ? newest.scenario : null,
  };
}
