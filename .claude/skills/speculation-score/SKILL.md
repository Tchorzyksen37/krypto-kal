---
name: speculation-score
description: Score past speculation bets using Kraken Futures fills and futures candles pulled from the API (no manual upload). Matches fills to bets automatically, computes actual and hypothetical outcomes, hit rate, mean R and calibration, and updates the scorecard under output/speculation/. Use when the user says score, "evaluate speculation", or asks how the bets performed.
---

# Speculation score

Evaluates whether the hourly speculation reports are worth anything. Design: section 9 of
`docs/superpowers/plans/2026-10-03-speculation-mode.md`. Chat in English. The user does not upload anything:
all data comes from the Kraken Futures API through the MCP tools.

## Hard rules

1. Write only under `BRAIN/output/speculation/`. Never touch `raw/` or `wiki/`.
2. Print N next to every percentage; say "too few bets" under 30. No conclusions from tiny samples.
3. Do not tune the `speculate` skill automatically. Report findings; the user decides.
4. Never invent a trade or a price. Ambiguous matches are flagged, never guessed.
5. Do the arithmetic with `speculation-score.ts`, not by hand.

## Procedure

1. **Score:** run `node --env-file-if-exists=.env src/speculation/score.ts <BRAIN>/output/speculation` from the repo.
   It fetches everything itself:
   - 1m trade-price candles of each bet's **futures contract** (public Kraken Futures endpoint, no keys; never
     the spot `kraken_ohlc`, which is a different market and only reaches back 12 hours);
   - your fills, synced into the local fill store with the read-only keys (`KRAKEN_FUTURES_RO_API_KEY/_SECRET`),
     including each fill's order id and maker/taker type.
   It then matches fills to bets (same contract and side, fill time inside the bet window plus TTL, price within the
   match tolerance, closest wins, one fill per bet) and computes:
   - taken or skipped; entry slippage; exit reason (TP, SL, manual close near TTL, other); net R after the real
     maker/taker fees of your fills (unknown type counts as taker);
   - hypothetical outcome of every bet from futures 1m candles (entry touched before the deadline? then TP, SL or
     TTL first; SL wins a same-candle tie), taken or not, with maker fees on the limit entry and take-profit and
     taker fees on stops and time-outs.
   Without the read-only keys it prints a warning and scores only the hypothetical outcomes. Warnings about failed
   candle requests mean those bets stay pending; rerun later.
   If the network cannot reach Kraken, gather the data with the MCP tools (`kraken_futures_candles` per contract and
   window, `kraken_futures_fills`) into a JSON file `{ fills, candles: { "PF_...": [...] } }` and run
   `node src/speculation/score.ts <dir> --input <file>`.
   It also scores each finished report's **bias** (`reports-log.json`, written by the checker): the session move of
   each symbol from the first trade to the last close of the window, flat when smaller than 0.25 x 1h ATR x
   sqrt(hours); the headline call is judged on BTC.
2. **Read** `YYYY-MM-DD/_day.md` and `_scorecard.md` (the script wrote them). The key line is the edge line: how
   often the take profit was reached (with its 95% interval) against the stated probability and the chance
   baseline `1 / (1 + R:R)`, and the Brier skill against chance (above 0 = the stated probabilities beat chance).
   Then the bias table (right vs chance, Brier), calibration (stated vs chance vs reached), per session / symbol
   / side / vs bias, never-touched rate, taken vs skipped.
3. **Reply** with: the edge line as written, the bias hit rate with N, mean net R with its interval, the one
   pattern that stands out (or "nothing significant yet"), and any fills that matched no bet.
