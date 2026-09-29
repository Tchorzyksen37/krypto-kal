# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCP server that exposes crypto futures data (open interest, funding rate, liquidations and more) to Claude, backed by two providers. There is no lint setup. Code comments and error messages are written in Polish.

- [coinalyze-client.ts](coinalyze-client.ts): `CoinalyzeClient` for the free Coinalyze API (`https://api.coinalyze.net/v1`, docs at `/v1/doc/`, OpenAPI spec at `/v1/doc/api-spec.json`). This is the working provider.
- [coinglass-client.ts](coinglass-client.ts): `CoinglassClient` for Coinglass Open API v4. The current account's plan gives no API access, so every call returns "Upgrade plan".
- [mcp-server.ts](mcp-server.ts): an MCP server over Streamable HTTP at `http://127.0.0.1:3000/mcp`. Each provider's tools (`coinalyze_*` and `coinglass_*`) are registered only when its API key is set.

## Commands

- Start the MCP server: `npm start` (runs `node --env-file-if-exists=.env mcp-server.ts`)
- Tests: `npm test` runs both suites, or run one with `npm run test:coinalyze` or `npm run test:coinglass`. Each suite ([coinalyze.test.ts](coinalyze.test.ts), [coinglass.test.ts](coinglass.test.ts)) spawns its own `mcp-server.ts` on a free port through [test-helpers.ts](test-helpers.ts). It checks auth (401 without a valid token) and `tools/list`, then calls every tool against the **real** API and validates the data shape. A suite is skipped if its provider's key is missing. Tests use real API quota and are slow because of the throttle (about 1.5 s per Coinalyze call).
- Run a single test: `node --env-file-if-exists=.env --test --test-name-pattern="liquidation" coinalyze.test.ts`
- Type-check: `npm run typecheck`
- Build to `dist/`: `npm run build`
- Register with Claude Code: `claude mcp add --transport http krypto-kal http://127.0.0.1:3000/mcp`

Credentials are in `.env`: `MCP_AUTH_TOKEN`, at least one of `COINALYZE_API_KEY` or `COINGLASS_API_KEY`, and optionally `PORT` and `HOST`. The server throws at startup if the token is missing or if neither API key is set. Every `/mcp` request must send `Authorization: Bearer <MCP_AUTH_TOKEN>`, otherwise it gets 401.

Claude Desktop connects through `mcp-remote` (the `krypto-kal` entry in `claude_desktop_config.json`), which passes that header. The token there must match `.env`.

## TypeScript / runtime setup

- ESM (`"type": "module"`). Node >= 23.6 runs `.ts` files directly by stripping types, so there is no build step for running.
- Because of that, `tsconfig.json` sets `erasableSyntaxOnly`. Don't use syntax that needs transformation: constructor parameter properties, `enum`, or `namespace`.
- Relative imports use the `.ts` extension (`./coinglass-client.ts`). `rewriteRelativeImportExtensions` turns them into `.js` in the build.
- `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- `exactOptionalPropertyTypes` is deliberately off because the MCP SDK's types don't compile with it.

## MCP server

The server is stateless. Each HTTP request gets a new `McpServer` and transport (`sessionIdGenerator: undefined`), but there is one client per provider for the whole process, so the cache and throttle work across requests. Tool input schemas are zod shapes. `toResult` converts client errors into `isError: true` results instead of throwing. It binds to `127.0.0.1` by default and requires the Bearer token described above.

Coinalyze tools take Coinalyze symbols such as `BTCUSDT_PERP.A`, where the suffix is the exchange code; `coinalyze_future_markets` finds them. History tools accept `limit` (intervals back from `to`) and turn it into the API's `from`/`to` in UNIX seconds. `aggregate: true` on OI and liquidation history sums all given symbols per timestamp in USD (`n` = number of symbols with data at that timestamp); this is how cross-exchange totals are built.

## Clients

Adding an endpoint means adding a wrapper method to the client, a response interface if needed, a `registerTool` call in `mcp-server.ts`, and an entry in that provider's `*.test.ts`.

Both clients send every request through the same pipeline, in order:

1. **Cache**: an in-memory `Map` keyed by the full URL, with a TTL of `cacheTtlMs` (default 20s). It is checked before anything else, so cache hits skip throttling.
2. **Retry** (`withRetry`): exponential backoff (`2^attempt * 1s` + jitter), up to `maxRetries` times. It retries only `network` errors and HTTP 429/5xx.
3. **Throttle** (`throttled`): a promise-chain queue that serializes all requests and spaces them out. Every retry attempt goes back through the queue.
4. **Request**: `fetch` with the API key header and a timeout.

Differences between the two clients:

- **Coinalyze** sends the key in the `api_key` header. Its limit is 40 calls/min, and every symbol in a request counts as one call (max 20 per request). So after a request with N symbols, the throttle waits `N × msPerCall` (default 1500 ms). On 429 it honours `Retry-After`. Intraday history keeps only about 1500–2000 points; daily history is kept in full. The `exchanges` and `future-markets` lists are cached for 1 h. Errors are `CoinalyzeError` (`http | network | parse`).
- **Coinglass** sends the key in the `CG-API-KEY` header and waits a fixed `minIntervalMs` (800 ms). Responses come in an envelope `{ code, msg, data }`, and an HTTP 200 can still carry an error inside it, so `code !== "0"` is treated as a failure. Errors are `CoinglassError` (`http | api | network | parse`). Its response types are assumed and have never been checked against real data. Paths are hyphenated (`/api/futures/funding-rate/history`), and `code 401 "Upgrade plan"` means the plan doesn't cover the endpoint; it is not an auth bug.
