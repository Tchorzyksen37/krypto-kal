// trade-store.ts – SQLite storage of Kraken Futures fills and the closed trades derived from them.
// Uses its own connection to the same database file as HistoryStore (WAL, so both can be open).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClosedTrade, PnlFill } from "./futures-pnl.ts";

export interface TimeFilter {
  symbol?: string;
  from?: number; // epoch ms, inclusive
  to?: number; // epoch ms, inclusive
}

export class TradeStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS futures_fills (
        fill_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
        side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS futures_fills_ts ON futures_fills (symbol, ts);
      CREATE TABLE IF NOT EXISTS futures_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, direction TEXT NOT NULL,
        opened_at INTEGER NOT NULL, closed_at INTEGER NOT NULL, size REAL NOT NULL,
        entry_price REAL NOT NULL, exit_price REAL NOT NULL, pnl REAL NOT NULL, fills INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS futures_trades_closed ON futures_trades (closed_at);
    `);
  }

  // Returns how many fills were new.
  saveFills(fills: PnlFill[]): number {
    let inserted = 0;
    this.transaction(() => {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO futures_fills (fill_id, ts, symbol, side, size, price) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const f of fills) inserted += Number(insert.run(f.id, f.ts, f.symbol, f.side, f.size, f.price).changes);
    });
    return inserted;
  }

  fills(filter: TimeFilter = {}, limit?: number): PnlFill[] {
    const { where, params } = whereClause(filter, "ts");
    const rows = this.db
      .prepare(`SELECT fill_id, ts, symbol, side, size, price FROM futures_fills ${where} ORDER BY ts DESC, fill_id DESC${limit ? " LIMIT ?" : ""}`)
      .all(...params, ...(limit ? [limit] : [])) as { fill_id: string; ts: number; symbol: string; side: "buy" | "sell"; size: number; price: number }[];
    return rows.map((r) => ({ id: r.fill_id, ts: r.ts, symbol: r.symbol, side: r.side, size: r.size, price: r.price }));
  }

  newestFillTs(): number | undefined {
    return this.scalar("SELECT MAX(ts) AS v FROM futures_fills");
  }

  oldestFillTs(): number | undefined {
    return this.scalar("SELECT MIN(ts) AS v FROM futures_fills");
  }

  countFills(): number {
    return this.scalar("SELECT COUNT(*) AS v FROM futures_fills") ?? 0;
  }

  // Average-cost trades depend on the whole history, so they are always rebuilt in full.
  replaceTrades(trades: ClosedTrade[]) {
    this.transaction(() => {
      this.db.exec("DELETE FROM futures_trades");
      const insert = this.db.prepare(
        "INSERT INTO futures_trades (symbol, direction, opened_at, closed_at, size, entry_price, exit_price, pnl, fills) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const t of trades) {
        insert.run(t.symbol, t.direction, t.openedAt, t.closedAt, t.size, t.entryPrice, t.exitPrice, t.pnl, t.fills);
      }
    });
  }

  // Trades closed within the filter, oldest first.
  trades(filter: TimeFilter = {}): ClosedTrade[] {
    const { where, params } = whereClause(filter, "closed_at");
    const rows = this.db
      .prepare(`SELECT * FROM futures_trades ${where} ORDER BY closed_at, id`)
      .all(...params) as {
      symbol: string; direction: "long" | "short"; opened_at: number; closed_at: number; size: number;
      entry_price: number; exit_price: number; pnl: number; fills: number;
    }[];
    return rows.map((r) => ({
      symbol: r.symbol, direction: r.direction, openedAt: r.opened_at, closedAt: r.closed_at, size: r.size,
      entryPrice: r.entry_price, exitPrice: r.exit_price, pnl: r.pnl, fills: r.fills,
    }));
  }

  close() {
    this.db.close();
  }

  private scalar(sql: string): number | undefined {
    const row = this.db.prepare(sql).get() as { v: number | null } | undefined;
    return row?.v ?? undefined;
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

function whereClause(filter: TimeFilter, timeColumn: string): { where: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (filter.symbol) {
    parts.push("symbol = ?");
    params.push(filter.symbol);
  }
  if (filter.from !== undefined) {
    parts.push(`${timeColumn} >= ?`);
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    parts.push(`${timeColumn} <= ?`);
    params.push(filter.to);
  }
  return { where: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}
