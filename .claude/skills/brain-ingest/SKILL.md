---
name: brain-ingest
description: Ingest the most market-moving new X posts into the second brain, end to end - raw/ -> wiki/ (events, actors, people, places, themes, markets, sources, timeline, index, log) -> output/ (a Polish briefing of what changed). Posts are ranked by impact and grouped into events by the brain_triage tool, so the strongest, corroborated news is read first and noise is skipped. Use when the user says ingest, "zaingestuj", "wczytaj nowe posty", update the brain/wiki, or asks for a briefing built from the wiki.
---

# Brain ingest

Turns the most impactful new raw X posts into linked wiki pages, then into a Polish briefing:
**raw/ -> wiki/ -> output/**, every run. Which posts to read, and in what order, is decided by code (`brain_triage`), not
by file age. Follow the steps in order. Do not skip steps and do not improvise a different layout: the format below is
the contract.

## 0. Where things are

- The brain root is the value of `BRAIN_DIR` in this repo's `.env` (read it; do not assume a path). It is **not**
  inside this repo. Call it `BRAIN` below. If `BRAIN/CLAUDE.md` or `BRAIN/x-accounts.json` does not exist there, stop and
  tell the user that `BRAIN_DIR` points to the wrong folder.
- Read `BRAIN/CLAUDE.md` first. It is the source of truth for the page format; this skill only adds a procedure.
- Folders: `BRAIN/raw/` (read only), `BRAIN/wiki/` (you write here), `BRAIN/output/` (briefings, Polish).
- Edit brain files directly with Read/Write/Edit. The `brain_*` MCP tools do the same and are fine if present.

## Hard rules

1. **Never create, edit or delete anything in `raw/`.** The only exception is the `x_sync` tool, which creates files.
2. Wiki pages are in **English**. Files in `output/` are in **Polish**. Chat with the user in Polish.
3. Every fact has a source link and a confidence label. No source, no fact.
4. `output/` is built from the wiki only, never straight from `raw/`.
5. Never invent. If a post does not say it, do not write it. If you are unsure, use `unverified`.
6. Do not run `node src/brain/x-sync.ts`: that file is a library and does nothing when run.
7. Do not ask the user questions during a normal run. Make the default choice and note it in the log.
8. **Never create helper or scratch files in the repo or in `BRAIN`** (no `all_raw.txt`, `ingested_raw.txt`, lists of
   file names, notes). The repo is under git and the brain is a synced Obsidian vault; neither is a work area. Do set
   arithmetic in memory (step 2 shows how). If you really need a scratch file, put it in the OS temp directory
   (`$env:TEMP` in PowerShell, `$TEMP` or `/tmp` in bash) under `krypto-kal-ingest/`, and delete it before you report.

## 1. Sync

- If the tool `x_sync` is available, call it once. It saves new posts to `BRAIN/raw/x/<YYYY-MM-DD>/` and reports the
  spend. It syncs the most important accounts first (officials and wires, then markets, OSINT, commentary; see
  `weight` in `x-accounts.json`), so a tight budget cuts the least important ones. If it fails with a budget error,
  continue and say so in the log.
- If `x_sync` is not available, skip this step and ingest what is already in `raw/`. Say so in the log.

## 2. Triage: what to read, in what order

Call `brain_triage` (default `max_posts: 40`). If the MCP tool is not available, run
`node --env-file-if-exists=.env src/brain/triage.ts 40` from the repo; it prints the same JSON. Do **not** list or
diff files yourself.

It returns (all paths are `raw/x/<date>/<user>-<id>.md`):

| Field | Meaning | What you do |
|---|---|---|
| `pending` | raw posts not cited in the wiki and not marked before | report the number |
| `selected` | events to ingest now, **highest impact first**. Each has `read` (posts to open), `alsoInEvent` (same event: cite in `sources:`, no need to open), `authors`, `corroborated`, `label`, `score` | steps 3-4, in this order |
| `deferred` | weaker events left for a later run | nothing; say how many in the log |
| `noise` | promotion, short posts or replies without market-moving terms | skim the list; mark them skipped in step 5 unless one is clearly news |
| `stale` | deferred posts older than 72 h | mark skipped as `stale` in step 5 |
| `accounts` | per account: pending, noise, average score, ingested and skipped so far | source suggestions in step 6 |

The score favours: officials and wires over commentary (and the `reliability:` you set on source pages), kinetic,
energy/chokepoint, escalation/diplomacy and macro/crypto terms, original posts over replies, unusual engagement, and
**corroboration** (several independent accounts on one event). It is a reading order, not a truth rating: you still
judge each post.

If `selected` is empty, say "nothing new worth ingesting", mark noise and stale (step 5), and still write the briefing
(step 7) only if the wiki changed since the last one; otherwise stop.

## 3. Read and classify

Work through `selected` in order. Open each post in `read` once (never the `alsoInEvent` ones). Each file has YAML frontmatter (`url`, `author`, `verified_type`, `kind`, `metrics`,
`links`) and the post text. For each post decide exactly one class:

| Class | What it is | What you do |
|---|---|---|
| **news** | Reports something that happened or a concrete statement/decision | Goes into an event page |
| **market** | Mentions a price, a move or a data release | Goes into an event page, with the market reaction |
| **noise** | Opinion without news, promotion, duplicate of another post, domestic politics unrelated to the region or markets | Skip. Count it for the log. |

Each `selected` entry is already one candidate event: posts about the same thing within a few hours. Merge two entries
if they are clearly the same event, and split one if it mixes two. Never make one page per post. A post you read and
judge as noise is marked skipped in step 5.

## 4. Write the wiki

For each event, in this order:

### 4a. Event page

Path: `wiki/events/YYYY-MM-DD-short-kebab-slug.md` (UTC date of the first post). If it already exists, update it
instead of creating a second one (search `wiki/events/` for the date and keywords first).

```markdown
---
title: Short plain title of the event (YYYY-MM-DD)
type: event
updated: YYYY-MM-DD
sources: [raw/x/YYYY-MM-DD/user-ID.md, raw/x/YYYY-MM-DD/user2-ID2.md]
---

Two to four sentences: what happened, who said it first, why it matters for markets.

**Market impact:** high | medium | low, and one line why (energy supply, escalation path, macro, crypto-specific).

## Facts
- HH:MM UTC: the claim, in your own words. ([user](../../raw/x/YYYY-MM-DD/user-ID.md), YYYY-MM-DD) – confidence: reported

## Open questions / contradictions
- Anything unclear, or who contradicts whom (name both sides).

## Related
[[page-slug]] · [[another-slug]]
```

- `sources:` lists every post of the event: the ones you read **and** its `alsoInEvent` posts.
- Time: take it from the post (`created_at` in the frontmatter); always UTC.
- The link inside `Facts` is a relative path from `wiki/events/` and looks like `../../raw/x/<date>/<file>.md`.
- Confidence labels (use exactly these words):
  - `confirmed`: an official source, or two independent wires (e.g. Reuters and Bloomberg) agree.
  - `reported`: one reliable outlet or wire.
  - `unverified`: a single account, OSINT, rumour, anonymous source.
  - `disputed`: sources contradict each other; write who says what.
- A government or military account (e.g. @IDF) is `confirmed` only for what **they** did or said, not for claims
  about the other side. Claims about the other side are `unverified`.

### 4b. Market reaction (only for news and market posts)

If the krypto-kal MCP tools are available, check the price around the post time and write the result in the
event's `Facts`, e.g. `BTC -0.8% between 07:15 and 07:30 UTC`. Use:
- `yahoo_history` with interval `5m` or `1h` for oil (`BZ=F`, `CL=F`), dollar (`DX-Y.NYB`), US 10y (`^TNX`).
- `coinalyze_ohlcv_history` (symbol like `BTCUSDT_PERP.A`, interval `5min`) for BTC.
Say "no visible reaction" when the move is within normal noise. If the tools are not available, write
"market reaction not checked". Never guess a price move.

### 4c. Other pages touched by the event

For every actor, person, place, theme and market the event mentions, open its page and **update** it, or create it
if it does not exist (search first: `ls wiki/<folder>/`).

| Folder | For | Example slug |
|---|---|---|
| `wiki/actors/` | countries, governments, militaries, groups | `iran`, `houthis` |
| `wiki/people/` | leaders and officials | `donald-trump` |
| `wiki/places/` | chokepoints, cities, targets | `strait-of-hormuz` |
| `wiki/themes/` | ongoing storylines | `gaza-ceasefire` |
| `wiki/markets/` | how events move prices | `oil`, `btc` |
| `wiki/sources/` | one page per X account used | `reuters` |

Page format is the same as the event page, with `type:` set to `actor`, `person`, `place`, `theme`, `market`
or `source`. To update an existing page:
- add the new fact line under `## Facts`, newest at the top, with source link and confidence;
- add the new raw file to the `sources:` list and set `updated:` to today;
- if the new fact contradicts an old one, keep both and add a line under `## Open questions / contradictions`;
- add `[[event-slug]]` to `## Related`.

Source pages (`wiki/sources/<username>.md`, slug = lowercase username) hold reliability, bias and track record: after
ingesting, add one line per account about what it gave (accurate, first, late, one-sided, noise). Once an account has
5 or more ingested posts, set `reliability: high | medium | low` in its frontmatter; `brain_triage` uses it to rank that
account's next posts (high x1.3, low x0.6). Do not rate an account from one post.

Slugs: lowercase kebab-case, unique, file name = slug + `.md`. Create a new page for a name only if it appears in
a source and no page exists. Do not create empty stub pages.

### 4d. Timeline

Add one line at the **top** of the list in `wiki/timeline.md` per event, newest first, in this exact shape:

`- YYYY-MM-DD HH:MM UTC – one-line summary → [[event-slug]]`

Set `updated:` in its frontmatter to today.

### 4e. Index

Every page you created must be listed in `wiki/index.md` under its section (Themes, Actors, People, Places,
Events, Markets, Sources), as `[[slug]]`. Never leave a new page unlisted.

## 5. Mark what was done

Call `brain_ingest_mark` once with:
- `ingested`: every post now cited in the wiki (all `read` and `alsoInEvent` paths of the events you wrote);
- `skipped`: `{ path, reason }` for the triage's `noise` and `stale` posts and every post you read and judged noise
  (reasons: `noise`, `duplicate`, `stale`, `off-topic`).
Without the tool, say in the log that marking was not possible (the next triage will still skip cited posts).

## 6. Log

Add a new entry right below the intro line of `wiki/log.md` (newest on top). Use this shape:

```markdown
## YYYY-MM-DD – ingest (HH:MM UTC)
- **Sources ingested:** N X posts (read M, cited without reading K) in `raw/x/<date>/` (per account: 13 @IDF, 4 @Reuters).
- **Triage:** pending P, events selected E (corroborated C), deferred D, skipped as noise/stale S.
- **Pages created (N):** list by type. **Updated:** list.
- **Skipped as noise:** count and one-line reason.
- **Contradictions flagged:** list, or "none".
- **Summary:** exactly three sentences on what changed in our picture of the world.
- **Source suggestions (not applied):** changes to `x-accounts.json` you recommend, from the triage's `accounts`
  statistics, or "none". Typical: an account with mostly noise (10+ posts, over 60% noise or never ingested) gets
  `"filter": true` or `"enabled": false`; an account that keeps being first on high-impact events gets a higher
  `weight`; an account whose reports the wiki marks wrong gets `reliability: low` on its source page.
- **Tools:** which tools were unavailable (`x_sync`, market data), or "all available".
```

Never edit `x-accounts.json` yourself: only suggest changes.

## 7. Briefing (every run that changed the wiki)

Write `output/YYYY-MM-DD-HHMM-briefing.md` **in Polish** (UTC time of the run), using only wiki pages (list which ones
at the bottom); never raw files. Order:

1. **Co się zmieniło** – the events of this run, highest market impact first, one or two lines each, with time (UTC),
   confidence and a link `[[event-slug]]`.
2. **Symetria** – how aggressive the public rhetoric is compared with what private diplomacy shows. Cite pages.
3. **Łańcuch transmisji** – event → energy/macro → inflation/rates → asset price (BTC, ETH, oil, dollar). Say which link
   is weakest.
4. **Wyzwalacze zmienności** – the specific dated events or signs that would move the market from priced-in to panic.
5. **Pewność** – mark `confirmed` only when the wiki marks it so. Single accounts and OSINT stay `unverified`.
6. **Reakcja rynku** – only reactions recorded in the wiki, with times. None recorded: say so.
7. **Czego nie wiemy** – open questions copied from the wiki.

End with the list of wiki pages used. Add the briefing to `wiki/index.md` under an `Output` section (create the section
if it is missing) and note its path in the log entry. If the user asked for a briefing on a specific topic, write that
instead, with the same frame.

## 8. Final check, then report

Before reporting, verify and fix anything that fails:

- [ ] Every new page has frontmatter with `title`, `type`, `updated`, `sources`.
- [ ] Every fact line has a link and one of: confirmed, reported, unverified, disputed.
- [ ] Every new page is in `wiki/index.md`; every new event is in `wiki/timeline.md`.
- [ ] Every `[[link]]` you wrote points to a file that exists in `wiki/`.
- [ ] The log entry is written. Nothing in `raw/` was changed.
- [ ] `brain_ingest_mark` was called (or its absence is logged).
- [ ] The briefing exists in `output/` and cites only wiki pages.

Report to the user in Polish, six lines at most: how many posts ingested and skipped (and how many events deferred),
pages created/updated, the most important thing that changed, contradictions found, the briefing path, and anything
you could not do (tools missing, budget, posts left over).
