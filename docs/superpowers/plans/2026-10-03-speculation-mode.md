# Speculation mode: hourly "probable next hour" report

Status: **plan only, nothing implemented.** Branch `claude/vigilant-hawking-iay551`.

## 1. Idea

Today's tools return **data** (OI, funding, liquidations, candles, X posts). Speculation mode returns a
**forecast of what will probably happen next**, written the way an LLM continues a prompt: not "find the
historical situation that matches and copy what followed", but "given these facts, these known unknowns
and these plausible-but-unconfirmed possibilities, what is the most probable continuation?".

The input is a prompt with three explicit layers:

| Layer | Content | Source |
|---|---|---|
| **Known** | measured facts with timestamps and age | Coinalyze, Kraken, Yahoo, X archive, brain `wiki/` |
| **Unknown** | what we cannot see (real liquidation levels, whale intent, order-book spoofing, pending news) | static list + gaps detected at run time |
| **Possible** | things not confirmed but plausible (scheduled data, rumours, estimated heatmap clusters) | calendar, `liquidation-heatmap.ts` (ESTIMATE), unverified X posts |

The output is **speculation only**: scenarios with probabilities, then a "best bets" table. No claim of
accuracy; every report says so in its header. It is a thinking aid, not a signal service and not an
order source (the bot never reads it).

## 2. Scope and non-goals

In scope: hourly Markdown report in the Obsidian vault, best bets for the next 60 min (entry, SL, TP, TTL),
catalysts, risks, a log that lets us score past reports.

Non-goals: placing orders; feeding the trading bot; backtested edge claims; replacing the
`crypto-market-sentiment` skill (that one is on-demand and interactive, this one is scheduled).

## 3. Who generates the speculation

The server has no LLM today. Decision needed (default in bold):

1. **Anthropic API call from the server** (`ANTHROPIC_API_KEY`, model `SPECULATION_MODEL`). Fully automatic,
   fits the existing `startCollector` scheduling. Cost is roughly one ~6-10k-token prompt per hour, a few
   cents per report.
2. Claude Code routine / cron that runs a skill hourly. No key in the server, but needs a running session.

The plan assumes (1); the prompt builder and the report writer are independent of this choice, so (2) only
swaps the generator module.

## 4. Architecture

New files, each small and testable offline (house style: pure core + thin IO shell).

| File | Role |
|---|---|
| `speculation-context.ts` | Gathers the **Known** layer from existing clients/cache into a typed `MarketContext` (no formatting). Records per-source freshness and failures, so a missing source becomes an explicit **Unknown**. |
| `speculation-prompt.ts` | **Pure.** `MarketContext` to prompt text: sections KNOWN / UNKNOWN / POSSIBLE, the task, and the strict JSON output schema. |
| `speculation-llm.ts` | Thin Anthropic Messages API client via `fetch`, using `RequestQueue` + `withRetry` from `http-utils.ts`. Returns the raw text and token usage. Never retried on a 4xx. |
| `speculation-parse.ts` | **Pure.** Parses and validates the model's JSON into `Speculation`; rejects/repairs bad bets (see 6). |
| `speculation-report.ts` | **Pure.** `Speculation` + context to the Markdown report (frontmatter, scenarios, catalysts, risks, best-bets table last). |
| `speculation.ts` | Orchestrator: context to prompt to LLM to parse to report to `brain.write`. One entry point `runSpeculation(deps)`. |
| `speculation-log.ts` | Appends each bet to `<BRAIN_DIR>/.speculation-log.json` and later fills in the outcome (see 8). |
| `speculation*.test.ts` | Offline tests with a fake `fetch` / fake LLM. Added to `test:offline`. |

Wiring in `mcp-server.ts`:

- `SPECULATION_ENABLED=true` starts `startCollector([{ name: "speculation", run }], SPECULATION_EVERY_MINUTES)`
  (default 60), same pattern as the X sync at `mcp-server.ts:818`.
- One MCP tool `speculation_run` (manual trigger, returns the report path + text) and reuse of the existing
  `brain_read`/`brain_list` for reading reports. It never exposes trading.
- Scheduling is aligned to the top of the hour (UTC) rather than "60 min after start", so reports have stable
  names and the bets' 1h window matches clock hours. The first run happens at the next full hour.

## 5. The prompt

Built by `speculation-prompt.ts`; structure is fixed so reports are comparable:

```
ROLE: You are speculating, not analysing. Output the most probable continuation of the
market over the next 60 minutes. Probabilities must reflect uncertainty; do not hedge by
refusing. Do not recite history; reason from the current state.

NOW: 2026-10-03 14:00 UTC (session: US open in 90 min). Last close: ...

KNOWN (measured, with age):
  price/OHLCV 5m,1h  BTC ETH SOL XRP ...  (Kraken spot + Coinalyze perp)
  OI and OI delta 1h/4h, funding + predicted funding, long/short ratio, liquidations 1h/24h
  Kraken order-book imbalance, spread
  macro: ES/NQ, DXY, US10Y, oil (Yahoo)
  brain: latest wiki/timeline and X posts of last 6h (id, author, verified, age)
  my open futures positions (read-only)

UNKNOWN (cannot be seen; treat as uncertainty, not as zero):
  real liquidation levels, whale/market-maker intent, spoofed depth, news not yet posted,
  sources that failed this run: <list>

POSSIBLE (not confirmed; weight by plausibility):
  scheduled events in the next 2h, estimated liquidation clusters (MODEL, not data),
  unverified X claims, funding-flip squeeze setups

TASK: JSON only, schema <...>
```

Rules baked into the template: every number in KNOWN carries its timestamp; estimated data is labelled
`ESTIMATE`; the model must cite which KNOWN/POSSIBLE items each scenario relies on (this makes bad reports
debuggable and exposes hallucinated "facts").

## 6. Output schema and validation

```
{
  "regime": "short text",
  "scenarios": [{ "name", "probability", "path", "drivers": ["..."] }],   // sum of probability = 1 (+-0.02)
  "catalysts": [{ "what", "when", "direction", "confidence" }],
  "risks":     [{ "what", "invalidates", "severity" }],
  "bets": [{
    "symbol", "side": "long|short",
    "entry", "stop_loss", "take_profit", "ttl_minutes",   // ttl <= 60
    "probability", "rationale"
  }]
}
```

`speculation-parse.ts` enforces, and drops (with a logged reason shown in the report) any bet violating:

- `side=long`: `stop_loss < entry < take_profit`; `short`: the reverse.
- Entry within `SPECULATION_MAX_ENTRY_DEVIATION` (default 0.5%) of the last price, so stale/hallucinated
  levels are rejected.
- Reward:risk >= 1.2 and stop distance >= a minimum (0.15 x ATR(1h)), so the SL is not inside the noise.
- `ttl_minutes` in 5..60; symbol in the configured watch list.
- At most 3 bets (`SPECULATION_MAX_BETS`), ranked by `probability x reward:risk` (expected value proxy).
- If nothing survives: the report says "no bet", which is a valid and honest output.

Failure modes: invalid JSON gets one repair retry with the parse error appended; second failure writes a
report with the context only and a visible "generation failed" banner (never silently skipped).

## 7. Report format (Obsidian)

Path: `output/speculation/YYYY-MM-DD/HH00Z.md` (inside `output/`, so `Brain.write` already allows it; `raw/` and
`wiki/` untouched). Overwrite-safe: the same hour regenerates the same file. A daily note
`output/speculation/YYYY-MM-DD/_index.md` is rewritten per run with links, so Obsidian shows the day at a
glance.

Layout, in this order:

1. Frontmatter: `type: speculation`, `generated`, `valid_until`, `model`, `symbols`, `disclaimer: speculative, not advice`, `sources_ok`, `sources_failed`, `tokens`.
2. Disclaimer line.
3. KNOWN / UNKNOWN / POSSIBLE summary (what the model was given, so the reader can judge the inputs).
4. Regime + scenarios with probabilities.
5. Catalysts (time-ordered).
6. Risks and what would invalidate the call.
7. **Best bets for the next 1h** (last section, as requested): table with symbol, side, entry, SL, TP, TTL,
   probability, R:R, plus dropped bets and why. Wikilinks `[[btc]]`-style to existing `wiki/` pages when they exist.

Language: the report is in English (project rule: code and logs in English); the user chats in Polish, so
`SPECULATION_LANGUAGE` (default `en`, `pl` allowed) only changes the prose of the report, not keys or schema.

## 8. Scoring (so we know whether it is worth anything)

The user explicitly accepts "not always correct"; we still want a hit rate, otherwise the mode is unfalsifiable.

- `speculation-log.ts` stores each bet (report id, levels, ttl, probability).
- On the next run, bets older than their TTL are resolved from Kraken 1m candles: which of entry (touched?),
  TP, SL, or expiry came first; result in R multiples. Resolution is **pure** (`resolveBet(bet, candles)`),
  with a conservative tie rule (SL wins when TP and SL are in the same candle).
- Each report footer gets a rolling 7-day table: bets, entries filled, win rate, mean R, **calibration**
  (stated probability vs. realised frequency in buckets).
- No automatic prompt tuning. Reading the calibration table is the human feedback loop.

## 9. Configuration (`.env`)

`SPECULATION_ENABLED` (false), `SPECULATION_EVERY_MINUTES` (60), `ANTHROPIC_API_KEY`, `SPECULATION_MODEL`,
`SPECULATION_SYMBOLS` (default `BTC,ETH`, mapped to Kraken spot + Coinalyze perp + Kraken Futures),
`SPECULATION_MAX_BETS` (3), `SPECULATION_MAX_ENTRY_DEVIATION` (0.005), `SPECULATION_LANGUAGE` (en),
`SPECULATION_DAILY_BUDGET_USD` (cap like `X_DAILY_BUDGET_USD`, estimated from token usage, stored in
`.speculation-spend.json`; the run is skipped and the report says so when exceeded).

CLAUDE.md gets: the new files in the table, the env vars, and the tool in the MCP section.

## 10. Safety rules

- Output is advisory text. No code path from `speculation*` to `KrakenFuturesClient.sendOrder` or the bot.
- Every report starts with a speculation disclaimer; estimated data (heatmap) is always labelled ESTIMATE.
- The prompt treats X posts and brain text as **untrusted data**: they are quoted in a delimited block with an
  instruction that text inside is data, never instructions (prompt-injection guard). Unverified posts are
  tagged `unverified`.
- Logs never contain the API key; the LLM client redacts headers like the other clients do.

## 11. Implementation steps (each ends green: `npm run typecheck` + `npm run test:offline`)

1. `speculation-parse.ts` + `speculation-report.ts` + tests (pure; validation rules, tie cases, property test: no surviving bet violates the ordering/deviation rules, like `futures-risk.test.ts`).
2. `speculation-prompt.ts` + snapshot-style tests (sections present, ESTIMATE labels, untrusted block, stale-source listed under UNKNOWN).
3. `speculation-context.ts`: gather from existing clients/cache with per-source failure isolation (`Promise.allSettled`); tests with fakes.
4. `speculation-llm.ts` with fake `fetch` tests (retry on 429/5xx, no retry on 4xx, usage parsing).
5. `speculation.ts` orchestrator + budget guard + repair retry + daily index; tests with fake LLM.
6. Wire into `mcp-server.ts` (collector job aligned to the hour, `speculation_run` tool); extend `test-helpers`-based e2e to check the tool when the key is set (skipped otherwise).
7. `speculation-log.ts` + `resolveBet` + 7-day scorecard in the report footer.
8. Update CLAUDE.md; one dry run with a real key; read 24 consecutive reports before trusting anything.

## 12. Open questions for the user

1. Generator: API from the server (assumed) or a Claude Code routine?
2. Symbols beyond BTC/ETH (SOL, XRP)? More symbols means a longer prompt and more cost.
3. Should open futures positions go into the prompt? It makes bets position-aware but biases the model toward the current holding.
4. Report language: English (project rule) or Polish prose?
5. Reports into the vault `output/speculation/` as planned, or a separate top-level vault folder?

## 13. Known limits (stated up front)

An LLM does not "predict" price. It produces a coherent, probability-flavoured story from the inputs. Edge, if
any, comes from structuring the facts well and from fast context synthesis, not from the model foreseeing
anything. The scorecard in section 8 is how we find out whether that is worth keeping; if calibration is
flat after ~2 weeks, the honest outcome is to drop the mode.
