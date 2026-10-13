# Speculation automation: scheduled reports handed to the dry-run bot

Written 2026-10-12. Status: draft for review. Related: [speculation guide](../../speculation-guide.md), [trader core status](../2026-10-03-trader-core-status.md), skills `speculate` and `speculation-to-bot`.

## Goal

A speculation report is produced every 2 hours without the user. After each report, the best clean bet reaches the
**dry-run** bot as a policy that trades only inside the bet's window. The scorer runs daily. Nothing here can place a
real order: the bot stays dry-run, `LiveExecutor` stays a stub, and the guard tests stay green.

## Decisions already made with the user

| Decision | Choice |
|---|---|
| Where it runs | A PC that is always on (or awake for every slot); Windows Task Scheduler, no cloud routine (a cloud routine cannot reach `127.0.0.1` or the vault) |
| How reports are produced | Headless `claude -p "/speculate"` started by a repo script, not hand-made Claude Desktop tasks |
| Handoff to the bot | Pure code, no LLM; only a **clean** bet is stored (validated, on the bot's symbol, inside its entry window, no warnings from `fixturesFromSpeculation`); everything else is logged with the reason |
| Cadence | A new report every 2 hours (12 a day), replacing the four session reports |
| Bots | One bot, one account. A new policy replaces the previous one; an open position keeps its own protection and time-stop |

## Assumptions to confirm (not yet decided)

1. **Slots:** a 2-hour grid in UTC (00:00Z, 02:00Z, ... 22:00Z), the report generated at the slot time. The grid is UTC
   rather than local because local even hours repeat once on the autumn DST change (02:00 happens twice), which would
   give two slots one id; in Warsaw the slots fall on even hours in summer and odd hours in winter. Night slots are
   included; "no bet" is an accepted answer.
2. **Session still matters:** a slot belongs to the session (`sessions.ts`) it falls in. The session supplies the
   profile, regions, investors and limits (`maxEntryDeviation`, `minRewardRisk`, `maxBets`), but not the window.
3. **Bet window is the slot:** a bet's `fill_from` is the slot time and its `entry_deadline` is capped at the next slot
   (at most 2 h). So the previous policy expires on its own when the next report arrives, and two policies never compete.
   The hold time (`ttl_minutes`) may run past the next slot; that is a position, and it is managed by the bot.

## Flow

```
Task Scheduler (every 2 h + wake/logon + retries)
  -> npm run auto -- tick
       1. pick the due slot (slots.ts), take a lock, stop if its report is already handed off
       2. claude -p "/speculate" (narrow allowlist, timeout) writes <day>/<HHMMZ>.md and .meta.json
       3. node src/speculation/check.ts <meta.json>      (re-measures, validates, writes Best bets)
       4. handoff: best clean bet -> bot policy           (pure code, ledger-protected)
       5. log the outcome; on failure append to output/bot/alerts.md
Task Scheduler (daily)    -> claude -p "/speculation-score"
Task Scheduler (at logon) -> npm start ; npm run bot -- run   (restart on failure)
```

### New module `src/automation/`

| File | Job | Notes |
|---|---|---|
| `slots.ts` | Which slot is due now, which are missed and still worth generating | Pure; clock injected; reuses `tzOffsetMs`/`zonedToUtcMs` from `sessions.ts` |
| `handoff.ts` | From a checked `meta.json` to a stored policy or a logged skip | Wraps `fixturesFromSpeculation` and `addPolicy`; refuses anything with warnings |
| `ledger.ts` | Idempotency: which slots were generated and handed off | A JSON/JSONL file in `~/.krypto-kal/`, not in OneDrive |
| `run-claude.ts` | Starts `claude -p` with prompt, allowlist and timeout; returns exit status and output | The runner is injected so tests need no `claude` |
| `tick.ts` / `cli.ts` | Orchestrates the flow; `npm run auto -- tick|status|install` | Lock file so two ticks cannot overlap |
| `scripts/install-tasks.ps1` | Registers and removes the Task Scheduler tasks | `-Uninstall` removes every task it created |

### Catch-up

A missed slot is generated only while its bets could still be useful: until the slot's `entry_deadline` (at most 2 h
after the slot). After that it is skipped and logged. Retries inside that window cost nothing because a tick that finds
the report already handed off exits at once.

## Changes to existing code (needed because reports are no longer one per session)

1. **Naming and ids:** `HHMMZ` is today the *session* start. With several reports per session it must be the *slot* start,
   or two reports of one session collide in file name and in bet id (`YYYYMMDD-HHMMZ-SYMBOL-n`).
2. **`check.ts`:** `fill_from` and `entry_deadline` come from the slot (see assumption 3), not from the session window.
   To verify in the code before changing it: how a mid-session run is handled today.
3. **`speculate` skill:** write files by slot, and say which slot it covers. The prompt used by `claude -p` names the
   slot explicitly, so the skill does not guess from the clock.
4. **`score.ts` and `drivers.ts`:** per-session tables and the macro `drivers` scoring assume one report per session.
   Overlapping hold times between consecutive slots need a rule so one price move is not counted as two outcomes.
5. **Docs:** `speculation-guide.md` (setup section replaced by `npm run auto -- install`), CLAUDE.md module table.

## Safety and operations

- Dry-run only. The handoff cannot construct a live executor; the existing guard tests (`guards.test.ts`) must pass.
- `claude -p` runs with an explicit allowlist: the `krypto-kal` MCP tools, reads and writes under the vault's
  `output/speculation/`, and `node src/speculation/check.ts`. No bypass-permissions flag. Hard timeout about 15 min.
- The lock file prevents overlapping ticks; a stale lock (older than the timeout) is replaced.
- Failures (non-zero exit, timeout, no `Best bets` block, checker error) go to `output/bot/alerts.md` and the run log.
  A push channel (phone, Telegram) is out of scope.
- Cost and quota: 12 runs a day instead of 4. `speculation_context` takes up to a minute per run and uses Coinalyze
  (40 calls/min); the seasonality and positioning parts are cached for 6 h. Watch `server_stats` during the first days.
- Honest expectation: 12 reports a day produce overlapping, highly correlated bets. Judge the bets only by the scorecard
  against the `1/(1+RR)` baseline, as the speculation guide says, before any step toward real orders.

## Testing

Offline unit tests, no keys and no network: slot selection across DST changes, catch-up cut-off, handoff gating
(clean / warnings / wrong symbol / expired / no bets), ledger idempotency, lock handling, runner failure paths with a
stubbed `claude`. Plus one real `claude -p "/speculate"` run by hand before the schedule is installed, and a
`schedule.ps1 -WhatIf`-style dry listing of the tasks before they are registered.

## Out of scope

A live executor and real orders; a push alert channel; the Ollama ingest and a `brain-ingest` schedule; more than one
bot symbol.
