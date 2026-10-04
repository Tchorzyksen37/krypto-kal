# Testing the bot in dry-run

How to run the Kraken Futures bot against the real market without any real transaction, what you will see, and how it
tells you when something is wrong. Architecture: [bot-architecture.md](bot-architecture.md). Status and unverified
assumptions: [superpowers/2026-10-03-trader-core-status.md](superpowers/2026-10-03-trader-core-status.md).

## What "dry-run" means here

- **Market data is real:** prices, candles, funding and the contract come from Kraken Futures' public endpoints (no
  keys).
- **The exchange is simulated:** orders, fills, the position and the account live in the bot's SQLite file
  (`~/.krypto-kal/bot.db`). The fill model is pessimistic: a limit fills only when price trades through it, stops fill
  at the worse of trigger and quote, and a stop beats a target inside one candle.
- **No real order is possible:** the live executor cannot be constructed, the launcher refuses `mode: "live"`, and the
  exchange client is created with empty keys. Guard tests check all three.
- **Sampling:** the trader reads the price every `cycle_interval_sec` (default 5 s). A wick shorter than that is not
  seen by the simulation; minutes the bot was down are replayed from 1-minute candles at the next start.

## Setup (once)

1. Optional config file (anything you leave out uses the defaults: capital 1000 USD, 0.5% risk per trade, leverage 2,
   PF_XBTUSD):
   ```json
   { "symbol": "PF_XBTUSD", "trading_capital_usd": 1000, "manual_approval": false }
   ```
   Pass it with `--config bot.json` or `BOT_CONFIG=bot.json` in `.env`.
2. `BRAIN_DIR` in `.env` (already set for the brain) makes the bot write alerts and reports into the vault.

## Daily use

The bot only trades policies. Until the analyst exists, you write them:

```powershell
npm run bot -- policy template long > policy.json   # levels around the current price (entry zone, stop, two targets)
# edit policy.json if you like, then add it twice (the engine acts only when 2 agreeing policies exist):
npm run bot -- policy add policy.json
npm run bot -- policy add policy.json
npm run bot -- run                                   # trader + watchdog; Ctrl+C stops both
```

A policy is valid for at most `max_policy_ttl_min` (60 min) and its level menu must be fresh, so add new ones when they
expire. With `"manual_approval": true` the trader asks `Approve BUY ...? [y/N]` in the terminal before every entry
(stops, targets and closes are never asked, so a position is never left waiting unprotected).

In another terminal, or in Claude (`bot_status` MCP tool, "how is the bot?"):

```powershell
npm run bot -- status          # state, halt, position, orders, account, recent incidents and decisions
npm run bot -- report          # today: net PnL (fees, funding), trades with R, calibration, entries not taken
npm run bot -- report --days 7 --write
```

## How problems reach you

| Where | What |
|---|---|
| Terminal log | every incident and halt as an ERROR line, as it happens |
| Vault: `output/bot/alerts.md` | every incident and halt, once each, newest at the bottom (written by the trader within one cycle) |
| Vault: `output/bot/report-<day>.md` | the day's report, refreshed hourly and finalised after the day ends |
| `npm run bot -- status` / `bot_status` | the current state, the last incidents and decisions |
| SQLite (`incidents`, `journal`) | the full record: every decision with its input snapshot and the config hash |

Incident kinds you may see:

| Kind | Meaning | What to do |
|---|---|---|
| `cannot_verify` | the simulated account or the market could not be read | usually network; the bot decides nothing until it can read again |
| `funding_unavailable` | the funding history could not be read | network; funding is charged later when it is back |
| `no_sl`, `no_tp`, `wrong_sl_size`, `wrong_tp_size` | the watchdog found protection missing or mis-sized | it repairs once, then closes; **report it: in dry-run this is a bug** |
| `orphan_reduce_only` | a stop or target is left without a position | cancelled by the engine; frequent ones are a bug |
| `unexplained_position`, `position_on_wrong_side` | the position does not match the bot's record | the bot halts; check `status`, then `ack-halt` |
| `order_rejected:*` | the simulated exchange refused an order | read the detail; repeated ones are a bug |
| `runner_cycle_failed`, `watchdog_failed` | an unexpected error in a loop | **always a bug**: send the detail |
| `halt_acknowledged` | you ran `ack-halt` | none |

A **halt** stops new entries and keeps protecting what is open. `daily_loss_limit` clears itself at the reset hour;
the others need `npm run bot -- ack-halt`, which re-runs reconciliation (entries stay blocked until it is clean).

**In dry-run, the simulated exchange cannot disagree with reality, only with itself.** So an incident about
protection, sizes or unexplained positions means a bug in the bot or the simulator, not a market event. The
assumptions about Kraken's real behaviour (trigger direction of stops, whether filling one protective order cancels the
other, reduce-only resizing, duplicate `cliOrdId`) can only be checked with tiny live orders (stage 2), which iteration 1
cannot place.

## Suggested test plan

1. A day with `manual_approval: true`: watch each entry request, check stops and targets appear (`status`).
2. A week unattended: read `alerts.md` daily; anything other than network incidents goes to a bug report.
3. Restart tests: stop the bot with a position open, wait some minutes, start it again: the downtime replay should fire
   stops or targets that would have hit, once.
4. Read the weekly report: net PnL after fees and funding, R per trade, and whether higher conviction gave higher R.
