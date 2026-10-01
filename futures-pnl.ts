// futures-pnl.ts – realized profit/loss statistics for Kraken Futures, computed from the account's fills.
// Fills are the source of truth: they are synced into SQLite (TradeStore), turned into closed trades by
// average-cost netting, and summarized. The numbers are GROSS: trading fees and funding payments are not
// included, because the fills endpoint does not carry them reliably.
//
// A "trade" runs from a flat position to the next flat position of one symbol (scaling in/out stays one
// trade; a reversal closes one trade and opens the next). Only linear contracts (PF_, FF_) are supported: their
// PnL is in the quote currency (USD). Inverse contracts (PI_, FI_) pay in the coin and are skipped.

import type { FuturesFill } from "./kraken-futures-client.ts";
import { createLogger } from "./logger.ts";
import type { TradeStore } from "./trade-store.ts";

const log = createLogger("futures-pnl");

const EPS = 1e-9;

export interface PnlFill {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  ts: number; // epoch ms
}

export interface ClosedTrade {
  symbol: string;
  direction: "long" | "short";
  openedAt: number; // epoch ms
  closedAt: number; // epoch ms
  size: number; // largest position held during the trade, in contracts
  entryPrice: number; // volume-weighted average of the opening fills
  exitPrice: number; // volume-weighted average of the closing fills
  pnl: number; // gross realized, quote currency
  fills: number;
}

export const isInverseSymbol = (symbol: string) => /^(PI|FI)_/i.test(symbol);

// Average-cost netting per symbol. A position still open at the end of the fills is not a closed trade.
export function buildTrades(fills: PnlFill[]): { trades: ClosedTrade[]; skippedSymbols: string[] } {
  const bySymbol = new Map<string, PnlFill[]>();
  for (const f of fills) {
    const list = bySymbol.get(f.symbol) ?? [];
    list.push(f);
    bySymbol.set(f.symbol, list);
  }

  const trades: ClosedTrade[] = [];
  const skippedSymbols: string[] = [];

  for (const [symbol, list] of bySymbol) {
    if (isInverseSymbol(symbol)) {
      skippedSymbols.push(symbol);
      continue;
    }
    list.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));

    let pos = 0; // signed contracts
    let avg = 0;
    let cur: { openedAt: number; pnl: number; maxSize: number; inNotional: number; inSize: number; outNotional: number; outSize: number; fills: number } | undefined;

    for (const f of list) {
      let rem = f.side === "buy" ? f.size : -f.size;
      while (Math.abs(rem) > EPS) {
        if (Math.abs(pos) < EPS) {
          pos = 0;
          cur = { openedAt: f.ts, pnl: 0, maxSize: 0, inNotional: 0, inSize: 0, outNotional: 0, outSize: 0, fills: 0 };
        }
        if (!cur) break; // unreachable: flat always starts a trade
        cur.fills++;
        if (pos === 0 || Math.sign(rem) === Math.sign(pos)) {
          const total = Math.abs(pos) + Math.abs(rem);
          avg = (Math.abs(pos) * avg + Math.abs(rem) * f.price) / total;
          pos += rem;
          cur.inNotional += Math.abs(rem) * f.price;
          cur.inSize += Math.abs(rem);
          cur.maxSize = Math.max(cur.maxSize, Math.abs(pos));
          rem = 0;
        } else {
          const closing = Math.min(Math.abs(rem), Math.abs(pos));
          cur.pnl += closing * (f.price - avg) * Math.sign(pos);
          cur.outNotional += closing * f.price;
          cur.outSize += closing;
          const direction = pos > 0 ? "long" : "short";
          pos += Math.sign(rem) * closing;
          rem -= Math.sign(rem) * closing;
          if (Math.abs(pos) < EPS) {
            trades.push({
              symbol, direction, openedAt: cur.openedAt, closedAt: f.ts, size: cur.maxSize,
              entryPrice: cur.inNotional / cur.inSize, exitPrice: cur.outNotional / cur.outSize, pnl: cur.pnl, fills: cur.fills,
            });
            pos = 0;
            avg = 0;
            cur = undefined;
          }
        }
      }
    }
  }
  trades.sort((a, b) => a.closedAt - b.closedAt);
  return { trades, skippedSymbols };
}

export interface PnlSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null; // fraction of trades with pnl > 0
  totalPnl: number;
  grossProfit: number;
  grossLoss: number; // negative
  profitFactor: number | null; // grossProfit / |grossLoss|; null without losses
  avgWin: number | null;
  avgLoss: number | null; // negative
  bestTrade: number | null;
  worstTrade: number | null;
  avgHoldSeconds: number | null;
  maxDrawdown: number; // largest peak-to-trough fall of the cumulative realized pnl (>= 0)
}

export function summarize(trades: ClosedTrade[]): PnlSummary {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const wins = sorted.filter((t) => t.pnl > 0);
  const losses = sorted.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of sorted) {
    cumulative += t.pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const pnls = sorted.map((t) => t.pnl);
  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRate: sorted.length ? wins.length / sorted.length : null,
    totalPnl: grossProfit + grossLoss,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss < 0 ? grossProfit / -grossLoss : null,
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? grossLoss / losses.length : null,
    bestTrade: pnls.length ? Math.max(...pnls) : null,
    worstTrade: pnls.length ? Math.min(...pnls) : null,
    avgHoldSeconds: sorted.length ? sorted.reduce((s, t) => s + (t.closedAt - t.openedAt) / 1000, 0) / sorted.length : null,
    maxDrawdown,
  };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface PnlReport {
  summary: PnlSummary;
  bySymbol: Record<string, PnlSummary>;
  byDay: { day: string; trades: number; pnl: number; cumulativePnl: number }[];
}

export function report(trades: ClosedTrade[]): PnlReport {
  const symbols = [...new Set(trades.map((t) => t.symbol))].sort();
  const days = new Map<string, { trades: number; pnl: number }>();
  for (const t of [...trades].sort((a, b) => a.closedAt - b.closedAt)) {
    const d = days.get(utcDay(t.closedAt)) ?? { trades: 0, pnl: 0 };
    d.trades++;
    d.pnl += t.pnl;
    days.set(utcDay(t.closedAt), d);
  }
  let cumulativePnl = 0;
  return {
    summary: summarize(trades),
    bySymbol: Object.fromEntries(symbols.map((s) => [s, summarize(trades.filter((t) => t.symbol === s))])),
    byDay: [...days].map(([day, d]) => ({ day, trades: d.trades, pnl: d.pnl, cumulativePnl: (cumulativePnl += d.pnl) })),
  };
}

export const toPnlFill = (f: FuturesFill): PnlFill => ({
  id: f.fill_id, symbol: f.symbol, side: f.side, size: Number(f.size), price: Number(f.price), ts: Date.parse(f.fillTime),
});

export interface FillSource {
  fills(lastFillTime?: string): Promise<FuturesFill[]>;
}

export interface FillSyncResult {
  pages: number;
  fetched: number;
  inserted: number;
  skippedSymbols: string[];
  totalFills: number;
  closedTrades: number;
  firstFill: string | null; // history before this is unknown: a position opened earlier would be misread
}

// Pulls fills newest-first (100 per page) until it reaches ones already stored (with a 1 min overlap), then
// rebuilds the closed trades from all stored fills. The first run walks back up to `maxPages` pages.
export async function syncFills(source: FillSource, db: TradeStore, maxPages = 50): Promise<FillSyncResult> {
  const stopBefore = (db.newestFillTs() ?? 0) - 60_000;
  let cursor: string | undefined;
  let cursorTs = Infinity;
  let pages = 0;
  let fetched = 0;
  let inserted = 0;

  while (pages < maxPages) {
    const page = (await source.fills(cursor)).map(toPnlFill).filter((f) => Number.isFinite(f.ts));
    pages++;
    if (page.length === 0) break;
    fetched += page.length;
    inserted += db.saveFills(page);
    const oldest = Math.min(...page.map((f) => f.ts));
    if (oldest <= stopBefore || oldest >= cursorTs) break; // caught up, or the cursor did not move
    cursor = new Date(oldest).toISOString();
    cursorTs = oldest;
  }
  if (pages >= maxPages) log.warn("fill history truncated at the page limit", { maxPages });

  const { trades, skippedSymbols } = buildTrades(db.fills());
  db.replaceTrades(trades);
  const first = db.oldestFillTs();
  log.info("futures fills synced", { pages, fetched, inserted, trades: trades.length });
  return {
    pages, fetched, inserted, skippedSymbols, totalFills: db.countFills(), closedTrades: trades.length,
    firstFill: first === undefined ? null : new Date(first).toISOString(),
  };
}
