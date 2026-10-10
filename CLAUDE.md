# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCP server that exposes market data to Claude: crypto derivatives (Coinalyze, Coinglass), indices, currencies and stocks (Yahoo Finance), and Kraken spot market data. It also serves a "second brain" knowledge base fed with posts from curated X accounts about the Middle East. The brain lives outside this repo, in the user's Obsidian vault `C:\Users\mtchorze\OneDrive\Documents\pierdoly` (`BRAIN_DIR`); the vault's other folders are the user's own notes and not part of the brain. The Kraken client is also the intended base for a future trading bot. There is no lint setup. **All code, comments, logs and error messages are in English**, even though the user chats in Polish.

Source lives in `src/`, grouped by module; unit tests sit next to the code (`*.test.ts`), end-to-end tests in
`test/e2e/`. Imports between modules are relative with the `.ts` extension.

```
src/
  server/       MCP server entry point and background collector
  core/         shared infrastructure: HTTP pipeline, logger, SQLite history cache
  providers/    one folder per data source: coinalyze, coinglass, yahoo, kraken (spot + futures), x
  brain/        the second brain (vault file access) and the X-to-brain sync
  analytics/    pure models on top of market data
  trading/      Kraken Futures risk check, PnL statistics and the fill store
  bot/          the trading bot's deterministic core
  speculation/  speculation mode support code (checker, sessions, screen, volume, scorer)
test/e2e/       end-to-end tests against the real APIs (spawn the server)
docs/           architecture notes, guides, plans
.claude/skills/ project skills (one job each, see Skills below)
```

| Module | File | What it is |
|---|---|---|
| server | [mcp-server.ts](src/server/mcp-server.ts) | MCP server over Streamable HTTP at `http://127.0.0.1:3000/mcp`. |
| server | [collector.ts](src/server/collector.ts) | Optional background jobs that keep filling the cache. |
| core | [http-utils.ts](src/core/http-utils.ts) | Shared by all clients: `RequestQueue` (serialize + weighted spacing), `withRetry`, `TtlCache`. |
| core | [logger.ts](src/core/logger.ts) | Leveled logger; every module uses `createLogger(scope)`. |
| core | [history-store.ts](src/core/history-store.ts) | SQLite (`node:sqlite`) store of series points plus coverage ranges. |
| core | [series-cache.ts](src/core/series-cache.ts) | Provider-independent read-through history cache on top of `HistoryStore`. |
| providers | [coinalyze-client.ts](src/providers/coinalyze/coinalyze-client.ts) | Free Coinalyze API (`https://api.coinalyze.net/v1`; OpenAPI spec at `/v1/doc/api-spec.json`). Needs `COINALYZE_API_KEY`. |
| providers | [coinglass-client.ts](src/providers/coinglass/coinglass-client.ts) | Coinglass Open API v4. The account's plan has no API access ("Upgrade plan"); its key is commented out in `.env`. |
| providers | [yahoo-client.ts](src/providers/yahoo/yahoo-client.ts) | Unofficial Yahoo Finance API, no key. Uses `/v8/finance/chart` for both history and quotes, because `/v7/finance/quote` needs a cookie crumb (401). |
| providers | [kraken-client.ts](src/providers/kraken/kraken-client.ts) | Kraken spot REST: public market data plus signed private account/trading calls. |
| providers | [kraken-futures-client.ts](src/providers/kraken/kraken-futures-client.ts) | Kraken Futures (derivatives) REST: a separate exchange with its own keys. Market data, account, positions and trading for the planned bot. Not exposed through MCP yet. |
| providers | [x-client.ts](src/providers/x/x-client.ts) | X API v2, read-only (recent search, user lookup). Needs `X_BEARER_TOKEN`. |
| brain | [brain.ts](src/brain/brain.ts) | Path-safe file access to the brain root (`BRAIN_DIR`) (list, read, search, write to `wiki/`/`output/` only, write-once to `raw/`). |
| brain | [x-sync.ts](src/brain/x-sync.ts) | Pulls new posts of the accounts in `<BRAIN_DIR>/x-accounts.json` into `<BRAIN_DIR>/raw/x/` (highest-weight accounts first); reads the archive back. |
| brain | [triage.ts](src/brain/triage.ts) | Ranks raw X posts not yet ingested by likely market impact (account weight and wiki reliability, market-moving terms, kind, engagement), groups them into corroborated events, flags noise and stale posts, and keeps `<BRAIN_DIR>/.ingest-state.json`. Behind the MCP tools `brain_triage` and `brain_ingest_mark`. |
| analytics | [liquidation-heatmap.ts](src/analytics/liquidation-heatmap.ts) | Pure model that ESTIMATES a liquidation heatmap from price bars, open interest and the long/short ratio (OI-delta cohorts over assumed leverage tiers; model OI follows real OI). Behind `coinalyze_liquidation_heatmap_estimate`. Not measured data. |
| trading | [futures-risk.ts](src/trading/futures-risk.ts) | Pure pre-trade risk check for the futures bot: caps per-symbol and total exposure, leverage, open positions, order size and rate, and daily loss. |
| trading | [futures-pnl.ts](src/trading/futures-pnl.ts), [trade-store.ts](src/trading/trade-store.ts) | Realized PnL statistics for Kraken Futures: fills are synced into SQLite (`futures_fills`, with order id and maker/taker type; older databases are migrated on open), turned into closed trades by average-cost netting (`futures_trades`) and summarized. Gross of fees and funding; linear contracts (PF_/FF_) only. |
| bot | [src/bot/](src/bot/) | The Kraken Futures trading bot (state machine, sizing, simulated exchange, watchdog, reconciliation, property tests) and its dry-run launcher: `npm run bot -- run` (trader + watchdog processes on real public market data), `policy template/add/from-speculation`, `status`, `report`, `ack-halt`; `policy from-speculation <meta.json>` (`from-speculation.ts`, skill `speculation-to-bot`) turns the best checked speculation bet on the bot's symbol into a policy that trades only inside the bet's window (`not_before` = window start, `valid_until` = fill-by, horizon = hold time); alerts and daily reports go to `<BRAIN_DIR>/output/bot/`. **Cannot place real orders** (`LiveExecutor` always throws, guard tests). `npm run test:bot`. Testing guide: [docs/bot-testing.md](docs/bot-testing.md). Architecture: [docs/bot-architecture.md](docs/bot-architecture.md). Status, deviations from the spec and unverified assumptions: [docs/superpowers/2026-10-03-trader-core-status.md](docs/superpowers/2026-10-03-trader-core-status.md). |
| speculation | [src/speculation/](src/speculation/) | Speculation mode (four session reports a day: "most probable continuation" with an explicit LONG/SHORT/NEUTRAL bias, written by the `speculate` skill into `<BRAIN_DIR>/output/speculation/`). Code is deterministic support only: `context.ts` + `market.ts` (the measured KNOWN layer behind the MCP tool `speculation_context`: futures prices, ATR, spread, depth, funding, Coinalyze OI/long-short/liquidations, the screen and the multi-exchange volume share), `check.ts` (re-measures last price and ATR on Kraken Futures, validates bets, rewrites the report's Best bets block, appends `bets-log.json` and `reports-log.json`), `screen.ts` (symbol screening), `sessions.ts` (the four sessions with regions, investor profiles and bet limits; DST-aware), `volume.ts` (measured volume share per session), `seasonality.ts` (opening-hour range, direction and first-15-minute continuation after the Tokyo, Europe and US opens from 15m futures candles, DST-aware) and `positioning.ts` (UTC hours where open interest is built or unwound, and what follows a sharp 1h move: OI, giveback, range and volume decay), both exposed by `speculation_context` as base rates from a short sample (cached 6 h), `drivers.ts` (scores the macro drivers of each finished report: Nasdaq, US 10y, dollar index and oil from Yahoo 15m bars, did they do what the report's `drivers` view expected, alignment with BTC's session move, one-factor beta and R², headline call vs Nasdaq, realized altcoin betas vs the reports' `betas`; stored as `driverOutcome` in `reports-log.json` and rendered in the scorecard) and `score.ts` (matches Kraken Futures fills to bets, resolves outcomes from futures 1m candles with maker/taker fees per leg, calibration on take-profit hits against the chance baseline `1/(1+RR)` with Brier skill and 95% intervals, bias scoring on the session move, per-session/per-bias tables), `fetch.ts` (the scorer fetches futures candles and syncs fills itself). Advisory text only, no order placement. `npm run test:speculation`. Plan: [docs/superpowers/plans/2026-10-03-speculation-mode.md](docs/superpowers/plans/2026-10-03-speculation-mode.md). User guide: [docs/speculation-guide.md](docs/speculation-guide.md). |

## Skills

Each skill answers one question; when a request belongs to another skill, say so instead of doing its job. Shared
rules live in one place and the others link to them: the macro calendar in
`crypto-market-sentiment/references/macro-checklist.md` (section 4), the squeeze score and the price/OI quadrant in
`crypto-market-sentiment/references/derivatives-playbook.md` (sections 3 and 5), and the post-vs-price timing in
`social-check-before-trade/references/market-alignment.md`. Sessions everywhere are the four of `src/speculation/sessions.ts`.

| Skill | Question it answers | Horizon | Writes |
|---|---|---|---|
| `speculate` | Where does the next session go, and which bets? (bias, scenarios, checked bets) | one session | `output/speculation/` |
| `crypto-market-sentiment` | What is the market regime? (macro, derivatives phase, squeeze risk, range) | days | chat; `output/sentiment/` on request |
| `position-review` | What about the position I hold? (protection, R, liquidation, scenarios, plan) | the position's | `output/positions/` |
| `social-check-before-trade` | Is this news true, and is it already priced in? | hours | chat only |
| `brain-ingest` | Update the second brain from X (raw -> wiki -> briefing) | since the last run | `wiki/`, `output/` (the only wiki writer) |
| `speculation-score` | How did the bets and biases do? | history | `output/speculation/` scorecards |
| `speculation-to-bot` | Let the dry-run bot trade a bet inside its window | one bet | bot policies (via the CLI) |

## Commands

- **Start the server:** `npm start` (runs `node --env-file-if-exists=.env src/server/mcp-server.ts`).
- **Bot (dry-run):** `npm run bot -- <command>` (`src/bot/cli.ts`; no command prints the list). Config file via `--config` or `BOT_CONFIG`.
- **All tests:** `npm test`.
- **Offline tests only:** `npm run test:offline`: every `src/**/*.test.ts` (unit tests next to their modules, including the bot's and speculation's; `futures-risk.test.ts` has a randomized check that no allowed order breaks a cap). `npm run test:bot` and `npm run test:speculation` run one module. They stub `fetch` with fake APIs and need no keys or network.
- **End-to-end tests against the real APIs** (`test/e2e/`; all of them: `npm run test:e2e`): `npm run test:coinalyze`, `npm run test:yahoo`, `npm run test:kraken`, `npm run test:x` or `npm run test:coinglass`.
  - `test:x` always tests the brain tools (temporary `BRAIN_DIR`, seeded with `x-accounts.json` from the real `BRAIN_DIR`); its X part runs only with `X_BEARER_TOKEN` and syncs at most 10 posts per query from the last hour.
  - Each spawns `src/server/mcp-server.ts` on a free port through [test-helpers.ts](test/e2e/test-helpers.ts), checks auth and `tools/list`, calls every tool and validates the data shape.
  - A suite is skipped when its provider is not configured.
  - They use real API quota and are slow because of throttling.
- **Run a single test:** `node --env-file-if-exists=.env --test --test-name-pattern="liquidation" test/e2e/coinalyze.test.ts`.
- **Type-check:** `npm run typecheck`. **Build** to `dist/`: `npm run build`.

## Configuration (`.env`)

**Required:** `MCP_AUTH_TOKEN`.

**Providers:**
- Coinalyze and Coinglass are enabled by their keys.
- Yahoo and Kraken are on by default; `YAHOO_ENABLED=false` or `KRAKEN_ENABLED=false` turns them off.
- Kraken account tools also need `KRAKEN_API_KEY` and `KRAKEN_API_SECRET`.
- Kraken Futures read-only tools need `KRAKEN_FUTURES_RO_API_KEY` and `KRAKEN_FUTURES_RO_API_SECRET` (a read-only key pair for the futures exchange, different from spot). `KrakenFuturesClient` itself defaults to `KRAKEN_FUTURES_API_KEY`/`_SECRET`, reserved for the future trading bot's keys.
- X is enabled by `X_BEARER_TOKEN`. `X_COLLECT=true` turns on the background sync every `X_SYNC_EVERY_MINUTES` (30); `X_BACKFILL_HOURS` (24), `X_MAX_POSTS_PER_QUERY` (200) and `X_REQUIRE_VERIFIED` (true) tune it. Spend caps: `X_DAILY_BUDGET_USD` (default 1) and `X_TOTAL_BUDGET_USD` (default none).

**Optional:**
- `PORT`, `HOST`.
- `BRAIN_DIR`: the brain root, set to the Obsidian vault `pierdoly`. The fallback `brain/` in the repo root is gitignored.
- Speculation mode (all optional): `SPECULATION_SYMBOLS` (core, `BTC,ETH,XRP`), `SPECULATION_SCREEN_EXTRA` (3), `SPECULATION_MIN_VOLUME_USD`, `SPECULATION_MIN_DEPTH_USD`, `SPECULATION_MAX_BETS` (3), `SPECULATION_MAX_ENTRY_DEVIATION` (0.005), `SPECULATION_FEE_BPS` (5, taker fee the checker assumes for both legs), `SPECULATION_MAKER_FEE_BPS` (2) / `SPECULATION_TAKER_FEE_BPS` (5) (scoring), `SPECULATION_MATCH_TOLERANCE` (0.003), `SPECULATION_TZ` (Europe/Warsaw), `SPECULATION_LEAD_MINUTES` (20), `SPECULATION_VERIFY` (true; `false` stops the checker from re-measuring prices).
- `BOT_CONFIG`: path of the bot's JSON config (merged over its defaults; `cycle_interval_sec`, `db_path` default `~/.krypto-kal/bot.db`, ...). Used by `npm run bot` and `bot_status`.
- `LOG_LEVEL`: `debug`, `info` (default), `warn` or `error`.
- `CACHE_DB_PATH`: default `~/.krypto-kal/cache.db`, deliberately outside OneDrive because sync can lock SQLite files.
- Collector (runs only when at least one symbol list is set):
  - Coinalyze: `COLLECT_SYMBOLS`, `COLLECT_INTERVALS`.
  - Yahoo: `YAHOO_COLLECT_SYMBOLS`, `YAHOO_COLLECT_INTERVALS`.
  - Both: `COLLECT_EVERY_MINUTES`.

**Auth:** every `/mcp` request needs `Authorization: Bearer <MCP_AUTH_TOKEN>`, otherwise the server answers 401. Claude Desktop connects through `mcp-remote` (the `krypto-kal` entry in `claude_desktop_config.json`), and the token there must match `.env`.

## TypeScript / runtime setup

- ESM (`"type": "module"`). Node >= 23.6 runs `.ts` files directly by stripping types; there is no build step for running.
- Because of that, `tsconfig.json` sets `erasableSyntaxOnly`. Don't use syntax that needs transformation: constructor parameter properties, `enum`, `namespace`.
- Relative imports use the `.ts` extension; `rewriteRelativeImportExtensions` rewrites them for the build.
- `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- `exactOptionalPropertyTypes` is deliberately off because the MCP SDK's types don't compile with it.
- In PowerShell, avoid a variable named `rd` in inline scripts: the tool's safety check treats it as the `Remove-Item` alias. Write longer probe scripts to a file instead.

## MCP server

- **Stateless:** each HTTP request gets a new `McpServer` and transport. There is one client per provider and one `HistoryStore` for the whole process, so caches and throttles are shared.
- **`toResult(tool, args, fn)`:** wraps every tool. It logs the outcome with its duration and turns errors into `isError: true` results.
- **`timeRange(intervalSeconds, {limit, from, to}, gapFactor)`:** converts `limit` into `from`/`to`.
  - Coinalyze: `limit` = number of intervals back.
  - Yahoo: `limit` = number of most recent **bars**. Markets pause overnight and on weekends, so it fetches `limit × interval × YAHOO_GAP_FACTOR` of calendar time and keeps the last `limit` bars.
- **Tool families:**
  - `coinalyze_*`: symbols like `BTCUSDT_PERP.A`, found with `coinalyze_future_markets`. `aggregate: true` sums OI or liquidations across symbols in USD.
  - `yahoo_*`: `search`, `quote`, `history`.
  - `kraken_*`: `ticker`, `ohlc`, `order_book`, `system_status`, plus read-only `balance` and `open_orders` when keys are set. **Kraken trading is never exposed as an MCP tool.**
  - `speculation_context`: the measured inputs of a speculation report in one call (registered whenever Kraken Futures is enabled; uses Coinalyze when its key is set). Takes up to about a minute.
  - `speculation_score`: scores the bets and biases in `<BRAIN_DIR>/output/speculation` (same fill sync and store as `kraken_futures_fills`; without the read-only keys only hypothetical outcomes) and writes the scorecard.
  - `kraken_futures_candles`: public trade-price candles of a futures contract (no keys; registered whenever Kraken Futures is enabled). Use it, not spot `kraken_ohlc`, for PF_ prices and older ranges.
  - `kraken_futures_*` account tools (registered only with `KRAKEN_FUTURES_RO_API_KEY`/`_SECRET`; `KRAKEN_FUTURES_ENABLED=false` turns them off): `positions` (open positions + margin account), `open_orders`, `fills` and `pnl`. The last two first sync new fills into the local DB (`CACHE_DB_PATH`), so history goes past the API's 100-fill window. The MCP client never has `tradingEnabled`.
  - `x_*`: `sync` (fetch new posts into `brain/raw/x/`) and `accounts` (curated list + live profiles); `x_recent` reads the local archive and works without a token.
  - `bot_status`: read-only view of the bot's SQLite file (state, halt, simulated position and account, incidents, decisions, report). Always registered; says so when the bot has not run.
  - `brain_*`: `list`, `read`, `search`, `write`, plus `triage` (what to ingest next, by impact) and `ingest_mark` (record ingested/skipped posts). Always registered, so Claude Desktop can run the brain workflow. `raw/` is never writable through MCP.
- **Future plan** (not started): server-side processing of data before tools return it. Keep raw points in the cache and put processing in a separate layer between the cache and tool output.

## History cache (the key design)

`cachedSeries()` in `series-cache.ts` is used by Coinalyze and Yahoo. Schemas of all SQLite files and vault state files, and who accesses them: [docs/database-design.md](docs/database-design.md) (PlantUML diagrams in `docs/diagrams/`).

- **Coverage:** `HistoryStore` keeps `points`, keyed by (kind, symbol, interval, t), and `coverage`, the merged time ranges known to be complete. `kind` separates providers and variants: Coinalyze uses the endpoint path plus `:usd` when `convert_to_usd` is on, and Yahoo uses `yahoo-chart`.
- **Closed vs. open:** points with `t <= closedUntil` are final and come from the store. Only ranges missing from coverage are fetched and saved, and symbols missing the same range share one fetch. The open tail after `closedUntil` is always fetched live and never stored.
  - Coinalyze bars are epoch-aligned, so `closedUntil` is the start of the current interval, minus `settleSeconds` (300 s), minus 1.
  - Yahoo bars are **not** aligned (stock bars start at the session open, e.g. 13:30 UTC), so `closedUntil = now − settle − interval`.
- **Call savings:**
  - A gap that reaches the tail is fetched together with the tail in one request.
  - With `alignSeconds` (Coinalyze only), gaps that can't contain an interval start are marked covered for free.
  - The tail's `to` is rounded to the end of the current interval, so its URL is stable and the in-memory cache can hit.
- **Yahoo specifics:**
  - Prices are split-adjusted, not dividend-adjusted. `adjclose` is **not** stored, because it changes retroactively after every dividend.
  - If a fetched response carries a split dated after bars already cached for that symbol, all of the symbol's series are deleted and re-fetched.
  - `from` is clamped to Yahoo's lookback: 1m 30 days, 5m–30m 60 days, 1h 730 days.
  - 1m ranges are split into requests of at most 7 days.
- **Collector:** its jobs request the full available window of closed intervals. Once the cache is warm, each run fetches only new intervals: Coinalyze 6 calls per symbol per interval, Yahoo 1 request per symbol per interval.

## Second brain (`BRAIN_DIR`)

`CLAUDE.md` in the brain root defines the knowledge base: `raw/` (untouched sources), `wiki/` (linked pages), `output/` (deliverables from the wiki only) and the five prompts (Interview, Ingest, Migrate, Query, Lint). Edit it when the workflow changes; the content of `wiki/` is maintained by those prompts.

- **Raw X posts:** one file per post, `raw/x/<YYYY-MM-DD UTC>/<username>-<id>.md`, YAML frontmatter (url, author, verified_type, category, kind, metrics, links) plus the full text (`note_tweet` for long posts) and the quoted post. Files are created with `wx` and never rewritten.
- **Queries:** `buildQueries` packs `from:` clauses into as few recent-search queries as fit 512 chars. Accounts with `filter: true` get the `topics` clause, so only matching posts are read (and billed). Retweets are excluded.
- **Cursors:** `<BRAIN_DIR>/.x-sync.json` keeps the newest post id per query string. A changed account list or topic list creates new queries, which start from `X_BACKFILL_HOURS`. A cursor older than ~7 days is replaced by `start_time`, because recent search rejects it.
- **Cost control:** pay-per-use bills every returned object ($0.005/post, $0.01/user, `X_PRICE`), including expansions. So the search requests **no expansions**: authors come from a profile cache (`<BRAIN_DIR>/.x-users.json`, refreshed weekly), and quoted/replied-to posts are stored as links only. Every read is charged against `<BRAIN_DIR>/.x-spend.json` (estimated USD per UTC day). A sync shrinks `max_results` to what the budget allows and stops before exceeding the daily or total cap; `x_sync` and `x_accounts` report the spend. Accounts with `"enabled": false` stay on the list but are not queried.
- **Impact:** accounts may set `weight` (0–3) in `x-accounts.json`; otherwise their category decides (`CATEGORY_WEIGHT` in `x-sync.ts`). Queries run highest weight first. The ingest reads what `brain_triage` selects, not the oldest posts. The vault's own `CLAUDE.md` template is [docs/brain/CLAUDE.md](docs/brain/CLAUDE.md).
- **Verification:** posts of authors without `verified: true` are dropped by default. A badge is not a reliability rating; reliability lives in `wiki/sources/`.

## Clients

Adding an endpoint means:
1. adding a wrapper method to the client (and a response interface if needed),
2. adding a `registerTool` call in `mcp-server.ts`,
3. adding a test to that provider's offline and/or end-to-end test file.

All clients share this request pipeline: in-memory `TtlCache`, then `withRetry` (backoff on network errors, 429 and 5xx), then a throttle, then `fetch` with a timeout. Every API request is logged at `info`; cache and throttle details go to `debug`.

- **Coinalyze:**
  - The key goes in the `api_key` header.
  - The limit is 40 calls/min, and each symbol in a request counts as one call. After an N-symbol request the queue waits N × 1500 ms, and it honours `Retry-After` on 429.
  - `CoinalyzeError` (`http | network | parse`).
- **Yahoo:**
  - Sends a browser `User-Agent`, and requests are spaced 500 ms apart.
  - Batching isn't supported, so it makes one request per symbol.
  - Errors come as `chart.error.description`, e.g. 404 "No data found, symbol may be delisted" or 422 "1m data not available…". They become `YahooError` (`http | network | parse`).
- **Kraken:**
  - Responses are `{ error: [], result }`, and errors arrive with HTTP 200. They become `KrakenError`, with Kraken's codes in `errors`.
  - Public calls are spaced 1 s apart.
  - Private calls are signed: `API-Sign = base64(HMAC-SHA512(base64(secret), path + SHA256(nonce + body)))`. This is verified against the docs example in the offline test. The nonce is strictly increasing (µs).
  - Private calls go through `CounterLimiter`, which emulates Kraken's API counter (Starter tier: max 15, decay 0.33/s; history calls cost 2).
  - **Bot safety:** `addOrder` sends `validate=true` unless called with `{ validate: false }`. `addOrder`, `cancelOrder` and `cancelAll` are never retried. `cacheTtlMs` defaults to 0 (always fresh); the MCP server uses 5 s.
- **X:**
  - Bearer token in `Authorization`; requests spaced 1.1 s apart.
  - Errors are `{ title, detail }` or `errors[]` (partial errors come with HTTP 200 and are only logged). They become `XError` (`http | network | parse`).
  - On 429 the queue waits until `x-rate-limit-reset`; if that is more than 60 s away the call fails immediately with the reset time instead of blocking the tool.
  - Reads are billed per post, so there is no in-memory cache and every sync is incremental.
- **Kraken Futures:**
  - Base `https://futures.kraken.com`: REST under `/derivatives/api/v3`, candles under `/api/charts/v1/trade/{symbol}/{resolution}` (max 2000 per page, ms timestamps, string values), funding history at `/derivatives/api/v4/historicalfundingrates`.
  - The demo environment (`demo-futures.kraken.com`) was shut down on 2026-07-14. There is no sandbox; test with fakes, paper trading and tiny live orders.
  - Auth headers `APIKey`, `Nonce`, `Authent = base64(HMAC-SHA512(base64(secret), SHA256(postData + nonce + path)))`, where `path` has no `/derivatives` prefix and `postData` is the exact url-encoded query (GET) or body (POST). There is no official test vector; the offline test only checks the documented steps.
  - Errors: `{ result: "error", error: "authenticationError" }` (often HTTP 200) or `{ result: "error", errors: [{ message }] }`. A `sendorder` with `result: "success"` can still be rejected in `sendStatus.status`; that becomes `KrakenFuturesError` kind `rejected`.
  - Rate limit: a budget of 500 per 10 s (`CounterLimiter`, shared with spot in `http-utils.ts`); orders, edits and cancels cost 10, account reads 2.
  - The order book arrives with bids ascending; the client sorts both sides best-first.
  - **Bot safety:** `sendOrder`/`editOrder` throw unless the client is created with `tradingEnabled: true`, and are never retried. Cancels and `deadMansSwitch` are always allowed and retried.
  - The `/accounts` flex fields are typed from docs only and have not been checked against a real account.
- **Coinglass:**
  - The key goes in the `CG-API-KEY` header, with requests spaced 800 ms apart.
  - Responses are an envelope `{ code, msg, data }`, and `code !== "0"` is an error even with HTTP 200. Errors are `CoinglassError`.
  - Response types have never been checked against real data.
  - `code 401 "Upgrade plan"` means the plan doesn't cover the endpoint.
