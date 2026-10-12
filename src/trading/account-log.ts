// account-log.ts – the Kraken Futures account log in SQLite, synced incrementally, plus the latest FX rates.
// The account log is the only source with fees and funding (fills carry neither), so the dashboard's net results
// come from here. Each entry is kept with its raw JSON, so a different reading of a field (the schema is typed from
// Kraken's docs and unverified) needs no re-download.
//
// Tables (in the same file as the fill store, CACHE_DB_PATH):
//   futures_account_log (id PK, t_ms, info, asset, contract, data)   one row per account-log entry
//   fx_rates (pair, t_ms, rate, PK (pair, t_ms))                        quotes from Yahoo, e.g. USDPLN=X

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../core/logger.ts";
import type { FuturesAccountLogEntry } from "../providers/kraken/kraken-futures-client.ts";

const log = createLogger("account-log");

export class AccountLogStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS futures_account_log (
        id INTEGER PRIMARY KEY, t_ms INTEGER NOT NULL, info TEXT NOT NULL, asset TEXT, contract TEXT, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS futures_account_log_t ON futures_account_log (t_ms);
      CREATE TABLE IF NOT EXISTS fx_rates (
        pair TEXT NOT NULL, t_ms INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY (pair, t_ms)
      ) WITHOUT ROWID;
    `);
  }

  // Inserts new entries (an id already stored is left as it is). Returns how many were new.
  save(entries: FuturesAccountLogEntry[]): number {
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare("INSERT OR IGNORE INTO futures_account_log (id, t_ms, info, asset, contract, data) VALUES (?, ?, ?, ?, ?, ?)");
      for (const e of entries) {
        const t = Date.parse(e.date);
        if (!Number.isInteger(e.id) || !Number.isFinite(t)) continue;
        inserted += Number(insert.run(e.id, t, e.info ?? "", e.asset ?? null, e.contract ?? null, JSON.stringify(e)).changes);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return inserted;
  }

  maxId(): number | undefined {
    const row = this.db.prepare("SELECT MAX(id) AS v FROM futures_account_log").get() as { v: number | null };
    return row.v ?? undefined;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS v FROM futures_account_log").get() as { v: number }).v;
  }

  // All entries in id order.
  entries(): FuturesAccountLogEntry[] {
    const rows = this.db.prepare("SELECT data FROM futures_account_log ORDER BY id").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as FuturesAccountLogEntry);
  }

  saveRate(pair: string, tMs: number, rate: number): void {
    this.db.prepare("INSERT OR REPLACE INTO fx_rates (pair, t_ms, rate) VALUES (?, ?, ?)").run(pair, tMs, rate);
  }

  latestRate(pair: string): { tMs: number; rate: number } | undefined {
    const row = this.db.prepare("SELECT t_ms, rate FROM fx_rates WHERE pair = ? ORDER BY t_ms DESC LIMIT 1").get(pair) as { t_ms: number; rate: number } | undefined;
    return row ? { tMs: row.t_ms, rate: row.rate } : undefined;
  }

  close(): void {
    this.db.close();
  }
}

export interface AccountLogSource {
  accountLog(p: { from?: number; count?: number; sort?: "asc" | "desc" }): Promise<FuturesAccountLogEntry[]>;
}

export interface AccountLogSyncResult {
  pages: number;
  fetched: number;
  inserted: number;
  total: number;
  complete: boolean; // false when the page limit stopped the sync (it continues on the next run)
}

// Pulls entries after the newest stored id, oldest first, page by page. The first run walks from the account's first
// entry; later runs fetch only what is new. Stops at a short page, a page with nothing new, or `maxPages`.
export async function syncAccountLog(source: AccountLogSource, store: AccountLogStore, pageSize = 500, maxPages = 200): Promise<AccountLogSyncResult> {
  let pages = 0;
  let fetched = 0;
  let inserted = 0;
  let from = (store.maxId() ?? -1) + 1;
  let complete = false;
  while (pages < maxPages) {
    const page = await source.accountLog({ from, count: pageSize, sort: "asc" });
    pages++;
    fetched += page.length;
    const added = store.save(page);
    inserted += added;
    const top = Math.max(-1, ...page.map((e) => e.id).filter(Number.isInteger));
    if (page.length < pageSize || added === 0 || top < from) {
      complete = true;
      break;
    }
    from = top + 1;
  }
  if (!complete) log.warn("account log sync stopped at the page limit; the next run continues", { maxPages });
  log.info("account log synced", { pages, fetched, inserted });
  return { pages, fetched, inserted, total: store.count(), complete };
}
