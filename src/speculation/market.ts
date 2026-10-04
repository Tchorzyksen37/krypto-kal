// speculation/market.ts – measurements taken from raw Kraken Futures data, so prices, ATR, spread, depth and
// funding in a report come from code, not from the model. Pure.

import type { FuturesCandle, FuturesOrderBook, FuturesTicker } from "../providers/kraken/kraken-futures-client.ts";

const round = (x: number, digits = 6) => Number(x.toPrecision(digits));

// True range of each candle after the first: max(high, prev close) - min(low, prev close).
export function trueRanges(candles: FuturesCandle[]): number[] {
  const c = [...candles].sort((a, b) => a.t - b.t);
  const out: number[] = [];
  for (let i = 1; i < c.length; i++) out.push(Math.max(c[i]!.h, c[i - 1]!.c) - Math.min(c[i]!.l, c[i - 1]!.c));
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface Volatility {
  atr_1h: number; // mean true range of the last 14 hourly candles
  atrRatio: number; // mean TR of the last 3 hours / median TR of the last 24 (> 1 = volatility expanding)
}

// From hourly candles (at least 15; 25+ for the ratio). Undefined when there are too few.
export function volatility(hourly: FuturesCandle[]): Volatility | undefined {
  const tr = trueRanges(hourly);
  if (tr.length < 14) return undefined;
  const atr = tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const recent = tr.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, tr.length);
  const base = median(tr.slice(-24));
  return { atr_1h: round(atr), atrRatio: base > 0 ? round(recent / base, 3) : 1 };
}

// Hourly candles are complete when the last 24 hours have no missing hour and the newest one is recent.
export function candlesOk(hourly: FuturesCandle[], nowSec: number): boolean {
  const c = [...hourly].sort((a, b) => a.t - b.t).filter((x) => x.t >= nowSec - 25 * 3600);
  if (c.length < 23) return false;
  for (let i = 1; i < c.length; i++) if (c[i]!.t - c[i - 1]!.t > 3600) return false;
  return nowSec - c[c.length - 1]!.t <= 2 * 3600;
}

export const spreadBps = (t: Pick<FuturesTicker, "bid" | "ask">) =>
  t.bid > 0 && t.ask > 0 ? round(((t.ask - t.bid) / ((t.ask + t.bid) / 2)) * 10_000, 4) : Number.POSITIVE_INFINITY;

// USD depth within `withinPct` of mid on the thinner side. PF_ (linear) contracts are one unit of the base asset,
// so price x size is USD.
export function depthUsd(book: FuturesOrderBook, withinPct = 0.2): number {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (!bestBid || !bestAsk) return 0;
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - withinPct / 100);
  const hi = mid * (1 + withinPct / 100);
  const bid = book.bids.filter((l) => l.price >= lo).reduce((a, l) => a + l.price * l.size, 0);
  const ask = book.asks.filter((l) => l.price <= hi).reduce((a, l) => a + l.price * l.size, 0);
  return round(Math.min(bid, ask), 6);
}

// Kraken's `fundingRate` is absolute funding per contract per hour (quote currency); expressed here as percent
// per 8 hours of the mark price, the convention most venues quote and the screen's thresholds assume.
export const fundingPct8h = (t: Pick<FuturesTicker, "fundingRate" | "markPrice">) =>
  t.fundingRate !== undefined && t.markPrice > 0 ? round((t.fundingRate / t.markPrice) * 8 * 100, 4) : 0;

export const volumeUsd24h = (t: Pick<FuturesTicker, "volumeQuote" | "vol24h" | "last">) => t.volumeQuote ?? t.vol24h * t.last;
export const openInterestUsd = (t: Pick<FuturesTicker, "openInterest" | "markPrice">) => t.openInterest * t.markPrice;

// PF_XBTUSD -> BTC, PF_ETHUSD -> ETH (Kraken calls bitcoin XBT).
export function baseOf(futures: string): string {
  const m = /^PF_([A-Z0-9]+?)USD$/i.exec(futures);
  const base = (m?.[1] ?? futures).toUpperCase();
  return base === "XBT" ? "BTC" : base;
}

export const futuresOf = (symbol: string) => `PF_${symbol.toUpperCase() === "BTC" ? "XBT" : symbol.toUpperCase()}USD`;

export const isLinearPerp = (t: Pick<FuturesTicker, "symbol" | "tag" | "suspended">) =>
  /^PF_/i.test(t.symbol) && (t.tag === undefined || t.tag === "perpetual") && !t.suspended;
