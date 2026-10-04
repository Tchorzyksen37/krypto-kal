// history-store.ts – persistent cache for historical series in SQLite (node:sqlite, Node >= 22.5).
// Stores series points plus "coverage" – time ranges for which we have complete data –
// so we know exactly what is still missing and only that needs to be fetched from the API.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Time range in epoch seconds, inclusive on both ends.
export interface Range {
  from: number;
  to: number;
}

// Identifies one series, e.g. { kind: "open-interest-history:usd", symbol: "BTCUSDT_PERP.A", interval: "1hour" }.
export interface SeriesKey {
  kind: string;
  symbol: string;
  interval: string;
}

export class HistoryStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS points (
        kind TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL,
        t INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (kind, symbol, interval, t)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS coverage (
        kind TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL,
        from_t INTEGER NOT NULL, to_t INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coverage_series ON coverage (kind, symbol, interval);
    `);
  }

  getPoints<P extends { t: number }>(key: SeriesKey, range: Range): P[] {
    const rows = this.db
      .prepare(
        "SELECT data FROM points WHERE kind = ? AND symbol = ? AND interval = ? AND t BETWEEN ? AND ? ORDER BY t",
      )
      .all(key.kind, key.symbol, key.interval, range.from, range.to) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as P);
  }

  // Stores points and marks `range` as covered – in a single transaction.
  save(key: SeriesKey, range: Range, points: { t: number }[]) {
    this.transaction(() => {
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO points (kind, symbol, interval, t, data) VALUES (?, ?, ?, ?, ?)",
      );
      for (const p of points) insert.run(key.kind, key.symbol, key.interval, p.t, JSON.stringify(p));

      const merged = mergeRanges([...this.coverage(key), range]);
      this.db
        .prepare("DELETE FROM coverage WHERE kind = ? AND symbol = ? AND interval = ?")
        .run(key.kind, key.symbol, key.interval);
      const add = this.db.prepare(
        "INSERT INTO coverage (kind, symbol, interval, from_t, to_t) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of merged) add.run(key.kind, key.symbol, key.interval, r.from, r.to);
    });
  }

  coverage(key: SeriesKey): Range[] {
    const rows = this.db
      .prepare(
        "SELECT from_t, to_t FROM coverage WHERE kind = ? AND symbol = ? AND interval = ? ORDER BY from_t",
      )
      .all(key.kind, key.symbol, key.interval) as { from_t: number; to_t: number }[];
    return rows.map((r) => ({ from: r.from_t, to: r.to_t }));
  }

  // Parts of `range` that are not covered yet.
  missing(key: SeriesKey, range: Range): Range[] {
    return subtractRanges(range, this.coverage(key));
  }

  hasPointsBefore(key: SeriesKey, t: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM points WHERE kind = ? AND symbol = ? AND interval = ? AND t < ? LIMIT 1")
        .get(key.kind, key.symbol, key.interval, t) !== undefined
    );
  }

  // Drops all points and coverage of a symbol for every interval (e.g. after a stock split).
  deleteSeries(kind: string, symbol: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM points WHERE kind = ? AND symbol = ?").run(kind, symbol);
      this.db.prepare("DELETE FROM coverage WHERE kind = ? AND symbol = ?").run(kind, symbol);
    });
  }

  close() {
    this.db.close();
  }

  private transaction(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

// Merges overlapping or adjacent ranges (integers, so adjacency = +1).
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

// `range` minus the sorted, disjoint `covered` ranges.
export function subtractRanges(range: Range, covered: Range[]): Range[] {
  const out: Range[] = [];
  let cursor = range.from;
  for (const c of covered) {
    if (c.to < cursor) continue;
    if (c.from > range.to) break;
    if (c.from > cursor) out.push({ from: cursor, to: c.from - 1 });
    cursor = Math.max(cursor, c.to + 1);
    if (cursor > range.to) break;
  }
  if (cursor <= range.to) out.push({ from: cursor, to: range.to });
  return out;
}
