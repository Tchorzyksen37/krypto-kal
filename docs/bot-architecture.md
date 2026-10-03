# Kraken Futures bot: architecture and design

Reference for the trader core in `bot/`. The requirements and decisions are in `superpowers/specs/2026-10-03-trader-core-design.md`,
the build order in `superpowers/plans/2026-10-03-trader-core.md`, and what is done and unverified in
`superpowers/2026-10-03-trader-core-status.md`. This document explains how the pieces fit and why.

## 1. Principles

1. **The LLM never places orders.** It emits a validated policy; a deterministic engine acts only inside it and inside hard limits from a config the LLM cannot read.
2. **Every position has a stop and targets.** Enforced by three independent layers: the engine, the watchdog, and a property harness that tries to break it.
3. **Decide purely, act separately.** `decide()` is a pure function of a snapshot; the trader does the I/O. The same code runs in dry-run and live.
4. **An ack is not a confirmation.** State moves on only after reading the exchange back.
5. **Fail safe.** What cannot be read is not guessed: no decisions, an incident, entries blocked. Ambiguity in simulation resolves against the bot.
6. **Never touch what the bot did not create.** Foreign orders and positions are reported, never cancelled or closed.
7. **Training wheels.** Iteration 1 cannot place a real order: the only executor is a simulation and the trader holds read-only keys.

## 2. System context

```
 Obsidian vault  output/*.md ──► [analyst]  claude -p ──► policies + level menus ─┐   (sub-project 2, not built)
 (X posts, Ollama ingest)                                                          │
                                                                                   ▼
 Kraken Futures (read-only) ──► MarketData ──►  [trader] ◄──── SQLite (bot.db) ◄──── [watchdog]
                                                    │             ▲  journal, state,         │
                                                    ▼             │  counters, sim_*       │
                                               Executor ◄─────────┴────────────────────────┘
                                         (DryRunExecutor now; LiveExecutor later)
```

Three processes, coordinated only through one SQLite file outside OneDrive (`~/.krypto-kal/bot.db`): the **analyst** writes policies and menus, the **trader** runs the state machine, the **watchdog** verifies protection. The launcher (Task 14) is not built yet.

## 3. Modules and layers

| Layer | Module | Responsibility |
|---|---|---|
| Foundation | `clock.ts`, `config.ts`, `zod-issues.ts` | Injectable time; strict hard-limit config with a stable hash |
| Domain (pure) | `policy.ts`, `sizing.ts`, `limits.ts`, `indicators.ts` | Policy validation and effective policy; sizing, rounding, TP ladder, liquidation; day boundary, entry gate, cooldowns; ATR |
| Decision (pure) | `engine.ts` | `decide(snapshot, config) -> Action[]`: the state machine |
| Persistence | `bot-store.ts`, `engine-state.ts` | SQLite store; the persisted engine record |
| Exchange boundary | `executor.ts`, `dry-run-executor.ts` | `Executor` and `MarketData` interfaces; simulated exchange |
| Orchestration | `trader.ts`, `reconcile.ts`, `watchdog.ts` | One cycle; startup reconciliation; the independent check |
| Verification | `sim.ts`, `trader-fixtures.ts`, `sim-fixtures.ts`, `*.test.ts` | Scenario harness and shared test worlds |

Dependencies point downward only. `engine.ts` imports no I/O. Only `trader.ts`, `reconcile.ts` and `watchdog.ts` call an `Executor`.

## 4. The cycle

```
runCycle:
  rec  = loadEngineRecord(store)                       (corrupt record  -> cannot_verify, no decisions)
  snap = snapshotFrom(rec): positions, orders, fills,  (unreadable exchange -> cannot_verify, no decisions)
         account, quote, ATR, funding, contract, effective policy + resolved scenario, counters
  actions = decide(snap, config)
  journal (row on any action, on state/reason change, every 60 s)   (failed write -> entries stripped)
  execute: state transitions first when an entry is placed; otherwise engine order
           lost ack / rejection = incident, remaining actions still run
  save record, lastClockMs = max(lastClockMs, now)
```

Market data that cannot be read becomes `null` (reduce-only mode), not an error. The contract falls back to the last cached one.

## 5. State machine

States: `FLAT, ENTERING, PROTECTING, OPEN, REDUCING, COOLDOWN, HALTED`. Reduce-only mode is a flag derived from the snapshot, not a state.

| State | Does |
|---|---|
| FLAT | Entry only if reconciled, no foreign exposure, fresh data, live policy with a scenario, direction allowed, bias not against it, price in the zone for `entry_confirm_sec`, `planTrade` passes, limits pass. Places a resting limit on the passive side, then ENTERING. |
| ENTERING | Withdraws the entry on timeout, left zone, stale data or a changed policy. On a fill: cancels the remainder and protects at the filled size. |
| PROTECTING | Places what is missing. OPEN only when the exchange shows a stop and targets covering the position. After `protect_timeout_sec` unprotected: close at market, REDUCING. |
| OPEN | Time-stop, policy flip or void (only from a live policy), stop resize after a target fill, tighten-only trailing, missing stop returns to PROTECTING. |
| REDUCING | Closes, cancels leftover bot orders, then COOLDOWN (longer after a loss or unknown PnL). |
| COOLDOWN | Waits; cancels leftovers; a position here is unexplained. |
| HALTED | Never opens. Withdraws entries. Closes a stop-less position it has a trade record for. A daily-loss halt clears at the reset hour; every other halt needs manual acknowledgement. |

Global rules, checked first: liquidation or ADL fill halts (manual); daily loss halts until the next reset hour; a backwards clock blocks everything time-dependent but still protects an open position.

## 6. Data model (one SQLite file)

| Table | Content |
|---|---|
| `menus` | Immutable level menus (`id`, JSON). A duplicate id throws. |
| `policies` | Validated policies; the store assigns the integer id (never the LLM). Newest first by creation time. |
| `kv` | The engine record (`engine:record`), watchdog state, journal dedupe markers, order-count markers, contract cache. |
| `counters` | `(day, name) -> value`: entries and orders per trading day. `raiseCounter` is a max. |
| `journal` | Every decision: time, config hash, kind, input snapshot (JSON), policy id, decision, reason. |
| `incidents` | Rejections, lost acks, halts, cannot_verify, watchdog findings. |
| `docs` | Generic JSON documents; the DryRunExecutor keeps orders, fills, position, account and meta here. |

Rules: the watchdog never writes the engine record (two processes must not read-modify-write one value); the DryRunExecutor holds no state in memory, so the trader and watchdog see the same world.

## 7. Order identity

`cliOrdId = bot-<policyId>-<role>-<seq>`, roles `entry, sl, tp1..3, close`, at most 100 characters. A retry after a lost ack reuses the id, so the exchange sees one order. A finished order's id cannot place a new order, so repairs use fresh numbers: the engine bumps `protectSeq` when a stop goes missing and derives a close attempt from elapsed time; the watchdog uses 100 and up (closes from 1000). The prefix `bot-` is how the bot recognises its own orders.

## 8. Safety mechanisms

| Invariant | Enforced by |
|---|---|
| No position without stop and targets | Engine PROTECTING timeout; watchdog re-place then close; reconciliation halts; property P1 |
| Stop only tightens | Engine trailing; `lastStop` makes a re-placed stop no wider; P2 |
| Risk, leverage, entries, order budget | `planTrade` caps; `checkEntryLimits` reserves room for the whole bundle; P3, P5 |
| Limits survive restart | Counters persisted; `rebuildCounters` is a max from exchange history; P6 |
| Loosening needs N cycles | `effectivePolicy` per field; P7 |
| Reduce-only never increases exposure | Executor rule; watchdog places only reduce-only; P8 |
| No entry on stale or uncertain state | `reduceOnlyReason`, `reconciled` flag, foreign-exposure block, unreadable exchange means no decisions |
| Entry only after state is saved | `execute` orders transitions before the entry placement |
| Not the user's positions | Foreign-order and no-trade-record paths never cancel or close |

## 9. Failure handling

| Failure | Behaviour |
|---|---|
| Exchange or record unreadable | `cannot_verify`, no orders, entries blocked; recorded once then every 60 s |
| Lost ack | Order may exist; next cycle reads back; retry reuses the id; counted once |
| Rejection | Incident; cycle continues; protection is retried or the position closed |
| Journal write fails | Entries stripped; protection and closing carry on |
| Clock backwards | Only protection actions; no timeouts, entries or trailing |
| Restart | `reconciled=false`; reconcile replays downtime (simulation), rebuilds counters, halts on unexplained positions, cancels orphan bot orders |
| Engine hung | Watchdog acts after twice `protect_timeout_sec` |

## 10. Dry-run exchange model

Pessimistic by design: a limit fills only when the last price trades through it, at the limit, as maker; market orders, marketable limits and stops fill as taker, stops at the worse of stop and quote plus slippage; stops are checked before limits in a tick; in a replayed candle the adverse extreme is walked first so a stop beats a target. Reduce-only is capped at the position and cancelled when it fires with nothing to reduce, but an order left after a close stays open (the orphan hazard the engine cleans up). Funding is charged hourly to the position held. Faults (lost ack, rejection, partial fill in whole lots, delay) are injectable.

## 11. Verification

- Unit tests per module, nearly every safety rule mutation-checked (break the rule, a test must fail).
- `sim.ts`: deterministic random scenarios over the real components with hostile policies, faults, outages, a hung engine, clock jumps and restarts; properties P1 to P8, G1, G3, G5, X1 checked after every step; coverage thresholds; a tripwire that must report P1 when the safety net is broken. `SIM_SEEDS` and `SIM_STEPS` scale it; `collectScenario(seed, steps, { trace: true })` replays a failure.
- Contract tests keep the simulated objects in the shape of `FuturesPosition`, `FuturesOpenOrder`, `FuturesFill`.

## 12. Key decisions

| Decision | Reason |
|---|---|
| Levels are menu IDs, not prices | An LLM cannot invent a stop or target; the engine resolves prices from a code-built menu |
| Pure `decide` plus a thin trader | Testable without I/O; same code dry-run and live |
| No bracket orders | The Kraken Futures docs show no OTO/OCO, so protection is a place-then-confirm step with a timeout close |
| TPs as reduce-only limits | Fill as maker and avoid unverified `take_profit` trigger semantics |
| Separate watchdog process with its own id range | Survives an engine hang; never writes shared state |
| Risk cap after the conviction multiplier | Otherwise 0.5% x 1.25 would exceed the hard cap |
| State saved before the entry is placed | A crash between the two leaves ENTERING with no order (resolved to FLAT), never a resting entry in FLAT |
| Bot and manual trading must not share the symbol | Foreign exposure blocks entries; a dedicated sub-account is recommended |
| SQLite outside OneDrive | Sync can lock database files; the PC may sleep, so downtime is a normal state |

## 13. Not built yet

`LiveExecutor` stub and `ApprovingExecutor` (Task 13); report, CLI and launcher that feed prices and funding and run the loops (Task 14); the analyst and the Ollama ingest (sub-projects 2 and 3); stage 2 live verification of the assumptions listed in the status document.
