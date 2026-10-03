# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCP server that exposes market data to Claude: crypto derivatives (Coinalyze, Coinglass), indices, currencies and stocks (Yahoo Finance), and Kraken spot market data. It also serves a "second brain" knowledge base fed with posts from curated X accounts about the Middle East. The brain lives outside this repo, in the user's Obsidian vault `C:\Users\mtchorze\OneDrive\Documents\pierdoly` (`BRAIN_DIR`); the vault's other folders are the user's own notes and not part of the brain. The Kraken client is also the intended base for a future trading bot. There is no lint setup. **All code, comments, logs and error messages are in English**, even though the user chats in Polish.

| File | What it is |
|---|---|
| [coinalyze-client.ts](coinalyze-client.ts) | Free Coinalyze API (`https://api.coinalyze.net/v1`; OpenAPI spec at `/v1/doc/api-spec.json`). Needs `COINALYZE_API_KEY`. |
| [coinglass-client.ts](coinglass-client.ts) | Coinglass Open API v4. The account's plan has no API access ("Upgrade plan"); its key is commented out in `.env`. |
| [yahoo-client.ts](yahoo-client.ts) | Unofficial Yahoo Finance API, no key. Uses `/v8/finance/chart` for both history and quotes, because `/v7/finance/quote` needs a cookie crumb (401). |
| [x-client.ts](x-client.ts) | X API v2, read-only (recent search, user lookup). Needs `X_BEARER_TOKEN`. |
| [x-sync.ts](x-sync.ts) | Pulls new posts of the accounts in `<BRAIN_DIR>/x-accounts.json` into `<BRAIN_DIR>/raw/x/`; reads the archive back. |
| [brain.ts](brain.ts) | Path-safe file access to the brain root (`BRAIN_DIR`) (list, read, search, write to `wiki/`/`output/` only, write-once to `raw/`). |
| [kraken-client.ts](kraken-client.ts) | Kraken spot REST: public market data plus signed private account/trading calls. |
| [kraken-futures-client.ts](kraken-futures-client.ts) | Kraken Futures (derivatives) REST: a separate exchange with its own keys. Market data, account, positions and trading for the planned bot. Not exposed through MCP yet. |
| [futures-risk.ts](futures-risk.ts) | Pure pre-trade risk check for the futures bot: caps per-symbol and total exposure, leverage, open positions, order size and rate, and daily loss. |
| [futures-pnl.ts](futures-pnl.ts), [trade-store.ts](trade-store.ts) | Realized PnL statistics for Kraken Futures: fills are synced into SQLite (`futures_fills`), turned into closed trades by average-cost netting (`futures_trades`) and summarized. Gross of fees and funding; linear contracts (PF_/FF_) only. |
| [liquidation-heatmap.ts](liquidation-heatmap.ts) | Pure model that ESTIMATES a liquidation heatmap from price bars, open interest and the long/short ratio (OI-delta cohorts over assumed leverage tiers; model OI follows real OI). Behind `coinalyze_liquidation_heatmap_estimate`. Not measured data. |
| [bot/](bot/) | The Kraken Futures trading bot's deterministic core (state machine, sizing, simulated exchange, watchdog, reconciliation, property tests). **Cannot place real orders yet.** `npm run test:bot`. Architecture: [docs/bot-architecture.md](docs/bot-architecture.md). Status, deviations from the spec and unverified assumptions: [docs/superpowers/2026-10-03-trader-core-status.md](docs/superpowers/2026-10-03-trader-core-status.md). |
| [http-utils.ts](http-utils.ts) | Shared by all clients: `RequestQueue` (serialize + weighted spacing), `withRetry`, `TtlCache`. |
| [history-store.ts](history-store.ts) | SQLite (`node:sqlite`) store of series points plus coverage ranges. |
| [series-cache.ts](series-cache.ts) | Provider-independent read-through history cache on top of `HistoryStore`. |
| [collector.ts](collector.ts) | Optional background jobs that keep filling the cache. |
| [logger.ts](logger.ts) | Leveled logger; every module uses `createLogger(scope)`. |
| [mcp-server.ts](mcp-server.ts) | MCP server over Streamable HTTP at `http://127.0.0.1:3000/mcp`. |

## Commands

- **Start the server:** `npm start` (runs `node --env-file-if-exists=.env mcp-server.ts`).
- **All tests:** `npm test`.
- **Offline tests only:** `npm run test:offline`. These are [coinalyze-cache.test.ts](coinalyze-cache.test.ts), [yahoo-client.test.ts](yahoo-client.test.ts), [kraken-client.test.ts](kraken-client.test.ts), [kraken-futures-client.test.ts](kraken-futures-client.test.ts), [futures-risk.test.ts](futures-risk.test.ts) (with a randomized check that no allowed order breaks a cap), [futures-pnl.test.ts](futures-pnl.test.ts), [liquidation-heatmap.test.ts](liquidation-heatmap.test.ts) and [x-sync.test.ts](x-sync.test.ts). They stub `fetch` with fake APIs and need no keys or network.
- **End-to-end tests against the real APIs:** `npm run test:coinalyze`, `npm run test:yahoo`, `npm run test:kraken`, `npm run test:x` or `npm run test:coinglass`.
  - `test:x` always tests the brain tools (temporary `BRAIN_DIR`); its X part runs only with `X_BEARER_TOKEN` and syncs at most 10 posts per query from the last hour.
  - Each spawns `mcp-server.ts` on a free port through [test-helpers.ts](test-helpers.ts), checks auth and `tools/list`, calls every tool and validates the data shape.
  - A suite is skipped when its provider is not configured.
  - They use real API quota and are slow because of throttling.
- **Run a single test:** `node --env-file-if-exists=.env --test --test-name-pattern="liquidation" coinalyze.test.ts`.
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
- `BRAIN_DIR`: the brain root, set to the Obsidian vault `pierdoly`. The fallback `brain/` next to the source files is gitignored.
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
  - `kraken_futures_*` (registered only with `KRAKEN_FUTURES_RO_API_KEY`/`_SECRET`; `KRAKEN_FUTURES_ENABLED=false` turns them off): `positions` (open positions + margin account), `open_orders`, `fills` and `pnl`. The last two first sync new fills into the local DB (`CACHE_DB_PATH`), so history goes past the API's 100-fill window. The MCP client never has `tradingEnabled`.
  - `x_*`: `sync` (fetch new posts into `brain/raw/x/`) and `accounts` (curated list + live profiles); `x_recent` reads the local archive and works without a token.
  - `brain_*`: `list`, `read`, `search`, `write`. Always registered, so Claude Desktop can run the brain workflow. `raw/` is never writable through MCP.
- **Future plan** (not started): server-side processing of data before tools return it. Keep raw points in the cache and put processing in a separate layer between the cache and tool output.

## History cache (the key design)

`cachedSeries()` in `series-cache.ts` is used by Coinalyze and Yahoo.

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
