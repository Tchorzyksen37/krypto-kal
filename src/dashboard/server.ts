// dashboard/server.ts – a local web page with the results of the Kraken Futures account since it was opened:
// today, open positions, the whole period, wins and profit factor, the result per UTC day and per instrument, each
// as gross, fees, funding and net, in USD and in a second currency at the latest Yahoo rate.
//
//   npm run dashboard        -> http://127.0.0.1:3001
//
// Data: the account log (src/trading/account-log.ts) is synced into SQLite (CACHE_DB_PATH) in the background every
// DASHBOARD_SYNC_MINUTES and on a page load when it is more than a minute old; the first run reads the whole history.
// Needs the read-only keys KRAKEN_FUTURES_RO_API_KEY / _SECRET. The page shows account data, so it only listens on
// a loopback address unless DASHBOARD_ALLOW_REMOTE=true.

import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../core/logger.ts";
import { type FuturesPosition, KrakenFuturesClient } from "../providers/kraken/kraken-futures-client.ts";
import { YahooClient } from "../providers/yahoo/yahoo-client.ts";
import { type AccountLogSource, AccountLogStore, type AccountLogSyncResult, syncAccountLog } from "../trading/account-log.ts";
import { type AccountStats, accountStats } from "../trading/account-stats.ts";

const log = createLogger("dashboard");
const PAGE = fileURLToPath(new URL("./page.html", import.meta.url));

export interface DashboardDeps {
  futures: AccountLogSource & { openPositions(): Promise<FuturesPosition[]> };
  quotes?: { quotes(symbols: string[]): Promise<{ symbol: string; price: number; marketTime: string }[]> } | undefined;
  store: AccountLogStore;
  currency: string; // second currency, e.g. "PLN"; "USD" for none
  now?: () => number;
  syncMaxAgeMs?: number; // a page load syncs when the last sync is older than this (default 60 s)
  fxMaxAgeMs?: number; // the FX rate is refreshed when older than this (default 15 min)
  positionsTtlMs?: number; // open positions are re-read after this (default 30 s)
}

export interface DashboardPayload {
  stats: AccountStats;
  currency: string;
  fx: { pair: string; rate: number; time: string; stale: boolean; error?: string } | undefined;
  sync: { at: string | undefined; result: AccountLogSyncResult | undefined; error: string | undefined };
  positionsError: string | undefined;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Dashboard {
  private readonly d: DashboardDeps;
  private readonly now: () => number;
  private syncing: Promise<void> | undefined;
  private lastSync: { atMs: number; result?: AccountLogSyncResult; error?: string } | undefined;
  private fxError: string | undefined;
  private fxCheckedMs = 0;
  private positions: { atMs: number; value?: FuturesPosition[]; error?: string } | undefined;

  constructor(deps: DashboardDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  get fxPair(): string | undefined {
    return this.d.currency.toUpperCase() === "USD" ? undefined : `USD${this.d.currency.toUpperCase()}=X`;
  }

  // One sync at a time: concurrent callers wait for the running one.
  sync(): Promise<void> {
    this.syncing ??= (async () => {
      try {
        const result = await syncAccountLog(this.d.futures, this.d.store);
        this.lastSync = { atMs: this.now(), result };
      } catch (e) {
        this.lastSync = { atMs: this.now(), ...(this.lastSync?.result ? { result: this.lastSync.result } : {}), error: errText(e) };
        log.warn("account log sync failed", { error: errText(e) });
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  private async refreshFx(): Promise<void> {
    const pair = this.fxPair;
    if (!pair || !this.d.quotes) return;
    const latest = this.d.store.latestRate(pair);
    const maxAge = this.d.fxMaxAgeMs ?? 15 * 60_000;
    if (this.now() - this.fxCheckedMs < maxAge && latest) return;
    this.fxCheckedMs = this.now();
    try {
      const [q] = await this.d.quotes.quotes([pair]);
      const t = q ? Date.parse(q.marketTime) : Number.NaN;
      if (!q || !(q.price > 0) || !Number.isFinite(t)) throw new Error(`no rate for ${pair}`);
      this.d.store.saveRate(pair, t, q.price);
      this.fxError = undefined;
    } catch (e) {
      this.fxError = errText(e);
      log.warn("FX rate refresh failed; using the last stored rate", { pair, error: this.fxError });
    }
  }

  private async openPositions(): Promise<{ value?: FuturesPosition[]; error?: string }> {
    const ttl = this.d.positionsTtlMs ?? 30_000;
    if (this.positions && this.now() - this.positions.atMs < ttl) return this.positions;
    try {
      this.positions = { atMs: this.now(), value: await this.d.futures.openPositions() };
    } catch (e) {
      this.positions = { atMs: this.now(), error: errText(e) };
    }
    return this.positions;
  }

  async payload(forceSync = false): Promise<DashboardPayload> {
    const maxAge = this.d.syncMaxAgeMs ?? 60_000;
    if (forceSync || !this.lastSync || this.now() - this.lastSync.atMs > maxAge) await this.sync();
    const [, positions] = await Promise.all([this.refreshFx(), this.openPositions()]);
    const pair = this.fxPair;
    const rate = pair ? this.d.store.latestRate(pair) : undefined;
    return {
      stats: accountStats(this.d.store.entries(), positions.value, this.now()),
      currency: this.d.currency.toUpperCase(),
      fx: pair && rate ? {
        pair, rate: rate.rate, time: new Date(rate.tMs).toISOString(), stale: this.fxError !== undefined,
        ...(this.fxError ? { error: this.fxError } : {}),
      } : undefined,
      sync: { at: this.lastSync ? new Date(this.lastSync.atMs).toISOString() : undefined, result: this.lastSync?.result, error: this.lastSync?.error },
      positionsError: positions.error,
    };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(await readFile(PAGE, "utf8"));
      } else if (req.method === "GET" && url.pathname === "/api/stats") {
        const body = JSON.stringify(await this.payload(url.searchParams.get("refresh") === "1"));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (e) {
      log.error("request failed", { path: url.pathname, error: errText(e) });
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`error: ${errText(e)}`);
    }
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

async function main(): Promise<void> {
  const host = process.env.DASHBOARD_HOST ?? "127.0.0.1";
  const port = Number(process.env.DASHBOARD_PORT ?? 3001);
  if (!LOOPBACK.has(host) && process.env.DASHBOARD_ALLOW_REMOTE !== "true") {
    throw new Error(`DASHBOARD_HOST=${host} is not a loopback address; the page shows account data. Set DASHBOARD_ALLOW_REMOTE=true to allow it.`);
  }
  const apiKey = process.env.KRAKEN_FUTURES_RO_API_KEY;
  const apiSecret = process.env.KRAKEN_FUTURES_RO_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("KRAKEN_FUTURES_RO_API_KEY and KRAKEN_FUTURES_RO_API_SECRET are needed (read-only keys)");

  const dbPath = process.env.CACHE_DB_PATH ?? join(homedir(), ".krypto-kal", "cache.db");
  const dashboard = new Dashboard({
    futures: new KrakenFuturesClient({ apiKey, apiSecret, tradingEnabled: false }),
    quotes: process.env.YAHOO_ENABLED?.toLowerCase() === "false" ? undefined : new YahooClient(),
    store: new AccountLogStore(dbPath),
    currency: process.env.DASHBOARD_CURRENCY ?? "PLN",
  });

  const every = Number(process.env.DASHBOARD_SYNC_MINUTES ?? 5);
  await dashboard.sync(); // the first run reads the whole history before the page opens
  setInterval(() => void dashboard.sync(), Math.max(1, every) * 60_000).unref();

  createServer((req, res) => void dashboard.handle(req, res)).listen(port, host, () => {
    log.info("dashboard listening", { url: `http://${host}:${port}/`, db: dbPath, syncEveryMinutes: every });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    log.error("dashboard failed to start", { error: errText(e) });
    process.exit(1);
  });
}
