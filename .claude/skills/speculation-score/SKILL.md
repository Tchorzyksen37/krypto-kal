---
name: speculation-score
description: Score past speculation bets against the user's uploaded daily portfolio report and Kraken Futures fills. Matches trades to bet ids, computes actual and hypothetical outcomes, hit rate, mean R and calibration, and updates the scorecard under output/speculation/. Use when the user uploads a portfolio report, says score, "evaluate speculation", or asks how the bets performed.
---

# Speculation score

Evaluates whether the hourly speculation reports are worth anything. Design: section 9 of
`docs/superpowers/plans/2026-10-03-speculation-mode.md`. Chat in English.

## Hard rules

1. Write only under `BRAIN/output/speculation/`. Never touch `raw/` or `wiki/`.
2. The uploaded portfolio file is copied to `output/speculation/portfolio/YYYY-MM-DD.<ext>` and never edited.
3. Print N next to every percentage; say "too few bets" under 30. No conclusions from tiny samples.
4. Do not tune the `speculate` skill automatically. Report findings; the user decides.
5. Never invent a trade or a price. Unreadable rows in the upload are listed, not guessed.

## Procedure

1. **Read the upload** (CSV, PDF or screenshot) and extract trades: symbol, side, entry time and price,
   exit time and price, size, fees, realised PnL. Cross-check against `kraken_futures_fills` and
   `kraken_futures_pnl` for the same day; report any mismatch.
2. **Match trades to bets** in `output/speculation/bets-log.json`: by bet id if the user quoted one, else by
   symbol + side + time (within the bet's window) + entry price proximity. List unmatched trades as "not from a
   report"; exclude them from bet statistics.
3. **Score** with `node speculation-score.ts <day>` (pure code does the arithmetic; do not compute by hand):
   - taken / skipped; entry slippage; exit reason (TP, SL, manual close at TTL, other); net R.
   - hypothetical outcome of every bet from Kraken 1m candles (entry touched? TP, SL or TTL first; SL wins
     a same-candle tie), taken or not.
4. **Write** `YYYY-MM-DD/_day.md` and refresh the rolling 7-day and all-time tables: hit rate, mean R,
   calibration buckets, per symbol / session / side, entry-never-touched rate, taken vs skipped.
5. **Re-render** the dashboard scorecard (`node speculation-render.ts --scorecard`).
6. **Reply** with: bets scored, win rate with N, mean R, the one pattern that stands out (or "nothing
   significant yet"), and any unmatched trades.
