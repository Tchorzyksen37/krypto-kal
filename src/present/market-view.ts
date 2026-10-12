// present/market-view.ts – the joined market view of one asset as the text the model reads: the provider series are
// joined on the bar time into one table (Coinalyze OHLCV, open interest, funding, long/short, liquidations, plus the
// Kraken Futures close), the facts are computed from the closed bars, and the table keeps the newest bars at their
// native interval within a row budget. Pure: the server fetches, this module only shapes. Deterministic for a given
// input and asOf.

import type { LiquidationPoint, LongShortPoint, OhlcPoint, OhlcvPoint } from "../providers/coinalyze/coinalyze-client.ts";
import type { FuturesCandle } from "../providers/kraken/kraken-futures-client.ts";
import { type KrakenContext, type MarketPoint, marketFacts } from "./facts.ts";
import { DEFAULT_RECENT_ROWS, PresentedText, isoMinute, renderSeries } from "./table.ts";
import { MARKET_VIEW } from "./units.ts";

export interface MarketViewInput {
  asset: string; // BTC
  symbol: string; // Coinalyze symbol, BTCUSDT_PERP.A
  intervalSec: number;
  asOfSec: number;
  ohlcv: OhlcvPoint[];
  openInterest: OhlcPoint[]; // USD
  funding: OhlcPoint[];
  longShort: LongShortPoint[];
  liquidations: LiquidationPoint[]; // USD
  kraken?: KrakenContext & { candles: FuturesCandle[] };
  maxRows?: number;
  recentRows?: number;
  failed?: string[]; // series that could not be fetched, e.g. "long/short (http 500)"
}

// Outer join on t; the later source wins a field it shares with an earlier one (none overlap here).
export function joinMarket(i: Pick<MarketViewInput, "ohlcv" | "openInterest" | "funding" | "longShort" | "liquidations"> & { krakenCandles?: FuturesCandle[] }): MarketPoint[] {
  const byT = new Map<number, MarketPoint>();
  const put = (t: number, fields: Partial<MarketPoint>) => {
    if (!Number.isFinite(t)) return;
    byT.set(t, { ...(byT.get(t) ?? { t }), ...fields });
  };
  for (const p of i.ohlcv) put(p.t, { o: p.o, h: p.h, l: p.l, c: p.c, v: p.v, bv: p.bv });
  for (const p of i.openInterest) put(p.t, { oi: p.c });
  for (const p of i.funding) put(p.t, { fr: p.c });
  for (const p of i.longShort) put(p.t, { ls: p.r });
  for (const p of i.liquidations) put(p.t, { liqL: p.l, liqS: p.s });
  for (const p of i.krakenCandles ?? []) put(p.t, { kf: p.c });
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export function renderMarketView(i: MarketViewInput): PresentedText {
  const points = joinMarket({ ...i, ...(i.kraken ? { krakenCandles: i.kraken.candles } : {}) });
  const closed = points.filter((p) => p.t + i.intervalSec <= i.asOfSec);
  const lastClosed = closed.at(-1)?.t;
  const notes = [
    lastClosed !== undefined
      ? `facts use the ${closed.length} closed bars through ${isoMinute(lastClosed)}; the table also shows the open bar`
      : "facts: no closed bar yet",
  ];
  if (i.failed?.length) notes.push(`not available: ${i.failed.join("; ")} (their columns are empty)`);
  const source = `${i.asset} (Coinalyze ${i.symbol}${i.kraken ? `; Kraken Futures ${i.kraken.symbol}` : ""})`;
  const text = renderSeries(MARKET_VIEW, points, {
    tool: "market_view", symbol: source, intervalSec: i.intervalSec, asOfSec: i.asOfSec, notes,
    facts: marketFacts(closed, i.intervalSec, i.kraken),
    ...(i.maxRows ? { maxRows: i.maxRows, recentRows: i.recentRows ?? DEFAULT_RECENT_ROWS } : {}),
  });
  return new PresentedText(text, points.length);
}
