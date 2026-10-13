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

## Starting the bot (dry-run)

The bot never places a real order: the exchange is simulated on real public prices. Start it in this order, each
step in its own PowerShell terminal in the repo directory.

**1. Check `.env`.** `BRAIN_DIR` (alerts and reports go into the vault). For the automatic speculation flow also
`MCP_AUTH_TOKEN`, `COINALYZE_API_KEY` and the read-only `KRAKEN_FUTURES_RO_API_KEY` / `_SECRET`. The bot itself needs
no keys.

**2. Pick the config.** Without `--config` the bot uses its defaults (a policy lives at most 60 minutes). For policies
from the 2-hour speculation reports use `config/bot.auto.json` (it raises `max_policy_ttl_min` to 120). Set it once
for the terminal, so every bot command below sees the same config and database:

```powershell
$env:BOT_CONFIG = 'config/bot.auto.json'
```

**3. Terminal 1, the MCP server** (needed for the speculation reports and the `bot_status` tool, not by the bot itself):

```powershell
npm start
```

**4. Terminal 2, the bot** (trader and watchdog, one launcher):

```powershell
npm run bot -- run
```

Run **one** launcher only. The bot has no single-instance lock, so a second one (for example by hand while the
scheduled `bot` task from `scripts/install-tasks.ps1` is already running) trades the same simulated account twice.
Ctrl+C stops the trader and the watchdog together; the next start replays the minutes it was down.

**5. Terminal 3, check that it is up:**

```powershell
npm run bot -- status
```

The trader log shows `reconciled: entries allowed`, and `status` shows the state, no halt and no position. Until it
is reconciled the bot opens nothing. A halt is cleared with `npm run bot -- ack-halt`.

**6. Give it something to trade.** The bot acts only on policies, and only once 2 agreeing copies exist.

- *Automatically*, from the speculation reports: `npm run auto -- tick` once to try it, then
  `powershell -File scripts/install-tasks.ps1` to run it every 2 hours (see the
  [speculation guide](docs/speculation-guide.md)).
- *By hand*: `npm run bot -- policy template long > policy.json`, then `npm run bot -- policy add policy.json` twice.
- *From one report*: `npm run bot -- policy from-speculation <meta.json> --dry`, then again without `--dry`.

**7. Watch it:** `npm run bot -- status`, `npm run bot -- report`, and `output/bot/alerts.md` in the vault. Incident
kinds and what to do about them: [docs/bot-testing.md](docs/bot-testing.md).
