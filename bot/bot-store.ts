// bot-store.ts – the bot's SQLite file (node:sqlite), shared by the analyst, trader and watchdog processes.
// Holds level menus, policies, small state, daily counters, the decision journal and incidents.
// Kept outside OneDrive by default (see config.db_path): sync can lock SQLite files.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LevelMenu, Policy } from "./policy.ts";

export interface StoredPolicy {
  id: number; // assigned by the store, never chosen by the LLM
  createdAtMs: number;
  policy: Policy;
}

export interface Incident {
  tMs: number;
  kind: string;
  detail: string;
}

export interface JournalEntry {
  tMs: number;
  configHash: string;
  kind: string;
  snapshot: unknown; // the engine's input at decision time
  policyId?: number;
  decision: string;
  reason: string;
}

// "~" and "~/x" mean the user's home directory; anything else is returned unchanged.
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
}

export class BotStore {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    const file = expandHome(path);
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS menus (
        id TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS policies_created ON policies (created_at, id);
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counters (
        day TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (day, name)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t_ms INTEGER NOT NULL, config_hash TEXT NOT NULL,
        kind TEXT NOT NULL, policy_id INTEGER, decision TEXT NOT NULL, reason TEXT NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_time ON journal (t_ms, id);
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t_ms INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
      );
    `);
  }

  // Runs `fn` atomically. Reentrant: only the outermost call commits, and a failure anywhere rolls back everything.
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  // A published menu is immutable: a duplicate id throws instead of changing the prices a policy refers to.
  putMenu(m: LevelMenu): void {
    this.db.prepare("INSERT INTO menus (id, data) VALUES (?, ?)").run(m.id, JSON.stringify(m));
  }

  getMenu(id: string): LevelMenu | undefined {
    const row = this.db.prepare("SELECT data FROM menus WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as LevelMenu) : undefined;
  }

  putPolicy(p: Policy, createdAtMs: number): number {
    const r = this.db.prepare("INSERT INTO policies (created_at, data) VALUES (?, ?)").run(createdAtMs, JSON.stringify(p));
    return Number(r.lastInsertRowid);
  }

  getPolicy(id: number): StoredPolicy | undefined {
    const row = this.db.prepare("SELECT id, created_at, data FROM policies WHERE id = ?").get(id) as PolicyRow | undefined;
    return row ? toStoredPolicy(row) : undefined;
  }

  // Newest first by creation time (so a slow analyst call finishing late cannot shadow a newer policy), then by id.
  latestPolicies(n: number): StoredPolicy[] {
    const rows = this.db
      .prepare("SELECT id, created_at, data FROM policies ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(n) as unknown as PolicyRow[];
    return rows.map(toStoredPolicy);
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }

  addCounter(day: string, name: string, by: number): void {
    this.db
      .prepare("INSERT INTO counters (day, name, value) VALUES (?, ?, ?) ON CONFLICT (day, name) DO UPDATE SET value = value + excluded.value")
      .run(day, name, by);
  }

  getCounter(day: string, name: string): number {
    const row = this.db.prepare("SELECT value FROM counters WHERE day = ? AND name = ?").get(day, name) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  // Throws if the write fails: the engine must not act on a decision it could not record.
  appendJournal(e: JournalEntry): void {
    this.db
      .prepare("INSERT INTO journal (t_ms, config_hash, kind, policy_id, decision, reason, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.tMs, e.configHash, e.kind, e.policyId ?? null, e.decision, e.reason, JSON.stringify(e.snapshot ?? null));
  }

  listJournal(sinceMs: number, kind?: string): JournalEntry[] {
    const rows = (
      kind === undefined
        ? this.db.prepare("SELECT * FROM journal WHERE t_ms >= ? ORDER BY t_ms, id").all(sinceMs)
        : this.db.prepare("SELECT * FROM journal WHERE t_ms >= ? AND kind = ? ORDER BY t_ms, id").all(sinceMs, kind)
    ) as unknown as JournalRow[];
    return rows.map((r) => ({
      tMs: r.t_ms, configHash: r.config_hash, kind: r.kind, snapshot: JSON.parse(r.snapshot) as unknown,
      ...(r.policy_id === null ? {} : { policyId: r.policy_id }), decision: r.decision, reason: r.reason,
    }));
  }

  addIncident(i: Incident): void {
    this.db.prepare("INSERT INTO incidents (t_ms, kind, detail) VALUES (?, ?, ?)").run(i.tMs, i.kind, i.detail);
  }

  listIncidents(sinceMs: number): Incident[] {
    const rows = this.db
      .prepare("SELECT t_ms, kind, detail FROM incidents WHERE t_ms >= ? ORDER BY t_ms, id")
      .all(sinceMs) as unknown as { t_ms: number; kind: string; detail: string }[];
    return rows.map((r) => ({ tMs: r.t_ms, kind: r.kind, detail: r.detail }));
  }

  close(): void {
    this.db.close();
  }
}

interface PolicyRow {
  id: number;
  created_at: number;
  data: string;
}

interface JournalRow {
  t_ms: number;
  config_hash: string;
  kind: string;
  policy_id: number | null;
  decision: string;
  reason: string;
  snapshot: string;
}

const toStoredPolicy = (r: PolicyRow): StoredPolicy => ({ id: r.id, createdAtMs: r.created_at, policy: JSON.parse(r.data) as Policy });
