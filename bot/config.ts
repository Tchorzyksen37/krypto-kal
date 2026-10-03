// config.ts – the bot's hard limits. Loaded once at startup from a JSON file, validated, and never
// readable or changeable by the LLM. The hash of the resolved config goes into every journal row.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { KRAKEN_FUTURES_RESOLUTIONS } from "../kraken-futures-client.ts";

const pct = z.number().positive().max(100);
const posInt = z.number().int().positive();

export const ConfigSchema = z
  .strictObject({
    mode: z.enum(["dry-run", "live"]),
    live_enabled: z.boolean(),
    manual_approval: z.boolean(),
    symbol: z.string().min(1),
    trading_capital_usd: z.number().positive(),
    margin_mode: z.literal("isolated"), // a constant, not a setting
    max_leverage: z.number().positive(),
    max_risk_per_trade_pct: pct,
    max_total_open_risk_pct: pct,
    conviction_multiplier_cap: z.number().min(0.5), // sizing clamps the multiplier to [0.5, cap]
    daily_loss_limit_pct: pct,
    max_open_positions: posInt,
    max_positions_per_asset: posInt,
    max_entries_per_day: posInt,
    max_orders_per_day: posInt, // counts placed orders, not only fills
    day_reset_utc_hour: z.number().int().min(0).max(23),
    cooldown_after_close_min: z.number().nonnegative(),
    cooldown_after_loss_min: z.number().nonnegative(),
    min_reward_risk: z.number().positive(),
    sl_min_atr_multiple: z.number().nonnegative(),
    liq_distance_min_multiple: z.number().positive(),
    maintenance_margin_rate: z.number().min(0).lt(1),
    atr: z.strictObject({ resolution: z.enum(KRAKEN_FUTURES_RESOLUTIONS), period: posInt }),
    fees_bps: z.strictObject({ maker: z.number(), taker: z.number() }), // maker may be a rebate (negative)
    slippage_cap_bps: z.number().nonnegative(),
    entry_timeout_sec: z.number().positive(),
    protect_timeout_sec: z.number().positive(),
    max_policy_ttl_min: z.number().positive(),
    stale_data_max_age_sec: z.number().positive(),
    loosen_confirm_cycles: posInt,
    max_hold_hours: z.number().positive(),
    watchdog_interval_sec: z.number().positive(),
    db_path: z.string().min(1), // "~" is expanded by the code that opens the database
  })
  .refine((c) => c.mode !== "live" || c.live_enabled, { message: 'mode "live" requires live_enabled: true' });

export type BotConfig = z.infer<typeof ConfigSchema>;

// Deliberately tiny and conservative (training wheels). The fee and margin-rate numbers are placeholders.
const DEFAULTS: BotConfig = {
  mode: "dry-run",
  live_enabled: false,
  manual_approval: false,
  symbol: "PF_XBTUSD",
  trading_capital_usd: 1000,
  margin_mode: "isolated",
  max_leverage: 2,
  max_risk_per_trade_pct: 0.5,
  max_total_open_risk_pct: 0.5,
  conviction_multiplier_cap: 1.25,
  daily_loss_limit_pct: 1.5,
  max_open_positions: 1,
  max_positions_per_asset: 1,
  max_entries_per_day: 2,
  max_orders_per_day: 20,
  day_reset_utc_hour: 0,
  cooldown_after_close_min: 30,
  cooldown_after_loss_min: 120,
  min_reward_risk: 1.5,
  sl_min_atr_multiple: 1.0,
  liq_distance_min_multiple: 3,
  maintenance_margin_rate: 0.005,
  atr: { resolution: "1h", period: 14 },
  fees_bps: { maker: 2, taker: 5 },
  slippage_cap_bps: 10,
  entry_timeout_sec: 300,
  protect_timeout_sec: 5,
  max_policy_ttl_min: 60,
  stale_data_max_age_sec: 120,
  loosen_confirm_cycles: 2,
  max_hold_hours: 48,
  watchdog_interval_sec: 5,
  db_path: "~/.krypto-kal/bot.db",
};

export function defaultConfig(): BotConfig {
  return structuredClone(DEFAULTS);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Deep-merges `over` onto `base` (objects merge key by key, everything else is replaced).
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? merge(b, v) : v;
  }
  return out;
}

// JSON with object keys sorted at every level, so equal content gives equal text.
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function configHash(config: BotConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

// Reads a JSON file, merges it over the defaults and validates the result (unknown keys fail).
export function loadConfig(path: string): { config: BotConfig; hash: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read bot config ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(raw)) throw new Error(`Bot config ${path} must be a JSON object`);

  const parsed = ConfigSchema.safeParse(merge(DEFAULTS, raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid bot config ${path}: ${issues}`);
  }
  return { config: parsed.data, hash: configHash(parsed.data) };
}
