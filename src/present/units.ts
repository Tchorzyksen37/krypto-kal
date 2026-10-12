// present/units.ts – what each series kind looks like to the model: column names (with the unit in the name where
// it varies), the rounding rule of each column, how a column aggregates when bars are resampled, and the unit lines
// written once in the header. Values are never converted here beyond scaling USD columns; what a provider reports is
// labelled, not reinterpreted (e.g. Coinalyze funding stays % per the exchange's own funding interval).

import type { LiquidationPoint, LongShortPoint, OhlcPoint, OhlcvPoint } from "../providers/coinalyze/coinalyze-client.ts";
import type { FuturesCandle } from "../providers/kraken/kraken-futures-client.ts";
import type { KrakenCandle } from "../providers/kraken/kraken-client.ts";
import type { YahooBar } from "../providers/yahoo/yahoo-client.ts";
import type { MarketPoint } from "./facts.ts";
import { COUNT, FUNDING, PERCENT, PRICE, QUANTITY, RATIO, type RoundRule } from "./round.ts";

export type Agg = "first" | "last" | "max" | "min" | "sum";

export interface BaseColumn<P> {
  name: string; // final name, or the stem of a USD column (the scale suffix is appended: oi_close_musd)
  get: (p: P) => number | undefined;
  agg: Agg;
  rule: RoundRule | "usd"; // "usd": one scale for the whole group, picked from the values (round.ts usdScale)
  usdGroup?: string; // columns sharing a scale (oi_open .. oi_close)
  hidden?: boolean; // used by derived columns and facts, not printed in the table
}

export interface DerivedColumn {
  name: string;
  derive: (row: Record<string, number | undefined>) => number | undefined; // from base columns, after resampling
  rule: RoundRule;
}

export type Summary =
  | { kind: "level"; column: string; label: string; relative: boolean; low?: string; high?: string } // first -> last; low / high with times, from the low / high columns when given
  | { kind: "total"; columns: string[]; label: string }; // sums over the window and the largest bar

export interface SeriesSpec<P> {
  title: string; // what the data is, e.g. "Coinalyze OHLCV"
  // "missing" (default): a regular 24/7 series, a missing bar is a gap in the data. "breaks": an exchange-hours series
  // (stocks, indices, FX, CME futures), where nights, weekends and holidays leave breaks that are not missing data.
  gaps?: "missing" | "breaks";
  base: BaseColumn<P>[];
  derived: DerivedColumn[];
  units: string[]; // header lines, one per column family
  summary: Summary;
}

const ohlc = <P extends { o: number; h: number; l: number; c: number }>(prefix: string, rule: RoundRule | "usd", usdGroup?: string): BaseColumn<P>[] => [
  { name: `${prefix}open`, get: (p) => p.o, agg: "first", rule, ...(usdGroup ? { usdGroup } : {}) },
  { name: `${prefix}high`, get: (p) => p.h, agg: "max", rule, ...(usdGroup ? { usdGroup } : {}) },
  { name: `${prefix}low`, get: (p) => p.l, agg: "min", rule, ...(usdGroup ? { usdGroup } : {}) },
  { name: `${prefix}close`, get: (p) => p.c, agg: "last", rule, ...(usdGroup ? { usdGroup } : {}) },
];

const share = (part: number | undefined, whole: number | undefined) =>
  part === undefined || whole === undefined || !(whole > 0) ? undefined : part / whole;

export const COINALYZE_OHLCV: SeriesSpec<OhlcvPoint> = {
  title: "Coinalyze OHLCV",
  base: [
    ...ohlc<OhlcvPoint>("", PRICE),
    { name: "volume", get: (p) => p.v, agg: "sum", rule: QUANTITY },
    { name: "buy_volume", get: (p) => p.bv, agg: "sum", rule: QUANTITY },
    { name: "trades", get: (p) => p.tx, agg: "sum", rule: COUNT },
    { name: "buy_trades", get: (p) => p.btx, agg: "sum", rule: COUNT },
  ],
  derived: [{ name: "taker_buy_share", derive: (r) => share(r.buy_volume, r.volume), rule: RATIO }],
  units: [
    "open, high, low, close: price in the market's quote currency",
    "volume, buy_volume: as reported by Coinalyze (base asset or contracts, depending on the market); buy = taker buys",
    "taker_buy_share = buy_volume / volume (0..1; above 0.5 aggressive buyers dominate)",
  ],
  summary: { kind: "level", column: "close", label: "close", relative: true, low: "low", high: "high" },
};

export function coinalyzeOpenInterest(usd: boolean): SeriesSpec<OhlcPoint> {
  return {
    title: "Coinalyze open interest",
    base: ohlc<OhlcPoint>("oi_", usd ? "usd" : QUANTITY, "oi"),
    derived: [],
    units: [usd ? "oi_*: open interest in USD (scale in the column name)" : "oi_*: open interest in the base asset or contracts, as reported"],
    summary: { kind: "level", column: "oi_close", label: "open interest", relative: true, low: "oi_low", high: "oi_high" },
  };
}

export function coinalyzeFunding(predicted: boolean): SeriesSpec<OhlcPoint> {
  const what = predicted ? "predicted funding rate" : "funding rate";
  return {
    title: `Coinalyze ${what}`,
    base: ohlc<OhlcPoint>("funding_", FUNDING),
    derived: [],
    units: [`funding_*: ${what} in % per the exchange's funding interval (8h on Binance and most exchanges; not normalised); positive = longs pay shorts`],
    summary: { kind: "level", column: "funding_close", label: "funding", relative: false, low: "funding_low", high: "funding_high" },
  };
}

export const COINALYZE_LONG_SHORT: SeriesSpec<LongShortPoint> = {
  title: "Coinalyze long/short ratio",
  base: [
    { name: "long_short_ratio", get: (p) => p.r, agg: "last", rule: RATIO },
    { name: "long_pct", get: (p) => p.l, agg: "last", rule: PERCENT },
    { name: "short_pct", get: (p) => p.s, agg: "last", rule: PERCENT },
  ],
  derived: [],
  units: ["long_pct, short_pct: % of accounts long / short; long_short_ratio = long_pct / short_pct (counts accounts, not position size)"],
  summary: { kind: "level", column: "long_short_ratio", label: "long/short ratio", relative: false },
};

export function coinalyzeLiquidations(usd: boolean): SeriesSpec<LiquidationPoint> {
  const rule = usd ? "usd" : QUANTITY;
  return {
    title: "Coinalyze liquidations",
    base: [
      { name: "liq_long", get: (p) => p.l, agg: "sum", rule, usdGroup: "liq" },
      { name: "liq_short", get: (p) => p.s, agg: "sum", rule, usdGroup: "liq" },
    ],
    derived: [],
    units: [usd
      ? "liq_long, liq_short: liquidated long / short positions in USD per bar (scale in the column name)"
      : "liq_long, liq_short: liquidated long / short positions per bar in the base asset or contracts, as reported"],
    summary: { kind: "total", columns: ["liq_long", "liq_short"], label: "liquidations" },
  };
}

// `aggregate: true` results of the server: USD sums over several symbols, n = symbols with data in the bar.
export const AGGREGATE_OPEN_INTEREST: SeriesSpec<{ t: number; c: number; n: number }> = {
  title: "Coinalyze open interest, summed over symbols",
  base: [
    { name: "oi", get: (p) => p.c, agg: "last", rule: "usd", usdGroup: "oi" },
    { name: "symbols_with_data", get: (p) => p.n, agg: "min", rule: COUNT },
  ],
  derived: [],
  units: ["oi: open interest at the bar close, summed over the symbols, in USD (scale in the column name)", "symbols_with_data: how many symbols had a value in the bar (lower = the sum is incomplete)"],
  summary: { kind: "level", column: "oi", label: "open interest", relative: true },
};

export const AGGREGATE_LIQUIDATIONS: SeriesSpec<{ t: number; l: number; s: number; n: number }> = {
  title: "Coinalyze liquidations, summed over symbols",
  base: [
    { name: "liq_long", get: (p) => p.l, agg: "sum", rule: "usd", usdGroup: "liq" },
    { name: "liq_short", get: (p) => p.s, agg: "sum", rule: "usd", usdGroup: "liq" },
    { name: "symbols_with_data", get: (p) => p.n, agg: "min", rule: COUNT },
  ],
  derived: [],
  units: ["liq_long, liq_short: liquidated long / short positions in USD per bar, summed over the symbols (scale in the column name)", "symbols_with_data: how many symbols had a value in the bar"],
  summary: { kind: "total", columns: ["liq_long", "liq_short"], label: "liquidations" },
};

export const KRAKEN_FUTURES_CANDLES: SeriesSpec<FuturesCandle> = {
  title: "Kraken Futures trade-price candles",
  base: [...ohlc<FuturesCandle>("", PRICE), { name: "volume", get: (p) => p.v, agg: "sum", rule: QUANTITY }],
  derived: [],
  units: ["open, high, low, close: trade price in USD", "volume: contracts traded (contract size per instrument, as Kraken lists it)"],
  summary: { kind: "level", column: "close", label: "close", relative: true, low: "low", high: "high" },
};

// The joined market view (market_view): Coinalyze price, volume, open interest, funding, long/short and liquidations
// of one perpetual, plus the Kraken Futures close of the same bar. buy_volume is only there for taker_buy_share.
export const MARKET_VIEW: SeriesSpec<MarketPoint> = {
  title: "joined market view",
  base: [
    { name: "open", get: (p) => p.o, agg: "first", rule: PRICE },
    { name: "high", get: (p) => p.h, agg: "max", rule: PRICE },
    { name: "low", get: (p) => p.l, agg: "min", rule: PRICE },
    { name: "close", get: (p) => p.c, agg: "last", rule: PRICE },
    { name: "volume", get: (p) => p.v, agg: "sum", rule: QUANTITY },
    { name: "buy_volume", get: (p) => p.bv, agg: "sum", rule: QUANTITY, hidden: true },
    { name: "oi", get: (p) => p.oi, agg: "last", rule: "usd", usdGroup: "oi" },
    { name: "funding", get: (p) => p.fr, agg: "last", rule: FUNDING },
    { name: "long_short_ratio", get: (p) => p.ls, agg: "last", rule: RATIO },
    { name: "liq_long", get: (p) => p.liqL, agg: "sum", rule: "usd", usdGroup: "liq" },
    { name: "liq_short", get: (p) => p.liqS, agg: "sum", rule: "usd", usdGroup: "liq" },
    { name: "kf_close", get: (p) => p.kf, agg: "last", rule: PRICE },
  ],
  derived: [{ name: "taker_buy_share", derive: (r) => share(r.buy_volume, r.volume), rule: RATIO }],
  units: [
    "open..close, volume, taker_buy_share: Coinalyze OHLCV of the perpetual (price in its quote currency, volume as reported)",
    "oi: open interest at the bar close in USD; funding: funding rate at the bar close in % per the exchange's interval; long_short_ratio: accounts long / short",
    "liq_long, liq_short: liquidations per bar in USD; kf_close: Kraken Futures trade-price close of the same bar (empty when not available)",
  ],
  summary: { kind: "level", column: "close", label: "close", relative: true, low: "low", high: "high" },
};

// Yahoo Finance chart bars: exchange hours, so breaks are reported as breaks, not gaps. Prices are split-adjusted, not
// dividend-adjusted; 7 significant figures also remove Yahoo's float32 noise (5678.89990234375 -> 5678.9).
export const YAHOO_BARS: SeriesSpec<YahooBar> = {
  title: "Yahoo Finance bars",
  gaps: "breaks",
  base: [...ohlc<YahooBar>("", PRICE), { name: "volume", get: (p) => p.v, agg: "sum", rule: QUANTITY }],
  derived: [],
  units: [
    "open, high, low, close: price in the instrument's currency, split-adjusted (not dividend-adjusted)",
    "volume: as Yahoo reports it (shares or contracts; 0 for most indices and FX)",
  ],
  summary: { kind: "level", column: "close", label: "close", relative: true, low: "low", high: "high" },
};

// Kraken spot OHLC. The VWAP of a resampled row is volume-weighted from its native bars, so it is carried as
// price x volume and divided again after resampling.
export const KRAKEN_SPOT_OHLC: SeriesSpec<KrakenCandle> = {
  title: "Kraken spot OHLC",
  base: [
    ...ohlc<KrakenCandle>("", PRICE),
    { name: "volume", get: (p) => p.v, agg: "sum", rule: QUANTITY },
    { name: "trades", get: (p) => p.count, agg: "sum", rule: COUNT },
    { name: "price_x_volume", get: (p) => p.vwap * p.v, agg: "sum", rule: QUANTITY, hidden: true },
  ],
  derived: [{ name: "vwap", derive: (r) => share(r.price_x_volume, r.volume), rule: PRICE }],
  units: [
    "open, high, low, close, vwap: price in the pair's quote currency (XBT = bitcoin)",
    "volume: base asset traded; trades: number of trades",
  ],
  summary: { kind: "level", column: "close", label: "close", relative: true, low: "low", high: "high" },
};
