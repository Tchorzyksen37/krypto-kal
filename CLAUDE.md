# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCP server that exposes market data to Claude: crypto derivatives (Coinalyze, Coinglass), indices, currencies and stocks (Yahoo Finance), and Kraken spot market data. The Kraken client is also the intended base for a future trading bot. There is no lint setup. **All code, comments, logs and error messages are in English**, even though the user chats in Polish.

| File | What it is |
|---|---|
| [coinalyze-client.ts](coinalyze-client.ts) | Free Coinalyze API (`https://api.coinalyze.net/v1`; OpenAPI spec at `/v1/doc/api-spec.json`). Needs `COINALYZE_API_KEY`. |
| [coinglass-client.ts](coinglass-client.ts) | Coinglass Open API v4. The account's plan has no API access ("Upgrade plan"); its key is commented out in `.env`. |
| [yahoo-client.ts](yahoo-client.ts) | Unofficial Yahoo Finance API, no key. Uses `/v8/finance/chart` for both history and quotes, because `/v7/finance/quote` needs a cookie crumb (401). |
| [kraken-client.ts](kraken-client.ts) | Kraken spot REST: public market data plus signed private account/trading calls. |
| [http-utils.ts](http-utils.ts) | Shared by all clients: `RequestQueue` (serialize + weighted spacing), `withRetry`, `TtlCache`. |
| [history-store.ts](history-store.ts) | SQLite (`node:sqlite`) store of series points plus coverage ranges. |
| [series-cache.ts](series-cache.ts) | Provider-independent read-through history cache on top of `HistoryStore`. |
| [collector.ts](collector.ts) | Optional background jobs that keep filling the cache. |
| [logger.ts](logger.ts) | Leveled logger; every module uses `createLogger(scope)`. |
| [mcp-server.ts](mcp-server.ts) | MCP server over Streamable HTTP at `http://127.0.0.1:3000/mcp`. |

## Commands

- **Start the server:** `npm start` (runs `node --env-file-if-exists=.env mcp-server.ts`).
- **All tests:** `npm test`.
- **Offline tests only:** `npm run test:offline`. These are [coinalyze-cache.test.ts](coinalyze-cache.test.ts), [yahoo-client.test.ts](yahoo-client.test.ts) and [kraken-client.test.ts](kraken-client.test.ts). They stub `fetch` with fake APIs and need no keys or network.
- **End-to-end tests against the real APIs:** `npm run test:coinalyze`, `npm run test:yahoo`, `npm run test:kraken` or `npm run test:coinglass`.
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

**Optional:**
- `PORT`, `HOST`.
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
- **Coinglass:**
  - The key goes in the `CG-API-KEY` header, with requests spaced 800 ms apart.
  - Responses are an envelope `{ code, msg, data }`, and `code !== "0"` is an error even with HTTP 200. Errors are `CoinglassError`.
  - Response types have never been checked against real data.
  - `code 401 "Upgrade plan"` means the plan doesn't cover the endpoint.
