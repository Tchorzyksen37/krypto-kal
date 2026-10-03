---
name: speculation-score
description: Score past speculation bets using Kraken Futures fills pulled from the API (no manual upload). Matches fills to bets automatically, computes actual and hypothetical outcomes, hit rate, mean R and calibration, and updates the scorecard under output/speculation/. Use when the user says score, "evaluate speculation", or asks how the bets performed.
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

1. **Pull data.** `kraken_futures_fills` and `kraken_futures_pnl` (they sync new fills into the local DB, so
   history goes past the API's 100-fill window), `kraken_ohlc` 1m candles for each bet window, and
   `BRAIN/output/speculation/bets-log.json`.
2. **Score:** `node speculation-score.ts <day>`. It matches fills to bets automatically (same contract and
   side, fill time inside the bet window plus TTL, price within the match tolerance, closest wins, one fill
   per bet), then computes:
   - taken or skipped; entry slippage; exit reason (TP, SL, manual close near TTL, other); net R after fees;
   - hypothetical outcome of every bet from 1m candles (entry touched before the deadline? then TP, SL or
     TTL first; SL wins a same-candle tie), taken or not.
3. **Write** `YYYY-MM-DD/_day.md` and refresh the rolling 7-day and all-time tables: hit rate, mean R,
   calibration buckets, per symbol / session / side, never-touched rate, taken vs skipped.
4. **Reply** with: bets scored, win rate with N, mean R, the one pattern that stands out (or "nothing
   significant yet"), and any fills that matched no bet.
