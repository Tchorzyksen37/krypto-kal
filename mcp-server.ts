// mcp-server.ts  (Node >= 23.6: `node mcp-server.ts`)
// MCP server (Streamable HTTP) exposing market data as tools for Claude:
// Coinalyze and Coinglass (crypto derivatives, need API keys), Yahoo Finance (indices, currencies,
// stocks – no key), Kraken (spot market data – no key; read-only account tools with a key), X (posts of
// curated accounts archived into the "second brain") and the second brain itself (BRAIN_DIR).
// Trading endpoints of Kraken are deliberately NOT exposed as tools.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CoinglassClient } from "./coinglass-client.ts";
import {
  CoinalyzeClient,
  INTERVAL_SECONDS,
  type CoinalyzeInterval,
  type SymbolHistory,
} from "./coinalyze-client.ts";
import { Brain } from "./brain.ts";
import { coinalyzeJobs, startCollector, yahooJobs, type CollectorJob } from "./collector.ts";
import { HistoryStore } from "./history-store.ts";
import { KRAKEN_OHLC_INTERVALS, KrakenClient } from "./kraken-client.ts";
import { createLogger } from "./logger.ts";
import { XClient } from "./x-client.ts";
import { accountsOverview, recentRawPosts, syncX, type SyncOptions } from "./x-sync.ts";
import { YAHOO_INTERVAL_SECONDS, YahooClient, type YahooInterval } from "./yahoo-client.ts";

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
  if (x) registerX(server, x);
  registerBrain(server);
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
