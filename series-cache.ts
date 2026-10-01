// series-cache.ts – provider-independent read-through cache for historical series.
// Closed (final) points come from HistoryStore; only ranges missing from its coverage are fetched
// and saved. The open "tail" after `closedUntil` is always fetched live and never stored.

import type { HistoryStore, Range } from "./history-store.ts";
import { isoTime, type Logger } from "./logger.ts";

export interface CachedSeriesRequest<P extends { t: number }> {
  store: HistoryStore;
  log: Logger;
  kind: string; // series family, e.g. "funding-rate-history" or "yahoo-chart"
  interval: string;
  symbols: string[];
  range: Range; // requested range, epoch seconds inclusive
  closedUntil: number; // points with t <= closedUntil are final and may be stored
  tailTo: number; // `to` used for live tail requests; keep it stable within an interval so URLs repeat
  // If every point's t is a multiple of alignSeconds, gaps containing no such multiple are skipped
  // without an API call. Leave undefined when points are not epoch-aligned (e.g. stock market bars).
  alignSeconds?: number;
  // Fetches the given symbols for a range; symbols missing from the result are treated as "no data".
  fetch: (symbols: string[], range: Range) => Promise<Map<string, P[]>>;
}

export async function cachedSeries<P extends { t: number }>(r: CachedSeriesRequest<P>): Promise<Map<string, P[]>> {
  const { store, log, kind, interval } = r;
  const key = (symbol: string) => ({ kind, symbol, interval });
  const closed: Range = { from: r.range.from, to: Math.min(r.range.to, r.closedUntil) };
  const hasClosed = closed.from <= closed.to;

  const needTail = r.range.to > r.closedUntil;
  const tailFrom = Math.max(r.range.from, r.closedUntil + 1);
  const inTail = (pt: P) => pt.t >= tailFrom && pt.t <= r.range.to;
  const tail = new Map<string, P[]>();

  // 1. Missing closed ranges – symbols missing the same range share one fetch.
  const groups = new Map<string, { range: Range; symbols: string[] }>();
  if (hasClosed) {
    for (const symbol of r.symbols) {
      for (const range of store.missing(key(symbol), closed)) {
        if (r.alignSeconds && Math.ceil(range.from / r.alignSeconds) * r.alignSeconds > range.to) {
          store.save(key(symbol), range, []); // cannot hold any point – mark covered for free
          continue;
        }
        const id = `${range.from}-${range.to}`;
        const g = groups.get(id) ?? { range, symbols: [] };
        g.symbols.push(symbol);
        groups.set(id, g);
      }
    }
  }

  for (const { range, symbols } of groups.values()) {
    // A gap that reaches the open tail is fetched together with it – one request instead of two.
    const withTail = needTail && range.to === r.closedUntil;
    const fetchRange = withTail ? { from: range.from, to: r.tailTo } : range;
    log.info("history cache miss, fetching", {
      kind, interval, symbols: symbols.join(","), from: isoTime(fetchRange.from), to: isoTime(fetchRange.to), withTail,
    });
    const data = await r.fetch(symbols, fetchRange);
    for (const symbol of symbols) {
      const all = data.get(symbol) ?? [];
      const points = all.filter((pt) => pt.t >= range.from && pt.t <= range.to);
      store.save(key(symbol), range, points);
      if (withTail) tail.set(symbol, all.filter(inTail));
      log.debug("history cached", { kind, symbol, interval, points: points.length });
    }
  }

  // 2. Open tail for symbols whose closed range was already cached.
  const tailSymbols = needTail ? r.symbols.filter((s) => !tail.has(s)) : [];
  if (tailSymbols.length > 0) {
    const data = await r.fetch(tailSymbols, { from: tailFrom, to: r.tailTo });
    for (const symbol of tailSymbols) tail.set(symbol, (data.get(symbol) ?? []).filter(inTail));
  }

  const result = new Map<string, P[]>();
  for (const symbol of r.symbols) {
    result.set(symbol, [...(hasClosed ? store.getPoints<P>(key(symbol), closed) : []), ...(tail.get(symbol) ?? [])]);
  }
  log.debug("history served", {
    kind, interval, symbols: r.symbols.length,
    points: [...result.values()].reduce((n, pts) => n + pts.length, 0),
    fetchedRanges: groups.size, liveTail: needTail,
  });
  return result;
}
