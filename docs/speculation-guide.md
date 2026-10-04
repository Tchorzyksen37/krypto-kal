# Speculation mode: user guide

How to use the speculation reports, how to act on them, and what to expect from them.
Design details: [superpowers/plans/2026-10-03-speculation-mode.md](superpowers/plans/2026-10-03-speculation-mode.md).

> **Status (2026-10-04):** the support code (`src/speculation/`) and both skills exist and the offline tests pass. The
> checker and scoring bugs found in review are fixed, but the mode has **not been run against the live tools yet**
> and some limitations remain (see [Known limitations](#known-limitations)). Treat the first reports as a test run
> and do not size positions on them.

## 1. What it is

Four times a day, Claude writes a **speculative** report about the coming trading session into your Obsidian vault.
It takes what is measured (prices, open interest, funding, liquidations, macro, X posts), what cannot be seen, and
what is possible but unconfirmed, and states the most probable continuation of the session:

- an overall **bias**: LONG, SHORT or NEUTRAL, with a probability, plus a lean per symbol;
- 2-4 scenarios with probabilities;
- catalysts (what can move the market, and when) and risks (what would invalidate the call);
- who is trading in this session (world regions, investor types) and how busy it usually is;
- at the end, up to 3 **best bets**: symbol, side, limit entry, stop loss (SL), take profit (TP), how long to hold.

It is a thinking aid. It does not place orders, and nothing in the code can.

## 2. What it is not, and what to expect

Read this before using any bet.

- **It is not a prediction engine.** The percentages are the model's verbal judgement, not token probabilities and not
  a statistical model. Whether they mean anything is exactly what the scorecard has to show.
- **Most bets will lose more often than they win, by design.** A bet with reward:risk 2:1 hits its take profit about
  33% of the time *by pure chance* (with no edge at all). A stated 40% therefore claims only about 7 percentage points
  of edge. A losing streak of 5-8 bets is normal even if the edge is real.
- **Break-even is not 50%.** With reward:risk `RR`, a bet breaks even at a win rate of `1 / (1 + RR)` before fees
  (33% at 2:1, 45% at 1.2:1). Fees and slippage push that up.
- **You need many bets before concluding anything.** With 4 reports a day and many bets never reaching their entry,
  expect roughly 30 filled bets after 1-2 weeks. That is enough to spot something badly broken, not enough to prove
  an edge. Telling a 40% from a 45% win rate takes hundreds of bets.
- **"No bet" is a good answer.** Especially at night. A report without bets is not a failure.
- **Expected honest outcome:** if, after a month or so of supervised use, the stated probabilities do not beat the
  chance baseline in the scorecard, the right decision is to stop using the bets (the market summary may still be
  useful as reading).
- **Risk:** only trade sizes you are fully prepared to lose. Leverage on perpetual futures can lose more than one
  stop's worth in a fast market (gaps, slippage, liquidation).

## 3. One-time setup

1. **Server.** On your machine, `npm start` in this repo (the MCP server at `127.0.0.1:3000`). The reports need:
   - `COINALYZE_API_KEY` (derivatives data),
   - `KRAKEN_FUTURES_RO_API_KEY` / `KRAKEN_FUTURES_RO_API_SECRET` (read-only: your positions and fills, used for scoring),
   - `BRAIN_DIR` pointing at the vault (`C:\Users\mtchorze\OneDrive\Documents\pierdoly`),
   - optionally `X_BEARER_TOKEN` for fresh X posts.
2. **Scheduled tasks.** In Claude Desktop / Claude Code on the same machine, create four scheduled tasks that run the
   `speculate` skill (Europe/Warsaw time):

   | Fires | Report | Session window (local) |
   |---|---|---|
   | 07:40 | Europe open | 08:00-12:00 |
   | 13:10 | Europe/US overlap | 13:30-17:30 |
   | 17:10 | US session | 17:30-22:00 |
   | 21:40 | Night (Asia) | 22:00-08:00 |

   The machine must be awake and the server running. A missed run is just a missing report; there is no catch-up.
   They must run locally: a cloud routine cannot reach `127.0.0.1` or your vault.
3. **Optional settings** in `.env`: `SPECULATION_SYMBOLS` (core symbols, default `BTC,ETH,XRP`),
   `SPECULATION_SCREEN_EXTRA` (extra screened symbols, default 3, `0` turns screening off), `SPECULATION_FEE_BPS`
   (default 5), `SPECULATION_TZ` (default `Europe/Warsaw`). Full list in [CLAUDE.md](../CLAUDE.md).

You can also run a report by hand at any time: ask Claude "speculate" (or `/speculate`). A run in the middle of a
session reports on the running session; its bets can only fill from the moment it was generated.

## 4. Daily workflow

1. **A report appears** in `output/speculation/YYYY-MM-DD/HHMMZ.md` (HHMM is the session start in UTC, e.g.
   `1130Z` = 13:30 Warsaw summer time).
2. **Read the top first.** The Bias block says LONG / SHORT / NEUTRAL. Then the session profile and "who is
   trading". Then risks: they tell you what would make the call wrong.
3. **Look at the Best bets block at the end.** For each bet:
   - **Entry is a limit order.** Wait for price to touch it. Do not chase.
   - **"Fill by"** (UTC): if the entry is not touched by then, the bet is void. Cancel the order.
   - **SL / TP:** set both as soon as you are filled.
   - **"Hold max"**: after the fill, close the position when this time runs out, even if neither SL nor TP was hit.
     "Latest close" is the latest possible moment (if you were filled right at the deadline).
   - **Break-even / EV:** the win rate the bet needs after fees, and the expected result per bet if the model's P is
     right. P minus break-even is the edge the model claims. Bets without a claimed edge are dropped.
   - **Counter-bias** warning: the bet goes against the symbol's stated lean. Be extra sceptical.
   - **Dropped bets** are listed with the reason. They failed a rule (levels in the wrong order, limit on the wrong
     side of the market, too far from price, stop inside normal noise, target not covering fees, fees above 0.2R,
     reward:risk too low, hold too long, no edge over break-even).
4. **Night session:** you will be asleep, so you cannot close by hand at the hold limit. Either skip night bets, or
   place the entry, SL and TP as orders before bed and accept that the hold limit is not enforced. (A proper
   "orders-before-bed, close at 08:00" mode is planned; see limitations.)
5. **Do not hold two bets on the same contract at once.** Kraken Futures nets positions per contract, so a short from
   one report cancels a long from the previous one. BTC, ETH and XRP move together: three longs are close to one big
   long.
6. **Trade on Kraken Futures** (the PF_ contracts the report names). Scoring matches your fills from that account
   automatically; you do not need to tag trades or upload anything.

## 5. Scoring

Once a day (or whenever you like), ask Claude "score the speculation bets" (skill `speculation-score`, which calls
the MCP tool `speculation_score`; your trades come from the same Kraken Futures fill sync as `kraken_futures_fills`),
or run it yourself: `node --env-file-if-exists=.env src/speculation/score.ts <vault>/output/speculation`. It fetches the futures
candles and your fills itself, and:

- pulls your Kraken Futures fills and matches them to bets automatically (same contract and side, inside the bet's
  time window, entry price within 0.3%); fills that match no bet are listed separately; ambiguous matches are flagged,
  never guessed;
- scores **every** bet, taken or not, against 1-minute candles of the futures contract (did the entry touch, then TP,
  SL or time-out first?). This measures the speculation itself, separately from your execution;
- scores the bets **you took** from your real fills: slippage, exit reason, result in R after the real maker/taker
  fees of your fills;
- writes `output/speculation/YYYY-MM-DD/_day.md` and `output/speculation/_scorecard.md`.

How to read the scorecard:

| Number | Meaning | What good looks like |
|---|---|---|
| Edge line | how often the take profit was reached (95% interval) vs the stated P and the chance baseline `1/(1+R:R)` | interval above chance; the verdict says so explicitly |
| Brier skill | how much better the stated probabilities forecast TP hits than the chance baseline | above 0 (below 0: the model's numbers are worse than chance) |
| TP rate [95%] (N=…) | share of filled bets that reached take profit, with its 95% interval | above the "Chance" column; always read N |
| Profitable | filled bets that ended in profit, including profitable time-outs | context only; the TP rate is what P is about |
| Mean net R [95%] | average result per filled bet, in units of risk, after fees, with its 95% interval | the whole interval above 0 over a large N |
| Bias table | the headline LONG/SHORT call judged on BTC's session move (flat when below 0.25 x 1h ATR x sqrt(hours)) | right more often than the "Chance" column `(1 - flat share)/2`; Brier below 0.25 |
| Never touched | bets whose entry was not reached | high is fine; it means the limits were patient |
| Calibration | stated probability vs chance vs how often the take profit was reached | stated 40% bets reach TP about 40% of the time, above their chance column |
| By session / symbol / side / vs bias | where results come from | tells you which sessions to ignore |
| Taken by you vs all bets | your selection and execution vs the raw bets | your mean R much lower than the raw bets' means execution costs you |

"Too few bets to conclude anything" is printed under 30 filled bets. Believe it.

## 6. Where things live

| Path (in the vault) | What |
|---|---|
| `output/speculation/YYYY-MM-DD/HHMMZ.md` | the report you read |
| `output/speculation/YYYY-MM-DD/HHMMZ.meta.json` | machine data of the report (levels, bias); you do not need to open it |
| `output/speculation/bets-log.json` | every validated bet and, later, its outcome |
| `output/speculation/YYYY-MM-DD/_day.md` | daily scorecard |
| `output/speculation/_scorecard.md` | rolling and all-time scorecard |

In this repo: `src/speculation/` (checker, screen, sessions, volume, scorer; `npm run test:speculation`),
`.claude/skills/speculate/` and `.claude/skills/speculation-score/`.

## 7. Known limitations

Fixed on 2026-10-04: negative-expectancy bets, stops smaller than fees, limit entries on the wrong side of the market,
stale levels in `bets-log.json` after a rerun, ranking that was not expected value, scoring on spot candles with a
12-hour limit, assumed instead of real maker/taker fees, model-written prices (the checker now re-measures them),
model-gathered inputs (now one `speculation_context` call), win rate instead of TP rate in calibration, no chance
baseline, the unscored bias, Kraken-only volume, and the screen's funding unit. Still open:

- **Session times assume summer offsets** in the descriptive text. In late October/early November and in March the
  US open shifts by an hour relative to Warsaw (e.g. 14:30 instead of 15:30 on 2026-10-27).
- **"Who is trading" is a timing proxy.** Volume by hour is now summed over several exchanges, but clock time still
  does not prove which region is trading.
- **Coinalyze data uses Binance USDT perpetuals as the proxy** for each symbol's open interest, long/short ratio
  and liquidations; Kraken's own positioning can differ.
- **No guard against overlapping or correlated bets** across reports, and the night session has no "orders before
  bed" mode yet.
- **Funding** paid or received while holding is not included in the R results.
- **Fees** default to Kraken Futures base-tier rates (0.02% maker, 0.05% taker). If your tier differs, set
  `SPECULATION_MAKER_FEE_BPS` / `SPECULATION_TAKER_FEE_BPS` (scoring) and `SPECULATION_FEE_BPS` (checker).
- **News freshness depends on the X sync.** Without `X_BEARER_TOKEN` (or `X_COLLECT=true` for a background sync) the
  archive goes stale; the report then says how old the newest post is.
- **Weekend macro quotes are Friday's close.** The skill labels them as stale; only CME futures (`ES=F`, `NQ=F`)
  update from Sunday evening.
