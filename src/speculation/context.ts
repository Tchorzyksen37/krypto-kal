// speculation/context.ts – the measured KNOWN layer of a speculation report in one call, so the model does not
// gather (or skip, or invent) the numbers itself:
//  * the session to report on, with its limits and profile (sessions.ts);
//  * per symbol, from Kraken Futures: last/mark/bid/ask, spread, 1h ATR and its ratio to the last 24 hours,
//    24h volume, open interest, funding (% per 8h), order-book depth;
//  * per symbol, from Coinalyze (Binance USDT perpetual as the proxy for the whole market), when a key is set:
//    open-interest change over 1h and 4h, long/short ratio, liquidation burst;
//  * the symbol screen (screen.ts) run on those measured values;
//  * the measured share of daily volume per session, summed over several exchanges' BTC perpetuals
//    (Coinalyze), or Kraken alone as a fallback (labelled as such).
// Used by the MCP tool `speculation_context` and by the CLI `node --env-file-if-exists=.env src/speculation/context.ts`.

import { fileURLToPath } from "node:url";
import type { CoinalyzeInterval, FutureMarket, HistoryParams, LiquidationPoint, LongShortPoint, OhlcPoint, OhlcvPoint, SymbolHistory } from "../providers/coinalyze/coinalyze-client.ts";
import type { FuturesCandle, FuturesOrderBook, FuturesTicker } from "../providers/kraken/kraken-futures-client.ts";
import {
  baseOf, candlesOk, depthUsd, fundingPct8h, isLinearPerp, openInterestUsd, spreadBps, volatility, volumeUsd24h,
} from "./market.ts";
import { type Candidate, DEFAULT_SCREEN, type ScreenOptions, filterReason, screen, screenOptionsFromEnv, setupScore } from "./screen.ts";
import { DEFAULT_LEAD_MINUTES, DEFAULT_TZ, describeWindow, pickSession, sessionOptionsFromEnv } from "./sessions.ts";
import { type VolumeBar, volumeReport } from "./volume.ts";

export interface FuturesSource {
  tickers(): Promise<FuturesTicker[]>;
  candles(symbol: string, resolution: "1h", range: { from?: number; to?: number }): Promise<{ candles: FuturesCandle[] }>;
  orderBook(symbol: string, depth?: number): Promise<FuturesOrderBook>;
}

export interface CoinalyzeSource {
  futureMarkets(): Promise<FutureMarket[]>;
  openInterestHistory(p: HistoryParams & { convertToUsd?: boolean }): Promise<SymbolHistory<OhlcPoint>[]>;
  longShortRatioHistory(p: HistoryParams): Promise<SymbolHistory<LongShortPoint>[]>;
  liquidationHistory(p: HistoryParams & { convertToUsd?: boolean }): Promise<SymbolHistory<LiquidationPoint>[]>;
  ohlcvHistory(p: HistoryParams): Promise<SymbolHistory<OhlcvPoint>[]>;
}

export interface ContextOptions {
  nowSec: number;
  tz: string;
  leadMinutes: number;
  screen: Partial<ScreenOptions>;
  prescreen: number; // extra candidates measured in depth (by 24h volume) before screening
  enrich: number; // extra candidates enriched with Coinalyze data (by provisional score); each costs ~3 Coinalyze calls
  volumeMarkets: number; // BTC perpetuals summed for the volume profile
}

export const DEFAULT_CONTEXT: Omit<ContextOptions, "nowSec"> = {
  tz: DEFAULT_TZ, leadMinutes: DEFAULT_LEAD_MINUTES, screen: {}, prescreen: 10, enrich: 6, volumeMarkets: 8,
};

export interface SymbolContext {
  symbol: string;
  futures: string;
  why: string;
  warnings: string[];
  last: number;
  mark: number;
  bid: number;
  ask: number;
  spread_bps: number;
  atr_1h?: number;
  atr_ratio?: number;
  volume_usd_24h: number;
  open_interest_usd: number;
  funding_pct_8h: number;
  depth_usd_0_2pct?: number;
  change_24h_pct?: number;
  coinalyze?: { symbol: string; oi_change_1h_pct?: number; oi_change_4h_pct?: number; long_short_ratio?: number; liquidation_burst?: number };
}

export interface SpeculationContext {
  measuredAt: string;
  session: ReturnType<typeof describeWindow> & { limits: Record<string, number>; profile: string[]; watch: string[]; caution: string[]; regions: unknown; investors: unknown };
  symbols: SymbolContext[]; // the screen's picks: core first, then the screened extras
  metaSymbols: { symbol: string; futures: string; last: number; atr_1h: number; spread_bps: number; why: string }[]; // ready for HHMMZ.meta.json
  excluded: { symbol: string; reason: string }[];
  volume: { source: string; days: number; shares: unknown } | { source: string; error: string };
  notMeasured: string[]; // goes to UNKNOWN in the report
  warnings: string[];
}

const HOUR = 3600;
const pctChange = (from: number | undefined, to: number | undefined) =>
  from !== undefined && to !== undefined && from !== 0 ? Math.round(((to - from) / from) * 10_000) / 100 : undefined;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Volume profile results change slowly: kept for 6 hours per process so repeated runs cost no API calls.
let volumeCache: { at: number; value: SpeculationContext["volume"] } | undefined;
export const clearVolumeCache = () => (volumeCache = undefined);

export async function buildContext(deps: { futures: FuturesSource; coinalyze?: CoinalyzeSource }, options: Partial<ContextOptions> = {}): Promise<SpeculationContext> {
  const o: ContextOptions = { ...DEFAULT_CONTEXT, nowSec: Math.floor(Date.now() / 1000), ...options };
  const so = { ...DEFAULT_SCREEN, ...o.screen };
  const warnings: string[] = [];
  const notMeasured: string[] = [];

  const win = pickSession(o.nowSec * 1000, o.tz, o.leadMinutes);
  const sd = win.session;
  const session = {
    ...describeWindow(win, o.tz),
    limits: { entryDeadlineMinutes: sd.entryDeadlineMinutes, maxTtlMinutes: sd.maxTtlMinutes, maxEntryDeviation: sd.maxEntryDeviation, maxBets: sd.maxBets, minRewardRisk: sd.minRewardRisk },
    profile: sd.profile, watch: sd.watch, caution: sd.caution, regions: sd.regions, investors: sd.investors,
  };

  // 1. Universe from one tickers call.
  const tickers = (await deps.futures.tickers()).filter(isLinearPerp);
  const bySymbol = new Map(tickers.map((t) => [baseOf(t.symbol), t]));
  const coreTickers = so.core.map((c) => bySymbol.get(c)).filter((t): t is FuturesTicker => Boolean(t));
  for (const c of so.core) if (!bySymbol.has(c)) warnings.push(`core symbol ${c} has no Kraken Futures linear perpetual`);
  const quickFilter = (t: FuturesTicker) =>
    volumeUsd24h(t) >= so.minVolumeUsd && openInterestUsd(t) >= so.minOpenInterestUsd && spreadBps(t) <= so.maxSpreadBps;
  const extras = tickers
    .filter((t) => !so.core.includes(baseOf(t.symbol)) && quickFilter(t))
    .sort((a, b) => volumeUsd24h(b) - volumeUsd24h(a))
    .slice(0, o.prescreen);

  // 2. Kraken measurements (hourly candles, order book) for core + prescreened extras.
  const measured = new Map<string, { candles: FuturesCandle[]; book?: FuturesOrderBook }>();
  for (const t of [...coreTickers, ...extras]) {
    try {
      const { candles } = await deps.futures.candles(t.symbol, "1h", { from: o.nowSec - 30 * HOUR, to: o.nowSec });
      let book: FuturesOrderBook | undefined;
      try {
        book = await deps.futures.orderBook(t.symbol, 50);
      } catch (e) {
        warnings.push(`order book ${t.symbol}: ${errText(e)}`);
      }
      measured.set(t.symbol, { candles, ...(book ? { book } : {}) });
    } catch (e) {
      warnings.push(`candles ${t.symbol}: ${errText(e)}`);
    }
  }

  const toCandidate = (t: FuturesTicker): Candidate => {
    const m = measured.get(t.symbol);
    const vol = m ? volatility(m.candles) : undefined;
    return {
      symbol: baseOf(t.symbol), futures: t.symbol,
      volumeUsd24h: volumeUsd24h(t), openInterestUsd: openInterestUsd(t), spreadBps: spreadBps(t),
      depthUsd: m?.book ? depthUsd(m.book) : 0, candlesOk: m ? candlesOk(m.candles, o.nowSec) : false,
      atrRatio: vol?.atrRatio ?? 1, fundingPct8h: fundingPct8h(t),
      oiChange1hPct: 0, oiChange4hPct: 0, longShortRatio: 1, liqBurst: 1,
    };
  };
  const candidates = new Map([...coreTickers, ...extras].map((t) => [t.symbol, toCandidate(t)]));

  // 3. Coinalyze enrichment for core + the most promising extras (provisional score without Coinalyze data).
  const czData = new Map<string, NonNullable<SymbolContext["coinalyze"]>>();
  if (!deps.coinalyze) notMeasured.push("open-interest change, long/short ratio and liquidations (no COINALYZE_API_KEY)");
  else {
    try {
      const markets = new Set((await deps.coinalyze.futureMarkets()).map((m) => m.symbol));
      const enrichList = [
        ...coreTickers,
        ...extras
          .filter((t) => !filterReason(candidates.get(t.symbol)!, so))
          .sort((a, b) => setupScore(candidates.get(b.symbol)!).score - setupScore(candidates.get(a.symbol)!).score)
          .slice(0, o.enrich),
      ];
      const czOf = new Map<string, string>();
      for (const t of enrichList) {
        const cz = `${baseOf(t.symbol)}USDT_PERP.A`;
        if (markets.has(cz)) czOf.set(cz, t.symbol);
        else warnings.push(`no Coinalyze market ${cz} for ${t.symbol}`);
      }
      const symbols = [...czOf.keys()];
      if (symbols.length) {
        const p = (interval: CoinalyzeInterval, hours: number): HistoryParams => ({ symbols, interval, from: o.nowSec - hours * HOUR, to: o.nowSec });
        const [oi, ls, liq] = await Promise.all([
          deps.coinalyze.openInterestHistory({ ...p("1hour", 6), convertToUsd: true }),
          deps.coinalyze.longShortRatioHistory(p("1hour", 3)),
          deps.coinalyze.liquidationHistory({ ...p("1hour", 26), convertToUsd: true }),
        ]);
        for (const cz of symbols) {
          const oiH = oi.find((x) => x.symbol === cz)?.history ?? [];
          const lsH = ls.find((x) => x.symbol === cz)?.history ?? [];
          const liqH = (liq.find((x) => x.symbol === cz)?.history ?? []).map((x) => x.l + x.s);
          const prior = liqH.slice(0, -1).slice(-24);
          const priorMean = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
          const entry: NonNullable<SymbolContext["coinalyze"]> = { symbol: cz };
          const oi1 = pctChange(oiH.at(-2)?.c, oiH.at(-1)?.c);
          const oi4 = pctChange(oiH.at(-5)?.c, oiH.at(-1)?.c);
          if (oi1 !== undefined) entry.oi_change_1h_pct = oi1;
          if (oi4 !== undefined) entry.oi_change_4h_pct = oi4;
          if (lsH.at(-1)) entry.long_short_ratio = lsH.at(-1)!.r;
          if (liqH.length) entry.liquidation_burst = priorMean > 0 ? Math.round((liqH.at(-1)! / priorMean) * 100) / 100 : 1;
          const futures = czOf.get(cz)!;
          czData.set(futures, entry);
          const c = candidates.get(futures)!;
          c.oiChange1hPct = entry.oi_change_1h_pct ?? 0;
          c.oiChange4hPct = entry.oi_change_4h_pct ?? 0;
          c.longShortRatio = entry.long_short_ratio ?? 1;
          c.liqBurst = entry.liquidation_burst ?? 1;
        }
      }
    } catch (e) {
      warnings.push(`Coinalyze: ${errText(e)}`);
      notMeasured.push("open-interest change, long/short ratio and liquidations (Coinalyze request failed)");
    }
  }

  // 4. Screen on measured values.
  const result = screen([...candidates.values()], so);
  const tickerOf = new Map(tickers.map((t) => [t.symbol, t]));
  const symbols: SymbolContext[] = result.picks.map((pick) => {
    const t = tickerOf.get(pick.futures)!;
    const m = measured.get(pick.futures);
    const vol = m ? volatility(m.candles) : undefined;
    const ctx: SymbolContext = {
      symbol: pick.symbol, futures: pick.futures, why: pick.why, warnings: pick.warnings,
      last: t.last, mark: t.markPrice, bid: t.bid, ask: t.ask, spread_bps: spreadBps(t),
      volume_usd_24h: Math.round(volumeUsd24h(t)), open_interest_usd: Math.round(openInterestUsd(t)), funding_pct_8h: fundingPct8h(t),
    };
    if (vol) {
      ctx.atr_1h = vol.atr_1h;
      ctx.atr_ratio = vol.atrRatio;
    } else ctx.warnings.push("ATR not measured (too few hourly candles)");
    if (m?.book) ctx.depth_usd_0_2pct = Math.round(depthUsd(m.book));
    if (t.change24h !== undefined) ctx.change_24h_pct = t.change24h;
    const cz = czData.get(pick.futures);
    if (cz) ctx.coinalyze = cz;
    return ctx;
  });
  const metaSymbols = symbols
    .filter((s) => s.atr_1h !== undefined)
    .map((s) => ({ symbol: s.symbol, futures: s.futures, last: s.last, atr_1h: s.atr_1h!, spread_bps: s.spread_bps, why: s.why }));

  // 5. Volume share per session.
  const volume = await volumeProfile(deps, o, warnings);
  if ("error" in volume) notMeasured.push(`session volume share (${volume.error})`);
  notMeasured.push("real liquidation levels, whale and market-maker intent, spoofed depth, ETF flows, Korean premium");

  return { measuredAt: new Date(o.nowSec * 1000).toISOString(), session, symbols, metaSymbols, excluded: result.excluded, volume, notMeasured, warnings };
}

// BTC hourly volume over 8 days summed across several exchanges' stablecoin-margined perpetuals (Coinalyze; USD =
// base volume x close), or Kraken Futures alone when Coinalyze is unavailable.
async function volumeProfile(
  deps: { futures: FuturesSource; coinalyze?: CoinalyzeSource }, o: ContextOptions, warnings: string[],
): Promise<SpeculationContext["volume"]> {
  if (volumeCache && o.nowSec - volumeCache.at < 6 * HOUR) return volumeCache.value;
  const from = o.nowSec - 8 * 86_400;
  let value: SpeculationContext["volume"] | undefined;
  if (deps.coinalyze) {
    try {
      const markets = (await deps.coinalyze.futureMarkets())
        .filter((m) => m.base_asset === "BTC" && m.is_perpetual && m.margined === "STABLE" && m.has_ohlcv_data && m.oi_lq_vol_denominated_in === "BASE_ASSET")
        .slice(0, o.volumeMarkets);
      if (markets.length) {
        const hist = await deps.coinalyze.ohlcvHistory({ symbols: markets.map((m) => m.symbol), interval: "1hour", from, to: o.nowSec });
        const byHour = new Map<number, number>();
        for (const h of hist) for (const p of h.history) byHour.set(p.t, (byHour.get(p.t) ?? 0) + p.v * p.c);
        const bars: VolumeBar[] = [...byHour].map(([t, usd]) => ({ t, c: 1, v: usd }));
        const r = volumeReport(bars, o.nowSec * 1000, o.tz);
        const source = `BTC perpetuals on ${markets.length} exchanges (Coinalyze: ${markets.map((m) => m.exchange).join(", ")})`;
        value = "error" in r ? { source, error: r.error } : { source, ...r };
      }
    } catch (e) {
      warnings.push(`volume profile via Coinalyze: ${errText(e)}`);
    }
  }
  if (!value) {
    const source = "Kraken Futures PF_XBTUSD only (one venue; under-represents Asian exchanges)";
    try {
      const { candles } = await deps.futures.candles("PF_XBTUSD", "1h", { from, to: o.nowSec });
      const r = volumeReport(candles.map((c) => ({ t: c.t, c: c.c, v: c.v })), o.nowSec * 1000, o.tz);
      value = "error" in r ? { source, error: r.error } : { source, ...r };
    } catch (e) {
      value = { source, error: errText(e) };
    }
  }
  if (!("error" in value)) volumeCache = { at: o.nowSec, value };
  return value;
}

export function contextOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ContextOptions> {
  return { ...sessionOptionsFromEnv(env), screen: screenOptionsFromEnv(env) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { KrakenFuturesClient } = await import("../providers/kraken/kraken-futures-client.ts");
    const { CoinalyzeClient } = await import("../providers/coinalyze/coinalyze-client.ts");
    const futures = new KrakenFuturesClient({ apiKey: "", apiSecret: "" });
    const coinalyze = process.env.COINALYZE_API_KEY ? new CoinalyzeClient() : undefined;
    const ctx = await buildContext({ futures, ...(coinalyze ? { coinalyze } : {}) }, contextOptionsFromEnv());
    console.log(JSON.stringify(ctx, null, 2));
  } catch (e) {
    console.error(`context failed: ${errText(e)}`);
    process.exit(1);
  }
}
