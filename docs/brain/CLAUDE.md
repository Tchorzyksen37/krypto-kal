# Second brain – geopolitics and crypto markets

A persistent, linked knowledge base. Raw sources go into `raw/`, the model keeps a linked wiki in
`wiki/`, and deliverables are built from the wiki into `output/`. Read this file before working
here. In Claude Desktop, use the `brain_*` MCP tools of the krypto-kal server (`brain_read`
`CLAUDE.md` first); in Claude Code, edit the files directly and follow the `brain-ingest` skill for ingests.

## Who I am

<!-- Filled by the Interview prompt. Keep it short and current. -->
- Trader of crypto derivatives (BTC, ETH, XRP, altcoins): perpetual futures, funding, open interest,
  liquidations. Chats in Polish.
- Watches US macro (Fed, CPI, payrolls, yields, dollar, oil) and, above all right now, the
  **Middle East**, which currently has the strongest impact on crypto prices.
- Market data comes from the krypto-kal MCP server (Coinalyze, Yahoo Finance, Kraken).

## What I'm building

<!-- Filled by the Interview prompt. -->
- A knowledge base that tracks the Middle East situation from verified X accounts and links events
  to market reactions (oil, yields, dollar, BTC/ETH, liquidations, funding).
- Later: a trading bot on Kraken that can use this knowledge as context.

## What already failed

<!-- Filled by the Interview prompt and by experience. One line per lesson, with a date. -->
- 2026-09: Coinglass API – the account's plan has no API access.
- 2026-10: Ingesting "the oldest new posts first" spent the reading budget on noise; ingest now reads by impact (`brain_triage`).

## Structure

| Folder / file | Purpose | Rules |
|---|---|---|
| `raw/` | Original sources. `raw/x/<YYYY-MM-DD>/<user>-<id>.md` = one X post (filled by `x_sync`). Other sources (articles, notes) go to `raw/<type>/`. | **Never edit or delete.** Untouched after they land. |
| `wiki/` | Evergreen knowledge written and linked by the model. | One source can touch 10–15 pages. Every claim cites its raw source. |
| `output/` | Reports, briefings, summaries. | Built **from the wiki only**, never directly from raw. |
| `x-accounts.json` | X accounts, their `weight` and topic keywords for `x_sync`. | Edit to add/remove sources; see "Sources" below. |
| `.ingest-state.json` | Raw posts already ingested or skipped (written by `brain_ingest_mark`). | Not edited by hand. |

### Wiki layout

- `wiki/index.md` – map of all pages, grouped by section (plus `Output` for briefings). Update it whenever a page is added.
- `wiki/log.md` – append-only log: every ingest, migration and lint run, newest at the top.
- `wiki/actors/` – countries, governments, militaries, groups (e.g. `iran.md`, `idf.md`, `houthis.md`).
- `wiki/people/` – leaders and officials whose statements move markets.
- `wiki/places/` – chokepoints and targets (e.g. `strait-of-hormuz.md`, `red-sea.md`).
- `wiki/events/` – one page per significant event: `YYYY-MM-DD-short-slug.md`, with a **Market impact** line.
- `wiki/themes/` – ongoing storylines (e.g. `iran-israel-conflict.md`, `oil-supply-risk.md`, `ceasefire-talks.md`).
- `wiki/markets/` – how events transmit to prices (e.g. `geopolitics-to-crypto.md`, `oil.md`, `btc.md`), with observed reactions.
- `wiki/sources/` – one page per source account (slug = lowercase username): reliability, bias, track record.
- `wiki/timeline.md` – dated one-line entries linking to event pages, newest at the top.

### Page format

```markdown
---
title: Strait of Hormuz
type: place            # actor | person | place | event | theme | market | source
updated: 2026-10-01
sources: [raw/x/2026-10-01/Reuters-1234.md]
---

Short summary (2–4 sentences) of what matters now.

## Facts
- Claim. ([Reuters](../../raw/x/2026-10-01/Reuters-1234.md), 2026-10-01) – confidence: confirmed

## Open questions / contradictions
- ...

## Related
[[iran]] · [[oil-supply-risk]] · [[2026-09-30-tanker-seized]]
```

- Links use `[[page-slug]]` (file name without `.md`); slugs are lowercase-kebab-case and unique.
- Every factual claim has a source and a **confidence**: `confirmed` (official source or two
  independent wires), `reported` (one reliable outlet), `unverified` (OSINT/single account),
  `disputed` (sources contradict – say who says what).
- Event pages: what happened (UTC time), who said it first, confirmations, **Market impact: high | medium | low**
  with one line why, market reaction (krypto-kal tools for prices around the event time), follow-ups.
- Source pages carry `reliability: high | medium | low` in the frontmatter once the account has 5+ ingested posts.
  `brain_triage` ranks that account's posts by it.
- Wiki pages are in English. `output/` deliverables are in Polish unless asked otherwise.
- A blue checkmark is bought, not earned: "verified" only means identity. Judge reliability by the
  source page in `wiki/sources/`.

## The five prompts

When the user names one of these (in any language), follow it exactly.

1. **Interview** – Ask the user one question at a time (who they are, how they trade, which
   events matter, what failed before). After each answer, update the "Who I am / What I'm
   building / What already failed" sections of this file. Stop when the user says so.
2. **Ingest** – raw → wiki → output, every run (in Claude Code the `brain-ingest` skill has the full procedure):
   1. `x_sync` (syncs the highest-weight accounts first).
   2. `brain_triage`: ranks every post not yet ingested by likely market impact and groups posts about the same
      event; read the `selected` events **in that order**, opening only their `read` posts.
   3. Write or update the event page and every page it touches, link them, flag contradictions, add
      `wiki/timeline.md` entries. Many posts on one event become **one** event page.
   4. `brain_ingest_mark`: everything cited as ingested; noise, duplicates and stale posts as skipped (with a reason).
   5. Log entry: date, posts ingested and skipped, events deferred, pages created/updated, a three-sentence summary,
      source suggestions.
   6. Briefing in `output/YYYY-MM-DD-HHMM-briefing.md` (Polish, from the wiki only): what changed by impact, symmetry,
      transmission chain, volatility triggers, confidence, market reaction, open questions.
3. **Migrate** – Given a pile of old notes, propose where each one goes (`raw/`, `wiki/` or
   `output/`) as a table, and **wait for the user's approval before moving a single file**.
4. **Query** – Answer from the whole wiki: search (`brain_search`), read the relevant pages, cite
   the pages used. Save the answer as a new page (usually `wiki/themes/` or `output/`) and link it
   from `wiki/index.md`.
5. **Lint** – Hunt for contradictions, stale claims (situation changed since `updated`), orphan
   pages (no incoming links), missing concepts (names mentioned on 3+ pages without their own page)
   and broken links. **Report only, fix nothing.** Log the run in `wiki/log.md`.

## Sources

- `x_sync` (MCP tool, or the collector when `X_COLLECT=true`) fetches new posts from the accounts in
  `x-accounts.json` and saves them to `raw/x/`. Posts from authors without an X verification badge
  are dropped. Accounts with `"filter": true` only contribute posts matching `topics`.
- **Impact weight:** each account may set `"weight"` (0–3). Without it the category decides: `official` and `wire` 3,
  `markets` 2.5, `news` 2, `journalist` and `osint` 1.5, `analyst` 1, `commentary` 0.75, anything else 1. Higher-weight
  accounts are synced first (a tight budget cuts the rest) and their posts rank higher in `brain_triage`.
- Improving sources: when ingest or lint shows an account is unreliable, noisy or missing, suggest
  changes to `x-accounts.json` (`weight`, `filter`, `enabled`) and record the reasoning in `wiki/sources/<username>.md`.
  The triage's per-account statistics (noise share, average score, ingested so far) are the evidence.
- X API reads are paid ($0.005 per post) and capped by a daily and total budget (`X_DAILY_BUDGET_USD`,
  `X_TOTAL_BUDGET_USD`). Only accounts without `"enabled": false` are synced. Prefer `"filter": true`
  unless an account posts almost exclusively about the region. When suggesting a new account, say
  which enabled one it should replace if the budget is tight.
- Quoted and replied-to posts are stored only as links (`quotes:`, `reply_to:`), because fetching
  them costs extra reads.
