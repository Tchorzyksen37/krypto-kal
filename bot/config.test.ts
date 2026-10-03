// config.test.ts – offline tests of the bot's clock and hard-limit config.
// Run: node --test bot/config.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FakeClock, SystemClock } from "./clock.ts";
import { type BotConfig, defaultConfig, loadConfig } from "./config.ts";

// Writes `content` (an object, serialized as JSON, or a raw string) to a temp file and returns its path.
const configFile = (content: object | string): string => {
  const dir = mkdtempSync(join(tmpdir(), "bot-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};

describe("defaultConfig", () => {
  test("matches spec section 6 exactly", () => {
    const expected: BotConfig = {
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
    assert.deepEqual(defaultConfig(), expected);
  });

  test("returns a fresh object each call (callers cannot mutate shared defaults)", () => {
    const a = defaultConfig();
    a.max_leverage = 99;
    assert.equal(defaultConfig().max_leverage, 2);
  });
});

describe("loadConfig", () => {
  test("an empty object loads as the defaults", () => {
    assert.deepEqual(loadConfig(configFile({})).config, defaultConfig());
  });

  test("a partial file overrides only the keys it names", () => {
    const { config } = loadConfig(configFile({ max_leverage: 3, fees_bps: { maker: 1, taker: 4 } }));
    assert.equal(config.max_leverage, 3);
    assert.deepEqual(config.fees_bps, { maker: 1, taker: 4 });
    assert.equal(config.symbol, "PF_XBTUSD");
  });

  test("mode live without live_enabled fails to load", () => {
    assert.throws(() => loadConfig(configFile({ mode: "live", live_enabled: false })), /live/i);
    assert.throws(() => loadConfig(configFile({ mode: "live" })), /live/i);
  });

  test("an unknown key fails (strict schema)", () => {
    assert.throws(() => loadConfig(configFile({ max_leverge: 3 })), /max_leverge/);
  });

  test("margin_mode is a constant: anything but isolated fails", () => {
    assert.throws(() => loadConfig(configFile({ margin_mode: "cross" })));
  });

  test("risk and limit values must be positive", () => {
    for (const bad of [
      { max_risk_per_trade_pct: 0 },
      { max_risk_per_trade_pct: -1 },
      { max_total_open_risk_pct: 0 },
      { daily_loss_limit_pct: 0 },
      { max_leverage: 0 },
      { max_open_positions: 0 },
      { protect_timeout_sec: 0 },
    ]) {
      assert.throws(() => loadConfig(configFile(bad)), /Invalid bot config/, JSON.stringify(bad));
    }
  });

  test("day_reset_utc_hour must be an integer 0..23", () => {
    assert.throws(() => loadConfig(configFile({ day_reset_utc_hour: 24 })));
    assert.throws(() => loadConfig(configFile({ day_reset_utc_hour: -1 })));
    assert.throws(() => loadConfig(configFile({ day_reset_utc_hour: 1.5 })));
  });

  test("a missing file and invalid JSON both throw", () => {
    assert.throws(() => loadConfig(join(tmpdir(), "does-not-exist-bot-config.json")));
    assert.throws(() => loadConfig(configFile("{ not json")));
  });
});

describe("config hash", () => {
  test("is stable for equal content, whatever the key order or formatting", () => {
    const a = loadConfig(configFile('{"max_leverage":3,"symbol":"PF_XBTUSD"}')).hash;
    const b = loadConfig(configFile('{\n  "symbol": "PF_XBTUSD",\n  "max_leverage": 3\n}')).hash;
    assert.equal(a, b);
  });

  test("a file that only restates the defaults hashes like an empty file", () => {
    assert.equal(loadConfig(configFile(defaultConfig())).hash, loadConfig(configFile({})).hash);
  });

  test("changes when any value changes", () => {
    const base = loadConfig(configFile({})).hash;
    assert.notEqual(loadConfig(configFile({ max_leverage: 3 })).hash, base);
    assert.notEqual(loadConfig(configFile({ fees_bps: { maker: 2, taker: 6 } })).hash, base);
  });
});

describe("clocks", () => {
  test("FakeClock starts at the given time and advances", () => {
    const c = new FakeClock(1_000);
    assert.equal(c.now(), 1_000);
    c.advance(500);
    assert.equal(c.now(), 1_500);
  });

  test("FakeClock.set can move time backwards (NTP step, resume from sleep)", () => {
    const c = new FakeClock(10_000);
    c.set(4_000);
    assert.equal(c.now(), 4_000);
  });

  test("SystemClock follows the wall clock", () => {
    const before = Date.now();
    const t = new SystemClock().now();
    assert.ok(t >= before && t <= Date.now());
  });
});
