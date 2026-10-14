# Bot: four symbols, one position at a time, calibrated conviction sizing

Date: 2026-10-14. Status: design approved in chat, spec awaiting review. Scope: dry-run bot only (`LiveExecutor` still always throws).

## Intent

The user wants the dry-run bot to trade BTC, ETH, SOL and XRP perpetuals (`PF_XBTUSD`, `PF_ETHUSD`, `PF_SOLUSD`, `PF_XRPUSD`) and to size each bet by how much the speculation can be trusted. Decisions made with the user:

- **One position at a time** across all symbols; the best eligible bet of the four wins. Several simultaneous positions are out of scope (later work).
- **Leverage is not tied to confidence.** In isolated margin, risk = size x stop distance; leverage only moves the liquidation price and the locked margin. Confidence scales the **risk per trade** (position size). Leverage stays derived from the liquidation-distance rule (`liq_distance_min_multiple`, capped by `max_leverage`).
- **Confidence is the stated probability corrected by history** (the scorecard of touched bets), shrunk toward the stated value while the sample is small.

Success: with four allowed symbols the bot enters the best checked bet on any of them, holds at most one position, keeps every existing hard limit, and a bet's size grows with its (calibrated) probability up to, but never above, today's maximum risk per trade.

## Current state (read from the code)

- `config.symbol` (default `PF_XBTUSD`) is read in `engine.ts`, `trader.ts`, `watchdog.ts`, `reconcile.ts`, `dry-run-executor.ts`, `report.ts`, `sim.ts`, `cli.ts` and `policy.ts` (policy and menu symbol must equal it). `KrakenMarketData` is constructed with one symbol (`market-data.ts`).
- `from-speculation.ts` already ranks validated bets, takes the best eligible one (`haveOne`), and skips bets whose `futures` differ from `config.symbol`.
- Sizing: `computeSize` uses `riskPct = min(riskBudgetPct x convictionMultiplier, maxRiskPct)`, `convictionMultiplier = 0.5 + conviction x (cap - 0.5)`, cap 1.25. `from-speculation.ts` sets `risk_budget_pct = max_risk_per_trade_pct`, so any multiplier above 1 is clipped: today conviction can only shrink the position (multiplier 1.0 at conviction 0.667, below it smaller).
- Scorecard data: `src/speculation/score.ts` (`summarize`, `calibration`, `readLog`) over `bets-log.json`. All-time there are 3 touched bets, 0 take-profit hits.

## Design

### 1. Symbols

- Config: replace `symbol: string` with `symbols: string[]` (non-empty, unique). Default `["PF_XBTUSD"]` so nothing changes for existing configs; the automation config `config/bot.auto.json` lists the four. A legacy `symbol` key is rejected by the strict schema with a message pointing to `symbols`.
- Active symbol, resolved every cycle, never stored in the config (the config hash goes into every journal row and must stay a function of the file):
  1. the symbol of the open position, if any (must be in `symbols`);
  2. otherwise the symbol of the live policy's menu.
  Everything that reads `config.symbol` takes the active symbol as an explicit argument instead.
- Market data: a factory returns a `KrakenMarketData` per symbol (cached per process). Contract specs (tick, size step, minimum) come from `instrument(symbol)` as today.
- Policy and menu validation (`policy.ts`): symbol must be in `config.symbols` rather than equal to one symbol.
- One-position rule: `max_open_positions` stays 1 and is enforced across all symbols; `max_positions_per_asset` stays 1. `reconcile` and `watchdog` look at the positions and bot orders of all allowed symbols, and a second position on another allowed symbol is an incident, not a silent state.
- `from-speculation.ts`: the symbol check becomes "in `config.symbols`"; the policy and menu use the bet's `futures`; ATR comes from the bet's report symbol as today. The best eligible bet over all four symbols is taken (ranking unchanged).
- Report and `bot_status` show the symbol per trade and the active symbol.
- Simulated state keyed by symbol already exists for the position document (`putDoc(POSITION, symbol, ...)`); to be verified for orders and fills in the plan.
- Not changed: account-wide limits (total open risk, daily loss, entries per day, orders per day, cooldowns).

Out of scope, noted for before any live mode: on the real account the user's manual positions in the same symbols share one net position per symbol on Kraken Futures flex, so the bot's reconcile cannot treat them as separate. The dry-run simulated exchange is unaffected.

### 2. Conviction sizing

- New config field `base_risk_per_trade_pct` (default 0.4, must be <= `max_risk_per_trade_pct`). `from-speculation.ts` sets `risk_budget_pct` to it instead of the cap. With the cap multiplier 1.25 the maximum is 0.4 x 1.25 = 0.5%, equal to today's `max_risk_per_trade_pct`; the hard cap is unchanged and still applied last.
- Resulting risk per trade (defaults): conviction 0 -> 0.20%, 0.4 -> 0.32%, 0.667 -> 0.40%, 1.0 -> 0.50%.
- Calibrated conviction (new pure module, e.g. `src/bot/conviction.ts`, unit-tested, no I/O):
  - Input: the logged touched bets (non-overlapping), each with its stated probability and whether take-profit was reached.
  - `r = (hits + k x pbar) / (expected + k x pbar)`, `expected = sum of stated probabilities` of the touched bets, `pbar = expected / touched`, `k = 10` pseudo-bets that were perfectly calibrated at the mean stated probability (so `r` is 1 when there is no data and moves toward the observed ratio as bets accumulate).
  - `conviction = clamp(stated x r, 0, 1)`.
  - Global pooled, not per symbol or session, until a later change has the sample for it.
  - With today's log (3 touched, 0 hits, expected about 1.2) `r` is about 0.77.
- The conversion reads `bets-log.json` (path from the same place `speculation_score` uses), computes the calibrated value and writes it as `conviction`; the stated and calibrated values and `r` go into the policy `rationale` for the journal.
- Conviction never loosens a hard limit: stop distance in ATR, reward:risk, liquidation distance, daily and total risk caps are unchanged.

## Error handling

- Missing or unreadable `bets-log.json`: `r = 1` (stated probability), with a warning in the conversion output.
- Symbol not in `symbols` (policy, menu, or a bet): rejected with a reason, as today for a mismatch.
- An open position on a symbol outside `symbols` (for example after the list is edited): halt with an incident, no new entries.
- No ticker or suspended contract for the active symbol: the cycle skips with the existing `no_price` reason.

## Testing

- `config.test.ts`: `symbols` validation, legacy `symbol` rejected, `base_risk_per_trade_pct <= max_risk_per_trade_pct`.
- `sizing.test.ts`: the table above; a property test that risk never exceeds `max_risk_per_trade_pct`.
- New `conviction.test.ts`: no data gives `r = 1`, the 3-bet case, a large well-calibrated sample, a large badly-calibrated sample, clamps.
- `from-speculation.test.ts`: best bet across four symbols, symbol not allowed, calibrated conviction in the fixture.
- `engine`/`trader`/`watchdog`/`reconcile` tests: active symbol from position, then from policy; second position on another symbol is an incident; protection checks per symbol.
- `dry-run-replay.test.ts`: a replay with bets on two different symbols in sequence; one position at a time holds.
- `invariants.test.ts`: still green with the new symbol parameter.
- Run `npm run test:bot`, then `npm run test:offline` and `npm run typecheck`.

## Files expected to change

`src/bot/config.ts`, `policy.ts`, `from-speculation.ts`, `sizing.ts` (inputs only), `engine.ts`, `trader.ts`, `watchdog.ts`, `reconcile.ts`, `dry-run-executor.ts`, `sim.ts`, `market-data.ts` (factory), `report.ts`, `cli.ts`, new `conviction.ts`, the matching tests, `config/bot.auto.json` (the four symbols), `CLAUDE.md` and `docs/bot-architecture.md` (bot row and symbols).

## Open points for the plan

- Whether the simulated order and fill documents are already keyed per symbol (the position document is).
- Where the automation tick builds the policy, so the bets log path reaches the conversion without a new global.
- Exact `k` and the base risk are config-level defaults the user can change; the values above are the starting point.
