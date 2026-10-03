# Trader Core Implementation Plan

> **For the implementer:** the user writes the implementation code. The assistant writes test skeletons on request
> and reviews each task against this plan and the spec. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Kraken Futures bot's trader core: policy and config validation, sizing, a pure state machine, a
`DryRunExecutor`, reconciliation, a watchdog, a journal and a report. No real order can be placed.

**Architecture:** Pure decision logic (`decide`) is separated from I/O (`runCycle`). Engine and watchdog talk only to
the `Executor` interface. Three processes (analyst, trader, watchdog) share one SQLite file. This plan covers the
trader and the watchdog. The analyst is sub-project 2, so policies enter through a fixture CLI.

**Tech Stack:** TypeScript on Node >= 23.6 (types stripped), `node:test`, `node:sqlite`, `zod` ^4.6.5 (already a dependency).

**Spec:** `docs/superpowers/specs/2026-10-03-trader-core-design.md`

## Global Constraints

- Node >= 23.6 runs `.ts` directly: no `enum`, no `namespace`, no constructor parameter properties (`erasableSyntaxOnly`).
- Relative imports use the `.ts` extension; type-only imports use `import type` (`verbatimModuleSyntax`).
- All code, comments, logs and error messages are in English. Loggers come from `createLogger(scope)` in `logger.ts`.
- All new code lives in `bot/`. Tests are `bot/*.test.ts`, offline, using `node:test` and `node:assert/strict`.
- Iteration 1 cannot place real orders: `LiveExecutor` throws `NotImplemented` in its constructor; the trader process
  uses only `KRAKEN_FUTURES_RO_API_KEY` / `KRAKEN_FUTURES_RO_API_SECRET`.
- Every order carries a `cliOrdId` of the form `bot-<policy_id>-<role>-<seq>`, at most 100 characters.
- Time comes from the injected `Clock`. `Date.now()` is allowed only inside `SystemClock`.
- Default DB path `~/.krypto-kal/bot.db` (outside OneDrive). Tests use `:memory:`.
- Config values and defaults are exactly those in spec section 6. Reduce and close are always allowed; limits block
  entries only.
- Ambiguity in the dry-run fill model resolves against the bot (spec section 7).

## Review Focus

Failure modes the spec implies but does not spell out. Each has a test in the task that owns the code.

1. **Clock steps backwards** (NTP fix, resume from sleep). Cooldowns and TTLs must not extend or crash; the cycle
   treats it as stale data. Task 1 (`FakeClock.set`) and Task 8.
2. **Foreign orders or positions on the symbol** (the user's manual trades). Nothing is cancelled; entries are
   blocked and an incident is recorded. Task 10.
3. **Degenerate levels:** entry zone with `from` above `to`, targets not ordered away from entry, a target on the
   wrong side, stop equal to entry. Rejected at validation, never sized. Task 2 and Task 3.
4. **Bad market numbers:** ATR of zero or NaN, a candle gap, a zero or negative price. No entry and a journal reason;
   never a division by zero in sizing. Task 3.
5. **Rounding breaks the ladder:** tick rounding moves a stop across the entry, or the filled quantity is too small
   to split into the requested TP rungs. Collapse to fewer rungs; if the stop crosses the entry, no entry. Task 3 and Task 9.

---

## File Structure

| File | Responsibility |
|---|---|
| `bot/clock.ts` | `Clock`, `SystemClock`, `FakeClock` |
| `bot/config.ts` | Config schema, defaults, loader, hash |
| `bot/policy.ts` | Policy schema, level menu, validation, effective policy |
| `bot/sizing.ts` | Position sizing, pre-trade validation, liquidation estimate |
| `bot/bot-store.ts` | SQLite tables, key-value state, counters, journal, incidents |
| `bot/executor.ts` | `Executor`, `MarketData`, order types, `makeCliOrdId` |
| `bot/dry-run-executor.ts` | Simulated exchange: fills, fees, funding, replay, fault injection |
| `bot/limits.ts` | Day boundary, counters, cooldowns, limit gate, halt conditions |
| `bot/engine.ts` | Pure `decide(snapshot, config) => Action[]` |
| `bot/trader.ts` | `runCycle`: read, decide, execute, confirm by read-back, journal |
| `bot/reconcile.ts` | Startup reconciliation |
| `bot/watchdog.ts` | `checkProtection`, `watchdogTick` |
| `bot/live-executor.ts`, `bot/approving-executor.ts` | Stub and approval decorator |
| `bot/report.ts`, `bot/cli.ts` | Report, fixture policy insert, halt acknowledgement, launcher |
| `bot/sim.ts` | Random-scenario driver and invariant checker used by property tests |

## Tasks

### Task 1: Clock, config, test wiring

**Files:** Create `bot/clock.ts`, `bot/config.ts`, `bot/config.test.ts`. Modify `package.json`.

**Interfaces:**
- Produces: `interface Clock { now(): number }` (epoch ms); `class SystemClock implements Clock`;
  `class FakeClock implements Clock { constructor(startMs: number); advance(ms: number): void; set(ms: number): void }`;
  `const ConfigSchema` (zod); `type BotConfig = z.infer<typeof ConfigSchema>`; `defaultConfig(): BotConfig`;
  `loadConfig(path: string): { config: BotConfig; hash: string }`.

- [ ] **Step 1: Write failing tests** in `bot/config.test.ts`: `defaultConfig()` equals the spec section 6 values;
  `mode: "live"` with `live_enabled: false` fails to load; an unknown key fails (strict schema);
  `max_risk_per_trade_pct <= 0` fails; the hash is stable for equal content and differs after any value changes;
  `FakeClock.set` can move time backwards.
- [ ] **Step 2: Run** `node --test bot/config.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the signatures above. YAML is not needed: the config file is JSON.
- [ ] **Step 4:** Add `"test:bot": "node --test bot/*.test.ts"` and append `bot/*.test.ts` to `test:offline` and `test`.
  Check that the glob expands under `npm run test:bot` on Windows. Run it. Expected: PASS.
- [ ] **Step 5: Commit** `bot: add clock and config`.

### Task 2: Policy, level menu, effective policy

**Files:** Create `bot/policy.ts`, `bot/policy.test.ts`.

**Interfaces:**
- Consumes: `BotConfig` (Task 1).
- Produces: `type LevelId = string`; `interface Level { id: LevelId; price: number; kind: string }`;
  `interface LevelMenu { id: string; symbol: string; createdAtMs: number; levels: Level[] }`;
  `const PolicySchema`; `type Policy = z.infer<typeof PolicySchema>`;
  `interface ResolvedScenario { direction: "long" | "short"; entryLow: number; entryHigh: number; targets: number[]; stop: number; horizonHours: number }`;
  `validatePolicy(raw: unknown, ctx: { config: BotConfig; getMenu(id: string): LevelMenu | undefined; nowMs: number }): { ok: true; policy: Policy; scenario: ResolvedScenario | null } | { ok: false; reason: string }`;
  `effectivePolicy(history: Policy[], n: number): Policy | null` (history newest first).

- [ ] **Step 1: Write failing tests:** rejects malformed JSON shapes, `bias` outside [-1, 1], `risk_budget_pct` above
  `max_risk_per_trade_pct` (rejected, not clamped), unknown `menu_id`, a menu older than `max_menu_age_min`,
  `symbol` mismatch, a past `valid_until`; clamps `valid_until` to `max_policy_ttl_min`; null `scenario` is valid but
  yields no entry; missing target or invalidation in a scenario fails; long with invalidation at or above the entry
  zone fails; `entry_zone.from` above `to` fails; targets not ordered away from entry fail; `horizon_hours` above
  `max_hold_hours` fails. `effectivePolicy`: tightening (lower risk, conviction, |bias|, fewer directions, earlier
  `valid_until`) takes effect with n = 1 of history; loosening takes the most conservative value over the last n.
- [ ] **Step 2: Run** `node --test bot/policy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as above; `effectivePolicy` works per field.
- [ ] **Step 4: Run.** Expected: PASS. **Step 5: Commit** `bot: add policy validation`.

### Task 3: Sizing and pre-trade validation

**Files:** Create `bot/sizing.ts`, `bot/sizing.test.ts`.

**Interfaces:**
- Consumes: `BotConfig`, `ResolvedScenario`.
- Produces: `interface Contract { tickSize: number; sizeStep: number; minSize: number }`;
  `floorTo(x, step)`, `ceilTo(x, step)`, `convictionMultiplier(conviction, cap)`, `estimateLiquidation({ side, entry, leverage, mmr })`;
  `computeSize(i): { size, riskUsd, riskPct, convictionMult } | { reject: "size_below_min" | "zero_stop_distance" | "invalid_input" }`;
  `splitLadder(prices, size, contract): { price, size }[]`;
  `planTrade(i: TradeInput): TradePlan` with `TradePlan = { ok: true; size; riskUsd; riskPct; stop; ladder; leverage; rewardRisk } | { ok: false; reason: TradeReject }`.
  `planTrade` is what the engine calls; it rounds, sizes and validates in one pass (see spec section 5).

- [ ] **Step 1: Write failing tests** in `bot/sizing.test.ts`: the cap applies after the conviction multiplier;
  leverage caps the size for tight stops; size rounds down to `sizeStep`; `size_below_min`; `zero_stop_distance`;
  `invalid_input` for NaN, zero or negative inputs (never a throw, never a NaN field); stop rounds away from the
  entry and targets toward it, and a target that lands on the entry is dropped; R:R, noise floor and costs (fees
  plus funding, receipts not credited) each reject with their own reason; liquidation reduces the size and never
  moves the stop; the ladder collapses to fewer rungs and its sizes sum to the position.
- [ ] **Step 2: Run** `node --test bot/sizing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Liquidation estimate: `entry x (1 -/+ (1/leverage - mmr))` for long/short.
- [ ] **Step 4: Run.** Expected: PASS. **Step 5: Commit** `bot: add sizing and trade validation`.

### Task 4: Store and journal

**Files:** Create `bot/bot-store.ts`, `bot/bot-store.test.ts`.

**Interfaces:**
- Produces: `expandHome(path: string): string` (expands a leading `~`);
  `class BotStore { constructor(path: string); close(): void }` (`:memory:` or a file; `~` expanded; same
  `mkdirSync` + WAL pattern as `HistoryStore`) with:
  `transaction<T>(fn: () => T): T` (public, reentrant: only the outermost call commits or rolls back),
  `putMenu(m: LevelMenu): void` (throws on a duplicate id), `getMenu(id: string): LevelMenu | undefined`,
  `putPolicy(p: Policy, createdAtMs: number): number` (returns the store-assigned id, never chosen by the LLM),
  `getPolicy(id: number): StoredPolicy | undefined`, `latestPolicies(n: number): StoredPolicy[]` (newest first by
  `createdAtMs`, then id), `getKv(key: string): string | undefined`, `setKv(key: string, value: string): void`,
  `addCounter(day: string, name: string, by: number): void`, `getCounter(day: string, name: string): number` (0 if unset),
  `appendJournal(e: JournalEntry): void` (throws on write failure), `listJournal(sinceMs: number, kind?: string): JournalEntry[]`,
  `addIncident(i: Incident): void`, `listIncidents(sinceMs: number): Incident[]`.
  `interface StoredPolicy { id: number; createdAtMs: number; policy: Policy }`;
  `interface Incident { tMs: number; kind: string; detail: string }`;
  `interface JournalEntry { tMs: number; configHash: string; kind: string; snapshot: unknown; policyId?: number; decision: string; reason: string }`.

- [ ] **Step 1: Write failing tests** (`:memory:`): round-trips for menus, policies (newest first), kv, counters;
  `addCounter` accumulates; a journal row keeps its config hash; `appendJournal` on a closed database throws.
- [ ] **Step 2: Run** `node --test bot/bot-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** JSON columns for snapshots. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `bot: add store and journal`.

### Task 5: Executor interface and DryRunExecutor core

**Files:** Create `bot/executor.ts`, `bot/dry-run-executor.ts`, `bot/dry-run-executor.test.ts`.

**Interfaces:**
- Consumes: `BotStore`, `Clock`, `BotConfig`; types `FuturesPosition`, `FuturesOpenOrder`, `FuturesFill` from
  `kraken-futures-client.ts` (via `import type`).
- Produces: `type OrderRole = "entry" | "sl" | "tp1" | "tp2" | "tp3" | "close"`;
  `makeCliOrdId(policyId: string, role: OrderRole, seq: number): string`;
  `interface OrderRequest { symbol: string; side: "buy" | "sell"; orderType: "lmt" | "mkt" | "stp" | "take_profit"; size: number; limitPrice?: number; stopPrice?: number; reduceOnly: boolean; triggerSignal?: "mark" | "last"; cliOrdId: string; processBefore?: string }`;
  `type RejectKind = "insufficient_margin" | "reduce_only_violation" | "would_cross" | "rate_limited" | "unknown"`;
  `type OrderAck = { ok: true; orderId: string } | { ok: false; kind: RejectKind; message: string }`;
  `interface Executor` exactly as in spec section 7 (`placeOrder`, `editOrder`, `cancelOrder`, `cancelAll`,
  `getPositions`, `getOpenOrders`, `getFills`, `getAccount`) plus `readonly kind`;
  `interface MarketData { ticker(): Promise<PriceEvent>; candles(resolution: string, n: number): Promise<FuturesCandle[]>; fundingRates(): Promise<{ t: number; rate: number }[]>; clock: Clock }`;
  `interface PriceEvent { t: number; mark: number; last: number; bid: number; ask: number }`;
  `class DryRunExecutor implements Executor { constructor(o: { store: BotStore; clock: Clock; config: BotConfig }); onPrice(e: PriceEvent): void }`.

- [ ] **Step 1: Write failing tests:** a limit buy fills only when `last` trades through the limit, not on a touch;
  a stop-market triggers on the configured signal and fills at trigger plus slippage against the bot; maker fee on
  limits and taker fee on market and stop; a repeated `cliOrdId` returns the existing order and creates no second one;
  `reduceOnly` with no position rejects with `reduce_only_violation`; a reduce-only order is capped at the position
  size; `makeCliOrdId` is deterministic, starts with `bot-` and stays within 100 characters; state survives creating
  a new executor on the same store; `onPrice` with a time earlier than the last one is ignored.
- [ ] **Step 2: Run** `node --test bot/dry-run-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Persist orders, positions and fills in the store (add `sim_*` tables to `BotStore`), one
  transaction per event. Position average price by average-cost netting, as in `futures-pnl.ts`.
- [ ] **Step 4: Run.** Expected: PASS. **Step 5: Commit** `bot: add executor interface and dry-run core`.

### Task 6: DryRunExecutor funding, replay, fault injection, contract

**Files:** Modify `bot/dry-run-executor.ts`. Create `bot/dry-run-replay.test.ts`.

**Interfaces:**
- Produces: `DryRunExecutor.accrueFunding(rates: { t: number; rate: number }[]): void`;
  `DryRunExecutor.replay(candles: FuturesCandle[]): void`;
  `DryRunExecutor.inject(f: { dropAck?: number; rejectNext?: RejectKind; partialFill?: number; delayMs?: number }): void`.

- [ ] **Step 1: Write failing tests:** funding accrues once per interval and not twice for the same timestamp;
  replay over candles fires a stop that a candle low crossed; when one candle crosses both SL and TP the SL fires
  first; replay never fires an order placed after the candle; `dropAck: 1` makes the next `placeOrder` throw after
  the order was recorded (a later `getOpenOrders` shows it); `partialFill` fills the given fraction and leaves the
  rest open; output objects have exactly the keys of the `FuturesPosition`, `FuturesOpenOrder` and `FuturesFill`
  interfaces.
- [ ] **Step 2: Run** `node --test bot/dry-run-replay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run all dry-run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `bot: add dry-run funding, replay and fault injection`.

### Task 7: Limits, counters, cooldowns

**Files:** Create `bot/limits.ts`, `bot/limits.test.ts`. Modify `bot/bot-store.ts` (`raiseCounter`).

**Interfaces:**
- Consumes: `BotStore`, `BotConfig`, `FuturesFill`.
- Produces: `tradingDay(nowMs, resetHourUtc): string`; `dayStartMs(nowMs, resetHourUtc): number`;
  `recordPlacedOrder(store, config, nowMs, o: { cliOrdId: string; isEntry: boolean }): boolean` (idempotent per cliOrdId);
  `entryAllowed(i: EntryCheck): { ok: true } | { ok: false; reason: EntryLimit }` where `EntryCheck` carries
  `store, config, nowMs, lastClockMs, openRiskPct, newRiskPct, openPositions, ordersNeeded` (the whole bundle: entry, stop, targets);
  `cooldownUntil({ closedAtMs, lossy, config }): number`; `dailyLossBreached({ realized, unrealized, config }): boolean`;
  `netRealizedSince(fills: FuturesFill[], sinceMs, config): number`;
  `rebuildCounters(store, config, history: { placedAtMs: number; isEntry: boolean }[]): void` (a max, never an add).

- [ ] **Step 1: Write failing tests:** the day boundary honours `day_reset_utc_hour`; each limit blocks an entry at its
  boundary and not before; the order budget reserves room for the whole bundle so protective orders are never blocked;
  placed orders count even when never filled and a retry is not counted twice; cooldown is longer after a loss; daily
  loss counts realised plus unrealised after fees and fails safe on garbage; `rebuildCounters` never lowers a persisted
  counter and is idempotent; a clock set backwards makes `entryAllowed` return `{ ok: false }`; a property test that an
  allowed entry never breaks any cap.
- [ ] **Step 2: Run** `node --test bot/limits.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `bot: add limits and counters`.

### Task 8: Engine decision function (state machine)

**Files:** Create `bot/engine.ts`, `bot/engine.test.ts`. Modify `bot/limits.ts` (pure `checkEntryLimits`), `bot/config.ts`
(`entry_confirm_sec`, `trail_atr_multiple`, `trail_start_r`).

**Interfaces:**
- Consumes: Tasks 1-3, 5, 7.
- Produces: `EngineState`; `TradeRecord` (policyId, direction, entryCliOrdId, entryPrice, plan { size, stop, ladder, leverage },
  horizonEndMs, protectSeq, lastStop?); `PolicyView { id, policy (effective), scenario }`; `Snapshot` (the trader fills it:
  clock, state and its start, halt, trade, position, open orders, price and its age, ATR, policy, time in zone, reconciled,
  foreign exposure, daily-loss and liquidation flags, cooldown end, last trade PnL, daily counters, open risk, contract,
  funding); `Action` = place | cancel | edit (stopPrice and/or size) | transition (with the new trade record or a cooldown end)
  | halt (manual acknowledgement or until a time) | skip; `reduceOnlyReason(s, config)`; `decide(s, config): Action[]` (pure,
  never empty, at least a `skip` with a reason).
- Id rules the trader relies on: repairs use a fresh `protectSeq` (bumped on a missing stop) and close orders use an attempt
  number derived from elapsed time, so a retry reuses the id but a finished order is never "re-placed".

- [ ] **Step 1: Write failing tests:** one block per row of the spec section 4 table; each FLAT precondition has its own skip
  reason; reduce-only mode blocks entries but never closes a position, and an expired policy is not authoritative;
  protection is confirmed by read-back, sized to the filled quantity, and closes at market on timeout; the stop is only
  ever tightened (mutation-checked property over random snapshots); leftovers are cancelled before COOLDOWN and the
  bot never cancels an order it did not create; manual halts never clear by themselves; a backwards clock yields only a skip.
- [ ] **Step 2: Run** `node --test bot/engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `decide` as one pure function per state. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `bot: add pure engine decision function`.

### Task 9: Trader cycle and protection flow

**Files:** Create `bot/trader.ts`, `bot/trader.test.ts`, `bot/indicators.ts` (ATR), `bot/engine-state.ts` (the persisted record),
`bot/indicators.test.ts`. Modify `bot/engine.ts` (`filledRoles`), `bot/policy.ts` (export `resolveScenario`), `bot/executor.ts`
(`MarketData.contract()`).

**Interfaces:**
- Consumes: Tasks 4-8.
- Produces: `TraderDeps { executor, market, store, clock, config, configHash }`; `buildSnapshot(d): Promise<Snapshot>` (throws when the
  exchange or the stored record cannot be read); `runCycle(d): Promise<Action[]>`; `JOURNAL_HEARTBEAT_MS`;
  `atr(candles, period, resolution, nowMs): number | null`; `EngineRecord` with `loadEngineRecord` / `saveEngineRecord` (one JSON value in the store).
- Rules: an unreadable exchange or record means no decisions (an incident and a `snapshot_unavailable` skip); an entry is placed only
  after the new state is saved, everything else in the order the engine returns; a lost ack or a rejection is an incident, not an abort; a failed
  journal write blocks new entries but never protection; the journal gets a row on any action, on a change of state or reason, and as a heartbeat.

- [ ] **Step 1: Write failing tests** against the real `DryRunExecutor` and store with a fake market: the snapshot reads everything;
  entry placement and counters; a lost ack leaves one order; protection is confirmed by read-back (a lying ack keeps the bot out of OPEN and
  ends in a close); a stop refused for good closes within the timeout; a lost ack on the stop is retried with the same id; a partial fill is
  cancelled then protected at the filled size; a filled target shrinks the stop, then the stop trails and `lastStop` is saved; a missing
  stop is re-placed under a new id at `lastStop` without the filled rung; a stop hit leaves no orphans before the cooldown; the time-stop; journal
  dedupe, heartbeat and failure; an unreadable exchange, a corrupt record, a backwards clock, the daily-loss halt and its clearing, a
  liquidation halt, foreign orders; and the ordering of state saves against order placement.
- [ ] **Step 2: Run** `node --test bot/trader.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildSnapshot`, `runCycle` and the helpers. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `bot: add trader cycle and protection flow`.

### Task 10: Reconciliation

**Files:** Create `bot/reconcile.ts`, `bot/reconcile.test.ts`, `bot/trader-fixtures.ts` (the shared test world, moved out of
`trader.test.ts`). Modify `bot/executor.ts` (`getOrderHistory`, `PlacedOrder`), `bot/dry-run-executor.ts` (`getOrderHistory`,
`lastTickMs`), `bot/engine.ts` (a HALTED bot closes a stop-less position only when it has a trade record for it).

**Interfaces:**
- Produces: `reconcile(d: TraderDeps, opts?: { replayer?: Replayer }): Promise<{ clean: boolean; incidents: Incident[] }>`;
  `Replayer { replay(candles, intervalSec?); accrueFunding(rates); lastTickMs() }` (`DryRunExecutor` satisfies it).
- Rules: the persisted `reconciled` flag is cleared first and set again only by a clean run; a position with no trade record (or on the
  wrong side of it) halts for acknowledgement and is never closed; a bot position without a stop halts and the engine closes it; orders the
  bot created that no trade explains are cancelled; orders it did not create are reported and left alone (entries stay blocked while they
  exist); counters are raised from the order history; in the simulation the downtime is replayed from one-minute candles (at most 2000)
  and the funding of the hours held is charged; an unreadable exchange or record, a failed or impossible replay with something open, are not clean.

- [ ] **Step 1: Write failing tests:** a clean start; a healthy position and a resting entry left alone; idempotence; the flag cleared before
  anything else; an unreadable exchange or record; a bot position without a stop; an unexplained position never closed (and its stops kept);
  the wrong side; orphan and foreign orders; counters raised, never lowered, bot orders only, and a rebuilt budget refusing the next entry;
  a stop that fired in the downtime books once; a target and funding during the downtime; no candles, too long a gap, and a long gap with nothing open.
- [ ] **Step 2: Run** `node --test bot/reconcile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `bot: add reconciliation`.

### Task 11: Watchdog

**Files:** Create `bot/watchdog.ts`, `bot/watchdog.test.ts`. Modify `bot/trader.ts` (export `filledTargets`).

**Interfaces:**
- Produces: `IssueKind` (`no_sl`, `wrong_sl_size`, `no_tp`, `wrong_tp_size`, `orphan_reduce_only`, `unexplained_position`,
  `position_on_wrong_side`, `cannot_verify`); `ProtectionIssue { kind, detail }`;
  `ProtectionInput { position, orders, trade, filledRoles, config }`; `checkProtection(i): ProtectionIssue[]` (pure);
  `watchdogTick(d: TraderDeps): Promise<ProtectionIssue[]>`.
- Rules: it only reads the engine record and keeps its own state under its own key; it waits `2 x protect_timeout_sec` after first seeing a
  problem; everything it places is reduce-only; it never touches a position without a trade record or an order the bot did not create; a
  missing stop is re-placed once (at the last trailed stop) and then the position is closed at market; a missing or short target is
  re-placed but never closes anything; repair ids start at sequence 100 (closes at 1000) and only count up; what it cannot read it reports as
  `cannot_verify` while a pending repair keeps its clock.

- [ ] **Step 1: Write failing tests:** each issue kind from crafted positions and orders; a clean set reports none; a property that no issues
  means a stop of the right size exists; the grace period; the stop re-placed at the trailed value; a failed repair closes; leftover targets
  cancelled and foreign orders untouched; a missing target re-placed at its own rung and never closing; a wrong stop size edited; orphans after
  a close; engine and watchdog repairing together leave one stop in either order; nothing done right after a fill while the engine protects; an
  unexplained position never touched; an unreadable exchange; the engine record never written; one incident per distinct problem.
- [ ] **Step 2: Run** `node --test bot/watchdog.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `bot: add watchdog`.

### Task 12: Property tests and tripwire

**Files:** Create `bot/sim.ts`, `bot/invariants.test.ts`. Modify `bot/engine.ts` (a backwards clock no longer stops protection),
`bot/trader.ts` (an outage is recorded once, not every cycle), `bot/watchdog.ts` (counts its orders; oversized targets are not an issue),
`bot/dry-run-executor.ts` (an injected partial fill is rounded down to the size step).

**Interfaces:**
- Produces: `collectScenario(seed, steps, opts?): Promise<{ violations: Violation[]; stats: Stats }>`;
  `runRandomScenario(seed, steps, opts?): Promise<void>` (throws `P1 violated (seed N, step M): ...` on the first violation);
  `ScenarioOptions { breakProtectTimeout?: boolean; trace?: boolean }`; `Prop`, `Violation`, `Stats`.
- A scenario is deterministic from its seed and uses the fake clock. It drives the real engine, executor, watchdog and reconciliation through
  price walks with gaps, hostile policies (stored only if the real validator accepts them), lost acks, rejections, partial fills, delays, refused
  stops, targets acknowledged but never placed, an unreadable exchange, a hung engine, stops cancelled behind the bot, oversized targets, foreign
  orders, clock jumps both ways, and restarts with downtime and orders cancelled meanwhile.
- Properties checked after every step: P1 (a bot position never lacks a stop for more than 30 s of operating time, paused while the exchange is
  unreadable), P2, P3 (state, risk, leverage, entries per day, the order budget for the whole bundle), P4 (undisturbed OPEN cycles; targets must
  not under-cover), P5, P6, P7, P8, G1 (one entry order; foreign orders untouched), G3, G5, X1 (nothing throws).

- [ ] **Step 1: Write the tests:** one test per property over `SIM_SEEDS` (default 60) scenarios of `SIM_STEPS` (default 500) steps; coverage
  thresholds so no property passes because nothing happened; the tripwire (with stops and closes never reaching the exchange the harness must
  report P1, and `runRandomScenario` must throw naming the seed); determinism (the same seed gives the same result).
- [ ] **Step 2: Run** `node --test bot/invariants.test.ts`. Expected: FAIL (no `sim.ts`).
- [ ] **Step 3: Implement `sim.ts`** by composing Tasks 5-11. **Step 4: Run.** Expected: PASS, tripwire included (about 20 s).
- [ ] **Step 5: Commit** `bot: add property tests`.

### Task 13: Live stub and approval decorator

**Files:** Create `bot/live-executor.ts`, `bot/approving-executor.ts`, `bot/guards.test.ts`.

**Interfaces:**
- Produces: `class LiveExecutor implements Executor` whose constructor always throws `Error("LiveExecutor is not implemented in iteration 1")`;
  `class ApprovingExecutor implements Executor { constructor(inner: Executor, ask: (summary: string) => Promise<boolean>) }`.

- [ ] **Step 1: Write failing tests:** constructing `LiveExecutor` always throws, even with `live_enabled: true`;
  `ApprovingExecutor` forwards an approved `placeOrder`, returns `{ ok: false, kind: "unknown" }` on a denied one,
  shows the reason text, and never gates `cancelOrder`, `cancelAll` or reads; the trader entry point refuses to start
  when `mode: "live"`; a source scan finds no use of `tradingEnabled: true` anywhere in `bot/`.
- [ ] **Step 2: Run** `node --test bot/guards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `bot: add live stub and approval decorator`.

### Task 14: Report, CLI, launcher

**Files:** Create `bot/report.ts`, `bot/cli.ts`, `bot/report.test.ts`. Modify `package.json` (add `"bot"`).

**Interfaces:**
- Produces: `buildReport(store: BotStore, sinceMs: number): { policyAccuracy: ...; rejectedByReason: Record<string, number>; netPnl: number; incidents: number; calibration: { tercile: "low" | "mid" | "high"; avgR: number; n: number }[] }`;
  CLI commands `node bot/cli.ts policy add <file>` (validates then stores a fixture policy and menu),
  `report`, `ack-halt`, `run` (starts trader and watchdog as separate child processes).

- [ ] **Step 1: Write failing tests:** the report counts rejected entries per reason; net PnL includes fees,
  funding and slippage; calibration buckets by conviction tercile and reports `n` per bucket; `policy add` rejects
  an invalid fixture and stores a valid one; `ack-halt` clears only a manual-acknowledgement halt, never the
  daily-loss halt before its reset hour.
- [ ] **Step 2: Run** `node --test bot/report.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** `npm run test:bot` and `npm run typecheck`. Expected: PASS, no errors.
- [ ] **Step 5: Commit** `bot: add report, CLI and launcher`.

## Self-review notes

- Spec sections 4, 5, 6, 7, 8, 9, 10 map to Tasks 8, 2-3, 1, 5-6 and 13, 8-11, 14, 12. Section 11 (exit criteria) is
  operational, not code. Section 2's assumptions are for stage 2 and are not tested here.
- The foreign-order rule and `maintenance_margin_rate` were added to the spec while writing this plan.
