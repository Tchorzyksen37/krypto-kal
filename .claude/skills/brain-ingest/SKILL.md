---
name: brain-ingest
description: Ingest new raw X posts into the second brain wiki (events, actors, people, places, themes, markets, sources, timeline, index, log) and optionally write a Polish market briefing to output/. Use when the user says ingest, "zaingestuj", "wczytaj nowe posty", update the brain/wiki, or asks for a briefing built from the wiki.
---

# Brain ingest

Turns new raw X posts into linked wiki pages. Follow the steps in order. Do not skip steps and do not
improvise a different layout: the format below is the contract.

## 0. Where things are

- The brain root is `BRAIN_DIR` from `.env` (currently `C:\Users\mtchorze\OneDrive\Documents\pierdoly\krypto-kal`).
  It is **not** inside this repo. Call it `BRAIN` below.
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

## 1. Sync (optional)

- If the tool `x_sync` is available, call it once. It saves new posts to `BRAIN/raw/x/<YYYY-MM-DD>/` and
  reports the spend. If it fails with a budget error, continue without it and say so in the log.
- If `x_sync` is not available, skip this step and ingest what is already in `raw/`. Say so in the log.

## 2. Find the posts that are not ingested yet

A raw post is "ingested" when its file name appears in the `sources:` line of some wiki page.

1. Subtract the two sets **in memory, with no files** (hard rule 8). Raw file names look like `<user>-<id>.md`, and the
   wiki names them in links and `sources:` lines, so one pattern finds every ingested name. In PowerShell, with
   `$BRAIN` set to the brain root, this prints the new sources oldest first (the date folder sorts chronologically):

   ```powershell
   $done = Get-ChildItem "$BRAIN\wiki" -Recurse -Filter *.md |
     Select-String -Pattern '[A-Za-z0-9_]+-\d+\.md' -AllMatches | ForEach-Object { $_.Matches.Value } | Sort-Object -Unique
   $new = @(Get-ChildItem "$BRAIN\raw\x" -Recurse -Filter *.md | Sort-Object FullName | Where-Object { $_.Name -notin $done })
   "new sources: $($new.Count)"
   $new | Select-Object -First 40 | ForEach-Object { $_.FullName }
   ```

   In bash, the count is `comm -23 <(ls -1 "$BRAIN"/raw/x/*/ | grep '\.md$' | sort -u) <(grep -rhoE '[A-Za-z0-9_]+-[0-9]+\.md' "$BRAIN/wiki" | sort -u) | wc -l`.
   (Or Glob `raw/x/**/*.md` and Grep the wiki, if you prefer the tools to the shell.)
2. The files that are not named anywhere in the wiki are the **new sources**. Count them.
3. If there are none, say "nothing new to ingest" and stop (still offer a briefing, step 6).
4. If there are more than 40, ingest the 40 oldest and tell the user how many remain.

## 3. Read and classify

Read each new source once. Each file has YAML frontmatter (`url`, `author`, `verified_type`, `kind`, `metrics`,
`links`) and the post text. For each post decide exactly one class:

| Class | What it is | What you do |
|---|---|---|
| **news** | Reports something that happened or a concrete statement/decision | Goes into an event page |
| **market** | Mentions a price, a move or a data release | Goes into an event page, with the market reaction |
| **noise** | Opinion without news, promotion, duplicate of another post, domestic politics unrelated to the region or markets | Skip. Count it for the log. |

Group the news and market posts by **event**: posts about the same thing within a few hours are ONE event.
Never make one page per post.

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

## Facts
- HH:MM UTC: the claim, in your own words. ([user](../../raw/x/YYYY-MM-DD/user-ID.md), YYYY-MM-DD) – confidence: reported

## Open questions / contradictions
- Anything unclear, or who contradicts whom (name both sides).

## Related
[[page-slug]] · [[another-slug]]
```

- Time: take it from the post (`created` in the frontmatter or the post URL's snowflake time); always UTC.
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

Source pages (`wiki/sources/<username>.md`) hold reliability, bias and track record: after ingesting, add one line
per account about what it gave (accurate, late, one-sided, noise). Do not rate an account from one post.

Slugs: lowercase kebab-case, unique, file name = slug + `.md`. Create a new page for a name only if it appears in
a source and no page exists. Do not create empty stub pages.

### 4d. Timeline

Add one line at the **top** of the list in `wiki/timeline.md` per event, newest first, in this exact shape:

`- YYYY-MM-DD HH:MM UTC – one-line summary → [[event-slug]]`

Set `updated:` in its frontmatter to today.

### 4e. Index

Every page you created must be listed in `wiki/index.md` under its section (Themes, Actors, People, Places,
Events, Markets, Sources), as `[[slug]]`. Never leave a new page unlisted.

## 5. Log

Add a new entry right below the intro line of `wiki/log.md` (newest on top). Use this shape:

```markdown
## YYYY-MM-DD – ingest (HH:MM UTC)
- **Sources ingested:** N X posts in `raw/x/<date>/` (per account: 13 @IDF, 4 @Reuters).
- **Pages created (N):** list by type. **Updated:** list.
- **Skipped as noise:** count and one-line reason.
- **Contradictions flagged:** list, or "none".
- **Summary:** exactly three sentences on what changed in our picture of the world.
- **Source suggestions (not applied):** changes to `x-accounts.json` you recommend, or "none".
- **Tools:** which tools were unavailable (`x_sync`, market data), or "all available".
```

Never edit `x-accounts.json` yourself: only suggest changes.

## 6. Briefing (only if the user asked for one, or says "briefing" / "analiza")

Write `output/YYYY-MM-DD-<topic>.md` **in Polish**, using only wiki pages (list which ones at the bottom).
Use this exact analysis frame and keep each point short:

1. **Symetria** – compare how aggressive the public rhetoric is with what private diplomacy shows. Cite pages.
2. **Łańcuch transmisji** – event → energy/macro → inflation/rates → asset price. Say which link is weakest.
3. **Wyzwalacze zmienności** – the specific dated events or signs that would move the market from priced-in to
   panic.
4. **Pewność** – mark `confirmed` only when the wiki marks it so. Single accounts and OSINT stay `unverified`.
5. **Reakcja rynku** – only reactions recorded in the wiki, with times. No reaction recorded: say so.

End with a "Czego nie wiemy" list (open questions copied from the wiki) and the list of wiki pages used.
Add the output file to `wiki/index.md` under an `Output` line only if the index already has that section.

## 7. Final check, then report

Before reporting, verify and fix anything that fails:

- [ ] Every new page has frontmatter with `title`, `type`, `updated`, `sources`.
- [ ] Every fact line has a link and one of: confirmed, reported, unverified, disputed.
- [ ] Every new page is in `wiki/index.md`; every new event is in `wiki/timeline.md`.
- [ ] Every `[[link]]` you wrote points to a file that exists in `wiki/`.
- [ ] The log entry is written. Nothing in `raw/` was changed.

Report to the user in Polish, five lines at most: how many posts ingested and skipped, pages created/updated,
the most important thing that changed, contradictions found, and anything you could not do (tools missing,
budget, posts left over).
