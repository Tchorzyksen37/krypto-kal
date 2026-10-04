// runner.ts – the launcher's loops, as small steps that tests can drive with a fake clock.
//
// Trader process:  startup (reconcile, with the simulated exchange's downtime replay) once, then every
//                  cycle_interval_sec a traderStep: one cycle (its ticker read also feeds the simulated exchange),
//                  hourly funding, alerts for new incidents and halt changes, and the vault report once an hour.
// Watchdog process: every watchdog_interval_sec a watchdogTick (independent check of the stop and targets).
// Iteration 1 is dry-run only: buildRuntime refuses any other mode and never creates a live executor.

import { createLogger } from "../core/logger.ts";
import { type AlertSink, collectAlerts, dispatch, writeVaultReport } from "./alerts.ts";
import type { BotStore } from "./bot-store.ts";
import type { Clock } from "./clock.ts";
import type { BotConfig } from "./config.ts";
import type { DryRunExecutor } from "./dry-run-executor.ts";
import { dayStartMs, tradingDay } from "./limits.ts";
import { reconcile, type ReconcileResult } from "./reconcile.ts";
import { buildReport, renderReport } from "./report.ts";
import { type TraderDeps, runCycle } from "./trader.ts";
import { watchdogTick } from "./watchdog.ts";

const log = createLogger("bot-runner");
const HOUR_MS = 3_600_000;

export interface Runtime {
  deps: TraderDeps; // its market feeds quotes to `sim`; its executor may be the approval decorator around `sim`
  sim: DryRunExecutor;
  sinks: AlertSink[];
  brainDir?: string; // where the vault report goes; absent: no report file
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Reconciles once at start. Entries stay blocked until a clean run (the engine checks the flag).
export async function startup(rt: Runtime): Promise<ReconcileResult> {
  const result = await reconcile(rt.deps, { replayer: rt.sim });
  if (result.clean) log.info("reconciled: entries allowed");
  else log.warn("reconciliation is NOT clean: entries stay blocked until it is (see incidents)", { incidents: result.incidents.length });
  await flushAlerts(rt);
  return result;
}

export async function flushAlerts(rt: Runtime): Promise<void> {
  try {
    await dispatch(collectAlerts(rt.deps.store, rt.deps.clock.now()), rt.sinks);
  } catch (e) {
    log.error("collecting alerts failed", { error: errText(e) });
  }
}

const LAST_FUNDING_KEY = "runner:funding_hour";
const FUNDING_ERROR_KEY = "runner:funding_error";
const LAST_REPORT_KEY = "runner:report_hour";

// One trader iteration. Never throws: a failure becomes an incident, so the loop keeps protecting what is open.
export async function traderStep(rt: Runtime): Promise<void> {
  const { store, clock } = rt.deps;
  try {
    await runCycle(rt.deps);
  } catch (e) {
    note(store, clock, "runner_cycle_failed", errText(e));
  }

  const hour = Math.floor(clock.now() / HOUR_MS);
  if (store.getKv(LAST_FUNDING_KEY) !== String(hour)) {
    try {
      rt.sim.accrueFunding(await rt.deps.market.fundingRates());
      const account = await rt.sim.getAccount();
      store.putDoc("funding_mark", String(hour), clock.now(), { t: clock.now(), funding: account.funding });
      store.setKv(LAST_FUNDING_KEY, String(hour));
      store.setKv(FUNDING_ERROR_KEY, "");
    } catch (e) {
      // Retried every step, but recorded only when the cause changes or once an hour: an outage is one incident, not one per cycle.
      const detail = errText(e);
      const last = JSON.parse(store.getKv(FUNDING_ERROR_KEY) || "null") as { detail: string; tMs: number } | null;
      if (!last || last.detail !== detail || clock.now() - last.tMs >= HOUR_MS || clock.now() < last.tMs) {
        note(store, clock, "funding_unavailable", detail);
        store.setKv(FUNDING_ERROR_KEY, JSON.stringify({ detail, tMs: clock.now() }));
      }
    }
  }

  await flushAlerts(rt);

  if (rt.brainDir && store.getKv(LAST_REPORT_KEY) !== String(hour)) {
    try {
      await writeDayReport(rt, clock.now());
      store.setKv(LAST_REPORT_KEY, String(hour));
    } catch (e) {
      log.warn("writing the vault report failed", { error: errText(e) });
    }
  }
}

// The report of the trading day containing `nowMs`, written to <brain>/output/bot/report-<day>.md. At the first
// hour of a new day the previous day is finalised once more, so its last hour is included.
export async function writeDayReport(rt: Runtime, nowMs: number): Promise<string | undefined> {
  if (!rt.brainDir) return undefined;
  const { store, config } = rt.deps;
  const start = dayStartMs(nowMs, config.day_reset_utc_hour);
  if (nowMs - start < HOUR_MS) {
    const prevStart = start - 24 * HOUR_MS;
    await writeVaultReport(rt.brainDir, tradingDay(prevStart, config.day_reset_utc_hour), renderReport(buildReport(store, prevStart, config, start)));
  }
  return writeVaultReport(rt.brainDir, tradingDay(nowMs, config.day_reset_utc_hour), renderReport(buildReport(store, start, config, nowMs)));
}

export async function watchdogStep(deps: TraderDeps): Promise<void> {
  try {
    const issues = await watchdogTick(deps);
    if (issues.length) log.warn("watchdog found protection issues", { issues: issues.map((i) => i.kind) });
  } catch (e) {
    note(deps.store, deps.clock, "watchdog_failed", errText(e));
  }
}

function note(store: BotStore, clock: Clock, kind: string, detail: string): void {
  log.error(kind, { detail });
  try {
    store.addIncident({ tMs: clock.now(), kind, detail });
  } catch {
    /* the log line is what is left */
  }
}

// Runs `step` every `intervalMs` until `stop()` says so. Overruns do not stack: the next step starts after the
// previous one finished.
export async function loop(
  step: () => Promise<void>, intervalMs: number,
  opts: { stop?: () => boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  while (!opts.stop?.()) {
    await step();
    if (opts.stop?.()) break;
    await sleep(intervalMs);
  }
}

export const intervals = (config: BotConfig) => ({ traderMs: config.cycle_interval_sec * 1000, watchdogMs: config.watchdog_interval_sec * 1000 });
