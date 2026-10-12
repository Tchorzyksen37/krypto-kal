// present/records.ts – the non-series tool results as text the model reads, with the same rules as the tables: a
// header that says what, when and how fresh, units once, ISO UTC times, per-field rounding, empty cells for missing
// values, and N next to every rate. Pure; `asOf` is passed in.

import type { YahooQuote } from "../providers/yahoo/yahoo-client.ts";
import type { RawXPost } from "../brain/x-sync.ts";
import type { ClosedTrade, FillSyncResult, PnlFill, PnlReport, PnlSummary } from "../trading/futures-pnl.ts";
import { wilson } from "../speculation/stats.ts";
import { PERCENT, PRICE, QUANTITY, num, round } from "./round.ts";
import { PresentedText, duration, isoMinute } from "./table.ts";
import { QUOTE_STALE_MINUTES } from "./thresholds.ts";

// A CSV cell: text with a comma, quote or line break is quoted (RFC 4180), so the columns stay aligned.
export function cell(v: string | number | undefined | null): string {
  if (v === undefined || v === null) return "";
  const s = typeof v === "number" ? num(v) : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (cells: (string | number | undefined | null)[]) => cells.map(cell).join(",");
const isoMs = (ms: number) => isoMinute(Math.floor(ms / 1000));
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const r = (x: number | undefined | null, rule = PRICE) => (x === undefined || x === null || !Number.isFinite(x) ? undefined : round(x, rule));
const money = (x: number | undefined | null) => (x === undefined || x === null || !Number.isFinite(x) ? undefined : Number(x.toFixed(2)));

// ---- yahoo_quote ----

export function renderQuotes(quotes: YahooQuote[], asOfSec: number): PresentedText {
  const lines = [
    `yahoo_quote: ${quotes.length} quote${quotes.length === 1 ? "" : "s"}; as of ${isoMinute(asOfSec)}`,
    "units: price, change, previous_close, day_low, day_high in the instrument's currency; change_pct in %; market_time = time of the last price (UTC)",
    `state: "fresh" when the last price is at most ${QUOTE_STALE_MINUTES} min old; otherwise "stale" with the weekday of the last price (weekend, holiday or closed market: not a live signal)`,
    "symbol,name,type,currency,price,change,change_pct,previous_close,day_low,day_high,volume,market_time,age,state",
  ];
  for (const q of quotes) {
    const t = Date.parse(q.marketTime);
    const age = Number.isFinite(t) ? asOfSec - Math.floor(t / 1000) : undefined;
    const state = age === undefined ? "unknown" : age <= QUOTE_STALE_MINUTES * 60 ? "fresh" : `stale (last price ${WEEKDAY[new Date(t).getUTCDay()]})`;
    lines.push(row([
      q.symbol, q.name, q.type, q.currency, r(q.price), r(q.change), r(q.changePercent, PERCENT), r(q.previousClose),
      r(q.dayLow), r(q.dayHigh), r(q.volume, QUANTITY), Number.isFinite(t) ? isoMs(t) : q.marketTime, age === undefined ? undefined : duration(age), state,
    ]));
  }
  return new PresentedText(lines.join("\n"), quotes.length);
}

// ---- kraken_futures_fills ----

function syncLine(sync: FillSyncResult): string {
  return `sync: ${sync.inserted} new of ${sync.fetched} fetched in ${sync.pages} page${sync.pages === 1 ? "" : "s"}; ${sync.totalFills} fills stored, history known from ${sync.firstFill ?? "no fill yet"}${sync.skippedSymbols.length ? `; not netted into trades (not linear): ${sync.skippedSymbols.join(", ")}` : ""}`;
}

export function renderFills(sync: FillSyncResult, fills: PnlFill[], asOfSec: number): PresentedText {
  const bySymbol = new Map<string, { n: number; buy: number; sell: number; maker: number; taker: number }>();
  for (const f of fills) {
    const s = bySymbol.get(f.symbol) ?? { n: 0, buy: 0, sell: 0, maker: 0, taker: 0 };
    s.n++;
    s[f.side] += f.size;
    if (f.fillType === "maker") s.maker++;
    else if (f.fillType === "taker") s.taker++;
    bySymbol.set(f.symbol, s);
  }
  const lines = [
    `kraken_futures_fills: ${fills.length} fill${fills.length === 1 ? "" : "s"}, newest first${fills.length ? `, ${isoMs(fills[fills.length - 1]!.ts)} .. ${isoMs(fills[0]!.ts)}` : ""}; as of ${isoMinute(asOfSec)}`,
    syncLine(sync),
    "units: size in contracts; price in USD; notional_usd = size x price (linear PF_/FF_ contracts); fill_type as Kraken reports it (maker, taker, liquidation, ...)",
  ];
  if (bySymbol.size) {
    lines.push(`summary: ${[...bySymbol].sort(([a], [b]) => a.localeCompare(b)).map(([sym, s]) => `${sym} ${s.n} fills (bought ${num(r(s.buy, QUANTITY))}, sold ${num(r(s.sell, QUANTITY))}; maker ${s.maker}, taker ${s.taker}, other ${s.n - s.maker - s.taker})`).join("; ")}`);
  }
  lines.push("time,symbol,side,size,price,notional_usd,fill_type,order_id,fill_id");
  for (const f of fills) lines.push(row([isoMs(f.ts), f.symbol, f.side, r(f.size, QUANTITY), r(f.price), money(f.size * f.price), f.fillType, f.orderId, f.id]));
  return new PresentedText(lines.join("\n"), fills.length);
}

// ---- kraken_futures_pnl ----

function summaryText(s: PnlSummary): string {
  if (!s.trades) return "no closed trades";
  const ci = wilson(s.wins, s.trades);
  return [
    `${s.trades} trades (${s.wins} wins, ${s.losses} losses)`,
    `win rate ${s.winRate === null ? "n/a" : `${(s.winRate * 100).toFixed(1)}%`}${ci ? ` [95%: ${(ci.lo * 100).toFixed(0)}-${(ci.hi * 100).toFixed(0)}%] (N=${s.trades})` : ""}`,
    `total ${num(money(s.totalPnl))} USD (profit ${num(money(s.grossProfit))}, loss ${num(money(s.grossLoss))})`,
    `profit factor ${s.profitFactor === null ? "n/a (no losses)" : s.profitFactor.toFixed(2)}`,
    `avg win ${num(money(s.avgWin)) || "n/a"}, avg loss ${num(money(s.avgLoss)) || "n/a"}`,
    `best ${num(money(s.bestTrade)) || "n/a"}, worst ${num(money(s.worstTrade)) || "n/a"}`,
    `max drawdown ${num(money(s.maxDrawdown))} USD`,
    `avg hold ${s.avgHoldSeconds === null ? "n/a" : duration(s.avgHoldSeconds)}`,
  ].join("; ");
}

export function renderPnl(sync: FillSyncResult, rep: PnlReport, recent: ClosedTrade[], asOfSec: number): PresentedText {
  const lines = [
    `kraken_futures_pnl: realized PnL of closed trades (flat to flat, average-cost netting); as of ${isoMinute(asOfSec)}`,
    syncLine(sync),
    "units: USD; gross of fees and funding; linear contracts (PF_/FF_) only; a position opened before the known history is misread",
    `summary: ${summaryText(rep.summary)}`,
  ];
  const symbols = Object.keys(rep.bySymbol).sort();
  if (symbols.length) {
    lines.push("", "by symbol:", "symbol,trades,wins,win_rate_pct,total_pnl,profit_factor,max_drawdown");
    for (const sym of symbols) {
      const s = rep.bySymbol[sym]!;
      lines.push(row([sym, s.trades, s.wins, s.winRate === null ? undefined : r(s.winRate * 100, PERCENT), money(s.totalPnl), s.profitFactor === null ? undefined : r(s.profitFactor, PERCENT), money(s.maxDrawdown)]));
    }
  }
  if (rep.byDay.length) {
    lines.push("", "by UTC day (closing day):", "day,trades,pnl,cumulative_pnl");
    for (const d of rep.byDay) lines.push(row([d.day, d.trades, money(d.pnl), money(d.cumulativePnl)]));
  }
  if (recent.length) {
    lines.push("", `most recent ${recent.length} closed trade${recent.length === 1 ? "" : "s"}, newest first:`, "closed_at,opened_at,symbol,direction,size,entry_price,exit_price,pnl,held,fills");
    for (const t of recent) {
      lines.push(row([isoMs(t.closedAt), isoMs(t.openedAt), t.symbol, t.direction, r(t.size, QUANTITY), r(t.entryPrice), r(t.exitPrice), money(t.pnl), duration((t.closedAt - t.openedAt) / 1000), t.fills]));
    }
  }
  return new PresentedText(lines.join("\n"), recent.length);
}

// ---- x_recent ----

export function renderPosts(posts: RawXPost[], asOfSec: number, hours: number, maxChars: number): PresentedText {
  const newest = posts[0] ? Date.parse(posts[0].created_at) : undefined;
  const lines = [
    `x_recent: ${posts.length} archived post${posts.length === 1 ? "" : "s"} from the last ${hours}h, newest first; as of ${isoMinute(asOfSec)}`,
    newest !== undefined && Number.isFinite(newest)
      ? `newest post ${duration(asOfSec - Math.floor(newest / 1000))} old; the archive only holds what x_sync fetched, so an empty stretch is not "no news"`
      : "no posts in the window; the archive only holds what x_sync fetched, so this is not \"no news\"",
    `format: time UTC (age) @author [category, kind]: text (line breaks removed, cut at ${maxChars} chars; brain_read the path for the full post)`,
  ];
  for (const p of posts) {
    const t = Date.parse(p.created_at);
    const text = p.text.replace(/\s+/g, " ").trim();
    const cut = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
    const when = Number.isFinite(t) ? `${isoMs(t)} (${duration(asOfSec - Math.floor(t / 1000))})` : p.created_at;
    lines.push(`- ${when} @${p.author} [${p.category || "?"}, ${p.kind || "?"}]: ${cut} (${p.path})`);
  }
  return new PresentedText(lines.join("\n"), posts.length);
}
