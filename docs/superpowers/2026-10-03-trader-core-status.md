# Kraken Futures bot: trader core, status

Written 2026-10-03, after Task 12 of 14. Spec: `specs/2026-10-03-trader-core-design.md`. Plan: `plans/2026-10-03-trader-core.md`.

## What exists

An LLM-free, deterministic trader core for the Kraken Futures bot. **It cannot place a real order**: the only executor is a
simulation, `LiveExecutor` does not exist yet, and the trader process is meant to hold read-only keys. All code is in `src/bot/`.

| Task | File(s) | What it does |
|---|---|---|
| 1 | `clock.ts`, `config.ts` | Injectable clock; strict hard-limit config merged over tiny defaults, with a stable hash |
| 2 | `policy.ts` | Policy schema; levels are IDs from a code-built menu, never prices; geometry validation; the effective policy (tighten at once, loosen after N cycles) |
| 3 | `sizing.ts` | `planTrade`: rounding that never favours the bot, risk cap applied after the conviction multiplier, costs, reward/risk, liquidation, TP ladder |
| 4 | `bot-store.ts` | SQLite store: menus, policies (store-assigned ids), state, daily counters, journal, incidents, generic documents, reentrant transactions |
| 5, 6 | `executor.ts`, `dry-run-executor.ts` | `Executor` interface; simulated exchange with pessimistic fills, idempotent `cliOrdId`, funding, candle replay of downtime, fault injection |
| 7 | `limits.ts` | Day boundary, counters, the entry gate (reserves room for the whole order bundle), cooldowns, daily loss |
| 8 | `engine.ts` | Pure `decide(snapshot)`: the state machine FLAT, ENTERING, PROTECTING, OPEN, REDUCING, COOLDOWN, HALTED |
| 9 | `trader.ts`, `engine-state.ts`, `indicators.ts` | One cycle: read, decide, execute, journal. State is saved before an entry is placed |
| 10 | `reconcile.ts` | Startup reconciliation; the `reconciled` flag gates all entries |
| 11 | `watchdog.ts` | Independent check and backstop: re-places a missing stop once, then closes; reduce-only only |
| 12 | `sim.ts`, `invariants.test.ts` | Random-scenario property harness for the spec's safety properties, with a tripwire |

**Not built yet**
- Task 13: `LiveExecutor` stub (always throws) and `ApprovingExecutor` (y/n per order), plus guard tests.
- Task 14: report, CLI (`policy add`, `report`, `ack-halt`, `run`), and the launcher that runs the loops. No process wires `trader.ts`,
  `watchdog.ts` and `reconcile.ts` together or feeds `onPrice` and `accrueFunding` yet. `ack-halt` must re-run reconcile.
- The analyst (`claude -p` reading `output/`) and the Ollama ingest are separate sub-projects, not started.

## Tests

`npm run test:bot` runs 453 offline tests in about 22 s (`npm run typecheck` is clean). `SIM_SEEDS=1000 SIM_STEPS=800 npm run test:bot`
runs a much deeper property run. Nearly every safety rule was **mutation-checked**: break the rule, confirm a test fails.
A failing property prints its seed and step; replay it with `collectScenario(seed, steps, { trace: true })` from `src/bot/sim.ts`.

## Where the implementation deliberately differs from the spec (the spec was updated to match)

- Risk cap applies **after** the conviction multiplier (the spec's formula could exceed `max_risk_per_trade_pct`).
- The entry gate reserves order budget for the whole bundle (entry, stop, each target), so a limit never blocks a protective order.
- Foreign orders and positions (not created by the bot) are reported and never cancelled or closed. A HALTED bot closes a stop-less position only if it has a trade record for it.
- The watchdog never writes the engine's record and uses its own id range (sequence 100 and up), instead of sharing `cliOrdId`s with the engine.
- A backwards clock blocks everything time-dependent but not the protection of an open position.
- New config keys: `max_menu_age_min`, `entry_confirm_sec`, `trail_atr_multiple`, `trail_start_r`, `maintenance_margin_rate`.
- `Executor.getOrderHistory` was added (fills alone cannot rebuild the daily order count).

## Bugs the property harness found in the bot (all fixed)

1. A backwards clock stopped the engine from protecting a position whose stop was cancelled.
2. Re-protection after a filled target re-placed that target (an immediate taker fill); the engine now knows `filledRoles`.
3. The simulated partial fill produced sizes that are not a multiple of the size step.
4. An exchange outage wrote a journal row and an incident every cycle.
5. (Earlier) A HALTED bot would have closed a position it had no trade record for.

## Assumptions that dry-run cannot verify (stage 2: tiny live orders)

- Trigger direction of `stp` and `take_profit` relative to the order side.
- Whether the exchange cancels the other protective order when one fills (assumed not: orphan reduce-only orders are possible).
- Whether a reduce-only order resizes or is capped when the position shrinks (assumed capped, not resized).
- Whether a duplicate `cliOrdId` is rejected by the exchange.
- A positive funding rate means longs pay shorts; funding uses the latest mark within the hour.
- Per-position isolated-margin leverage and the maintenance margin rate (a placeholder `0.005`) and the fee tier (placeholders 2 and 5 bps).
- The `Futures*` interfaces are typed from the docs; the client returns the API's JSON unmapped.
- Separate processes each keep their own rate-limit counter; their combined request rate could exceed Kraken's budget.

## Known gaps

- Daily loss excludes funding paid. Live `getFills` returns only the last 100 fills.
- The harness reaches P8 (reduce-only never increases exposure) rarely; its unit tests are the main guard. Re-placing a filled target is covered by unit tests only.
- The exit criteria for leaving training wheels (spec section 11) are operational, not code.

## Next steps

1. Task 13, then Task 14 (report, CLI, launcher), then run the bot in dry-run against live read-only data.
2. Sub-project 2 (analyst) and 3 (Ollama ingest), as in the plan.
3. Stage 2: verify the assumptions above with minimum-size live orders, approved separately.
