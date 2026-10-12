import assert from "node:assert/strict";
import { test } from "node:test";
import type { YahooQuote } from "../providers/yahoo/yahoo-client.ts";
import type { ClosedTrade, FillSyncResult, PnlFill } from "../trading/futures-pnl.ts";
import { report } from "../trading/futures-pnl.ts";
import { cell, renderFills, renderPnl, renderPosts, renderQuotes } from "./records.ts";
import { duration, renderSeries } from "./table.ts";
import { KRAKEN_SPOT_OHLC, YAHOO_BARS } from "./units.ts";

const AS_OF = Date.parse("2026-10-12T09:00:00Z") / 1000; // a Monday
const H = 3600;

const quote = (symbol: string, marketTime: string, extra: Partial<YahooQuote> = {}): YahooQuote => ({
  symbol, name: undefined, type: "INDEX", currency: "USD", exchange: undefined, price: 5678.89990234375, previousClose: 5600,
  change: 78.89990234375, changePercent: 1.40892, dayHigh: 5700.5, dayLow: 5590.25, volume: 0, fiftyTwoWeekHigh: undefined,
  fiftyTwoWeekLow: undefined, marketTime, timezone: undefined, ...extra,
});

test("CSV cells quote commas, quotes and line breaks", () => {
  assert.equal(cell("S&P 500"), "S&P 500");
  assert.equal(cell('Apple, Inc. "AAPL"'), '"Apple, Inc. ""AAPL"""');
  assert.equal(cell("a\nb"), '"a\nb"');
  assert.equal(cell(undefined), "");
  assert.equal(cell(1.5e-7), "0.00000015");
});

test("golden: quotes with fresh and stale states", () => {
  const text = renderQuotes([
    quote("ES=F", "2026-10-12T08:55:00Z", { name: "E-mini S&P 500, Dec 26", type: "FUTURE" }),
    quote("^GSPC", "2026-10-09T20:00:00Z", { name: "S&P 500" }),
  ], AS_OF).text;
  assert.equal(text, [
    "yahoo_quote: 2 quotes; as of 2026-10-12T09:00Z",
    "units: price, change, previous_close, day_low, day_high in the instrument's currency; change_pct in %; market_time = time of the last price (UTC)",
    'state: "fresh" when the last price is at most 30 min old; otherwise "stale" with the weekday of the last price (weekend, holiday or closed market: not a live signal)',
    "symbol,name,type,currency,price,change,change_pct,previous_close,day_low,day_high,volume,market_time,age,state",
    'ES=F,"E-mini S&P 500, Dec 26",FUTURE,USD,5678.9,78.8999,1.41,5600,5590.25,5700.5,0,2026-10-12T08:55Z,5m,fresh',
    "^GSPC,S&P 500,INDEX,USD,5678.9,78.8999,1.41,5600,5590.25,5700.5,0,2026-10-09T20:00Z,2d 13h,stale (last price Fri)",
  ].join("\n"));
});

const sync: FillSyncResult = { pages: 1, fetched: 3, inserted: 2, skippedSymbols: [], totalFills: 40, closedTrades: 12, firstFill: "2026-09-01T10:00:00.000Z" };

test("golden: fills table with a per-symbol summary", () => {
  const fills: PnlFill[] = [
    { id: "f3", ts: Date.parse("2026-10-12T08:30:00Z"), symbol: "PF_XBTUSD", side: "sell", size: 0.002, price: 62150.5, orderId: "o2", fillType: "taker" },
    { id: "f2", ts: Date.parse("2026-10-12T07:00:00Z"), symbol: "PF_XBTUSD", side: "buy", size: 0.002, price: 61900, orderId: "o1", fillType: "maker" },
    { id: "f1", ts: Date.parse("2026-10-11T22:00:00Z"), symbol: "PF_XRPUSD", side: "buy", size: 100, price: 0.5234567 },
  ];
  assert.equal(renderFills(sync, fills, AS_OF).text, [
    "kraken_futures_fills: 3 fills, newest first, 2026-10-11T22:00Z .. 2026-10-12T08:30Z; as of 2026-10-12T09:00Z",
    "sync: 2 new of 3 fetched in 1 page; 40 fills stored, history known from 2026-09-01T10:00:00.000Z",
    "units: size in contracts; price in USD; notional_usd = size x price (linear PF_/FF_ contracts); fill_type as Kraken reports it (maker, taker, liquidation, ...)",
    "summary: PF_XBTUSD 2 fills (bought 0.002, sold 0.002; maker 1, taker 1, other 0); PF_XRPUSD 1 fills (bought 100, sold 0; maker 0, taker 0, other 1)",
    "time,symbol,side,size,price,notional_usd,fill_type,order_id,fill_id",
    "2026-10-12T08:30Z,PF_XBTUSD,sell,0.002,62150.5,124.3,taker,o2,f3",
    "2026-10-12T07:00Z,PF_XBTUSD,buy,0.002,61900,123.8,maker,o1,f2",
    "2026-10-11T22:00Z,PF_XRPUSD,buy,100,0.5234567,52.35,,,f1",
  ].join("\n"));
});

test("PnL: summary with N and a 95% interval, per symbol, per day, recent trades", () => {
  const t = (i: number, pnl: number, symbol = "PF_XBTUSD"): ClosedTrade => ({
    symbol, direction: i % 2 ? "short" : "long", openedAt: Date.parse("2026-10-10T08:00:00Z") + i * 3_600_000,
    closedAt: Date.parse("2026-10-10T09:30:00Z") + i * 3_600_000, size: 0.01, entryPrice: 62000, exitPrice: 62000 + pnl * 100, pnl, fills: 2,
  });
  const trades = [t(0, 12.5), t(1, -5), t(2, 7.25), t(3, -3, "PF_ETHUSD")];
  const text = renderPnl(sync, report(trades), trades.slice(-2).reverse(), AS_OF).text;
  assert.match(text, /\nsummary: 4 trades \(2 wins, 2 losses\); win rate 50\.0% \[95%: 15-85%\] \(N=4\); total 11\.75 USD \(profit 19\.75, loss -8\); profit factor 2\.47; avg win 9\.88, avg loss -4; best 12\.5, worst -5; max drawdown 5 USD; avg hold 1h 30m\n/);
  assert.match(text, /\nby symbol:\nsymbol,trades,wins,win_rate_pct,total_pnl,profit_factor,max_drawdown\nPF_ETHUSD,1,0,0,-3,0,3\nPF_XBTUSD,3,2,66\.67,14\.75,3\.95,5\n/);
  assert.match(text, /\nby UTC day \(closing day\):\nday,trades,pnl,cumulative_pnl\n2026-10-10,4,11\.75,11\.75\n/);
  assert.match(text, /\nclosed_at,opened_at,symbol,direction,size,entry_price,exit_price,pnl,held,fills\n2026-10-10T12:30Z,2026-10-10T11:00Z,PF_ETHUSD,short,0\.01,62000,61700,-3,1h 30m,2\n2026-10-10T11:30Z,2026-10-10T10:00Z,PF_XBTUSD,long,0\.01,62000,62725,7\.25,1h 30m,2$/);
  assert.match(renderPnl(sync, report([]), [], AS_OF).text, /\nsummary: no closed trades$/);
});

test("posts: one line each, newest age in the header, long text cut", () => {
  const posts = [
    { path: "raw/x/2026-10-12/Reuters-2.md", author: "Reuters", created_at: "2026-10-12T08:45:00.000Z", url: "", category: "wire", verified_type: "business", kind: "post", text: "Iran says\nthe strait stays open, officials report" },
    { path: "raw/x/2026-10-11/IDF-1.md", author: "IDF", created_at: "2026-10-11T23:00:00.000Z", url: "", category: "official", verified_type: "government", kind: "reply", text: "x".repeat(100) },
  ];
  const text = renderPosts(posts, AS_OF, 24, 50).text.split("\n");
  assert.equal(text[0], "x_recent: 2 archived posts from the last 24h, newest first; as of 2026-10-12T09:00Z");
  assert.match(text[1]!, /^newest post 15m old;/);
  assert.equal(text[3], "- 2026-10-12T08:45Z (15m) @Reuters [wire, post]: Iran says the strait stays open, officials report (raw/x/2026-10-12/Reuters-2.md)");
  assert.equal(text[4], `- 2026-10-11T23:00Z (10h) @IDF [official, reply]: ${"x".repeat(49)}… (raw/x/2026-10-11/IDF-1.md)`);
  assert.match(renderPosts([], AS_OF, 6, 280).text, /\nno posts in the window; the archive only holds what x_sync fetched/);
});

test("Yahoo bars: breaks instead of gaps, and the age of the newest bar", () => {
  // Friday 19:00-20:00 UTC, then Monday 13:00: the weekend is a break, not missing data.
  const fri = Date.parse("2026-10-09T19:00:00Z") / 1000;
  const mon = Date.parse("2026-10-12T13:00:00Z") / 1000;
  const bars = [fri, fri + H, mon].map((t) => ({ t, o: 5678.89990234375, h: 5700, l: 5600, c: 5650.10009765625, v: 0 }));
  const text = renderSeries(YAHOO_BARS, bars, { tool: "yahoo_history", symbol: "^GSPC", intervalSec: H, asOfSec: mon + 5 * H });
  assert.match(text, /\nas of 2026-10-12T18:00Z; all bars closed; the newest bar ended 4h before as of\n/);
  assert.match(text, /\nbreaks: 1 \(market closed: nights, weekends, holidays; no exchange calendar is applied, so a halt or missing data looks the same\); the longest 2d 16h from 2026-10-09T21:00Z\n/);
  assert.match(text, /\n2026-10-09T19:00Z,5678\.9,5700,5600,5650\.1,0\n/);
});

test("Kraken spot OHLC: the VWAP of a resampled row is volume-weighted", () => {
  const bars = Array.from({ length: 6 }, (_, i) => ({ t: 1759190400 + i * 60, o: 100, h: 101, l: 99, c: 100, vwap: i < 3 ? 100 : 110, v: i < 3 ? 1 : 3, count: 2 }));
  const text = renderSeries(KRAKEN_SPOT_OHLC, bars, { tool: "kraken_ohlc", symbol: "XXBTZUSD", intervalSec: 60, asOfSec: 1759190400 + 3600, maxRows: 4, recentRows: 2 });
  const header = text.split("\n").find((l) => l.startsWith("time,"))!;
  assert.equal(header, "time,open,high,low,close,volume,trades,vwap,bars");
  // The 00:02 bucket holds a bar at VWAP 100 with volume 1 and one at 110 with volume 3: (100 + 330) / 4 = 107.5.
  assert.match(text, /\n2025-09-30T00:00Z,100,101,99,100,2,4,100,2\n2025-09-30T00:02Z,100,101,99,100,4,4,107\.5,2\n/);
});

test("durations", () => {
  assert.deepEqual([0, 59, 60, 3600, 5400, 86_400, 93_600, 230_400].map(duration), ["0m", "0m", "1m", "1h", "1h 30m", "1d", "1d 2h", "2d 16h"]);
});
