---
name: speculation-to-bot
description: Hand the best bet of a speculation report to the Kraken Futures bot (dry-run) as a policy that trades only inside the speculation's time window - no entry before the session window opens or after the bet's fill-by time, and the position is closed after the bet's hold time. Use when the user says "send to the bot", "let the bot trade this", "przekaż do bota", "zagraj tym botem", or asks to test a speculation with the bot.
---

# Speculation to bot

Turns the best checked bet of a speculation report into a bot policy, stores it, and tells the user when the bot may
trade. The bot runs in dry-run only (simulated fills on real prices); nothing here can place a real order.

## Hard rules

1. Only a report the checker has validated: its `HHMMZ.meta.json` must have a `validated` list. If it does not, run
   `node src/speculation/check.ts <meta.json>` first. Never write bets or levels by hand.
2. Never edit the bot config (`bot.json` / `BOT_CONFIG`) or the bot database yourself. If a setting blocks the bet, tell
   the user which one and why.
3. Never start, stop or restart the bot processes on your own: tell the user the command.
4. Chat in Polish; the commands and files are in English.

## Procedure

1. **Pick the report.** The newest `BRAIN/output/speculation/<YYYY-MM-DD>/<HHMMZ>.meta.json` (`BRAIN` = `BRAIN_DIR`
   from `.env`), unless the user names one. Say which report and which session you use.
2. **Dry run:** `npm run bot -- policy from-speculation <meta.json> --dry` (add `--config <file>` if the user runs the
   bot with one). It prints, for the best bet on the bot's symbol: the side, entry zone, stop and target, and the
   window: entries from (session window start) until (the bet's fill-by time), close by (fill-by + hold time). It also
   lists skipped bets and warnings.
3. **Read the warnings before storing:**
   - `trades PF_..., this bet is on PF_...`: the bot trades one symbol (its config `symbol`). Bets on other contracts
     need a second bot with its own config and `db_path`; tell the user, do not change the config.
   - `sl_min_atr_multiple` or `min_reward_risk`: the bot's own limits are stricter than the speculation checker and it
     will refuse the entry. Store it only if the user still wants to see the refusal in the report; otherwise stop.
   - `max_policy_ttl_min`: the bet's entry window is longer than a policy may live (default 60 min, e.g. the night
     session's 3 h); the bot stops looking for the entry early. Suggest `"max_policy_ttl_min": 180` in the bot config.
   - `entry window closed`: too late for this report; say so and stop.
4. **Store:** run the same command without `--dry`. It stores the policy in as many agreeing copies as the bot needs
   (`loosen_confirm_cycles`), so the bot acts on it at once inside the window.
5. **Check the bot is running:** `npm run bot -- status` (or the MCP tool `bot_status`). If it is not running, tell the
   user to start it with `npm run bot -- run`. If it is HALTED, say why and that `npm run bot -- ack-halt` clears a
   halt that needs acknowledgement.
6. **Reply** in Polish, at most six lines: the report and bet id, side and levels, the three times (entries from, entries
   until, close by, in UTC and Warsaw time), warnings, and how to follow it (`npm run bot -- status`, `report`,
   `bot_status`, `output/bot/alerts.md`).

## What the bot does with it

- Before the window opens: nothing (`policy_not_yet_active` in the journal).
- Inside the window: enters only when the price reaches the bet's limit level (a thin band of 0.1 ATR on the waiting
  side), sizes the trade by its own risk rules (at most `max_risk_per_trade_pct` of capital), places the stop and the
  target at once.
- After the fill-by time: no new entries (`policy_expired`); an open position keeps its protection.
- After the hold time: the time-stop closes the position at market.
- The bot's own limits still apply (daily loss, entries per day, cooldowns, reward:risk, stop distance).
