# Bot: four symbols, one position at a time, calibrated conviction sizing - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dry-run bot trades BTC, ETH, SOL and XRP perpetuals (one position at a time, the best checked speculation bet wins) and sizes each bet by its history-corrected probability.

**Architecture:** `config.symbols` replaces the single `config.symbol`. The "active symbol" is resolved every cycle in the trader (open trade, else held position, else the live policy's symbol) and passed explicitly into the pure engine through the snapshot. The simulated exchange keeps a quote and a position per symbol. A new pure module corrects the stated probability with the scorecard history; the converter uses it and a lower base risk so conviction can raise as well as lower the position.

**Tech Stack:** TypeScript on Node >= 23.6 (types stripped, no build), `node:test`, `node:sqlite`, zod.

**Spec:** `docs/superpowers/specs/2026-10-14-bot-multi-symbol-conviction-design.md`

## Global Constraints

- All code, comments, logs and error messages in English. Relative imports use the `.ts` extension; type-only imports use `import type`; no `enum`, `namespace` or constructor parameter properties (`erasableSyntaxOnly`).
- Dry-run only: `LiveExecutor` still always throws; `assertDryRunOnly` stays; the guard tests (`guards.test.ts`) stay green.
- Hard limits are never loosened by conviction: `max_risk_per_trade_pct` (0.5), `max_total_open_risk_pct`, `daily_loss_limit_pct`, `max_open_positions` (1), `sl_min_atr_multiple`, `min_reward_risk`, `liq_distance_min_multiple`.
- New config defaults: `symbols: ["PF_XBTUSD"]`, `base_risk_per_trade_pct: 0.4` (must be <= `max_risk_per_trade_pct`). `config/bot.auto.json` ends with the four symbols `PF_XBTUSD`, `PF_ETHUSD`, `PF_SOLUSD`, `PF_XRPUSD`.
- Calibration: `k = 10` pseudo-bets, global (not per symbol or session), no data gives ratio 1.
- Tests: `npm run test:bot` after every task, `npm run typecheck` and `npm run test:offline` at the end. Every task leaves both green.
- Work on a new branch (the current `fix/speculation-meta-case-and-window` holds unrelated work). `config/bot.auto.json` already has an uncommitted user change (`max_policy_ttl_min: 30`); keep it when editing the file.
- The running dry-run database (`~/.krypto-kal/bot.db`) holds an open BTC short written by the old code. It must load and keep working after the change (Task 5 and 6 pin this).

## Review Focus

1. A policy for a different symbol must not blend into the effective policy of the previous one (min conviction, min budget over mixed symbols) - Task 3.
2. A live policy for another symbol must not close, flip or void an open position, and a resting entry must be withdrawn when the live policy moves to another symbol - Task 6.
3. The "price stayed in the entry zone" timer must not carry over when the active symbol changes - Task 6.
4. Two positions, or one on a symbol outside `symbols`, must halt for acknowledgement and never be silently ignored - Tasks 5, 6, 7.
5. Old state loads: a trade record without `symbol`, the simulator's single `price`/`hist`/contract cache, a missing or corrupt `bets-log.json` (ratio 1 with a warning) - Tasks 2, 5, 6.

---

### Task 1: Config fields `symbols` and `base_risk_per_trade_pct`

**Files:**
- Modify: `src/bot/config.ts`, `src/bot/config.test.ts`
- Modify: `config/bot.auto.json` is changed in Task 9, not here.

**Interfaces:**
- Produces: `BotConfig.symbols: string[]`, `BotConfig.base_risk_per_trade_pct: number`, and `export const isAllowedSymbol = (config: BotConfig, symbol: string): boolean`. `BotConfig.symbol` stays for now as the transitional primary symbol (removed in Task 9).

- [ ] **Step 1: Write failing tests in `config.test.ts`:** `defaults: symbols is ["PF_XBTUSD"] and base_risk_per_trade_pct is 0.4`; `symbols must be non-empty and unique` (two cases, each throws with a message containing "symbols"); `symbols must contain symbol` (throws); `base_risk_per_trade_pct above max_risk_per_trade_pct is rejected`; `a file with four symbols loads and isAllowedSymbol accepts each and rejects PF_DOGEUSD`; `the config hash changes when symbols change`.
- [ ] **Step 2: Run** `node --env-file-if-exists=.env --test src/bot/config.test.ts`; expect the new tests to FAIL.
- [ ] **Step 3: Implement** in `ConfigSchema`: `symbols: z.array(z.string().min(1)).min(1)`, `base_risk_per_trade_pct: pct`, and `.refine` rules (unique, includes `symbol`, base <= max_risk_per_trade_pct). Add both to `DEFAULTS`. Export `isAllowedSymbol`.
- [ ] **Step 4: Run** `npm run test:bot` and `npm run typecheck`; expect PASS (other tests build configs from `defaultConfig()` so they keep working).
- [ ] **Step 5: Commit** `git add src/bot/config.ts src/bot/config.test.ts && git commit -m "bot config: symbols list and base risk per trade"`.

### Task 2: Calibrated conviction (pure module)

**Files:**
- Create: `src/bot/conviction.ts`, `src/bot/conviction.test.ts`

**Interfaces:**
- Consumes: `LoggedBet` from `../speculation/types.ts`, `withoutOverlaps` from `../speculation/overlap.ts` (non-overlapping bets, as the scorecard does).
- Produces:
  - `export const CALIBRATION_K = 10`
  - `export function calibrationRatio(log: LoggedBet[], k = CALIBRATION_K): { ratio: number; touched: number; hits: number; expected: number }`
  - `export function calibratedConviction(stated: number, ratio: number): number` (`clamp(stated x ratio, 0, 1)`)
  - `export function loadCalibration(speculationDir: string, k = CALIBRATION_K): { ratio: number; touched: number; warning?: string }` (synchronous; reads `<dir>/bets-log.json` with `readFileSync`)

- [ ] **Step 1: Write failing tests** (`node:test`, bets built with a small helper that sets `probability`, `hypothetical.status`, `symbol`, `side`, times):
  - `no touched bets: ratio is 1`.
  - `3 touched bets with stated 0.4 and no hit: ratio is 4 / 5.2 (0.769)` (assert within 1e-3). The formula: touched bets only (status `tp`, `sl` or `ttl`), `hits` = status `tp`, `expected` = sum of stated probabilities, `pbar = expected / touched`, `ratio = (hits + k x pbar) / (expected + k x pbar)`.
  - `a well calibrated sample of 100 (hits equal expected) gives ratio 1`.
  - `a badly calibrated sample of 100 (40 expected, 5 hits) gives a ratio near 0.3` (assert < 0.4).
  - `an over-performing sample gives ratio above 1 and calibratedConviction clamps to 1`.
  - `overlapping bets on the same symbol and side count once`.
  - `loadCalibration: missing file, invalid JSON and a non-array each return ratio 1 and a warning`; `a valid file returns the ratio and no warning`.
- [ ] **Step 2: Run** `node --env-file-if-exists=.env --test src/bot/conviction.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement** the three functions as specified; `loadCalibration` catches every read/parse error.
- [ ] **Step 4: Run** the test file, then `npm run test:bot`; expect PASS.
- [ ] **Step 5: Commit** `git add src/bot/conviction.ts src/bot/conviction.test.ts && git commit -m "bot: history-corrected conviction"`.

### Task 3: Policy validation and effective policy per symbol

**Files:**
- Modify: `src/bot/policy.ts`, `src/bot/policy.test.ts`

**Interfaces:**
- Consumes: `isAllowedSymbol` (Task 1).
- Produces: `validatePolicy` accepts a policy whose `symbol` is in `config.symbols` and whose menu has the same symbol as the policy; `effectivePolicy(history, n)` considers only the leading run of `history` (newest first) with the same `symbol` as `history[0]`, and returns null while that run is shorter than `n`.

- [ ] **Step 1: Write failing tests:**
  - `validatePolicy accepts a symbol from config.symbols` (config with two symbols).
  - `validatePolicy rejects a symbol outside config.symbols` (message contains the symbol).
  - `validatePolicy rejects a menu whose symbol differs from the policy's`.
  - `effectivePolicy: copies of a new symbol do not blend with older policies of another symbol` (history `[ETH, ETH, BTC, BTC]`, n = 3 gives null; n = 2 returns a policy with `symbol` ETH and conviction equal to the minimum of the two ETH entries only).
  - `effectivePolicy: single-symbol behaviour is unchanged` (existing tests stay).
- [ ] **Step 2: Run** `node --env-file-if-exists=.env --test src/bot/policy.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** in `validatePolicy` (`!isAllowedSymbol(config, policy.symbol)` and `menu.symbol !== policy.symbol`) and at the top of `effectivePolicy` (slice the leading same-symbol run before the length check).
- [ ] **Step 4: Run** `npm run test:bot`; expect PASS.
- [ ] **Step 5: Commit** `git commit -am "bot policy: several symbols, effective policy per symbol"`.

### Task 4: Converter, base risk and calibration hand-off

**Files:**
- Modify: `src/bot/from-speculation.ts`, `src/bot/from-speculation.test.ts`, `src/bot/cli.ts` (`addFromSpeculation`, CLI `policy from-speculation`), `src/automation/handoff.ts`, `src/automation/cli.ts` (`buildDeps`), and the matching tests (`src/automation/*.test.ts` that call `handoff`).

**Interfaces:**
- Consumes: `isAllowedSymbol` (Task 1), `calibratedConviction`, `loadCalibration` (Task 2).
- Produces:
  - `fixturesFromSpeculation(meta: ReportMeta, config: BotConfig, nowMs: number, source = "speculation", ratio = 1): SpeculationConversion` - bets on any symbol in `config.symbols` are eligible; the menu and policy use the bet's `futures`; `risk_budget_pct = config.base_risk_per_trade_pct`; `conviction = calibratedConviction(clamp(bet.probability), ratio)`; the rationale ends with ` [stated P=0.xx, ratio=0.xx]`. Still one fixture per report (best eligible bet over all symbols). The skip text for other contracts becomes `the bot does not trade <futures> (allowed: <list>)`.
  - `addFromSpeculation(store, config, meta, nowMs, opts: { dry?: boolean; source?: string; ratio?: number })` and `handoff(store, config, meta, nowMs, source, ratio = 1)`. The output line prints the bet's symbol instead of `config.symbol`.
  - `buildDeps` (automation) and the CLI call `loadCalibration(join(brainDir, "output", "speculation"))` and pass `ratio`; a warning from it is appended to the handoff/CLI detail. The CLI uses `BRAIN_DIR` when set, otherwise ratio 1.

- [ ] **Step 1: Write failing tests in `from-speculation.test.ts`:** `the best bet over four symbols is converted and its futures is the policy symbol`; `a bet on a symbol outside config.symbols is skipped with the allowed list in the reason`; `risk_budget_pct equals base_risk_per_trade_pct`; `conviction equals stated x ratio (ratio 0.5, stated 0.6 gives 0.3) and is clamped to 1`; `the rationale carries stated P and the ratio`; `default ratio 1 keeps conviction equal to the stated probability`. In the automation handoff test: `handoff passes the ratio through` (store receives the corrected conviction). In `sizing.test.ts` (no code change in `sizing.ts`): `with base risk 0.4, cap 1.25 and max 0.5 the conviction multiplier is 0.5, 0.8, 1.0 and 1.25 for conviction 0, 0.4, 0.667 and 1`, `the risk taken is within one size step of min(0.4 x multiplier, 0.5) percent of capital`, and a property test over random conviction in [0, 1] that `riskPct` never exceeds `max_risk_per_trade_pct`.
- [ ] **Step 2: Run** `node --env-file-if-exists=.env --test src/bot/from-speculation.test.ts src/automation/*.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** as specified. The `haveOne` rule stays (first eligible bet wins; validated bets are already ranked).
- [ ] **Step 4: Run** `npm run test:bot` and `npm run test:offline`; expect PASS.
- [ ] **Step 5: Commit** `git commit -am "speculation hand-off: any allowed symbol, base risk, corrected conviction"`.

### Task 5: Simulated exchange with a quote and a position per symbol

**Files:**
- Modify: `src/bot/dry-run-executor.ts`, `src/bot/market-data.ts` (`PriceSink`, `FeedingMarket`), `src/bot/dry-run-executor.test.ts`, `src/bot/dry-run-replay.test.ts`, `src/bot/sim-fixtures.ts`

**Interfaces:**
- Consumes: `isAllowedSymbol` (Task 1).
- Produces:
  - `DryRunExecutor.onPrice(e: PriceEvent, symbol?: string)`, `replay(candles, intervalSec?, symbol?)`, `accrueFunding(rates, symbol?)`; `symbol` defaults to `config.symbols[0]`. `lastTickMs()` stays global.
  - `PriceSink.onPrice(e: PriceEvent, symbol?: string)`; `new FeedingMarket(inner, sink, symbol?)` passes its symbol on.
  - `export function readSimPositions(store: BotStore, config: BotConfig): { symbol: string; size: number; avgPrice: number }[]` (every symbol with a non-zero simulated position, including symbols that are no longer in `config.symbols`).
  - `getPositions()` returns one entry per symbol with a position (using `readSimPositions` logic); orders and fills carry their own symbol.

- [ ] **Step 1: Write failing tests (dry-run-executor.test.ts, using a config with two symbols):**
  - `quotes are per symbol: a stop on ETH fires only on an ETH quote, not on a BTC quote` (both prices fed, only the ETH one crosses).
  - `a position is kept per symbol and getPositions lists both` (long BTC and short ETH).
  - `account equity uses each position's own mark` (assert equity against a hand-computed value).
  - `available margin counts the notional of every position`.
  - `an order on a symbol outside config.symbols is rejected` (kind `unknown`, message contains the symbol).
  - `a position on a symbol no longer in config.symbols is still reported` (open on a config with the symbol, rebuild the executor with a config without it, `getPositions()` still returns it).
  - `funding is charged to the position's own size history` (two symbols, `accrueFunding(rates, "PF_ETHUSD")` charges only the ETH position).
  - `legacy state loads`: write the old shapes by hand (`sim_meta` with `price` and no `prices`, position doc under the old symbol, history doc id `hist`) and assert that the old position is reported, a stop still fires on a new quote, and funding history is found.
  - In `dry-run-replay.test.ts`: `replay for a symbol walks that symbol's candles and does not touch another symbol's orders`.
- [ ] **Step 2: Run** `node --env-file-if-exists=.env --test src/bot/dry-run-executor.test.ts src/bot/dry-run-replay.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** `SimMeta` gets `prices: Record<string, PriceEvent>` (`loadMeta` migrates a legacy `price` into `prices[config.symbols[0]]`); matching in `feed` only considers orders whose `req.symbol` equals the fed symbol; `position(symbol)`, `account()` sums over `readSimPositions`; the history document id is the symbol (fallback to the legacy id `hist` for `config.symbols[0]`); every fill adds the symbol to a `sim_symbols` index document, which `readSimPositions` unions with `config.symbols`. `validate` uses `isAllowedSymbol`.
- [ ] **Step 4: Run** `npm run test:bot`; expect PASS (existing single-symbol tests use the default symbol).
- [ ] **Step 5: Commit** `git commit -am "dry-run exchange: a quote and a position per symbol"`.

### Task 6: Engine and trader with an active symbol

**Files:**
- Modify: `src/bot/engine.ts`, `src/bot/trader.ts`, `src/bot/engine-state.ts`, `src/bot/executor.ts` (only if `MarketData` factory type is placed there), `src/bot/engine.test.ts`, `src/bot/trader.test.ts`, `src/bot/trader-fixtures.ts`

**Interfaces:**
- Consumes: `isAllowedSymbol` (Task 1), per-symbol policy window (Task 3), `FeedingMarket`/sim (Task 5).
- Produces:
  - `TradeRecord.symbol: string`; `Snapshot.symbol: string`; `Snapshot.positionIssue: "multiple_positions" | "position_outside_symbols" | null`; `EngineRecord.inZoneSymbol: string | null` (default null).
  - `TraderDeps.marketFor?: (symbol: string) => MarketData`; `export function marketOf(d: TraderDeps, symbol: string): MarketData` (returns `d.marketFor(symbol)` if present, else `d.market` when `symbol === d.config.symbols[0]`, else throws `no market for <symbol>`).
  - Active symbol: `rec.trade?.symbol` (legacy record without it: the held position's symbol, else `config.symbols[0]`), else the symbol of a held position, else the effective policy's symbol, else `config.symbols[0]`.
  - Snapshot `position` and `openOrders` cover every symbol in `config.symbols`. `positions` outside `config.symbols` or more than one distinct symbol set `positionIssue`; `decide` returns `[halt(<issue>, true)]` unless already HALTED.
  - Every order the engine places uses `s.symbol`; `botOrders` filters by `isAllowedSymbol`.
  - Contract cache key becomes `contract:cache:<symbol>` (fallback to the old key `contract:cache` for `config.symbols[0]`).

- [ ] **Step 1: Write failing tests:**
  - engine.test.ts: `flat: the entry order and the TradeRecord carry the snapshot symbol`; `protection and close orders use the trade's symbol`; `positionIssue multiple_positions halts with manual acknowledgement`; `positionIssue position_outside_symbols halts`; `a live policy for another symbol does not close or flip an open position` (policy symbol differs, bias opposite, state OPEN gives `skip:holding`); `a resting entry is withdrawn with reason policy_symbol_changed when the live policy moves to another symbol`; `botOrders sees leftovers on every allowed symbol in COOLDOWN`.
  - trader.test.ts (fixtures with two symbols and a `marketFor`): `flat with a policy for ETH reads the ETH ticker, ATR and contract and places an ETH entry`; `with an open BTC trade and a newer ETH policy the cycle keeps working on BTC`; `the in-zone timer restarts when the active symbol changes` (the timer set on BTC is not reused for ETH: assert `awaiting_confirmation` on the first ETH cycle even though BTC had been in zone long enough); `a legacy trade record without symbol gets the held position's symbol`; `the old contract cache key is still read for the primary symbol`; `contract cache is stored per symbol`.
- [ ] **Step 2: Run** `node --env-file-if-exists=.env --test src/bot/engine.test.ts src/bot/trader.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** In `engine.ts` replace every `config.symbol` with `s.symbol` (or `s.trade.symbol`); in `open()` consider a live policy only when `policy.symbol === trade.symbol`; add the `policy_symbol_changed` rule to `abandonReason`. In `trader.ts` resolve the active symbol before reading the market, filter positions/orders by `isAllowedSymbol`, compute `positionIssue`, use `marketOf`, key the contract cache by symbol, and reset `rec.inZoneSinceMs` when `rec.inZoneSymbol !== snapshot symbol` (then store the symbol). `trader-fixtures.ts` gets a two-symbol world helper.
- [ ] **Step 4: Run** `npm run test:bot`; expect PASS, including `invariants.test.ts`.
- [ ] **Step 5: Commit** `git commit -am "bot engine: active symbol, one position across symbols"`.

### Task 7: Reconcile, watchdog and runner across symbols

**Files:**
- Modify: `src/bot/reconcile.ts`, `src/bot/watchdog.ts`, `src/bot/runner.ts`, and `reconcile.test.ts`, `watchdog.test.ts`, `runner.test.ts`

**Interfaces:**
- Consumes: `marketOf` (Task 6), sim methods with a `symbol` argument (Task 5).
- Produces: `Replayer` becomes `{ replay(candles, intervalSec?, symbol?); accrueFunding(rates, symbol?); lastTickMs() }`.

- [ ] **Step 1: Write failing tests:**
  - reconcile: `replays and accrues funding for the exposed symbol using that symbol's market`; `two positions on different symbols: unclean, halt multiple_positions`; `a position on a symbol outside config.symbols: unclean, halt position_outside_symbols`; `an orphan bot order on another allowed symbol is cancelled`; `a foreign order on any allowed symbol is reported and left alone`.
  - watchdog: `finds the position and orders on any allowed symbol and places repair orders on the position's symbol` (no_sl on ETH re-places an ETH stop); `a position outside config.symbols is not repaired and reports unexplained_position`.
  - runner: `hourly funding accrues for the held symbol only and is skipped while flat`; `the vault report path is unchanged`.
- [ ] **Step 2: Run** `node --env-file-if-exists=.env --test src/bot/reconcile.test.ts src/bot/watchdog.test.ts src/bot/runner.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Reconcile reads exposure over all allowed symbols (and raises the two halt reasons); the symbol with exposure picks the market for candles and funding. The watchdog places repair orders with `position.symbol`. The runner finds the held symbol from `rt.sim.getPositions()` before accruing funding.
- [ ] **Step 4: Run** `npm run test:bot`; expect PASS.
- [ ] **Step 5: Commit** `git commit -am "bot reconcile, watchdog, runner: exposure on any allowed symbol"`.

### Task 8: Launcher, status, report and simulation harness

**Files:**
- Modify: `src/bot/cli.ts` (`buildRuntime`, `statusText`, `policyTemplate`, `main`), `src/bot/report.ts`, `src/bot/sim.ts`, and `cli` / `report` / sim tests

**Interfaces:**
- Consumes: `FeedingMarket(inner, sink, symbol)` (Task 5), `marketFor` (Task 6), `readSimPositions` (Task 5).
- Produces: `buildRuntime` creates one `KrakenMarketData` per symbol (lazily, cached) and sets `deps.marketFor`; `deps.market` is the first symbol's. `policyTemplate(market, config, direction, nowMs, symbol = config.symbols[0])` and the CLI `policy template long|short [--symbol PF_ETHUSD]`. `statusText` prints all symbols and every open position. The report states the symbol per closed trade and reads open positions with `readSimPositions`.

- [ ] **Step 1: Write failing tests:** `statusText lists the allowed symbols and an ETH position`; `buildReport shows the symbol of each trade`; `report open position uses every symbol`; `policyTemplate builds levels for the requested symbol (menu and policy symbol)`; `sim.ts scenarios still pass with symbols: [primary]`.
- [ ] **Step 2: Run** `node --env-file-if-exists=.env --test src/bot/cli.test.ts src/bot/report.test.ts` (use the real test file names found by `ls src/bot/*.test.ts`); expect FAIL.
- [ ] **Step 3: Implement** as specified; `sim.ts` replaces its two `config.symbol` uses with the scenario's symbol.
- [ ] **Step 4: Run** `npm run test:bot`; expect PASS.
- [ ] **Step 5: Commit** `git commit -am "bot launcher, status and report: several symbols"`.

### Task 9: Remove the transitional `symbol`, configure four symbols, document, verify

**Files:**
- Modify: `src/bot/config.ts`, `config/bot.auto.json`, `CLAUDE.md` (bot row, Configuration), `docs/bot-architecture.md`, `docs/bot-testing.md` if it names `symbol`, any leftover `config.symbol` found by the grep below, and the tests that still use it

- [ ] **Step 1: Write failing tests (config.test.ts):** `a config with the old key "symbol" is rejected and the message mentions "symbols"`; `config/bot.auto.json loads and lists exactly the four symbols`; `defaults have no symbol key`.
- [ ] **Step 2: Run** the config tests; expect FAIL.
- [ ] **Step 3: Implement.** Remove `symbol` from the schema, defaults and the `symbols`-contains-`symbol` refine; replace remaining uses with `symbols[0]` where a single default is needed (tests) or the active symbol. Verify with Grep that `config\.symbol\b` has no match in `src/`. Set `config/bot.auto.json` to `{ "max_policy_ttl_min": 30, "symbols": ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD"] }`. Update the docs (symbols list, one position at a time, base risk 0.4 with cap 0.5, calibrated conviction and its formula, the live-mode warning about manual positions sharing a symbol).
- [ ] **Step 4: Verify:** `npm run typecheck` (no errors), `npm run test:bot`, `npm run test:offline` (all green), then a smoke run with the existing database untouched: `BOT_CONFIG=config/bot.auto.json npm run bot -- status` prints the open BTC position and all four symbols. Do not start the live trader or watchdog from the plan; the user restarts the scheduled tasks after merging.
- [ ] **Step 5: Commit** `git commit -am "bot: four symbols configured, legacy symbol removed, docs"`.
