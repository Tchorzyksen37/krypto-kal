// cli.ts – the bot's command line (iteration 1: dry-run only, no real order can be placed).
//
//   npm run bot -- policy template long|short   prints a policy fixture around the current price (edit, then add it)
//   npm run bot -- policy add <file.json>        validates and stores a fixture policy (and its level menu)
//   npm run bot -- status                        state, position, orders, account, recent incidents and decisions
//   npm run bot -- report [--days N] [--write]   the report (and, with --write, the vault note output/bot/report-<day>.md)
//   npm run bot -- ack-halt                      clears a halt that needs acknowledgement, then reconciles again
//   npm run bot -- run                           starts the trader and the watchdog as two processes (Ctrl+C stops both)
//   npm run bot -- trader | watchdog             one of the two loops in the foreground
// Options: --config <file.json> (or BOT_CONFIG); BRAIN_DIR enables the vault alerts and reports.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createLogger } from "../core/logger.ts";
import { KrakenFuturesClient } from "../providers/kraken/kraken-futures-client.ts";
import { type AlertSink, logSink, VaultAlertSink, writeVaultReport } from "./alerts.ts";
import { ApprovingExecutor, type Ask } from "./approving-executor.ts";
import { BotStore } from "./bot-store.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { type BotConfig, configHash, defaultConfig, loadConfig } from "./config.ts";
import { DryRunExecutor } from "./dry-run-executor.ts";
import { loadEngineRecord, saveEngineRecord } from "./engine-state.ts";
import type { MarketData } from "./executor.ts";
import { atr } from "./indicators.ts";
import { dayStartMs, tradingDay } from "./limits.ts";
import { assertDryRunOnly } from "./live-executor.ts";
import { FeedingMarket, KrakenMarketData } from "./market-data.ts";
import { type LevelMenu, type Policy, validatePolicy } from "./policy.ts";
import { buildReport, renderReport } from "./report.ts";
import { type Runtime, intervals, loop, startup, traderStep, watchdogStep } from "./runner.ts";
import type { TraderDeps } from "./trader.ts";

const log = createLogger("bot-cli");

// ---- config ---------------------------------------------------------------------------------------------------------

export function resolveConfig(path: string | undefined): { config: BotConfig; hash: string } {
  if (path) return loadConfig(path);
  const config = defaultConfig();
  return { config, hash: configHash(config) };
}

// ---- policy add / template ------------------------------------------------------------------------------------------

export interface PolicyFixture {
  menu?: Omit<LevelMenu, "createdAtMs"> & { createdAtMs?: number }; // createdAtMs defaults to now (menus must be fresh)
  policy: Omit<Policy, "valid_until"> & { valid_until?: string }; // valid_until defaults to now + max_policy_ttl_min
}

export type AddResult =
  | { ok: true; id: number; stored: number; needed: number; note: string }
  | { ok: false; reason: string };

// Validates a fixture exactly as the analyst's output will be validated, then stores it. Nothing is stored on a failure.
export function addPolicy(store: BotStore, config: BotConfig, fixture: PolicyFixture, nowMs: number): AddResult {
  if (!fixture || typeof fixture !== "object" || !fixture.policy) return { ok: false, reason: "the fixture needs a `policy` object" };
  let menu: LevelMenu | undefined;
  if (fixture.menu) {
    menu = { ...fixture.menu, createdAtMs: fixture.menu.createdAtMs ?? nowMs } as LevelMenu;
    const existing = store.getMenu(menu.id);
    if (existing && JSON.stringify(existing.levels) !== JSON.stringify(menu.levels)) {
      return { ok: false, reason: `menu ${menu.id} already exists with different levels; give the new menu another id` };
    }
    if (existing) menu = existing;
  }
  const raw = { ...fixture.policy, valid_until: fixture.policy.valid_until ?? new Date(nowMs + config.max_policy_ttl_min * 60_000).toISOString() };
  const getMenu = (id: string) => (menu && menu.id === id ? menu : store.getMenu(id));
  const result = validatePolicy(raw, { config, nowMs, getMenu });
  if (!result.ok) return { ok: false, reason: result.reason };

  const id = store.transaction(() => {
    if (menu && !store.getMenu(menu.id)) store.putMenu(menu);
    return store.putPolicy(result.policy, nowMs);
  });
  const needed = config.loosen_confirm_cycles;
  const stored = Math.min(needed, store.latestPolicies(needed).length);
  const note = stored < needed
    ? `stored as policy ${id}; the engine acts once ${needed} agreeing policies exist (add it ${needed - stored} more time(s))`
    : `stored as policy ${id}; the effective policy now includes it`;
  return { ok: true, id, stored, needed, note };
}

// A fixture around the current price: entry zone +-0.25 ATR, stop 1.5 ATR from the price (1.25 ATR beyond the zone),
// targets 2.5 and 4 ATR, so the default min_reward_risk (1.5) and sl_min_atr_multiple (1) are met.
export async function policyTemplate(market: MarketData, config: BotConfig, direction: "long" | "short", nowMs: number): Promise<PolicyFixture> {
  const quote = await market.ticker();
  const candles = await market.candles(config.atr.resolution, config.atr.period + 3);
  const a = atr(candles, config.atr.period, config.atr.resolution, nowMs);
  if (!a) throw new Error("ATR unavailable: cannot place levels");
  const contract = await market.contract();
  const tick = (p: number) => Math.round(p / contract.tickSize) * contract.tickSize;
  const s = direction === "long" ? 1 : -1;
  const p = quote.last;
  const menuId = `manual-${new Date(nowMs).toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  return {
    menu: {
      id: menuId, symbol: config.symbol,
      levels: [
        { id: "zone_a", price: tick(p - 0.25 * a), kind: "atr_band" },
        { id: "zone_b", price: tick(p + 0.25 * a), kind: "atr_band" },
        { id: "stop", price: tick(p - s * 1.5 * a), kind: "invalidation" },
        { id: "t1", price: tick(p + s * 2.5 * a), kind: "target" },
        { id: "t2", price: tick(p + s * 4 * a), kind: "target" },
      ],
    },
    policy: {
      schema_version: 1, menu_id: menuId, symbol: config.symbol, bias: 0.5 * s, conviction: 0.5,
      risk_budget_pct: config.max_risk_per_trade_pct, allowed_directions: [direction],
      scenario: {
        direction, entry_zone: { from: "zone_a", to: "zone_b" }, targets: ["t1", "t2"], invalidation: "stop", horizon_hours: 12,
      },
      rationale: "manual test fixture", sources: [],
    },
  };
}

// ---- halt acknowledgement ------------------------------------------------------------------------------------------

export type AckResult = { ok: true; cleared: string } | { ok: false; reason: string };

// Clears a halt that waits for the user. A daily-loss halt is never cleared by hand before its reset time.
// Liquidation fills up to now count as acknowledged. The caller must reconcile afterwards (entries stay blocked until).
export function ackHalt(store: BotStore, nowMs: number): AckResult {
  const rec = loadEngineRecord(store);
  if (rec.state !== "HALTED" || !rec.halt) return { ok: false, reason: `the bot is not halted (state ${rec.state})` };
  if (!rec.halt.manualAck) {
    const until = rec.halt.untilMs ? new Date(rec.halt.untilMs).toISOString() : "its reset";
    return { ok: false, reason: `the ${rec.halt.reason} halt clears itself at ${until}; it cannot be acknowledged by hand` };
  }
  const cleared = rec.halt.reason;
  saveEngineRecord(store, { ...rec, state: "FLAT", sinceMs: nowMs, halt: null, reconciled: false, liqAckMs: nowMs, inZoneSinceMs: null });
  store.addIncident({ tMs: nowMs, kind: "halt_acknowledged", detail: `${cleared} acknowledged by the user` });
  return { ok: true, cleared };
}

// ---- status ---------------------------------------------------------------------------------------------------------

export async function statusText(store: BotStore, config: BotConfig, nowMs: number): Promise<string> {
  const sim = new DryRunExecutor({ store, clock: { now: () => nowMs }, config });
  const rec = loadEngineRecord(store);
  const [positions, orders, account] = await Promise.all([sim.getPositions(), sim.getOpenOrders(), sim.getAccount()]);
  const lines = [
    `mode: dry-run (no real orders)   symbol: ${config.symbol}   db: ${config.db_path}`,
    `state: ${rec.state}${rec.sinceMs ? ` since ${new Date(rec.sinceMs).toISOString()}` : ""}${rec.halt ? `   HALT: ${rec.halt.reason}${rec.halt.manualAck ? " (needs ack-halt)" : ""}` : ""}`,
    `reconciled: ${rec.reconciled}   cooldown until: ${rec.cooldownUntilMs ? new Date(rec.cooldownUntilMs).toISOString() : "-"}`,
    `position: ${positions[0] ? `${positions[0].side} ${positions[0].size} @ ${positions[0].price}, unrealised ${positions[0].unrealizedPnl?.toFixed(2)}` : "none"}`,
    `open orders: ${orders.length ? orders.map((o) => `${o.cliOrdId} ${o.side} ${o.orderType} ${o.unfilledSize} @ ${o.limitPrice ?? o.stopPrice}`).join("; ") : "none"}`,
    `equity: ${account.equity.toFixed(2)}   realised ${account.realizedPnl.toFixed(2)}   fees ${account.fees.toFixed(2)}   funding ${account.funding.toFixed(2)}`,
    "",
    "recent incidents:",
    ...store.listIncidents(nowMs - 24 * 3_600_000).slice(-8).map((i) => `  ${new Date(i.tMs).toISOString()} ${i.kind}: ${i.detail}`),
    "",
    "recent decisions:",
    ...store.listJournal(nowMs - 3_600_000, "cycle").slice(-5).map((j) => `  ${new Date(j.tMs).toISOString()} ${j.decision} (${j.reason})`),
  ];
  return lines.join("\n");
}

// ---- runtime --------------------------------------------------------------------------------------------------------

// A question on the terminal; no terminal (or no answer within the entry timeout) means no.
export function terminalAsk(timeoutSec: number): Ask {
  return async (summary) => {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const timeout = new Promise<string>((r) => setTimeout(() => r("n"), timeoutSec * 1000).unref());
    try {
      const answer = await Promise.race([rl.question(`Approve ${summary}? [y/N] `), timeout]);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

export async function buildRuntime(config: BotConfig, hash: string, opts: { feed: boolean; clock?: Clock }): Promise<Runtime> {
  assertDryRunOnly(config); // iteration 1: never a live executor
  const clock = opts.clock ?? new SystemClock();
  const store = new BotStore(config.db_path);
  // Public endpoints only; the empty keys keep the client from picking up any trading keys from the environment.
  const api = new KrakenFuturesClient({ apiKey: "", apiSecret: "" });
  const real = new KrakenMarketData(api, config.symbol, clock);
  let sizeStep: number | undefined;
  try {
    sizeStep = (await real.contract()).sizeStep;
  } catch (e) {
    log.warn("contract unavailable at start; the simulator uses its default size step", { error: e instanceof Error ? e.message : String(e) });
  }
  const sim = new DryRunExecutor({ store, clock, config, ...(sizeStep ? { sizeStep } : {}) });
  const market = opts.feed ? new FeedingMarket(real, sim) : real;
  const executor = config.manual_approval ? new ApprovingExecutor(sim, terminalAsk(config.entry_timeout_sec)) : sim;
  const deps: TraderDeps = { executor, market, store, clock, config, configHash: hash };
  const sinks: AlertSink[] = [logSink];
  const brainDir = process.env.BRAIN_DIR;
  if (brainDir) sinks.push(new VaultAlertSink(brainDir));
  else log.warn("BRAIN_DIR is not set: alerts go to the log only and no vault report is written");
  return { deps, sim, sinks, ...(brainDir ? { brainDir } : {}) };
}

// ---- main -----------------------------------------------------------------------------------------------------------

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const configPath = argValue(argv, "--config") ?? process.env.BOT_CONFIG;
  const args = argv.filter((a, i) => a !== "--config" && argv[i - 1] !== "--config");
  const [cmd, sub, arg] = args;
  const { config, hash } = resolveConfig(configPath);
  assertDryRunOnly(config);
  const now = () => Date.now();

  switch (cmd) {
    case "policy": {
      if (sub === "add" && arg) {
        const store = new BotStore(config.db_path);
        const r = addPolicy(store, config, JSON.parse(readFileSync(arg, "utf8")) as PolicyFixture, now());
        console.log(r.ok ? r.note : `rejected: ${r.reason}`);
        return r.ok ? 0 : 1;
      }
      if (sub === "template" && (arg === "long" || arg === "short")) {
        const market = new KrakenMarketData(new KrakenFuturesClient({ apiKey: "", apiSecret: "" }), config.symbol, new SystemClock());
        console.log(JSON.stringify(await policyTemplate(market, config, arg, now()), null, 2));
        return 0;
      }
      break;
    }
    case "status":
      console.log(await statusText(new BotStore(config.db_path), config, now()));
      return 0;
    case "report": {
      const days = Number(argValue(args, "--days") ?? "1");
      const store = new BotStore(config.db_path);
      const since = days === 1 ? dayStartMs(now(), config.day_reset_utc_hour) : now() - days * 86_400_000;
      const md = renderReport(buildReport(store, since, config, now()));
      console.log(md);
      if (args.includes("--write")) {
        if (!process.env.BRAIN_DIR) throw new Error("--write needs BRAIN_DIR");
        console.log(`written: ${await writeVaultReport(process.env.BRAIN_DIR, tradingDay(now(), config.day_reset_utc_hour), md)}`);
      }
      return 0;
    }
    case "ack-halt": {
      const rt = await buildRuntime(config, hash, { feed: true });
      const r = ackHalt(rt.deps.store, now());
      if (!r.ok) {
        console.log(r.reason);
        return 1;
      }
      const rec = await startup(rt);
      console.log(`cleared ${r.cleared}; reconciliation ${rec.clean ? "clean: entries allowed" : "NOT clean: entries stay blocked (see status)"}`);
      return 0;
    }
    case "trader": {
      const rt = await buildRuntime(config, hash, { feed: true });
      let stopping = false;
      process.on("SIGINT", () => (stopping = true));
      process.on("SIGTERM", () => (stopping = true));
      log.info("trader started (dry-run)", { symbol: config.symbol, configHash: hash.slice(0, 12) });
      await startup(rt);
      await loop(() => traderStep(rt), intervals(config).traderMs, { stop: () => stopping });
      return 0;
    }
    case "watchdog": {
      const rt = await buildRuntime(config, hash, { feed: false });
      let stopping = false;
      process.on("SIGINT", () => (stopping = true));
      process.on("SIGTERM", () => (stopping = true));
      log.info("watchdog started (dry-run)", { symbol: config.symbol });
      await loop(() => watchdogStep(rt.deps), intervals(config).watchdogMs, { stop: () => stopping });
      return 0;
    }
    case "run":
      return runBoth(configPath);
  }
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  return 2;
}

// Two child processes sharing the store. If either stops, the other is stopped too, so a trader is never left
// running without its watchdog.
function runBoth(configPath: string | undefined): Promise<number> {
  const self = fileURLToPath(import.meta.url);
  const extra = configPath ? ["--config", configPath] : [];
  const trader = spawn(process.execPath, [self, "trader", ...extra], { stdio: "inherit" });
  const watchdog = spawn(process.execPath, [self, "watchdog", ...extra], { stdio: ["ignore", "inherit", "inherit"] });
  const children = [trader, watchdog];
  const stopAll = () => children.forEach((c) => c.exitCode === null && c.kill("SIGTERM"));
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);
  return new Promise((resolve) => {
    let first = true;
    for (const c of children) {
      c.on("exit", (code) => {
        if (first) {
          first = false;
          log.warn(`${c === trader ? "trader" : "watchdog"} exited (code ${code}); stopping the other`);
          stopAll();
        }
        if (children.every((x) => x.exitCode !== null || x.signalCode !== null)) resolve(code ?? 0);
      });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
