# Speculation Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A speculation report is produced every 2 hours by a scheduled headless `claude -p`, and the best clean bet reaches the dry-run bot as a policy, with no user action.

**Architecture:** Windows Task Scheduler calls one idempotent command, `npm run auto -- tick`. The tick picks the due 2-hour slot, runs `claude -p` for the report, runs the existing checker, then a pure-code handoff stores the best clean bet through the bot's existing `addFromSpeculation`. A ledger and a lock make retries and overlaps harmless. No bot code changes: a policy's `valid_until` (capped at the next slot) makes the previous policy expire by itself.

**Tech Stack:** Node >= 23.6 running `.ts` directly (`node:test`, no build step), `erasableSyntaxOnly`, PowerShell for Task Scheduler. No new dependencies.

**Spec:** [../specs/2026-10-12-speculation-automation-design.md](../specs/2026-10-12-speculation-automation-design.md)

## Global Constraints

- All code, comments, logs and error messages in English. Relative imports use the `.ts` extension; type-only imports use `import type`. No `enum`, `namespace` or constructor parameter properties.
- Dry-run only. Nothing may construct a live executor or set `tradingEnabled: true`; `src/bot/guards.test.ts` must keep passing.
- Slots are a **2-hour grid in UTC** (00:00Z, 02:00Z ... 22:00Z): 12 a day. A slot's `window` is `[slotStart, slotStart + 2h]`.
- A bet's `entry_deadline` is at most the slot's window end (at most 2 h after the slot start).
- Catch-up: the current slot is generated late only until its bets could no longer be filled (`slotStart + the session's entryDeadlineMinutes`, capped at the window end); an earlier slot is never generated afterwards, only logged as skipped.
- `claude -p` runs with an explicit tool allowlist, no bypass-permissions flag, and a hard timeout of 15 minutes.
- State files (ledger, lock, run log) live in `~/.krypto-kal/automation/`, never in OneDrive. Failures are appended to `<BRAIN_DIR>/output/bot/alerts.md` through the existing `VaultAlertSink`.
- Tests are offline (`node --test`, stubbed clock and stubbed `claude`), next to the code as `*.test.ts`.

## Review Focus

- **Two ticks overlap** (a retry fires while the previous run still waits on `claude`): the second must exit without doing anything. Owned by Task 2.
- **A crashed tick leaves a lock behind:** a lock older than the timeout is replaced. Task 2.
- **`claude` exits 0 but wrote no `.meta.json`, or invalid JSON:** this is a failure with an alert, never a handoff. Task 6.
- **The checker is rerun on an already handed-off report** (meta rewritten): the ledger stops a second policy for the same slot. Tasks 2 and 4.
- **The PC slept through several slots:** only the current slot, and only while its bets can still fill, is generated; older slots are logged as skipped. Task 1.
- **Bot database missing or locked:** the handoff reports a failure and the tick records it; it does not crash the scheduler task. Task 4.
- **DST change (2026-10-25):** the UTC grid yields 12 distinct slots that day. Task 1.

## File Structure

| File | Responsibility |
|---|---|
| `src/automation/slots.ts` | Pure: the slot grid, which slot is due, catch-up cut-off. |
| `src/automation/state.ts` | Ledger (per-slot status) and lock file, both in a directory passed in. |
| `src/automation/handoff.ts` | Best clean bet of a checked `meta.json` -> stored policy, or a skip with a reason. |
| `src/automation/run-claude.ts` | Builds the prompt and arguments, runs `claude -p`, injectable for tests. |
| `src/automation/tick.ts` | The orchestration of one tick, with all effects injected. |
| `src/automation/cli.ts` | `npm run auto -- tick | status | score`, wiring real effects. |
| `scripts/install-tasks.ps1` | Registers and removes the Task Scheduler tasks. |
| `config/bot.auto.json` | Bot config for automated runs: `max_policy_ttl_min` 120. |
| Modify `src/speculation/check.ts` | Cap `entry_deadline` at the window end. |
| Modify `.claude/skills/speculate/SKILL.md` | Accept a slot window from the prompt. |
| Modify `src/speculation/score.ts` | Report calibration also over non-overlapping bets. |

---

### Task 1: Slot grid and catch-up (`slots.ts`)

**Files:**
- Create: `src/automation/slots.ts`
- Test: `src/automation/slots.test.ts`

**Interfaces:**
- Consumes: `pickSession`, `sessionOptionsFromEnv`, `SessionDef` from `src/speculation/sessions.ts`.
- Produces:
  - `export const SLOT_MS = 7_200_000`
  - `export interface Slot { id: string; startMs: number; endMs: number; session: SessionId; entryCutoffMs: number }` where `id` is `YYYYMMDD-HHMMZ` of the start (UTC) and `entryCutoffMs = min(startMs + session.entryDeadlineMinutes * 60_000, endMs)`.
  - `export function slotAt(nowMs: number): Slot` — the slot containing `nowMs`.
  - `export function dueSlot(nowMs: number, handled: ReadonlySet<string>): { due?: Slot; missed: Slot[] }` — `due` is the current slot when its id is not in `handled` and `nowMs < entryCutoffMs`. `missed` lists the up to 12 slots before the current one (the last 24 h) that are not in `handled`; since a slot's cutoff never passes its window end, no earlier slot can still be generated, so these are only for the caller to record as `skipped`.

- [ ] **Step 1: Write the failing tests** in `slots.test.ts`:
  - `slotAt(Date.parse("2026-10-12T09:41:00Z"))` has `id "20261012-0800Z"`, `startMs` 08:00Z, `endMs` 10:00Z.
  - The session of the slot starting 2026-10-12T08:00Z is the one `pickSession` gives for that instant (Europe open in summer: 10:00 local is inside 08:00-12:00).
  - `entryCutoffMs` never exceeds `endMs`, e.g. a night slot (entryDeadlineMinutes 180) has cutoff `startMs + 2h`.
  - `dueSlot` at 08:10Z with nothing handled: `due` is the 08:00Z slot. With `"20261012-0800Z"` handled: `due` is undefined.
  - Late wake-up: at 09:10Z (the Europe-open session allows 60 minutes, so the 08:00Z slot's cutoff is 09:00Z) with nothing handled, `due` is undefined (the bets could not fill any more) and `missed` holds the unhandled slots before 08:00Z (the 08:00Z slot itself becomes `missed` at the first tick after 10:00Z).
  - `missed` never includes a handled slot and never the current slot.
  - DST: for every 2-hour step of 2026-10-25 (the autumn change in Warsaw) the 12 slot ids are distinct and `endMs - startMs` is always `SLOT_MS`.
- [ ] **Step 2: Run** `node --test src/automation/slots.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the signatures above in `slots.ts`. The session of a slot is `pickSession(startMs, tz, 0).session.id` with `sessionOptionsFromEnv()` for `tz` (lead 0, so the session containing the slot start is chosen).
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/automation/slots.ts src/automation/slots.test.ts && git commit -m "Automation: 2-hour UTC slots with catch-up cut-off"`.

---

### Task 2: Ledger and lock (`state.ts`)

**Files:**
- Create: `src/automation/state.ts`
- Test: `src/automation/state.test.ts`

**Interfaces:**
- Produces:
  - `export type SlotStatus = "generated" | "handed_off" | "no_bet" | "failed" | "skipped"`
  - `export interface SlotRecord { slot: string; status: SlotStatus; atMs: number; detail: string }`
  - `export function readLedger(dir: string): SlotRecord[]` and `export function recordSlot(dir: string, r: SlotRecord): void` — JSONL file `ledger.jsonl`, append-only; the latest record per slot wins. Missing file means empty.
  - `export function handledSlots(records: SlotRecord[]): Set<string>` — slots whose latest status is `handed_off`, `no_bet` or `skipped` (a `failed` or `generated` slot is retried).
  - `export function acquireLock(dir: string, nowMs: number, staleMs: number): (() => void) | undefined` — creates `tick.lock` exclusively (`wx`); a lock older than `staleMs` is replaced; returns a release function, or `undefined` when held.

- [ ] **Step 1: Write the failing tests** (temp dir per test): empty dir gives `[]`; two records of one slot, `failed` then `handed_off`, make `handledSlots` contain it; `failed` alone does not; second `acquireLock` in the same dir returns `undefined`; after release it succeeds; a lock file written 20 minutes ago with `staleMs` 15 min is replaced; a corrupt ledger line is ignored, not thrown.
- [ ] **Step 2: Run** `node --test src/automation/state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:fs` sync calls (the files are tiny); lock age from the file's `mtimeMs` compared with the injected `nowMs`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Automation: ledger and lock files"` with the two files.

---

### Task 3: Cap the entry deadline at the window end (`check.ts`)

**Files:**
- Modify: `src/speculation/check.ts:143-148` (`validateBets`)
- Test: `src/speculation/check.test.ts`

**Interfaces:**
- Consumes/changes: `validateBets(meta, options)`; `deadline` becomes `Math.min(start + o.entryDeadlineMinutes * MIN, Date.parse(meta.window[1]))` when `meta.window[1]` parses, otherwise unchanged. `latest_close` follows from the new deadline.

- [ ] **Step 1: Write the failing tests** in `check.test.ts`, using its existing meta fixture style:
  - window `[T, T+2h]`, `generated` = T+10min, session with `entryDeadlineMinutes` 180: the bet's `entry_deadline` is `T+2h`, `latest_close` is `T+2h + ttl`.
  - window `[T, T+4h]`, entry deadline 45 min, generated at T: `entry_deadline` is `T+45min` (cap does not apply).
  - generated after the window end (a late run): every bet is dropped with the reason `"the report's window closed before it was checked"`, and `result.bets` is empty. Implement the drop in `validateBets`: when the capped `deadline <= start`, all bets go to `dropped` with that reason.
- [ ] **Step 2: Run** `node --test src/speculation/check.test.ts`. Expected: the new tests FAIL; existing pass.
- [ ] **Step 3: Implement** the cap and the closed-window drop in `validateBets`. Existing session-length windows are unaffected because their end is later than the deadline.
- [ ] **Step 4: Run** `npm run test:speculation`. Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "Checker: entry deadline never passes the report window"`.

---

### Task 4: Handoff (`handoff.ts`) and the automated bot config

**Files:**
- Create: `src/automation/handoff.ts`, `config/bot.auto.json`
- Test: `src/automation/handoff.test.ts`

**Interfaces:**
- Consumes: `fixturesFromSpeculation(meta, config, nowMs, source)` from `src/bot/from-speculation.ts`; `addFromSpeculation(store, config, meta, nowMs, {source})` from `src/bot/cli.ts`; `BotStore`, `BotConfig`, `ReportMeta`.
- Produces: `export type HandoffResult = { status: "handed_off"; betId: string; detail: string } | { status: "no_bet"; detail: string } | { status: "failed"; detail: string }` and `export function handoff(store: BotStore, config: BotConfig, meta: ReportMeta, nowMs: number, source: string): HandoffResult`.
- Rule: clean means `fixturesFromSpeculation(...)` returns exactly one fixture, no `warnings`; then call `addFromSpeculation` (not dry) and require `added === 1`. Any `skipped` or `warnings` entry is written into `detail` for the log. No fixtures: `no_bet` with the reasons. Storing rejected: `failed`.
- `config/bot.auto.json` content: `{ "max_policy_ttl_min": 120 }` (the default 60 would make every 2-hour bet carry a warning and never be clean).

- [ ] **Step 1: Write the failing tests** with `new BotStore(":memory:")` and the fixtures `config`, `T0` from `src/bot/sim-fixtures.ts` and a `bet`/`meta` builder as in `src/bot/from-speculation.test.ts`, with `config` overridden `max_policy_ttl_min: 120`:
  - a clean BTC bet: `status "handed_off"`, `store.latestPolicies(2).length === 2`.
  - one call stores exactly `config.loosen_confirm_cycles` policies (idempotency across calls lives in the ledger, Task 6, not here).
  - a bet on `PF_XRPUSD`: `no_bet`, detail mentions the bot trades `PF_XBTUSD`; store stays empty.
  - a bet whose stop is closer than `sl_min_atr_multiple` ATR: `no_bet`, detail contains the warning; store empty (a bet with warnings is never stored).
  - `validated` missing: `failed`, detail says the checker has not run.
  - `validated: []`: `no_bet`.
- [ ] **Step 2: Run** `node --test src/automation/handoff.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `handoff` as described. Create `config/bot.auto.json`.
- [ ] **Step 4: Run** `node --test src/automation/handoff.test.ts` and `npm run test:bot`. Expected: PASS, guard tests still green.
- [ ] **Step 5: Commit** `git commit -m "Automation: hand the best clean bet to the dry-run bot"`.

---

### Task 5: `claude -p` runner (`run-claude.ts`)

**Files:**
- Create: `src/automation/run-claude.ts`
- Test: `src/automation/run-claude.test.ts`

**Interfaces:**
- Produces:
  - `export interface ClaudeRun { ok: boolean; exitCode: number | null; timedOut: boolean; output: string }`
  - `export type ClaudeRunner = (prompt: string, args: string[], timeoutMs: number) => Promise<ClaudeRun>`
  - `export function speculatePrompt(slot: Slot): string` — names the skill and the slot explicitly: `Run the speculate skill for the 2-hour slot <id>: window start <ISO>, window end <ISO>, session <id>. Use exactly this window as the report's window and file name HHMMZ=<HHMM>Z. Do not offer to hand bets to the bot.`
  - `export function claudeArgs(brainDir: string): string[]` — `["-p", "--allowedTools", ...]` with: `mcp__krypto-kal__*`, `Read`, `Write(<brainDir>/output/speculation/**)`, `Edit(<brainDir>/output/speculation/**)`, `Bash(node src/speculation/check.ts:*)`, `Bash(node src/speculation/sessions.ts:*)`. No `--dangerously-skip-permissions`.
  - `export const realClaudeRunner: ClaudeRunner` — `child_process.spawn("claude", ...)`, kills on timeout, collects stdout+stderr (capped at 20 000 chars).

- [ ] **Step 1: Write the failing tests:** `speculatePrompt` contains the slot id, both ISO times and the session id; `claudeArgs("C:/v")` contains `-p`, contains every allowed pattern above, and does not contain `dangerously`; `realClaudeRunner` is exercised against a tiny node script instead of `claude`: expose `spawnOutput(cmd, args, timeoutMs)` (the generic part) and test it with `process.execPath` running `-e "console.log('hi')"` (ok, output `hi`), exit code 3 (not ok, `exitCode 3`), and a 200 ms timeout on a 5 s sleep (`timedOut true`).
- [ ] **Step 2: Run** `node --test src/automation/run-claude.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures; `realClaudeRunner = (prompt, args, t) => spawnOutput("claude", [...args, prompt], t)`. On Windows use `shell: false` and resolve `claude` via `where`-free spawn (`claude.cmd` fallback if `ENOENT`).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Automation: headless claude runner with a tool allowlist"`.

---

### Task 6: The tick (`tick.ts`)

**Files:**
- Create: `src/automation/tick.ts`
- Test: `src/automation/tick.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5, `runCheck` from `src/speculation/check.ts`.
- Produces: `export interface TickDeps { nowMs: number; stateDir: string; brainDir: string; runner: ClaudeRunner; check(metaPath: string): Promise<void>; handoff(meta: ReportMeta, nowMs: number, source: string): HandoffResult; alert(kind: string, detail: string): Promise<void>; timeoutMs: number }` and `export async function tick(d: TickDeps): Promise<{ slot?: string; status: SlotStatus | "busy" | "nothing_due"; detail: string }>`.
- Behaviour, in order:
  1. `acquireLock(stateDir, nowMs, timeoutMs + 60_000)`; held -> `busy`.
  2. `dueSlot(nowMs, handledSlots(readLedger(stateDir)))`; every `missed` slot is recorded `skipped` once; no `due` slot -> `nothing_due`.
  3. Report path `<brainDir>/output/speculation/<YYYY-MM-DD>/<HHMM>Z.meta.json`. If it already exists and parses with `validated`, skip the `claude` step (a rerun after a crash); else run `runner(speculatePrompt(slot), claudeArgs(brainDir), timeoutMs)`.
  4. Runner not ok, or the meta file missing/invalid JSON after the run -> record `failed`, `alert("automation_generate_failed", ...)`.
  5. `check(metaPath)`; a throw -> `failed` + alert.
  6. Read the meta, `handoff(...)`; map `handed_off` / `no_bet` / `failed` to the ledger; `failed` also alerts. Always release the lock in `finally`.

- [ ] **Step 1: Write the failing tests** with a temp `stateDir`/`brainDir`, a stub `runner` that writes a `.meta.json` (valid, with `validated`), stub `check`, `handoff`, `alert` recording calls:
  - happy path: ledger gets `handed_off`, the runner was called once with a prompt containing the slot id.
  - second `tick` for the same slot: `nothing_due`, runner not called again.
  - runner returns `ok: false`: ledger `failed`, one alert `automation_generate_failed`, next tick retries (runner called again).
  - runner ok but no meta file written: `failed` + alert, `handoff` not called.
  - `check` throws: `failed` + alert, `handoff` not called.
  - `handoff` returns `no_bet`: ledger `no_bet`, no alert.
  - lock held by another tick: result `busy`, runner not called.
  - the lock is released after a throwing runner.
  - meta already present and validated: runner not called, handoff called.
- [ ] **Step 2: Run** `node --test src/automation/tick.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `tick` per the order above.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Automation: one idempotent tick"`.

---

### Task 7: CLI, npm script and run log (`cli.ts`)

**Files:**
- Create: `src/automation/cli.ts`
- Modify: `package.json` (scripts: `"auto": "node --env-file-if-exists=.env src/automation/cli.ts"`, and add `src/automation` to `test:offline` coverage by pattern if not already matched by `src/**/*.test.ts`, which it is)
- Test: `src/automation/cli.test.ts`

**Interfaces:**
- Commands: `tick` (real effects, exit code 0 for `handed_off`/`no_bet`/`nothing_due`/`busy`, 1 for `failed`), `status` (prints the last 12 ledger records and the next slot), `score` (runs `claude -p "/speculation-score"` with the same runner and allowlist plus `Write(<brainDir>/output/speculation/**)`, alerts on failure).
- `export function buildDeps(env: NodeJS.ProcessEnv, nowMs: number): TickDeps` wires: `stateDir = ~/.krypto-kal/automation`, `brainDir = BRAIN_DIR` (error if unset), bot config via `resolveConfig(env.BOT_CONFIG)`, `BotStore(config.db_path)`, `runCheck` with the public Kraken Futures client, `VaultAlertSink` for alerts (level `incident`, kind as given), `timeoutMs = 900_000`. Every tick also appends one JSON line to `run-log.jsonl` in `stateDir`.

- [ ] **Step 1: Write the failing tests:** `buildDeps({}, now)` throws a message naming `BRAIN_DIR`; `buildDeps` with `BRAIN_DIR` and `BOT_CONFIG` pointing at `config/bot.auto.json` returns `timeoutMs 900000` and a `stateDir` ending in `automation`; the alert function appends a line containing the kind to `<brainDir>/output/bot/alerts.md`.
- [ ] **Step 2: Run** `node --test src/automation/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `cli.ts`; keep `main` thin: parse argv, call `tick(buildDeps(...))`, print one line, set the exit code.
- [ ] **Step 4: Run** `npm run test:offline` and `npm run typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `git commit -m "Automation: npm run auto (tick, status, score)"`.

---

### Task 8: The `speculate` skill accepts a slot

**Files:**
- Modify: `.claude/skills/speculate/SKILL.md` (the schedule paragraph at the top, step 1 and step 8)
- Modify: `docs/speculation-guide.md` section 3 (replace the manual scheduled-tasks setup with `npm run auto` and the install script, keep the manual option as a fallback)

- [ ] **Step 1: Edit the skill:** when the prompt names a slot (`window start`, `window end`, `session`), use exactly that window as `window` in the meta, take the session from the prompt, write `HHMMZ` from the window start, and skip step 10's offer to hand bets to the bot (the automation does it). Without a slot in the prompt the old behaviour (session windows) stays. Replace the schedule paragraph with a note that the automated schedule is a 2-hour UTC grid.
- [ ] **Step 2: Edit the guide** so section 3 says: install with `powershell -File scripts/install-tasks.ps1`, check with `npm run auto -- status`, and that reports are named by slot start.
- [ ] **Step 3: Manual verification (real, one run):** `npm start` in one terminal; then `npm run auto -- tick`. Expected: a `<BRAIN_DIR>/output/speculation/<day>/<HHMM>Z.md` and `.meta.json` with `window` of exactly two hours and `validated` present, one ledger line in `~/.krypto-kal/automation/ledger.jsonl`, and either a stored policy (`npm run bot -- status -- --config config/bot.auto.json` shows it) or a `no_bet` reason in the run log. Record what `claude -p` actually needed in permissions; if a prompt appears or a tool is denied, adjust `claudeArgs` and its test in Task 5.
- [ ] **Step 4: Commit** `git commit -m "Speculate skill takes a slot window from the automation"`.

---

### Task 9: Overlap-aware calibration in the scorer

**Files:**
- Create: `src/speculation/overlap.ts`
- Modify: `src/speculation/score.ts` (`renderScorecard`, around line 514)
- Test: `src/speculation/overlap.test.ts`, `src/speculation/score.test.ts`

**Interfaces:**
- Produces: `export function withoutOverlaps(log: LoggedBet[]): LoggedBet[]` — bets sorted by `fill_from`; a bet is dropped when an already kept bet has the same `symbol` and `side` and its `[fill_from, latest_close]` interval overlaps the bet's. The first bet of a chain is kept.
- `renderScorecard` adds, after "All time", a table "All time, non-overlapping bets" built with `statsTable` over `withoutOverlaps(log)` and a line stating how many bets were dropped as overlapping.

- [ ] **Step 1: Write the failing tests:** two long BTC bets whose intervals overlap -> only the earlier survives; same times but one short -> both survive; same side, non-overlapping intervals -> both survive; different symbols overlapping -> both survive; empty log -> `[]`; the scorecard text contains `non-overlapping` and the dropped count for a fixture with one overlap.
- [ ] **Step 2: Run** `node --test src/speculation/overlap.test.ts src/speculation/score.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `withoutOverlaps` and the scorecard section.
- [ ] **Step 4: Run** `npm run test:speculation`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Scorecard: also count non-overlapping bets"`.

---

### Task 10: Task Scheduler install script and docs

**Files:**
- Create: `scripts/install-tasks.ps1`
- Modify: `CLAUDE.md` (module table row for `src/automation/`, Commands list: `npm run auto`), `docs/speculation-guide.md` (done in Task 8)

**Interfaces:**
- `install-tasks.ps1 [-Uninstall] [-WhatIf]` registers, under the task folder `\krypto-kal\`:
  - `speculation-tick`: every 2 hours from 00:00 plus repeat every 10 minutes for 40 minutes after each (retries; the tick is idempotent), plus triggers at logon and on wake from sleep; action `npm run auto -- tick` in the repo directory with `BOT_CONFIG=config/bot.auto.json`; setting: do not start a new instance while one runs; run only when the user is logged on.
  - `speculation-score`: daily 23:30 local, `npm run auto -- score`.
  - `server`: at logon, `npm start`, restart on failure every minute up to 999 times.
  - `bot`: at logon (delayed 1 minute so the server is up), `npm run bot -- run --config config/bot.auto.json`, same restart settings.
  - `-WhatIf` only prints the tasks it would create; `-Uninstall` removes every task in the folder.

- [ ] **Step 1: Write the script** with `Register-ScheduledTask` calls built from one table of task definitions, so `-WhatIf` and install share it.
- [ ] **Step 2: Verify without installing:** `powershell -File scripts/install-tasks.ps1 -WhatIf`. Expected: four task definitions printed, each with the command line and trigger summary, nothing registered (`schtasks /query /tn "\krypto-kal\*"` finds none).
- [ ] **Step 3: Update CLAUDE.md and the guide.**
- [ ] **Step 4: Full check:** `npm run test:offline` and `npm run typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `git commit -m "Task Scheduler install script and docs for the automation"`.
- [ ] **Step 6: Install and soak (needs the user's go-ahead, it changes the machine):** run the script without `-WhatIf`, wait for two real slots, then check `npm run auto -- status`, the ledger, `output/bot/alerts.md` and `server_stats`; report Coinalyze quota use and run durations to the user.

---

## Self-review notes

- **Spec coverage:** flow and slots (Tasks 1, 6, 7); catch-up (1, 6); handoff gating and ledger idempotency (2, 4, 6); claude allowlist and timeout (5); failures to `alerts.md` (6, 7); changes to `check.ts` (3), the skill (8) and scoring overlap (9); supervision and install (10); docs (8, 10). Out of scope items stay out. Spec point "`score.ts`/`drivers.ts` assume one report per session": `score.ts` is handled by Task 9; `drivers.ts` scores per report from `window`, which is now the two-hour slot, so it needs no change, but Task 8 step 3 must confirm that on the first real report (a driver's expectation is judged over the slot).
- **Departures from the spec:** the slot grid is UTC (the spec's local-hours assumption would repeat 02:00 on 2026-10-25); no change to the `HHMMZ` naming code is needed because bet ids and file names already come from `meta.window[0]`, and `check.ts` already starts `fill_from` at the generation time for late runs.
- **Open decision recorded:** overlap handling is "first bet of an overlapping same-side chain counts" (Task 9). Change it there if you prefer another rule.
