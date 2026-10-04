# krypto-kal

MCP server that gives Claude market data (Coinalyze, Coinglass, Yahoo Finance, Kraken spot and futures), a "second
brain" knowledge base fed from curated X accounts, the deterministic core of a Kraken Futures trading bot (cannot
place real orders yet), and a supervised speculation mode.

## Layout

| Path | What is there |
|---|---|
| [src/server/](src/server/) | `mcp-server.ts` (entry point, every MCP tool) and the background collector |
| [src/core/](src/core/) | shared infrastructure: HTTP pipeline (queue, retry, cache), logger, SQLite history cache |
| [src/providers/](src/providers/) | one folder per data source: `coinalyze/`, `coinglass/`, `yahoo/`, `kraken/` (spot + futures), `x/` |
| [src/brain/](src/brain/) | vault file access for the second brain, and the X-to-brain sync |
| [src/analytics/](src/analytics/) | pure models on market data (estimated liquidation heatmap) |
| [src/trading/](src/trading/) | Kraken Futures pre-trade risk check, PnL statistics, fill store |
| [src/bot/](src/bot/) | trading bot core: state machine, sizing, simulation, watchdog, reconciliation |
| [src/speculation/](src/speculation/) | speculation mode: bet checker, sessions, symbol screen, volume profile, scorer |
| [test/e2e/](test/e2e/) | end-to-end tests that start the server and call the real APIs |
| [docs/](docs/) | [bot architecture](docs/bot-architecture.md), [speculation guide](docs/speculation-guide.md), plans and specs |
| [.claude/skills/](.claude/skills/) | project skills: `brain-ingest`, `speculate`, `speculation-score` |

Unit tests live next to the code they test (`*.test.ts`).

## Commands

```
npm start                  # MCP server at http://127.0.0.1:3000/mcp (needs MCP_AUTH_TOKEN in .env)
npm run test:offline       # all unit tests, no network or keys
npm run test:e2e           # end-to-end tests against the real APIs (uses quota)
npm run typecheck
```

Requires Node >= 23.6 (runs `.ts` directly). Configuration, design notes and conventions: [CLAUDE.md](CLAUDE.md).
