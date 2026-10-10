// speculation/fetch.ts – gathers what the scorer needs straight from Kraken Futures, so the skill does not have
// to shovel thousands of candles through a JSON file:
//  * 1m trade-price candles of the futures contract (public endpoint, no keys; the spot OHLC tool only reaches
//    back 720 candles = 12 hours and is a different market);
//  * the user's fills, synced into the local fill store first (read-only keys KRAKEN_FUTURES_RO_API_KEY/_SECRET),
//    so history is not limited to the API's last 100 fills.
// The source functions are injectable for tests.

import { homedir } from "node:os";
import { join } from "node:path";
import { syncFills, type FillSource } from "../trading/futures-pnl.ts";
import type { FuturesCandle } from "../providers/kraken/kraken-futures-client.ts";
import type { TradeStore } from "../trading/trade-store.ts";
import { DRIVER_SYMBOLS } from "./drivers.ts";
import type { ScoreInput } from "./score.ts";
import type { Candle, Fill, LoggedBet, ReportLogEntry } from "./types.ts";

const MINUTE = 60;
const PAGE_MINUTES = 2000; // the charts API returns at most 2000 candles per call
const MATCH_LOOKBACK_DAYS = 14; // bets older than this are no longer matched to fills

export interface CandleSource {
  candles(symbol: string, resolution: "1m", range: { from?: number; to?: number }): Promise<{ candles: FuturesCandle[]; moreCandles: boolean }>;
}

export interface Range {
  from: number; // epoch seconds
  to: number;
}

// Where the macro drivers' bars come from (YahooClient fits).
export interface DriverSource {
  history(p: { symbols: string[]; interval: "15m"; from: number; to: number }): Promise<{ symbol: string; history: { t: number; o: number; h: number; l: number; c: number }[] }[]>;
}

const DRIVER_PAD = 30 * 60; // bars from 30 minutes before the window start: the scorer wants a bar near the start

// Windows of finished reports that have no driver outcome yet, padded and merged. The bias outcome is set in the same
// run (after the fetch), so a report counts as soon as its window is over.
export function driverRanges(reports: ReportLogEntry[], nowSec: number): Range[] {
  const raw: Range[] = [];
  for (const r of reports) {
    const end = Date.parse(r.window[1]) / 1000;
    if (r.driverOutcome || end > nowSec) continue;
    raw.push({ from: Math.floor(Date.parse(r.window[0]) / 1000) - DRIVER_PAD, to: Math.min(nowSec, end + DRIVER_PAD) });
  }
  const out: Range[] = [];
  for (const r of raw.sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

const isFinal = (b: LoggedBet) => b.hypothetical !== undefined && b.hypothetical.status !== "open";

// Candle ranges still needed per futures contract: from each unresolved bet's fill start to its latest close
// and over each finished, unscored report window (for the bias), capped at now, with overlapping ranges merged.
export function candleRanges(log: LoggedBet[], nowSec: number, reports: ReportLogEntry[] = []): Map<string, Range[]> {
  const raw = new Map<string, Range[]>();
  const add = (symbol: string, fromIso: string, toIso: string) => {
    const from = Math.floor(Date.parse(fromIso) / 1000 / MINUTE) * MINUTE - MINUTE;
    const to = Math.min(nowSec, Math.ceil(Date.parse(toIso) / 1000 / MINUTE) * MINUTE + MINUTE);
    if (to > from) raw.set(symbol, [...(raw.get(symbol) ?? []), { from, to }]);
  };
  for (const b of log) if (!isFinal(b)) add(b.futures, b.fill_from, b.latest_close);
  for (const r of reports) {
    if (r.outcome || Date.parse(r.window[1]) / 1000 > nowSec) continue;
    for (const s of r.symbols) add(s.futures, r.window[0], r.window[1]);
  }
  const merged = new Map<string, Range[]>();
  for (const [symbol, ranges] of raw) {
    const out: Range[] = [];
    for (const r of ranges.sort((a, b) => a.from - b.from)) {
      const last = out[out.length - 1];
      if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
      else out.push({ ...r });
    }
    merged.set(symbol, out);
  }
  return merged;
}

// All 1m candles of `range`, paging through the 2000-candle limit; sorted and de-duplicated.
export async function fetchCandles(source: CandleSource, symbol: string, range: Range): Promise<Candle[]> {
  const byT = new Map<number, Candle>();
  for (let cursor = range.from; cursor < range.to; ) {
    const to = Math.min(range.to, cursor + PAGE_MINUTES * MINUTE);
    const { candles } = await source.candles(symbol, "1m", { from: cursor, to });
    for (const c of candles) if (c.t >= range.from && c.t <= range.to) byT.set(c.t, { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
    const newest = candles.reduce((m, c) => Math.max(m, c.t), -Infinity);
    // Continue after the newest candle (a short page is not the end); an empty page skips to the page end.
    cursor = newest >= cursor ? newest + MINUTE : to;
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// The earliest moment a fill can still matter: the oldest recent bet that has no matched fills yet.
export function fillsFrom(log: LoggedBet[], nowSec: number): number | undefined {
  const cutoff = (nowSec - MATCH_LOOKBACK_DAYS * 86_400) * 1000;
  const starts = log
    .filter((b) => !b.actual && Date.parse(b.latest_close) >= cutoff)
    .map((b) => Date.parse(b.fill_from));
  return starts.length ? Math.min(...starts) : undefined;
}

export interface LiveDeps {
  candles: CandleSource;
  drivers?: DriverSource; // Yahoo; absent: the macro drivers are not scored
  fills?: { source: FillSource; store: TradeStore }; // absent without read-only keys: only hypothetical outcomes
}

export async function gatherInput(
  log: LoggedBet[], nowSec: number, deps: LiveDeps, reports: ReportLogEntry[] = [],
): Promise<{ input: ScoreInput; warnings: string[] }> {
  const warnings: string[] = [];
  const candles: Record<string, Candle[]> = {};
  for (const [symbol, ranges] of candleRanges(log, nowSec, reports)) {
    const all: Candle[] = [];
    for (const r of ranges) {
      try {
        all.push(...(await fetchCandles(deps.candles, symbol, r)));
      } catch (e) {
        warnings.push(`candles for ${symbol} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    candles[symbol] = all;
  }

  let drivers: Record<string, Candle[]> | undefined;
  const wanted = deps.drivers ? driverRanges(reports, nowSec) : [];
  if (deps.drivers && wanted.length) {
    drivers = {};
    for (const range of wanted) {
      for (const symbol of DRIVER_SYMBOLS) {
        try {
          const [res] = await deps.drivers.history({ symbols: [symbol], interval: "15m", from: range.from, to: range.to });
          const bars = (res?.history ?? []).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
          drivers[symbol] = [...(drivers[symbol] ?? []), ...bars];
        } catch (e) {
          warnings.push(`driver bars for ${symbol} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  let fills: Fill[] = [];
  const from = fillsFrom(log, nowSec);
  if (!deps.fills) warnings.push("no read-only Kraken Futures keys: your own trades are not matched, only hypothetical outcomes are scored");
  else if (from !== undefined) {
    await syncFills(deps.fills.source, deps.fills.store);
    fills = deps.fills.store.fills({ from: from - 60_000 });
  }
  if (!deps.drivers && driverRanges(reports, nowSec).length) warnings.push("no Yahoo client: the macro drivers (Nasdaq, yields, dollar, oil) are not scored");
  return { input: { fills, candles, ...(drivers ? { drivers } : {}), nowSec }, warnings };
}

// Production wiring: the public futures client for candles, the read-only keys and the shared cache DB for fills.
export async function liveInput(log: LoggedBet[], nowSec: number, env: NodeJS.ProcessEnv = process.env, reports: ReportLogEntry[] = []) {
  const { KrakenFuturesClient } = await import("../providers/kraken/kraken-futures-client.ts");
  const { TradeStore } = await import("../trading/trade-store.ts");
  const client = new KrakenFuturesClient({ apiKey: env.KRAKEN_FUTURES_RO_API_KEY ?? "", apiSecret: env.KRAKEN_FUTURES_RO_API_SECRET ?? "" });
  const store = client.hasCredentials ? new TradeStore(env.CACHE_DB_PATH ?? join(homedir(), ".krypto-kal", "cache.db")) : undefined;
  try {
    const { YahooClient } = await import("../providers/yahoo/yahoo-client.ts");
    return await gatherInput(log, nowSec, { candles: client, drivers: new YahooClient(), ...(store ? { fills: { source: client, store } } : {}) }, reports);
  } finally {
    store?.close();
  }
}
