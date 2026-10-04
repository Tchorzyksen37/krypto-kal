// mcp-server.ts  (Node >= 23.6: `node src/server/mcp-server.ts`, or `npm start`)
// MCP server (Streamable HTTP) exposing market data as tools for Claude:
// Coinalyze and Coinglass (crypto derivatives, need API keys), Yahoo Finance (indices, currencies,
// stocks – no key), Kraken (spot market data – no key; read-only account tools with a key), X (posts of
// curated accounts archived into the "second brain") and the second brain itself (BRAIN_DIR).
// Trading endpoints of Kraken are deliberately NOT exposed as tools.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CoinglassClient } from "../providers/coinglass/coinglass-client.ts";
import {
  CoinalyzeClient,
  INTERVAL_SECONDS,
  type CoinalyzeInterval,
  type SymbolHistory,
} from "../providers/coinalyze/coinalyze-client.ts";
import { Brain } from "../brain/brain.ts";
import { coinalyzeJobs, startCollector, yahooJobs, type CollectorJob } from "./collector.ts";
import { HistoryStore } from "../core/history-store.ts";
import { estimateLiquidationHeatmap, type HeatmapBar } from "../analytics/liquidation-heatmap.ts";
import { KRAKEN_OHLC_INTERVALS, KrakenClient } from "../providers/kraken/kraken-client.ts";
import { KRAKEN_FUTURES_RESOLUTIONS, KrakenFuturesClient } from "../providers/kraken/kraken-futures-client.ts";
import { buildContext, contextOptionsFromEnv } from "../speculation/context.ts";
import { gatherInput } from "../speculation/fetch.ts";
import { existsSync } from "node:fs";
import { BotStore, expandHome } from "../bot/bot-store.ts";
import { resolveConfig, statusText } from "../bot/cli.ts";
import { dayStartMs } from "../bot/limits.ts";
import { buildReport, renderReport } from "../bot/report.ts";
import { biasStats, edgeLine, readLog, readReports, scoreDir, scoreOptionsFromEnv, summarize } from "../speculation/score.ts";
import { report as pnlReport, syncFills } from "../trading/futures-pnl.ts";
import { TradeStore } from "../trading/trade-store.ts";
import { createLogger } from "../core/logger.ts";
import { XClient } from "../providers/x/x-client.ts";
import { accountsOverview, recentRawPosts, syncX, type SyncOptions } from "../brain/x-sync.ts";
import { YAHOO_INTERVAL_SECONDS, YahooClient, type YahooInterval } from "../providers/yahoo/yahoo-client.ts";

const log = createLogger("server");

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!AUTH_TOKEN) throw new Error("MCP_AUTH_TOKEN is not set");

// Checks the "Authorization: Bearer <MCP_AUTH_TOKEN>" header.
function authorized(req: IncomingMessage): boolean {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${AUTH_TOKEN}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Persistent history cache shared by all providers. Defaults to a path outside OneDrive
// (sync can lock SQLite files).
const CACHE_DB_PATH = process.env.CACHE_DB_PATH ?? join(homedir(), ".krypto-kal", "cache.db");
const store = new HistoryStore(CACHE_DB_PATH);

const enabled = (name: string) => process.env[name]?.toLowerCase() !== "false";

// One client per provider for the whole process – shared cache and throttle.
const coinglass = process.env.COINGLASS_API_KEY ? new CoinglassClient() : undefined;
const coinalyze = process.env.COINALYZE_API_KEY ? new CoinalyzeClient({ store }) : undefined;
const yahoo = enabled("YAHOO_ENABLED") ? new YahooClient({ store }) : undefined;
const kraken = enabled("KRAKEN_ENABLED") ? new KrakenClient({ cacheTtlMs: 5_000 }) : undefined;
// Read-only keys (KRAKEN_FUTURES_RO_*), kept apart from any future trading keys. tradingEnabled stays off and
// no trading tool is exposed.
const krakenFutures = enabled("KRAKEN_FUTURES_ENABLED")
  ? new KrakenFuturesClient({
      apiKey: process.env.KRAKEN_FUTURES_RO_API_KEY ?? "",
      apiSecret: process.env.KRAKEN_FUTURES_RO_API_SECRET ?? "",
    })
  : undefined;
const tradeStore = new TradeStore(CACHE_DB_PATH);
const x = process.env.X_BEARER_TOKEN ? new XClient() : undefined;
const brain = new Brain();

const optionalNumber = (v: string | undefined) => (v ? Number(v) : undefined);

// X reads are paid: the daily budget defaults to $1, the total budget is off unless set.
const xSyncOptions: SyncOptions = {
  backfillHours: Number(process.env.X_BACKFILL_HOURS ?? 24),
  maxPostsPerQuery: Number(process.env.X_MAX_POSTS_PER_QUERY ?? 200),
  requireVerified: enabled("X_REQUIRE_VERIFIED"),
  budget: {
    dailyUsd: Number(process.env.X_DAILY_BUDGET_USD ?? 1),
    totalUsd: optionalNumber(process.env.X_TOTAL_BUDGET_USD),
  },
};

// Runs a tool, logs the outcome and turns errors into `isError` results instead of throwing.
async function toResult(tool: string, args: unknown, fn: () => Promise<unknown>): Promise<CallToolResult> {
  const started = Date.now();
  log.debug("tool call", { tool, args });
  try {
    const data = await fn();
    log.info("tool ok", { tool, ms: Date.now() - started });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (e) {
    const err = e as Error & { kind?: string; status?: number; code?: string };
    const msg = err.kind
      ? `${err.kind}${err.status ? ` ${err.status}` : ""}${err.code ? ` (code ${err.code})` : ""}: ${err.message}`
      : String(e);
    log.warn("tool failed", { tool, ms: Date.now() - started, error: msg });
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

// --- Coinglass ---

const cgIntervals = ["1m", "5m", "15m", "30m", "1h", "4h", "8h", "1d"] as const;

const cgMarketParams = {
  exchange: z.string().describe('Exchange, e.g. "Binance"'),
  symbol: z.string().describe('Pair, e.g. "BTCUSDT"'),
  interval: z.enum(cgIntervals),
  limit: z.number().int().positive().max(1000).optional(),
};

function registerCoinglass(server: McpServer, client: CoinglassClient) {
  server.registerTool(
    "coinglass_funding_rate_history",
    {
      description: "[Coinglass] Funding rate history (OHLC) for a perpetual contract on one exchange.",
      inputSchema: cgMarketParams,
    },
    (args) => toResult("coinglass_funding_rate_history", args, () => client.fundingRateHistory(args)),
  );

  server.registerTool(
    "coinglass_open_interest_history",
    {
      description: "[Coinglass] Open interest history (OHLC) for a contract on one exchange.",
      inputSchema: { ...cgMarketParams, unit: z.enum(["usd", "coin"]).optional() },
    },
    (args) => toResult("coinglass_open_interest_history", args, () => client.openInterestHistory(args)),
  );

  server.registerTool(
    "coinglass_liquidation_history",
    {
      description: "[Coinglass] Long/short liquidation history (USD) for a contract on one exchange.",
      inputSchema: cgMarketParams,
    },
    (args) => toResult("coinglass_liquidation_history", args, () => client.liquidationHistory(args)),
  );
}

// --- Coinalyze ---

const czIntervals = [
  "1min", "5min", "15min", "30min", "1hour", "2hour", "4hour", "6hour", "12hour", "daily",
] as const;

const czSymbols = z
  .array(z.string())
  .min(1)
  .max(20)
  .describe(
    'Coinalyze symbols, e.g. ["BTCUSDT_PERP.A"] (suffix = exchange code). ' +
      "Find them with coinalyze_future_markets. Each symbol uses 1 of 40 API calls/min.",
  );

const czHistoryParams = {
  symbols: czSymbols,
  interval: z.enum(czIntervals),
  limit: z
    .number().int().positive().max(2000).default(100)
    .describe("Number of intervals back from `to` (ignored when `from` is given)"),
  from: z.number().int().optional().describe("Range start, UNIX seconds"),
  to: z.number().int().optional().describe("Range end, UNIX seconds (default: now)"),
};

const czAggregate = z
  .boolean()
  .default(false)
  .describe("Sum all symbols into a single USD series (e.g. BTC across all exchanges)");

// `to` defaults to now; without `from`, the range reaches `limit` intervals (× gapFactor) back.
function timeRange(intervalSeconds: number, p: { limit: number; from?: number | undefined; to?: number | undefined }, gapFactor = 1) {
  const to = p.to ?? Math.floor(Date.now() / 1000);
  const from = p.from ?? to - Math.ceil(p.limit * intervalSeconds * gapFactor);
  return { from, to };
}

function range(p: { interval: CoinalyzeInterval; limit: number; from?: number | undefined; to?: number | undefined }) {
  return { interval: p.interval, ...timeRange(INTERVAL_SECONDS[p.interval], p) };
}

// Sums the given fields per timestamp; `n` = how many symbols had data in that interval.
function sumByTime<P extends { t: number }, K extends keyof P & string>(
  series: SymbolHistory<P>[],
  fields: K[],
) {
  const byT = new Map<number, Record<string, number>>();
  for (const s of series) {
    for (const point of s.history) {
      const acc = byT.get(point.t) ?? Object.fromEntries([["n", 0], ...fields.map((f) => [f, 0])]);
      for (const f of fields) acc[f]! += Number(point[f]);
      acc.n!++;
      byT.set(point.t, acc);
    }
  }
  return {
    symbols: series.map((s) => s.symbol),
    points: [...byT.entries()].sort(([a], [b]) => a - b).map(([t, acc]) => ({ t, ...acc })),
  };
}

function registerCoinalyze(server: McpServer, client: CoinalyzeClient) {
  server.registerTool(
    "coinalyze_exchanges",
    { description: "[Coinalyze] Exchanges and their codes (the suffix in symbols, e.g. .A)." },
    () => toResult("coinalyze_exchanges", {}, () => client.exchanges()),
  );

  server.registerTool(
    "coinalyze_future_markets",
    {
      description:
        "[Coinalyze] Searches futures markets and returns their symbols for use in the other Coinalyze tools.",
      inputSchema: {
        base_asset: z.string().optional().describe('E.g. "BTC"'),
        exchange: z.string().optional().describe('Exchange code, e.g. "A" (see coinalyze_exchanges)'),
        perpetual_only: z.boolean().default(true),
      },
    },
    (args) =>
      toResult("coinalyze_future_markets", args, async () =>
        (await client.futureMarkets())
          .filter(
            (m) =>
              (!args.base_asset || m.base_asset.toUpperCase() === args.base_asset.toUpperCase()) &&
              (!args.exchange || m.exchange === args.exchange) &&
              (!args.perpetual_only || m.is_perpetual),
          )
          .map(({ symbol, exchange, symbol_on_exchange, base_asset, quote_asset, margined, is_perpetual }) => ({
            symbol, exchange, symbol_on_exchange, base_asset, quote_asset, margined, is_perpetual,
          })),
      ),
  );

  server.registerTool(
    "coinalyze_current",
    {
      description: "[Coinalyze] Current open interest, funding rate (%) or predicted funding rate (%).",
      inputSchema: {
        metric: z.enum(["open_interest", "funding_rate", "predicted_funding_rate"]),
        symbols: czSymbols,
        convert_to_usd: z.boolean().default(true).describe("Only for open_interest"),
      },
    },
    (args) =>
      toResult("coinalyze_current", args, () =>
        args.metric === "open_interest"
          ? client.openInterest(args.symbols, args.convert_to_usd)
          : args.metric === "funding_rate"
            ? client.fundingRate(args.symbols)
            : client.predictedFundingRate(args.symbols),
      ),
  );

  server.registerTool(
    "coinalyze_open_interest_history",
    {
      description:
        "[Coinalyze] Open interest history (OHLC). With `aggregate` returns the USD sum (field c). " +
        "Closed intervals are cached locally.",
      inputSchema: {
        ...czHistoryParams,
        convert_to_usd: z.boolean().default(true),
        aggregate: czAggregate,
      },
    },
    (args) =>
      toResult("coinalyze_open_interest_history", args, async () => {
        const { symbols, convert_to_usd, aggregate, ...r } = args;
        const data = await client.openInterestHistory({
          symbols, ...range(r), convertToUsd: aggregate || convert_to_usd,
        });
        return aggregate ? sumByTime(data, ["c"]) : data;
      }),
  );

  server.registerTool(
    "coinalyze_funding_rate_history",
    {
      description:
        "[Coinalyze] Funding rate history in % (OHLC); `predicted` = predicted funding rate. " +
        "Closed intervals are cached locally.",
      inputSchema: { ...czHistoryParams, predicted: z.boolean().default(false) },
    },
    (args) =>
      toResult("coinalyze_funding_rate_history", args, () => {
        const { symbols, predicted, ...r } = args;
        return predicted
          ? client.predictedFundingRateHistory({ symbols, ...range(r) })
          : client.fundingRateHistory({ symbols, ...range(r) });
      }),
  );

  server.registerTool(
    "coinalyze_liquidation_history",
    {
      description:
        "[Coinalyze] Liquidation history: l = longs, s = shorts. With `aggregate` returns USD sums. " +
        "Closed intervals are cached locally.",
      inputSchema: {
        ...czHistoryParams,
        convert_to_usd: z.boolean().default(true),
        aggregate: czAggregate,
      },
    },
    (args) =>
      toResult("coinalyze_liquidation_history", args, async () => {
        const { symbols, convert_to_usd, aggregate, ...r } = args;
        const data = await client.liquidationHistory({
          symbols, ...range(r), convertToUsd: aggregate || convert_to_usd,
        });
        return aggregate ? sumByTime(data, ["l", "s"]) : data;
      }),
  );

  server.registerTool(
    "coinalyze_long_short_ratio_history",
    {
      description: "[Coinalyze] Long/short ratio history: r = ratio, l = % longs, s = % shorts.",
      inputSchema: czHistoryParams,
    },
    (args) =>
      toResult("coinalyze_long_short_ratio_history", args, () => {
        const { symbols, ...r } = args;
        return client.longShortRatioHistory({ symbols, ...range(r) });
      }),
  );

  server.registerTool(
    "coinalyze_ohlcv_history",
    {
      description:
        "[Coinalyze] OHLCV candles: v = volume, bv = buy volume, tx = trade count, btx = buy trades.",
      inputSchema: czHistoryParams,
    },
    (args) =>
      toResult("coinalyze_ohlcv_history", args, () => {
        const { symbols, ...r } = args;
        return client.ohlcvHistory({ symbols, ...range(r) });
      }),
  );

  server.registerTool(
    "coinalyze_liquidation_heatmap_estimate",
    {
      description:
        "[Coinalyze] ESTIMATED liquidation heatmap: where long positions (below the price) and short positions " +
        "(above it) would be liquidated, in USD per price bucket. Exchanges publish no such data, so this is a model " +
        "built from price bars, open interest and the long/short ratio: new open interest is split long/short and " +
        "spread over assumed leverage tiers, cohorts the price has traded through are removed, and the total follows " +
        "the real OI. Treat it as a rough map of clusters, not as measured data. Use a long window (e.g. 4hour × 500+) " +
        "so OI opened before the window washes out. Price comes from the first symbol; OI is summed over all symbols " +
        "(e.g. BTC across exchanges).",
      inputSchema: {
        symbols: czSymbols.describe(
          'Perpetuals of ONE asset, e.g. ["BTCUSDT_PERP.A","BTCUSD_PERP.0"]. The first symbol gives the price. ' +
            "Each symbol costs 2 API calls (OI + long/short), the first 1 more.",
        ),
        interval: z.enum(czIntervals).default("4hour"),
        limit: z.number().int().min(50).max(2000).default(500).describe("Number of intervals of history to simulate"),
        bucket_pct: z.number().min(0.05).max(5).default(0.5).describe("Bucket width, % of the current price"),
        range_pct: z.number().min(1).max(50).default(20).describe("Show liquidation prices within ± this % of the price"),
        leverage_tiers: z
          .array(z.object({ leverage: z.number().gt(1).max(200), weight: z.number().positive() }))
          .min(1)
          .max(10)
          .optional()
          .describe("Assumed leverage mix of new positions. Default: 5x 15%, 10x 30%, 25x 30%, 50x 15%, 100x 10%"),
        maintenance_margin_pct: z.number().min(0).max(5).default(0.5),
      },
    },
    (args) =>
      toResult("coinalyze_liquidation_heatmap_estimate", args, async () => {
        const { from, to } = timeRange(INTERVAL_SECONDS[args.interval], { limit: args.limit });
        const p = { symbols: args.symbols, interval: args.interval, from, to };
        const [prices, oi, ratios] = await Promise.all([
          client.ohlcvHistory({ ...p, symbols: [args.symbols[0]!] }),
          client.openInterestHistory({ ...p, convertToUsd: true }),
          client.longShortRatioHistory(p),
        ]);

        const oiByT = new Map<number, number>();
        for (const s of oi) for (const pt of s.history) oiByT.set(pt.t, (oiByT.get(pt.t) ?? 0) + Number(pt.c));
        // Mean long share across symbols, carried forward over missing intervals.
        const shareAcc = new Map<number, { sum: number; n: number }>();
        for (const s of ratios) {
          for (const pt of s.history) {
            const total = Number(pt.l) + Number(pt.s);
            if (!(total > 0)) continue;
            const a = shareAcc.get(pt.t) ?? { sum: 0, n: 0 };
            a.sum += Number(pt.l) / total;
            a.n++;
            shareAcc.set(pt.t, a);
          }
        }

        let share = 0.5;
        const bars: HeatmapBar[] = [];
        for (const b of prices[0]?.history ?? []) {
          const a = shareAcc.get(b.t);
          if (a) share = a.sum / a.n;
          const openInterest = oiByT.get(b.t);
          if (openInterest === undefined) continue;
          bars.push({ t: b.t, h: Number(b.h), l: Number(b.l), c: Number(b.c), oi: openInterest, longShare: share });
        }

        return {
          symbols: args.symbols,
          interval: args.interval,
          ...estimateLiquidationHeatmap(bars, {
            bucketPct: args.bucket_pct,
            rangePct: args.range_pct,
            maintenanceMargin: args.maintenance_margin_pct / 100,
            ...(args.leverage_tiers ? { tiers: args.leverage_tiers } : {}),
          }),
        };
      }),
  );
}

// --- Yahoo Finance ---

const yahooIntervals = ["1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"] as const;

const yahooSymbols = z
  .array(z.string())
  .min(1)
  .describe(
    "Yahoo symbols. Stocks: AAPL, MSFT, CDR.WA (Warsaw). Indices: ^GSPC (S&P 500), ^IXIC (Nasdaq), " +
      "^DJI (Dow), ^VIX, ^GDAXI (DAX), WIG20.WA. Currencies: EURUSD=X, USDPLN=X, DX-Y.NYB (dollar index). " +
      "Yields: ^TNX (US 10y). Futures: CL=F (oil), GC=F (gold). Unknown symbol? Use yahoo_search.",
  );

// Markets pause at night and on weekends, so `limit` bars span more calendar time than limit × interval.
const YAHOO_GAP_FACTOR: Record<YahooInterval, number> = {
  "1m": 6, "5m": 6, "15m": 6, "30m": 6, "1h": 6, "1d": 1.6, "1wk": 1.1, "1mo": 1.1,
};

function registerYahoo(server: McpServer, client: YahooClient) {
  server.registerTool(
    "yahoo_search",
    {
      description: "[Yahoo Finance] Finds symbols of stocks, indices, currencies, ETFs and futures by name.",
      inputSchema: { query: z.string().describe('E.g. "nasdaq", "apple", "euro dollar", "wig20"'), limit: z.number().int().min(1).max(25).default(10) },
    },
    (args) => toResult("yahoo_search", args, () => client.search(args.query, args.limit)),
  );

  server.registerTool(
    "yahoo_quote",
    {
      description:
        "[Yahoo Finance] Current price, change vs previous close (absolute and %), day range, volume and " +
        "52-week range. One request per symbol.",
      inputSchema: { symbols: yahooSymbols.max(20) },
    },
    (args) => toResult("yahoo_quote", args, () => client.quotes(args.symbols)),
  );

  server.registerTool(
    "yahoo_history",
    {
      description:
        "[Yahoo Finance] OHLCV bars (t = bar start, UNIX seconds). Returns the last `limit` bars unless " +
        "`from` is given. Prices are split-adjusted, not dividend-adjusted. History: 1m – last 30 days, " +
        "5m–30m – 60 days, 1h – 2 years, 1d+ – decades. Closed bars are cached locally.",
      inputSchema: {
        symbols: yahooSymbols.max(10),
        interval: z.enum(yahooIntervals),
        limit: z.number().int().positive().max(2000).default(100).describe("Number of most recent bars"),
        from: z.number().int().optional().describe("Range start, UNIX seconds (returns all bars in range)"),
        to: z.number().int().optional().describe("Range end, UNIX seconds (default: now)"),
      },
    },
    (args) =>
      toResult("yahoo_history", args, async () => {
        const { symbols, interval, limit } = args;
        const r = timeRange(YAHOO_INTERVAL_SECONDS[interval], args, YAHOO_GAP_FACTOR[interval]);
        const data = await client.history({ symbols, interval, ...r });
        return args.from === undefined ? data.map((s) => ({ ...s, history: s.history.slice(-limit) })) : data;
      }),
  );
}

// --- Kraken ---

function registerKraken(server: McpServer, client: KrakenClient) {
  const pairDescription = 'Kraken pair, e.g. "XBTUSD", "ETHEUR", "XBTPLN" (XBT = bitcoin)';

  server.registerTool(
    "kraken_ticker",
    {
      description: "[Kraken] Spot ticker: ask, bid, last price, today's open, 24h high/low/volume/VWAP/trades.",
      inputSchema: { pairs: z.array(z.string()).min(1).max(20).describe(pairDescription) },
    },
    (args) => toResult("kraken_ticker", args, () => client.ticker(args.pairs)),
  );

  server.registerTool(
    "kraken_ohlc",
    {
      description: "[Kraken] Spot OHLC candles (t = UNIX seconds, interval in minutes). At most the last 720 candles.",
      inputSchema: {
        pair: z.string().describe(pairDescription),
        interval: z
          .enum(KRAKEN_OHLC_INTERVALS.map(String) as [string, ...string[]])
          .describe("Minutes: 1, 5, 15, 30, 60, 240, 1440 (1d), 10080 (1w), 21600 (15d)"),
        limit: z.number().int().min(1).max(720).default(100),
      },
    },
    (args) =>
      toResult("kraken_ohlc", args, async () => {
        const res = await client.ohlc(args.pair, Number(args.interval) as (typeof KRAKEN_OHLC_INTERVALS)[number]);
        return { pair: res.pair, candles: res.candles.slice(-args.limit) };
      }),
  );

  server.registerTool(
    "kraken_order_book",
    {
      description: "[Kraken] Order book: best asks and bids (price, volume, time).",
      inputSchema: { pair: z.string().describe(pairDescription), count: z.number().int().min(1).max(500).default(10) },
    },
    (args) => toResult("kraken_order_book", args, () => client.orderBook(args.pair, args.count)),
  );

  server.registerTool(
    "kraken_system_status",
    { description: "[Kraken] Exchange status (online / maintenance / cancel_only / post_only)." },
    () => toResult("kraken_system_status", {}, () => client.systemStatus()),
  );

  // Read-only account tools; trading is never exposed through MCP.
  if (client.hasCredentials) {
    server.registerTool(
      "kraken_balance",
      { description: "[Kraken] Account balances per asset (read-only)." },
      () => toResult("kraken_balance", {}, () => client.balance()),
    );

    server.registerTool(
      "kraken_open_orders",
      { description: "[Kraken] Currently open orders (read-only)." },
      () => toResult("kraken_open_orders", {}, () => client.openOrders()),
    );
  }
}

// --- Kraken Futures (read-only; the client is created without trading) ---

const FUTURES_RESOLUTION_SECONDS: Record<(typeof KRAKEN_FUTURES_RESOLUTIONS)[number], number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14_400, "12h": 43_200, "1d": 86_400, "1w": 604_800,
};

// Public market data of the futures exchange: needs no keys, so it is registered whenever Kraken Futures is enabled.
function registerKrakenFuturesMarket(server: McpServer, client: KrakenFuturesClient) {
  server.registerTool(
    "kraken_futures_candles",
    {
      description:
        "[Kraken Futures] Trade-price OHLC candles of a futures contract (t = UNIX seconds, volume in contracts). " +
        "Use this, not the spot kraken_ohlc, for prices of PF_ perpetuals. Goes back far (unlike spot's 720-candle limit): " +
        "pass from/to for an older range. At most 2000 candles per call.",
      inputSchema: {
        symbol: z.string().describe('Futures contract, e.g. "PF_XBTUSD", "PF_ETHUSD", "PF_XRPUSD"'),
        resolution: z.enum(KRAKEN_FUTURES_RESOLUTIONS).default("1h"),
        from: z.string().datetime({ offset: true }).optional().describe("Start, ISO 8601. Default: `limit` candles before `to`"),
        to: z.string().datetime({ offset: true }).optional().describe("End, ISO 8601. Default: now"),
        limit: z.number().int().min(1).max(2000).default(200),
      },
    },
    (args) =>
      toResult("kraken_futures_candles", args, async () => {
        const to = args.to ? Math.floor(Date.parse(args.to) / 1000) : Math.floor(Date.now() / 1000);
        const from = args.from ? Math.floor(Date.parse(args.from) / 1000) : to - args.limit * FUTURES_RESOLUTION_SECONDS[args.resolution];
        const res = await client.candles(args.symbol, args.resolution, { from, to });
        const candles = args.from ? res.candles.slice(0, args.limit) : res.candles.slice(-args.limit);
        return { symbol: args.symbol, resolution: args.resolution, candles, more: res.moreCandles || res.candles.length > candles.length };
      }),
  );
}

function registerKrakenFutures(server: McpServer, client: KrakenFuturesClient, trades: TradeStore) {
  const iso = z.string().datetime({ offset: true }).optional();
  const toMs = (v: string | undefined) => (v ? Date.parse(v) : undefined);
  const timeParams = {
    symbol: z.string().optional().describe('Futures symbol, e.g. "PF_XBTUSD"'),
    from: iso.describe("Only from this time, ISO 8601, e.g. 2026-09-01T00:00:00Z"),
    to: iso.describe("Only up to this time, ISO 8601"),
  };
  const filterOf = (a: { symbol?: string | undefined; from?: string | undefined; to?: string | undefined }) => ({
    ...(a.symbol ? { symbol: a.symbol } : {}),
    ...(a.from ? { from: toMs(a.from) } : {}),
    ...(a.to ? { to: toMs(a.to) } : {}),
  });
  const isoTime = (ms: number) => new Date(ms).toISOString();

  server.registerTool(
    "kraken_futures_positions",
    {
      description:
        "[Kraken Futures] Currently open positions (symbol, side, size in contracts, average entry price, unrealized " +
        "PnL and funding) plus margin account state (read-only).",
    },
    () =>
      toResult("kraken_futures_positions", {}, async () => {
        const [positions, account] = await Promise.all([
          client.openPositions(),
          client.flexAccount().catch((e: unknown) => ({ error: String(e) })),
        ]);
        return { positions, account };
      }),
  );

  server.registerTool(
    "kraken_futures_open_orders",
    { description: "[Kraken Futures] Resting orders: limit, stop and take-profit (read-only)." },
    () => toResult("kraken_futures_open_orders", {}, () => client.openOrders()),
  );

  server.registerTool(
    "kraken_futures_fills",
    {
      description:
        "[Kraken Futures] Trade history: executed fills, newest first. Syncs new fills from Kraken into the local " +
        "database first, so it also works past the API's 100-fill window.",
      inputSchema: { ...timeParams, limit: z.number().int().min(1).max(1000).default(100) },
    },
    (args) =>
      toResult("kraken_futures_fills", args, async () => {
        const sync = await syncFills(client, trades);
        const fills = trades.fills(filterOf(args), args.limit).map((f) => ({ ...f, time: isoTime(f.ts) }));
        return { sync, fills };
      }),
  );

  server.registerTool(
    "kraken_futures_pnl",
    {
      description:
        "[Kraken Futures] Realized profit/loss statistics from the trade history: totals, win rate, profit factor, " +
        "average win/loss, best/worst trade, max drawdown, hold time, per symbol and per UTC day, plus the most recent " +
        "closed trades. A trade is a position from flat to flat. Figures are gross of fees and funding. Syncs fills first.",
      inputSchema: { ...timeParams, recent_trades: z.number().int().min(0).max(200).default(20) },
    },
    (args) =>
      toResult("kraken_futures_pnl", args, async () => {
        const sync = await syncFills(client, trades);
        const closed = trades.trades(filterOf(args));
        return {
          sync,
          ...pnlReport(closed),
          recentTrades: closed.slice(-args.recent_trades).reverse().map((t) => ({
            ...t, openedAt: isoTime(t.openedAt), closedAt: isoTime(t.closedAt),
          })),
        };
      }),
  );
}

// --- Speculation mode ---

// The measured KNOWN layer of a speculation report in one call (see src/speculation/context.ts).
function registerSpeculation(server: McpServer, futures: KrakenFuturesClient, cz: CoinalyzeClient | undefined, trades: TradeStore) {
  server.registerTool(
    "speculation_score",
    {
      description:
        "[Speculation] Scores the speculation bets and biases in <BRAIN_DIR>/output/speculation: syncs your Kraken " +
        "Futures fills into the local store (the same sync as kraken_futures_fills; needs the read-only keys, without " +
        "them only hypothetical outcomes are scored), fetches futures 1m candles for every unresolved bet and finished " +
        "report window, matches fills to bets, and writes bets-log.json, reports-log.json, <day>/_day.md and " +
        "_scorecard.md. Returns the edge line (take-profit rate vs stated P vs chance), bias statistics and what changed.",
      inputSchema: {
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("UTC day for the _day.md note, default today"),
      },
    },
    (args) =>
      toResult("speculation_score", args, async () => {
        const dir = brain.resolvePath("output/speculation");
        await mkdir(dir, { recursive: true });
        const nowSec = Math.floor(Date.now() / 1000);
        const { input, warnings } = await gatherInput(
          await readLog(dir), nowSec,
          { candles: futures, ...(futures.hasCredentials ? { fills: { source: futures, store: trades } } : {}) },
          await readReports(dir),
        );
        const run = await scoreDir(dir, input, args.day, scoreOptionsFromEnv());
        const all = summarize(run.log);
        return {
          edge: edgeLine(all),
          stats: all,
          bias: biasStats(await readReports(dir)),
          changed: {
            betsResolved: run.resolved, betsMatchedToYourFills: run.matched, reportsBiasScored: run.reportsScored ?? [],
            fillsFromNoReport: run.unmatchedFills.length, ambiguous: run.ambiguous,
          },
          warnings,
          files: ["output/speculation/_scorecard.md", `output/speculation/${args.day ?? new Date(nowSec * 1000).toISOString().slice(0, 10)}/_day.md`],
        };
      }),
  );

  server.registerTool(
    "speculation_context",
    {
      description:
        "[Speculation] Measured inputs for a speculation report in one call: the session to report on (window, limits, " +
        "profile, regions, investors), the screened symbols with Kraken Futures last/bid/ask, spread, 1h ATR and ATR " +
        "ratio, 24h volume, open interest, funding (% per 8h), order-book depth, plus Coinalyze OI change 1h/4h, " +
        "long/short ratio and liquidation burst (when a key is set), `metaSymbols` ready for the report's meta file, " +
        "and the measured share of daily volume per session across several exchanges. `notMeasured` lists what goes " +
        "to UNKNOWN. Takes up to about a minute because of Coinalyze's rate limit.",
      inputSchema: {
        core: z.array(z.string()).optional().describe('Core symbols, default from SPECULATION_SYMBOLS or ["BTC","ETH","XRP"]'),
        extra: z.number().int().min(0).max(5).optional().describe("Screened extra symbols, default SPECULATION_SCREEN_EXTRA or 3"),
      },
    },
    (args) =>
      toResult("speculation_context", args, () => {
        const opts = contextOptionsFromEnv();
        opts.screen = {
          ...opts.screen,
          ...(args.core ? { core: args.core.map((c) => c.toUpperCase()) } : {}),
          ...(args.extra !== undefined ? { extra: args.extra } : {}),
        };
        return buildContext({ futures, ...(cz ? { coinalyze: cz } : {}) }, opts);
      }),
  );
}

// --- Trading bot (read-only view of its store) ---

function registerBot(server: McpServer) {
  server.registerTool(
    "bot_status",
    {
      description:
        "[Bot] Read-only view of the Kraken Futures bot (dry-run; it cannot place real orders): engine state and any " +
        "halt, simulated position, open orders and account, recent incidents and decisions, and the report for the " +
        "window (net PnL with fees and funding, closed trades with R, conviction calibration, entries not taken by " +
        "reason). Reads the bot's SQLite file (BOT_CONFIG's db_path, default ~/.krypto-kal/bot.db).",
      inputSchema: { days: z.number().int().min(1).max(90).default(1).describe("Report window: 1 = the current trading day") },
    },
    (args) =>
      toResult("bot_status", args, async () => {
        const { config } = resolveConfig(process.env.BOT_CONFIG);
        const file = expandHome(config.db_path);
        if (!existsSync(file)) return { running: false, note: `no bot database at ${file}: the bot has not been started yet` };
        const store = new BotStore(config.db_path);
        try {
          const now = Date.now();
          const since = args.days === 1 ? dayStartMs(now, config.day_reset_utc_hour) : now - args.days * 86_400_000;
          const report = buildReport(store, since, config, now);
          return { status: await statusText(store, config, now), report: renderReport(report), summary: {
            state: report.state, halt: report.halt, netPnl: report.netPnl, equity: report.equity, trades: report.trades.length,
            incidents: report.incidents, incidentsByKind: report.incidentsByKind,
          } };
        } finally {
          store.close();
        }
      }),
  );
}

// --- X ---

function registerX(server: McpServer, client: XClient) {
  server.registerTool(
    "x_sync",
    {
      description:
        "[X] Fetches new posts of the curated accounts in x-accounts.json of the brain (Middle East news, officials, " +
        "OSINT, market squawks) and saves each one to raw/x/ in the brain. Only posts newer than the previous sync are " +
        "read (X reads are paid) and the run stops at the configured daily/total budget. Returns the new raw " +
        "files and the estimated spend; read the posts with x_recent or brain_read.",
    },
    () => toResult("x_sync", {}, () => syncX(client, brain, xSyncOptions)),
  );

  server.registerTool(
    "x_accounts",
    {
      description:
        "[X] The curated account list (enabled or not, category, notes) with each account's X profile " +
        "(found, verification type, followers) and the estimated API spend. Profiles are cached for a week; " +
        "a refresh costs $0.01 per account.",
    },
    () => toResult("x_accounts", {}, () => accountsOverview(client, brain, xSyncOptions.budget)),
  );
}

// --- Second brain (no API calls) ---

function registerBrain(server: McpServer) {
  const hours = (h: number) => new Date(Date.now() - h * 3_600_000);

  server.registerTool(
    "x_recent",
    {
      description:
        "[Brain] Archived X posts from raw/x/ in the brain, newest first (local files, no API calls). " +
        "Run x_sync first to pull new posts.",
      inputSchema: {
        hours: z.number().positive().max(24 * 365).default(24).describe("How far back to look"),
        author: z.string().optional().describe('Username, e.g. "Reuters"'),
        contains: z.string().optional().describe("Case-insensitive text filter"),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    (args) =>
      toResult("x_recent", args, () =>
        recentRawPosts(brain, { since: hours(args.hours), author: args.author, contains: args.contains, limit: args.limit }),
      ),
  );

  server.registerTool(
    "brain_list",
    {
      description:
        "[Brain] Lists files of the second brain (knowledge base): raw/ (sources), wiki/ (linked pages), " +
        "output/ (reports). Start a session by reading CLAUDE.md with brain_read – it defines the workflow.",
      inputSchema: {
        dir: z.string().default("").describe('E.g. "wiki", "wiki/events", "raw/x/2026-10-01"'),
        recursive: z.boolean().default(false),
      },
    },
    (args) => toResult("brain_list", args, () => brain.list(args.dir, args.recursive)),
  );

  server.registerTool(
    "brain_read",
    {
      description: '[Brain] Reads a file of the second brain, e.g. "CLAUDE.md", "wiki/index.md".',
      inputSchema: { path: z.string() },
    },
    (args) => toResult("brain_read", args, () => brain.read(args.path)),
  );

  server.registerTool(
    "brain_search",
    {
      description: "[Brain] Case-insensitive search (all words on one line) in the .md files of a folder.",
      inputSchema: {
        query: z.string().min(1),
        dir: z.string().default("wiki").describe('"wiki", "output", "raw/x" or a subfolder'),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    (args) => toResult("brain_search", args, () => brain.search(args.query, args.dir, args.limit)),
  );

  server.registerTool(
    "brain_write",
    {
      description:
        "[Brain] Creates or replaces a Markdown page in wiki/ or output/ (raw/ is read-only). Follow the page " +
        "format in CLAUDE.md and keep wiki/index.md and wiki/log.md up to date.",
      inputSchema: {
        path: z.string().describe('E.g. "wiki/places/strait-of-hormuz.md"'),
        content: z.string().describe("Full new file content"),
      },
    },
    (args) => toResult("brain_write", { path: args.path }, () => brain.write(args.path, args.content)),
  );
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "krypto-kal", version: "1.0.0" });
  if (coinglass) registerCoinglass(server, coinglass);
  if (coinalyze) registerCoinalyze(server, coinalyze);
  if (yahoo) registerYahoo(server, yahoo);
  if (kraken) registerKraken(server, kraken);
  if (krakenFutures) registerKrakenFuturesMarket(server, krakenFutures);
  if (krakenFutures) registerSpeculation(server, krakenFutures, coinalyze, tradeStore);
  if (krakenFutures?.hasCredentials) registerKrakenFutures(server, krakenFutures, tradeStore);
  if (x) registerX(server, x);
  registerBrain(server);
  registerBot(server);
  return server;
}

const list = (v: string | undefined, fallback = "") =>
  (v ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

// Builds collector jobs from COLLECT_* (Coinalyze) and YAHOO_COLLECT_* settings.
function collectorJobs(): CollectorJob[] {
  const jobs: CollectorJob[] = [];

  const czSymbolsToCollect = list(process.env.COLLECT_SYMBOLS);
  if (coinalyze && czSymbolsToCollect.length > 0) {
    const intervals = list(process.env.COLLECT_INTERVALS, "1hour");
    const invalid = intervals.filter((i) => !(i in INTERVAL_SECONDS));
    if (invalid.length) throw new Error(`Invalid COLLECT_INTERVALS: ${invalid.join(",")}`);
    jobs.push(...coinalyzeJobs(coinalyze, czSymbolsToCollect, intervals as CoinalyzeInterval[]));
  }

  const yahooSymbolsToCollect = list(process.env.YAHOO_COLLECT_SYMBOLS);
  if (yahoo && yahooSymbolsToCollect.length > 0) {
    const intervals = list(process.env.YAHOO_COLLECT_INTERVALS, "1h,1d");
    const invalid = intervals.filter((i) => !(i in YAHOO_INTERVAL_SECONDS));
    if (invalid.length) throw new Error(`Invalid YAHOO_COLLECT_INTERVALS: ${invalid.join(",")}`);
    jobs.push(...yahooJobs(yahoo, yahooSymbolsToCollect, intervals as YahooInterval[]));
  }
  return jobs;
}

// Stateless mode: a new server + transport for every request.
const http = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  if (path !== "/mcp") {
    log.debug("not found", { method: req.method, path });
    res.writeHead(404).end();
    return;
  }
  if (!authorized(req)) {
    log.warn("unauthorized request", { method: req.method, remote: req.socket.remoteAddress });
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    log.error("request handling failed", { error: e, stack: (e as Error).stack });
    if (!res.headersSent) res.writeHead(500).end();
  }
});

const jobs = collectorJobs(); // validated before listening, so bad config fails fast

http.listen(PORT, HOST, () => {
  const providers = [
    coinglass && "coinglass",
    coinalyze && "coinalyze",
    yahoo && "yahoo",
    kraken && (kraken.hasCredentials ? "kraken(+account)" : "kraken"),
    krakenFutures?.hasCredentials && "kraken-futures(read-only)",
    x && "x",
  ].filter(Boolean).join(",");
  log.info("MCP server listening", { url: `http://${HOST}:${PORT}/mcp`, providers });
  log.info("history cache", { path: CACHE_DB_PATH });
  log.info("second brain", { path: brain.root });
  if (jobs.length > 0) startCollector(jobs, Number(process.env.COLLECT_EVERY_MINUTES ?? 60));
  // X reads are paid, so the background sync is opt-in and has its own schedule.
  if (x && process.env.X_COLLECT?.toLowerCase() === "true") {
    startCollector([{ name: "x sync", run: () => syncX(x, brain, xSyncOptions) }], Number(process.env.X_SYNC_EVERY_MINUTES ?? 30));
  }
});
