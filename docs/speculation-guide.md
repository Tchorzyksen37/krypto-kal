# Speculation mode: user guide

How to use the speculation reports, how to act on them, and what to expect from them.
Design details: [superpowers/plans/2026-10-03-speculation-mode.md](superpowers/plans/2026-10-03-speculation-mode.md).

> **Status (2026-10-04):** the support code (`speculation/`) and both skills exist and the offline tests pass, but the
> mode has **not been run against the live tools yet**, and the review found bugs that are not fixed yet (see
> [Known limitations](#known-limitations)). Until those are fixed, treat reports as a test run and do not size
> positions on them.

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
   - **Counter-bias** warning: the bet goes against the symbol's stated lean. Be extra sceptical.
   - **Dropped bets** are listed with the reason. They failed a rule (levels in the wrong order, too far from price,
     stop inside normal noise, target not covering fees, reward:risk too low, hold too long).
4. **Night session:** you will be asleep, so you cannot close by hand at the hold limit. Either skip night bets, or
   place the entry, SL and TP as orders before bed and accept that the hold limit is not enforced. (A proper
   "orders-before-bed, close at 08:00" mode is planned; see limitations.)
5. **Do not hold two bets on the same contract at once.** Kraken Futures nets positions per contract, so a short from
   one report cancels a long from the previous one. BTC, ETH and XRP move together: three longs are close to one big
   long.
6. **Trade on Kraken Futures** (the PF_ contracts the report names). Scoring matches your fills from that account
   automatically; you do not need to tag trades or upload anything.

## 5. Scoring

Once a day (or whenever you like), ask Claude "score the speculation bets" (skill `speculation-score`). It:

- pulls your Kraken Futures fills and matches them to bets automatically (same contract and side, inside the bet's
  time window, entry price within 0.3%); fills that match no bet are listed separately; ambiguous matches are flagged,
  never guessed;
- scores **every** bet, taken or not, against 1-minute candles (did the entry touch, then TP, SL or time-out first?).
  This measures the speculation itself, separately from your execution;
- scores the bets **you took** from your real fills: slippage, exit reason, result in R after fees;
- writes `output/speculation/YYYY-MM-DD/_day.md` and `output/speculation/_scorecard.md`.

How to read the scorecard:

| Number | Meaning | What good looks like |
|---|---|---|
| Win rate (N=…) | share of filled bets that ended in profit | above the break-even rate for the bets' reward:risk; always read N |
| Mean net R | average result per filled bet, in units of risk, after assumed fees | above 0 over a large N |
| Never touched | bets whose entry was not reached | high is fine; it means the limits were patient |
| Calibration | stated probability vs how often it happened | stated 40% bets should win about 40% of the time |
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

In this repo: `speculation/` (checker, screen, sessions, volume, scorer; `npm run test:speculation`),
`.claude/skills/speculate/` and `.claude/skills/speculation-score/`.

## 7. Known limitations

Found in review, **not fixed yet**. Until they are, use the reports as a test run only.

- **Negative-expectancy bets can pass.** The checker does not yet require the stated probability to beat the
  break-even rate, and its ranking is not true expected value. Check yourself: `probability > 1 / (1 + R:R)`.
- **Stops can be smaller than fees.** A tight BTC stop can cost more in fees than the stop itself. Check that the stop
  distance is at least about 5x the round-trip fee (0.1% of price at 5 bps per side).
- **Limit entries on the wrong side of price are accepted.** A long "limit" above the market (or a short below) would
  fill at once. Skip such bets.
- **Re-running the checker keeps the old levels in `bets-log.json`.**
- **Scoring data:** the scorer currently has to use spot candles, which only reach back 12 hours at 1-minute
  resolution and differ slightly from futures prices. Score at least twice a day, and treat hypothetical results near
  the entry price as approximate. A futures-candles tool is planned.
- **Prices in the report are written by the model.** The checker trusts the last price and ATR it is given. Compare
  the entry with the live price before placing an order.
- **The bias is stated but not scored yet**, and the calibration counts profitable time-outs as wins.
- **Session times assume summer offsets** in the descriptive text. In late October/early November and in March the
  US open shifts by an hour relative to Warsaw (e.g. 14:30 instead of 15:30 on 2026-10-27).
- **"Who is trading" is a proxy.** Volume by hour comes from Kraken, which under-represents Asian exchanges, and
  clock time does not prove which region is trading.
- **No guard against overlapping or correlated bets** across reports.
