# LLM data layer: deterministic presentation between the cache and tool output

Status: **phase 1 implemented** (2026-10-10): `src/present/` and `format: "table"` on the Coinalyze history tools and
`kraken_futures_candles` (default still `raw`). Phases 2 and 3 are proposals. It is the "future plan" in `CLAUDE.md` ("keep raw points in the cache and
put processing in a separate layer between the cache and tool output"), worked out. Storage is described in
[database-design.md](database-design.md).

**Constraints:**
- The SQLite schema does not change.
- The cache keeps storing every raw point at full detail.
- Only the read path changes: what a tool hands to the model.
- Every transformation is deterministic: the same points and the same `asOf` always give the same bytes.

## 1. What the model reads today

Every tool ends in `toResult` (`src/server/mcp-server.ts`), which returns `JSON.stringify(data)` of the provider's
points as one text block. For time series that means:

| Problem | Where it comes from | What it costs the model |
|---|---|---|
| **Key names repeated on every point** | `[{symbol, history: [{t, o, h, l, c, v, bv, tx, btx}, ...]}]` | Most of the bytes are syntax, not data |
| **Float noise** | Coinalyze volumes (`3013.052267294251`), funding (`0.005650547992601315`), Yahoo float32 prices (`5678.89990234375`) | Tokens spent on digits that carry no information; harder to compare values by eye |
| **UNIX seconds** | `t` everywhere (Kraken Futures fills use ms, and add a `time` ISO field) | The model must convert times in its head to match them to news, sessions and the calendar; easy to get an hour wrong |
| **Ambiguous short keys** | `l`/`s` = liquidated **USD** in `coinalyze_liquidation_history`, but **% of accounts** in `coinalyze_long_short_ratio_history`; `v` = base asset (Coinalyze), contracts (Kraken Futures), shares (Yahoo) | The tool description is out of view by the time the data is read; units get mixed up |
| **Implicit units** | Funding is % per the exchange's own funding interval (Binance 8h, Kraken 1h); OI is coins or USD depending on `convert_to_usd` | Cross-exchange comparisons are wrong unless normalised |
| **No "open bar" mark** | The cache knows `closedUntil` exactly, but the output does not say which bar is still forming | Skills have to warn about it ("the last candle is usually unfinished"); the model may read an incomplete bar as a signal |
| **No gaps or provenance** | `coverage` knows which ranges are complete; the output does not distinguish "no trades" from "not fetched" or "market closed" | Silent gaps look like flat markets |
| **One endpoint per call** | Price, OI, funding, long/short and liquidations come from five tools as five arrays | The model joins them by `t` itself to read the price/OI quadrant or crowding |
| **Arithmetic left to the model** | The skills ask for funding percentiles, taker buy share `bv/v`, CVD, σ of log returns, ATR, swing levels, squeeze points (`derivatives-playbook.md`) | LLMs are unreliable at arithmetic over hundreds of numbers; results differ run to run |
| **Unbounded size** | `limit` up to 2000 per symbol per tool | A thorough analysis can push tens of thousands of tokens into context before any reasoning |

`speculation_context` already avoids most of this: code measures and the model reads the results. This proposal
generalises that pattern to the market-data tools.

## 2. Measured effect

A prototype formatter ran over one week of hourly BTC derivatives data: 168 bars of OHLCV, OI, funding, long/short
and liquidations. The data was synthetic, but in the shapes and precision the providers really return; the sandbox
cannot reach the APIs.

| Format | Characters | Approx. tokens | vs today |
|---|---|---|---|
| Today: 5 tool calls, raw JSON | 84,278 | ~28,000 | 100% |
| One joined table, columnar JSON | 15,495 | ~5,200 | 18% |
| One joined table, CSV text | 14,593 | ~4,900 | 17% |
| Digest: 6 fact lines + last 24 bars hourly + earlier bars resampled to 6h | 4,896 | ~1,600 | 6% |

**Caveats:**
- Tokens are estimated as characters / 3; numeric text tokenises worse than prose.
- The table keeps the close of OI, funding and the long/short ratio and drops the trade counts. Their full
  OHLC stays in the cache and in `format: "raw"`.
- The digest's fact lines were hand-written in the prototype, so only their length is representative.

A row the model reads changes from

```
{"t":1759208400,"o":61831.1,"h":62364,"l":61610.8,"c":62144.1,"v":3013.052267294251,"bv":1632.4129827993788,"tx":93405,"btx":48972}
{"t":1759208400,"o":0.005650547992601315,"h":0.005953641054850836,"l":0.005428203326197437,"c":0.005884228170655774}
... three more objects for OI, long/short and liquidations
```

to

```
time,open,high,low,close,volume_btc,taker_buy_share,oi_musd,funding_pct_8h,long_short_ratio,liq_long_kusd,liq_short_kusd
2025-09-30T05:00Z,61831.1,62364,61610.8,62144.1,3013,0.542,7349.6,0.0059,1.84,71,47
```

**Measuring the real thing.** The server now records the size of every tool result and how many series points it
carried (`src/core/run-stats.ts`; MCP tool `server_stats`; log `~/.krypto-kal/tool-stats.jsonl`). After a few days of
normal use, `node src/core/run-stats.ts --since <ISO>` shows which tools fill the context most. That is the order in
which to apply this layer, and the baseline to compare against after each phase.

## 3. Design

### 3.1 Where it sits

```
provider API -> client -> cachedSeries / HistoryStore (unchanged, raw points)
                                   |
                                   v
                      src/present/  (new, pure functions, no I/O)
                                   |
                                   v
                    toResult -> MCP text content the model reads
```

The present layer gets raw points plus their metadata: interval, `closedUntil`, coverage gaps and units. It returns
text. It never writes to the cache, so the stored data stays complete and other formats can be added later.

### 3.2 Modules (`src/present/`)

| File | Pure functions |
|---|---|
| `units.ts` | Normalisation with the unit in the column name. Funding goes to % per 8h from the exchange's interval (the rule `fundingPct8h` already applies in `speculation/market.ts`). OI goes to USD; volumes are labelled with their unit (base asset, contracts, shares). |
| `round.ts` | One rounding rule per field class: prices to the instrument tick when known, else 6 significant figures (this also removes Yahoo's float32 noise); USD amounts as integers in the column's scale (`_kusd`, `_musd`); ratios and shares to 3 decimals; funding to 4 decimals of a percent. Rounding uses `toPrecision`/`toFixed` only, so the result is identical on every machine. |
| `table.ts` | Columnar rows to CSV text: header once, ISO UTC minute timestamps (`2025-09-30T05:00Z`), fixed column order, empty cell for a missing value (never 0). |
| `join.ts` | Outer join of several series of one symbol on `t`, as used by the joined view (3.4). |
| `resample.ts` | Aggregation to a coarser interval: open first, high max, low min, close last, volumes and liquidations summed, OI and long/short last, funding averaged. Only whole buckets aligned to the epoch; a partial bucket is marked. |
| `stats.ts` | Deterministic statistics over a window: change % over 1, 4, 24 bars and the whole window; min / max with their times; percentile and z-score of the last value within the window; σ of log returns; ATR(14); swing highs/lows (fractal of 3 bars each side); taker buy share and CVD Σ(2·bv − v); price/OI quadrant over 4h and 24h; liquidation bars above the window's 95th percentile. |
| `facts.ts` | Short sentences built from `stats` with fixed templates, each with its numbers and the threshold it used (e.g. `funding 0.0123 %/8h, 81st percentile of 30d (crowded long above 80)`). No adjectives without a number; thresholds are named constants shared with the skills' playbook. |
| `digest.ts` | Assembles header + facts + table and applies the row budget (3.5). |

### 3.3 One output shape for every series tool

```
BTCUSDT_PERP.A (Coinalyze, Binance USDT perpetual) 1h, 2025-09-30T00:00Z .. 2025-10-06T23:00Z, 168 bars
as of 2025-10-07T00:12Z; last bar 2025-10-06T23:00Z is still open; cached through 2025-10-06T22:00Z, tail fetched live
units: price USDT; volume BTC; oi USD millions; funding % per 8h; liquidations USD thousands
gaps: none
facts:
- price 62000 -> 61234 (-1.2% 7d, -0.4% 24h); range 59870 (10-02 03:00Z) .. 63950 (10-04 15:00Z); ATR14 412 (0.67%)
- open interest +3.4% 7d, +1.1% 24h; quadrant 24h: price down, OI up
- ...
table:
time,open,high,low,close,...
```

- The **header** holds the provenance:
  - window, bar count and `as of`;
  - which bar is open (from `closedUntil`);
  - where the cache ends and the live tail begins (from `coverage`);
  - units, written once;
  - gaps: spans with no point inside a covered range. For Yahoo, weekends and session breaks are reported as "market
    closed", not as gaps.
- The **facts** are computed by code, so the model reasons over them instead of recomputing them.
- The **table** keeps the detail.

### 3.4 Formats and a joined view

- **History tools** get `format: "raw" | "table" | "digest"`:
  - `raw` is today's JSON, for exact values and compatibility;
  - `table` is header + CSV, every bar;
  - `digest` is header + facts + the budgeted table.
- **New tool `market_view(symbol, interval, window)`:**
  - Builds one joined table per asset: Coinalyze OHLCV, OI, funding, long/short and liquidations, plus Kraken Futures
    price and funding for the PF_ contract.
  - Adds the facts the `crypto-market-sentiment` and `position-review` skills now compute by hand.
  - Makes the same API calls as the five separate tools and shares their cache, so it costs nothing extra once warm.
- **Defaults:**
  - Existing tools keep `raw` as the default in phase 1, so the skills and e2e tests keep working.
  - `market_view` defaults to `digest`.
  - After the skills are switched over, the history tools default to `table`.

### 3.5 Row budget: detail where it matters

`max_rows` (default 200) bounds the table deterministically:
- the most recent `recent_rows` (default 48) stay at the native interval;
- older bars are resampled to the smallest multiple of the interval that fits the rest of the budget (1h → 2h, 4h, 6h, 12h, 1d);
- the header says so ("bars before 10-05 00:00Z resampled to 6h").

Nothing is dropped silently, and `format: "table"` with a larger `max_rows` or `format: "raw"` returns everything.

### 3.6 Other tools, same rules (later phases)

| Tool | Change |
|---|---|
| `kraken_futures_candles`, `yahoo_history`, `kraken_ohlc` | Same envelope. Yahoo gets session-aware gaps and float32 cleanup. |
| `kraken_futures_fills`, `kraken_futures_pnl` | One time format (ISO); a fills table; PnL facts with N next to every rate. |
| `yahoo_quote` | Quote time and a "stale (last close Fri)" flag computed from the market state, not left to the model. |
| `x_recent` | One line per post: `HH:MMZ @user [category, weight] first 200 chars`, newest first, with a header saying how old the newest post is. |

## 4. Determinism and testing

- **Pure functions:**
  - `asOf` is passed in, never read from the clock inside `present/`;
  - sorting is fixed (time ascending, then symbol);
  - no locale formatting (`toLocaleString` differs per machine).
- **Golden tests:** fixed fixtures in, exact text out, so a change in output is a visible diff in review.
- **Property tests:**
  - resampling keeps the window's high, low, first open and last close, and the summed volume and liquidations;
  - rounding never moves a price by more than half a tick;
  - `table` with no budget has exactly one row per raw point.
- **Contract test:** `raw` stays byte-identical to today's output.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Rounding hides a value someone needs | `raw` is always available; rounding rules are per field class and documented in the header units |
| Facts read as conclusions | Every fact carries its numbers and its threshold; estimates keep the ESTIMATE label; facts describe, they do not recommend |
| Thresholds drift from the skills | One constants file used by `facts.ts`, quoted by `derivatives-playbook.md` |
| Changing defaults breaks skills and e2e tests | Phase 1 adds formats without changing defaults; defaults switch only together with the skill and test updates |

## 6. Phases

1. **Done.** `src/present/` with `round`, `units`, `table`, `stats`, `resample` and golden / property tests
   (`present.test.ts`); `format: "raw" | "table"` and an optional `max_rows` on the five Coinalyze history tools (also
   with `aggregate`) and `kraken_futures_candles`; default `raw`, byte-identical to before. Deviations from the design
   above:
   - the row budget (3.5) came forward into phase 1 as the optional `max_rows` of `table`; the native part is the
     newest 48 rows but at most half the budget, and the last resampled bucket can be partial (its `bars` shows it);
   - `digest` and the facts lines are phase 2; `table` carries a computed `summary:` line instead (first -> last,
     change, low / high with times; totals and the largest bar for liquidations);
   - funding is labelled, not normalised to 8h: Coinalyze does not say each exchange's funding interval;
   - the open bar is the one whose interval has not ended at `asOf`; "cached through" is not shown yet.
2. `market_view` with facts and the row budget; point `crypto-market-sentiment` and `position-review` at it.
3. Switch history tools to `table` by default; the same envelope for Yahoo, fills / PnL, quotes and `x_recent`.
