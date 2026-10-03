// sim.ts – a random-scenario driver that runs the whole bot (engine, executor, watchdog, reconciliation) through long
// random sequences of events and checks the safety invariants of the spec (section 10) after every step.
//
// A scenario is deterministic given its seed and uses a fake clock: price walks with gaps and regime changes, hostile
// policies (which must pass the real validator to be stored), lost acks, rejections, partial fills, delays, stops
// that are refused or targets that are acknowledged but never placed, an unreadable exchange, stops cancelled behind
// the bot's back, foreign orders, clock jumps in both directions, and full restarts with downtime.
//
// Properties checked (the P numbers are the spec's):
//   P1 a bot position never has no stop for longer than a bound (operating time; paused while the exchange is unreadable)
//   P2 a stop only ever moves toward the market within a trade
//   P3 no entry breaks a cap: state, risk per trade, leverage, entries per day, order budget for the whole bundle
//   P4 in OPEN, after an undisturbed cycle, the stop equals the position and the targets add up to it
//   P5 every entry has the liquidation distance and the leverage the spec demands
//   P6 the daily counters never decrease, across restarts too
//   P7 the effective policy is never looser than the most conservative of the last N
//   P8 a reduce-only order never increases exposure
//   G1 at most one entry order is open, and an order the bot did not create is never touched
//   G3 an active state always has a trade record;  G5 the account stays finite;  X1 nothing throws

import type { FuturesCandle } from "../kraken-futures-client.ts";
import { BotStore } from "./bot-store.ts";
import { FakeClock } from "./clock.ts";
import { DryRunExecutor } from "./dry-run-executor.ts";
import { loadEngineRecord, saveEngineRecord, defaultEngineRecord } from "./engine-state.ts";
import { type FuturesFill, type OrderRequest, isBotOrder, parseCliOrdId } from "./executor.ts";
import { tradingDay } from "./limits.ts";
import { type LevelMenu, validatePolicy } from "./policy.ts";
import { reconcile } from "./reconcile.ts";
import { T0, config, px } from "./sim-fixtures.ts";
import { estimateLiquidation } from "./sizing.ts";
import { FakeMarket, MENU, Wrapped, longPolicy } from "./trader-fixtures.ts";
import { type TraderDeps, buildSnapshot, filledTargets, runCycle } from "./trader.ts";
import { checkProtection, watchdogTick } from "./watchdog.ts";

export type Prop = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "G1" | "G3" | "G5" | "X1";

export interface Violation {
  prop: Prop;
  seed: number;
  step: number;
  detail: string;
}

export interface ScenarioOptions {
  // Breaks the safety net: stops and closes never reach the exchange. A harness that cannot see P1 fail then is worthless.
  breakProtectTimeout?: boolean;
  // Prints what happened each step (for replaying a seed that failed).
  trace?: boolean;
}

// What a scenario actually exercised, so a property cannot pass because nothing happened.
export interface Stats {
  steps: number;
  entries: number;
  positionsOpened: number;
  stopFills: number;
  targetFills: number;
  closes: number;
  watchdogRepairs: number;
  restarts: number;
  clockBackJumps: number;
  policiesStored: number;
  policiesRejected: number;
  halts: number;
  faults: number;
  reasons: Record<string, number>; // why the engine did what it did: the journalled reason of each distinct decision
}

const PROTECT_BOUND_MS = 30_000; // operating time a bot position may be without a stop
const EPS = 1e-9;

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVELS = [95500, 96500, 97500, 98000, 98500, 99000, 99250, 99500, 100000, 101000, 102000, 103000, 104000, 105000];
const levelId = (i: number) => `L${LEVELS[Math.min(LEVELS.length - 1, Math.max(0, i))]}`;

export async function collectScenario(seed: number, steps: number, opts: ScenarioOptions = {}): Promise<{ violations: Violation[]; stats: Stats }> {
  const rand = mulberry32(seed * 7919 + 13);
  const chance = (p: number) => rand() < p;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);

  const violations: Violation[] = [];
  const flagged = new Set<Prop>();
  const stats: Stats = {
    steps: 0, entries: 0, positionsOpened: 0, stopFills: 0, targetFills: 0, closes: 0, watchdogRepairs: 0, restarts: 0,
    clockBackJumps: 0, policiesStored: 0, policiesRejected: 0, halts: 0, faults: 0, reasons: {},
  };
  let step = 0;
  const flag = (prop: Prop, detail: string) => {
    if (flagged.has(prop)) return; // the first violation of each property is enough
    flagged.add(prop);
    violations.push({ prop, seed, step, detail });
  };

  const store = new BotStore(":memory:");
  const clock = new FakeClock(T0);
  const market = new FakeMarket(clock);
  let ex!: DryRunExecutor;
  let wrapped!: Wrapped;
  let deps!: TraderDeps;

  // ---- fault windows (in steps) and bookkeeping -------------------------------------------------------------------
  let refuseSlUntil = -1;
  let lieTpUntil = -1;
  let unreadableUntil = -1;
  let hungUntil = -1; // the engine process is hung: no cycles, while the watchdog keeps running
  const foreignUntil = new Map<string, number>(); // a foreign order stays for a while, then the user cancels it
  let quietUntil = 0; // P4 is not judged while the bot is being disturbed
  let tpTampered = false;
  const reduceOnlyIds = new Map<string, boolean>();
  const foreignIds = new Set<string>();
  let foreignN = 0;

  // ---- entry-time checks (P3, P5): run when an entry order is about to reach the exchange --------------------------
  const onPlace = (r: OrderRequest) => {
    reduceOnlyIds.set(r.cliOrdId, r.reduceOnly);
    if (r.reduceOnly) return;
    stats.entries++;
    const rec = loadEngineRecord(store);
    const trade = rec.trade;
    if (rec.state !== "ENTERING" || !trade || trade.entryCliOrdId !== r.cliOrdId) {
      flag("P3", `an entry reached the exchange while the saved state was ${rec.state}`);
      return;
    }
    const entry = r.limitPrice ?? NaN;
    const capital = config.trading_capital_usd;
    const riskPct = (r.size * Math.abs(entry - trade.plan.stop) / capital) * 100;
    if (!(riskPct <= config.max_risk_per_trade_pct + 1e-6)) flag("P3", `risk ${riskPct}% exceeds ${config.max_risk_per_trade_pct}%`);
    const leverage = trade.plan.leverage;
    if (!(r.size * entry / capital <= leverage + 1e-6 && leverage <= config.max_leverage + EPS)) {
      flag("P3", `notional ${r.size * entry} over capital ${capital} at leverage ${leverage}`);
    }
    const day = tradingDay(clock.now(), config.day_reset_utc_hour);
    if (store.getCounter(day, "entries") > config.max_entries_per_day) flag("P3", "more entries than max_entries_per_day");
    // The counter already includes this entry. The orders before it plus the whole bundle (entry, stop, each target)
    // must fit the day, so that the protective orders can never be the ones a limit blocks.
    const used = store.getCounter(day, "orders");
    if (used - 1 + 2 + trade.plan.ladder.length > config.max_orders_per_day) flag("P3", `the bundle does not fit the order budget (${used} used)`);
    const side = trade.direction;
    const liq = estimateLiquidation({ side, entry, leverage, mmr: config.maintenance_margin_rate });
    if (!(Math.abs(entry - liq) >= config.liq_distance_min_multiple * Math.abs(entry - trade.plan.stop) - 1e-6)) {
      flag("P5", `liquidation ${liq} too close to entry ${entry} for a stop at ${trade.plan.stop}`);
    }
  };

  const boot = () => {
    ex = new DryRunExecutor({ store, clock, config, sleep: (ms) => clock.advance(ms) });
    wrapped = new Wrapped(ex);
    wrapped.onPlace = onPlace;
    wrapped.refuse = (r) => (opts.breakProtectTimeout ? /-sl-|-close-/.test(r.cliOrdId) : step <= refuseSlUntil && r.cliOrdId.includes("-sl-"));
    wrapped.lie = (r) => step <= lieTpUntil && r.cliOrdId.includes("-tp");
    deps = { executor: wrapped, market, store, clock, config, configHash: "sim" };
  };

  // ---- the world --------------------------------------------------------------------------------------------------
  store.putMenu(MENU);
  store.putPolicy(longPolicy(), T0 - 120_000);
  store.putPolicy(longPolicy(), T0 - 60_000);
  saveEngineRecord(store, { ...defaultEngineRecord(), reconciled: true });
  boot();

  let price = 99250;
  let target = 99250;
  const nextPrice = () => {
    if (chance(0.02)) target = pick([97500, 98200, 99250, 99250, 99250, 100500, 101800, 103000]);
    price += (target - price) * 0.05 + (rand() - 0.5) * 120;
    if (chance(0.03)) price += (rand() - 0.5) * 3000;
    price = Math.min(106000, Math.max(95000, price));
    return Math.round(price * 2) / 2;
  };
  market.last = price;
  ex.onPrice(px(price, clock.now()));

  // ---- random policies: sane ones around the price, and hostile ones; only those the real validator accepts are stored ---
  let menuN = 0;
  let regime: "long" | "short" = "long";
  const maybeStorePolicy = async () => {
    const nowMs = clock.now();
    const menu: LevelMenu = {
      id: `sim-m${menuN++}`, symbol: "PF_XBTUSD", createdAtMs: nowMs,
      levels: LEVELS.map((p) => ({ id: `L${p}`, price: p, kind: "level" })),
    };
    store.putMenu(menu);
    let iLo = 0;
    LEVELS.forEach((p, i) => { if (p <= price) iLo = i; });
    const iHi = Math.min(LEVELS.length - 1, iLo + 1);
    // The direction changes slowly, so that the effective policy (the most conservative of the last N) usually still has a scenario.
    if (chance(0.08)) regime = regime === "long" ? "short" : "long";
    const dir = chance(0.92) ? regime : regime === "long" ? "short" : "long";
    const sane = chance(0.85);
    const nTargets = 1 + Math.floor(rand() * 3);
    const scenario = chance(0.1) ? null : {
      direction: dir,
      entry_zone: sane ? { from: levelId(iLo), to: levelId(iHi) } : { from: levelId(Math.floor(rand() * 14)), to: levelId(Math.floor(rand() * 14)) },
      targets: Array.from({ length: nTargets }, (_, k) => levelId(dir === "long" ? iHi + 1 + k : iLo - 1 - k)),
      invalidation: sane ? levelId(dir === "long" ? iLo - 1 - Math.floor(rand() * 2) : iHi + 1 + Math.floor(rand() * 2)) : levelId(Math.floor(rand() * 14)),
      horizon_hours: between(1, 60),
    };
    const raw = {
      schema_version: 1, menu_id: menu.id, symbol: "PF_XBTUSD",
      bias: chance(0.9) ? (dir === "long" ? 1 : -1) * rand() : between(-1, 1), conviction: rand(),
      risk_budget_pct: chance(0.85) ? between(0.05, 0.5) : between(0.4, 0.9),
      allowed_directions: pick([[dir], [dir], [dir], [dir], ["long", "short"], ["long", "short"], []]), scenario,
      valid_until: new Date(nowMs + between(20, 70) * 60_000).toISOString(), rationale: "random", sources: [],
    };
    const verdict = validatePolicy(raw, { config, getMenu: (id) => store.getMenu(id), nowMs });
    if (!verdict.ok) {
      stats.policiesRejected++;
      return;
    }
    store.putPolicy(verdict.policy, nowMs);
    stats.policiesStored++;

    // P7: the effective policy the trader acts on is never looser than the most conservative of the last N.
    const n = config.loosen_confirm_cycles;
    const recent = store.latestPolicies(n);
    if (recent.length >= n && !wrapped.unreadable) {
      const eff = (await buildSnapshot(deps)).policy?.policy;
      if (!eff) return flag("P7", "no effective policy although enough policies are stored");
      const ps = recent.map((s) => s.policy);
      if (!(eff.risk_budget_pct <= Math.min(...ps.map((p) => p.risk_budget_pct)) + EPS)) flag("P7", "risk budget looser than the most conservative");
      if (!(eff.conviction <= Math.min(...ps.map((p) => p.conviction)) + EPS)) flag("P7", "conviction looser than the most conservative");
      if (!(Math.abs(eff.bias) <= Math.min(...ps.map((p) => Math.abs(p.bias))) + EPS)) flag("P7", "bias looser than the most conservative");
      if (!eff.allowed_directions.every((d) => ps.every((p) => p.allowed_directions.includes(d)))) flag("P7", "allowed directions wider than the intersection");
      if (!(Date.parse(eff.valid_until) <= Math.min(...ps.map((p) => Date.parse(p.valid_until))) + 1)) flag("P7", "valid_until later than the earliest");
    }
  };

  // ---- a restart: downtime, a market that moved meanwhile, a new process, reconciliation ------------------------------
  const restart = async () => {
    stats.restarts++;
    const lastTick = ex.lastTickMs();
    clock.advance(chance(0.3) ? 1000 : Math.floor(between(60_000, 30 * 60_000)));
    const minutes = Math.max(1, Math.ceil((clock.now() - lastTick) / 60_000) + 2);
    const candles: FuturesCandle[] = [];
    let p = price;
    for (let i = 0; i < minutes; i++) {
      const o = p;
      p = Math.min(106000, Math.max(95000, p + (target - p) * 0.05 + (rand() - 0.5) * 300 + (chance(0.05) ? (rand() - 0.5) * 2500 : 0)));
      const c = Math.round(p * 2) / 2;
      candles.push({ t: Math.floor(lastTick / 60_000) * 60 + i * 60, o, h: Math.max(o, c) + rand() * 120, l: Math.min(o, c) - rand() * 120, c, v: 1 });
    }
    price = Math.round(p * 2) / 2;
    market.last = price;
    market.minuteCandles = candles;
    boot();
    await reconcile(deps, { replayer: ex });
  };

  // The harness acts on the exchange directly too (cancelling a stop, placing a foreign order); an armed fault may hit it.
  const attemptHarness = async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await f();
    } catch {
      return undefined;
    }
  };

  // ---- per-step observation state ---------------------------------------------------------------------------------
  let unprotectedForMs = 0;
  let tradeKey: string | null = null;
  let bestStop: number | null = null;
  let wasOpen = new Set<string>();
  const counterSeen = new Map<string, number>();
  const seenFills = new Set<string>();
  let signed = 0;

  for (step = 1; step <= steps; step++) {
    stats.steps++;
    let disturbed = false;
    const roll = rand();
    try {
      if (roll < 0.03) {
        await maybeStorePolicy();
      } else if (roll < 0.06) {
        stats.faults++;
        disturbed = true;
        const f = pick(["drop", "reject", "partial", "delay"]);
        if (f === "drop") ex.inject({ dropAck: 1 });
        else if (f === "reject") ex.inject({ rejectNext: pick(["unknown", "rate_limited", "insufficient_margin"] as const) });
        else if (f === "partial") ex.inject({ partialFill: between(0.3, 0.7) });
        else ex.inject({ delayMs: Math.floor(between(3000, 8000)) });
      } else if (roll < 0.075) {
        disturbed = true;
        const open = await ex.getOpenOrders();
        const what = pick(["sl", "sl", "tp", "grow", "grow", "foreign", "unforeign", "unforeign"]);
        if (what === "grow") {
          // A target larger than the position (as after a partly filled stop): the exchange must cap it when it fires.
          const pos = (await ex.getPositions())[0];
          const tp = open.find((o) => o.cliOrdId && isBotOrder(o.cliOrdId) && parseCliOrdId(o.cliOrdId)?.role.startsWith("tp"));
          if (pos && tp?.cliOrdId) await attemptHarness(() => ex.editOrder({ cliOrdId: tp.cliOrdId!, size: Number((pos.size * 1.6).toFixed(4)) }));
        } else if (what === "sl" || what === "tp") {
          const victim = open.find((o) => o.cliOrdId && isBotOrder(o.cliOrdId) && parseCliOrdId(o.cliOrdId)?.role.startsWith(what));
          if (victim?.cliOrdId) {
            await attemptHarness(() => ex.cancelOrder({ cliOrdId: victim.cliOrdId! }));
            if (what === "tp") tpTampered = true;
          }
        } else if (what === "foreign") {
          const id = `manual-${foreignN++}`;
          const ack = await attemptHarness(() => ex.placeOrder({ symbol: "PF_XBTUSD", side: "buy", orderType: "lmt", size: 0.001, limitPrice: 80000 + foreignN, reduceOnly: false, cliOrdId: id }));
          if ((ack && ack.ok) || (await ex.getOpenOrders()).some((o) => o.cliOrdId === id)) { // a lost ack still placed it
            foreignIds.add(id);
            foreignUntil.set(id, step + 15);
          }
        } else if (foreignIds.size) {
          const id = [...foreignIds][0]!;
          await attemptHarness(() => ex.cancelOrder({ cliOrdId: id }));
          foreignIds.delete(id);
        }
      } else if (roll < 0.085) {
        disturbed = true;
        unreadableUntil = step + Math.floor(between(1, 4));
      } else if (roll < 0.095) {
        disturbed = true;
        if (chance(0.5)) refuseSlUntil = step + Math.floor(between(3, 9));
        else lieTpUntil = step + Math.floor(between(3, 9));
      } else if (roll < 0.105) {
        disturbed = true;
        if (chance(0.5)) clock.advance(Math.floor(between(60_000, 20 * 60_000)));
        else {
          clock.set(clock.now() - Math.floor(between(1000, 120_000)));
          stats.clockBackJumps++;
        }
      } else if (roll < 0.105 + 0.004) {
        // The engine hangs. Often the stop is cancelled just then, so only the watchdog can put it right.
        disturbed = true;
        hungUntil = step + Math.floor(between(4, 11));
        if (chance(0.7)) {
          const stop = (await ex.getOpenOrders()).find((o) => o.cliOrdId && parseCliOrdId(o.cliOrdId)?.role === "sl");
          if (stop?.cliOrdId) await attemptHarness(() => ex.cancelOrder({ cliOrdId: stop.cliOrdId! }));
        }
      } else if (roll < 0.105 + 0.004 + 0.006) {
        disturbed = true;
        if (chance(0.4)) {
          // While the bot was down someone cancelled its orders.
          for (const o of await ex.getOpenOrders()) {
            if (o.cliOrdId && isBotOrder(o.cliOrdId)) await attemptHarness(() => ex.cancelOrder({ cliOrdId: o.cliOrdId! }));
          }
        }
        await restart();
      }
      if (disturbed) quietUntil = step + 3;

      wrapped.unreadable = step <= unreadableUntil;
      // With a position open the market sometimes heads for the target or for the stop, so both get hit.
      const openTrade = loadEngineRecord(store).trade;
      if (openTrade && chance(0.04)) {
        const up = openTrade.direction === "long";
        target = chance(0.5) ? (up ? 102600 : 96400) : up ? 97600 : 101000;
      }
      const dt = 1000 + Math.floor(rand() * 4000);
      clock.advance(dt);
      const p = nextPrice();
      market.last = p;
      ex.onPrice(px(p, clock.now()));
      for (const [id, until] of foreignUntil) {
        if (step >= until) {
          await attemptHarness(() => ex.cancelOrder({ cliOrdId: id }));
          foreignIds.delete(id);
          foreignUntil.delete(id);
        }
      }
      if (step > hungUntil) await runCycle(deps);
      await watchdogTick(deps);

      if (opts.trace) {
        const last = store.listJournal(0, "cycle").slice(-1)[0];
        console.log("   engine:", last?.decision, "|", last?.reason, "| journal t", last ? last.tMs - T0 : "-");
      }
      if (opts.trace) {
        const o = await ex.getOpenOrders();
        const pos = (await ex.getPositions())[0];
        const rr = loadEngineRecord(store);
        console.log(`step ${step} t=${clock.now() - T0} price=${p} state=${rr.state} pos=${pos ? pos.side + " " + pos.size : "-"} orders=[${o.map((x) => `${x.cliOrdId}:${x.unfilledSize}@${x.stopPrice ?? x.limitPrice}`).join(" ")}] ${disturbed ? "DISTURBED(roll " + roll.toFixed(3) + ")" : ""} hung=${step <= hungUntil} unread=${step <= unreadableUntil}`);
      }

      // ---------------------------------------------------------------------------------------------------------
      // Observation (reads the simulated exchange directly, so an unreadable window does not blind the checks).
      const rec = loadEngineRecord(store);
      const [positions, orders, fills] = await Promise.all([ex.getPositions(), ex.getOpenOrders(), ex.getFills(new Date(0))]);
      const position = positions[0] ?? null;
      const trade = rec.trade;

      if ((trade?.entryCliOrdId ?? null) !== tradeKey) {
        tradeKey = trade?.entryCliOrdId ?? null;
        bestStop = null;
        tpTampered = false;
      }

      // P1
      const issues = checkProtection({ position, orders: orders.filter((o) => o.symbol === config.symbol), trade, filledRoles: [], config });
      const bare = !!position && !!trade && issues.some((i) => i.kind === "no_sl");
      if (!bare) unprotectedForMs = 0;
      else if (!wrapped.unreadable) {
        unprotectedForMs += dt;
        if (unprotectedForMs > PROTECT_BOUND_MS) flag("P1", `a ${position.side} position of ${position.size} had no stop for ${unprotectedForMs / 1000}s (state ${rec.state})`);
      }

      // P2
      if (trade) {
        const stops = orders.filter((o) => o.reduceOnly && o.stopPrice !== undefined && o.cliOrdId && parseCliOrdId(o.cliOrdId)?.role === "sl"
          && parseCliOrdId(o.cliOrdId)?.policyId === trade.policyId);
        if (stops.length) {
          const dir = trade.direction === "long" ? 1 : -1;
          const tightest = stops.reduce((a, o) => ((o.stopPrice! - a) * dir > 0 ? o.stopPrice! : a), stops[0]!.stopPrice!);
          if (bestStop !== null && (tightest - bestStop) * dir < -EPS) flag("P2", `the stop moved from ${bestStop} to ${tightest} against a ${trade.direction}`);
          if (bestStop === null || (tightest - bestStop) * dir > 0) bestStop = tightest;
        }
      }

      // P4
      const calm = step > quietUntil && step > hungUntil && !wrapped.unreadable && step > refuseSlUntil && step > lieTpUntil && !opts.breakProtectTimeout;
      if (calm && rec.state === "OPEN" && trade && position) {
        const filledRoles = filledTargets(fills, trade.policyId);
        const bad = checkProtection({ position, orders: orders.filter((o) => o.symbol === config.symbol), trade, filledRoles, config })
          .filter((i) => i.kind === "no_sl" || i.kind === "wrong_sl_size" || (!tpTampered && (i.kind === "no_tp" || i.kind === "wrong_tp_size")));
        if (bad.length) flag("P4", `OPEN but ${bad.map((b) => `${b.kind} (${b.detail})`).join("; ")}`);
      }

      // P6
      const day = tradingDay(clock.now(), config.day_reset_utc_hour);
      counterSeen.set(`${day}:entries`, counterSeen.get(`${day}:entries`) ?? 0);
      counterSeen.set(`${day}:orders`, counterSeen.get(`${day}:orders`) ?? 0);
      for (const [key, before] of counterSeen) {
        const [d, name] = key.split(":") as [string, string];
        const now = store.getCounter(d, name);
        if (now < before - EPS) flag("P6", `${key} fell from ${before} to ${now}`);
        counterSeen.set(key, Math.max(before, now));
      }

      // P8, and the statistics that come from the fills
      const fresh = fills.filter((f) => !seenFills.has(f.fill_id)).sort((a, b) => a.fillTime.localeCompare(b.fillTime) || a.fill_id.localeCompare(b.fill_id));
      for (const f of fresh) {
        seenFills.add(f.fill_id);
        const sign = f.side === "buy" ? 1 : -1;
        const before = signed;
        signed = Number((signed + sign * f.size).toFixed(10));
        if (f.cliOrdId && reduceOnlyIds.get(f.cliOrdId) === true && !(Math.abs(signed) <= Math.abs(before) + EPS && before * signed >= -EPS)) {
          flag("P8", `reduce-only fill ${f.cliOrdId} took the position from ${before} to ${signed}`);
        }
        countFill(f, stats);
      }

      // Open entries and the positions that became OPEN
      const openEntries = orders.filter((o) => !o.reduceOnly && o.cliOrdId && isBotOrder(o.cliOrdId));
      if (openEntries.length > 1) flag("G1", `${openEntries.length} entry orders open at once`);
      for (const id of foreignIds) if (!orders.some((o) => o.cliOrdId === id)) flag("G1", `the order ${id}, which the bot did not create, disappeared`);
      if (rec.state === "OPEN" && trade && !wasOpen.has(trade.entryCliOrdId)) {
        wasOpen.add(trade.entryCliOrdId);
        stats.positionsOpened++;
      }
      if (rec.state === "HALTED") stats.halts++;

      // G3, G5
      if ((rec.state === "ENTERING" || rec.state === "PROTECTING" || rec.state === "OPEN") && !trade) flag("G3", `${rec.state} without a trade record`);
      const acct = await ex.getAccount();
      if (![acct.equity, acct.availableMargin, acct.realizedPnl, acct.fees].every(Number.isFinite)) flag("G5", "the account is not finite");

      // The watchdog's repairs, for the statistics
      stats.watchdogRepairs = store.listJournal(0, "watchdog").filter((r) => r.decision !== "none").length;
    } catch (e) {
      flag("X1", e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(1, 4).join("\n")}` : String(e));
      break;
    }
  }
  wasOpen = new Set();
  for (const row of store.listJournal(0, "cycle")) stats.reasons[row.reason] = (stats.reasons[row.reason] ?? 0) + 1;
  return { violations, stats };
}

function countFill(f: FuturesFill, stats: Stats): void {
  const role = f.cliOrdId ? parseCliOrdId(f.cliOrdId)?.role : undefined;
  if (role === "sl") stats.stopFills++;
  else if (role === "tp1" || role === "tp2" || role === "tp3") stats.targetFills++;
  else if (role === "close") stats.closes++;
}

// Runs one scenario and throws on the first violation, naming the seed and the step so it can be replayed.
export async function runRandomScenario(seed: number, steps: number, opts: ScenarioOptions = {}): Promise<void> {
  const { violations } = await collectScenario(seed, steps, opts);
  const first = violations[0];
  if (first) throw new Error(`${first.prop} violated (seed ${first.seed}, step ${first.step}): ${first.detail}`);
}
