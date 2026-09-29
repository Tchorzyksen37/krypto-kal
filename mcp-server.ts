// mcp-server.ts  (Node >= 23.6: `node mcp-server.ts`)
// Serwer MCP (Streamable HTTP) udostępniający dane Coinglass i Coinalyze jako narzędzia dla Claude.
// Narzędzia danego dostawcy są rejestrowane tylko, gdy w .env jest jego klucz API.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
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

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!AUTH_TOKEN) throw new Error("Brak MCP_AUTH_TOKEN");

// Sprawdza nagłówek "Authorization: Bearer <MCP_AUTH_TOKEN>".
function authorized(req: IncomingMessage): boolean {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${AUTH_TOKEN}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Jeden klient na dostawcę na cały proces – współdzielony cache i throttle.
const coinglass = process.env.COINGLASS_API_KEY ? new CoinglassClient() : undefined;
const coinalyze = process.env.COINALYZE_API_KEY ? new CoinalyzeClient() : undefined;
if (!coinglass && !coinalyze) throw new Error("Brak COINGLASS_API_KEY i COINALYZE_API_KEY – ustaw przynajmniej jeden");

async function toResult(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (e) {
    const err = e as Error & { kind?: string; status?: number; code?: string };
    const msg = err.kind
      ? `${err.kind}${err.status ? ` ${err.status}` : ""}${err.code ? ` (code ${err.code})` : ""}: ${err.message}`
      : String(e);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

// --- Coinglass ---

const cgIntervals = ["1m", "5m", "15m", "30m", "1h", "4h", "8h", "1d"] as const;

const cgMarketParams = {
  exchange: z.string().describe('Giełda, np. "Binance"'),
  symbol: z.string().describe('Para, np. "BTCUSDT"'),
  interval: z.enum(cgIntervals),
  limit: z.number().int().positive().max(1000).optional(),
};

function registerCoinglass(server: McpServer, client: CoinglassClient) {
  server.registerTool(
    "coinglass_funding_rate_history",
    {
      description: "[Coinglass] Historia funding rate (OHLC) dla kontraktu perpetual na danej giełdzie.",
      inputSchema: cgMarketParams,
    },
    (args) => toResult(() => client.fundingRateHistory(args)),
  );

  server.registerTool(
    "coinglass_open_interest_history",
    {
      description: "[Coinglass] Historia open interest (OHLC) dla kontraktu na danej giełdzie.",
      inputSchema: { ...cgMarketParams, unit: z.enum(["usd", "coin"]).optional() },
    },
    (args) => toResult(() => client.openInterestHistory(args)),
  );

  server.registerTool(
    "coinglass_liquidation_history",
    {
      description: "[Coinglass] Historia likwidacji long/short (USD) dla kontraktu na danej giełdzie.",
      inputSchema: cgMarketParams,
    },
    (args) => toResult(() => client.liquidationHistory(args)),
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
    'Symbole Coinalyze, np. ["BTCUSDT_PERP.A"] (sufiks = kod giełdy). ' +
      "Znajdziesz je narzędziem coinalyze_future_markets. Każdy symbol zużywa 1 z 40 wywołań/min.",
  );

const czHistoryParams = {
  symbols: czSymbols,
  interval: z.enum(czIntervals),
  limit: z
    .number().int().positive().max(2000).default(100)
    .describe("Liczba interwałów wstecz od `to` (ignorowane, gdy podano `from`)"),
  from: z.number().int().optional().describe("Początek zakresu, UNIX sekundy"),
  to: z.number().int().optional().describe("Koniec zakresu, UNIX sekundy (domyślnie teraz)"),
};

const czAggregate = z
  .boolean()
  .default(false)
  .describe("Zsumuj wszystkie symbole w jedną serię w USD (np. BTC ze wszystkich giełd)");

function range(p: { interval: CoinalyzeInterval; limit: number; from?: number | undefined; to?: number | undefined }) {
  const to = p.to ?? Math.floor(Date.now() / 1000);
  const from = p.from ?? to - p.limit * INTERVAL_SECONDS[p.interval];
  return { interval: p.interval, from, to };
}

// Sumuje wybrane pola po znaczniku czasu; `n` = ile symboli miało dane w danym interwale.
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
    { description: "[Coinalyze] Lista giełd i ich kodów (sufiks w symbolach, np. .A)." },
    () => toResult(() => client.exchanges()),
  );

  server.registerTool(
    "coinalyze_future_markets",
    {
      description:
        "[Coinalyze] Wyszukuje rynki futures i zwraca ich symbole do użycia w pozostałych narzędziach Coinalyze.",
      inputSchema: {
        base_asset: z.string().optional().describe('Np. "BTC"'),
        exchange: z.string().optional().describe('Kod giełdy, np. "A" (patrz coinalyze_exchanges)'),
        perpetual_only: z.boolean().default(true),
      },
    },
    ({ base_asset, exchange, perpetual_only }) =>
      toResult(async () =>
        (await client.futureMarkets())
          .filter(
            (m) =>
              (!base_asset || m.base_asset.toUpperCase() === base_asset.toUpperCase()) &&
              (!exchange || m.exchange === exchange) &&
              (!perpetual_only || m.is_perpetual),
          )
          .map(({ symbol, exchange, symbol_on_exchange, base_asset, quote_asset, margined, is_perpetual }) => ({
            symbol, exchange, symbol_on_exchange, base_asset, quote_asset, margined, is_perpetual,
          })),
      ),
  );

  server.registerTool(
    "coinalyze_current",
    {
      description: "[Coinalyze] Bieżące open interest, funding rate (%) lub prognozowany funding rate (%).",
      inputSchema: {
        metric: z.enum(["open_interest", "funding_rate", "predicted_funding_rate"]),
        symbols: czSymbols,
        convert_to_usd: z.boolean().default(true).describe("Tylko dla open_interest"),
      },
    },
    ({ metric, symbols, convert_to_usd }) =>
      toResult(() =>
        metric === "open_interest"
          ? client.openInterest(symbols, convert_to_usd)
          : metric === "funding_rate"
            ? client.fundingRate(symbols)
            : client.predictedFundingRate(symbols),
      ),
  );

  server.registerTool(
    "coinalyze_open_interest_history",
    {
      description: "[Coinalyze] Historia open interest (OHLC). Z `aggregate` zwraca sumę (pole c) w USD.",
      inputSchema: {
        ...czHistoryParams,
        convert_to_usd: z.boolean().default(true),
        aggregate: czAggregate,
      },
    },
    ({ symbols, convert_to_usd, aggregate, ...r }) =>
      toResult(async () => {
        const data = await client.openInterestHistory({
          symbols, ...range(r), convertToUsd: aggregate || convert_to_usd,
        });
        return aggregate ? sumByTime(data, ["c"]) : data;
      }),
  );

  server.registerTool(
    "coinalyze_funding_rate_history",
    {
      description: "[Coinalyze] Historia funding rate w % (OHLC); `predicted` = prognozowany funding rate.",
      inputSchema: { ...czHistoryParams, predicted: z.boolean().default(false) },
    },
    ({ symbols, predicted, ...r }) =>
      toResult(() =>
        predicted
          ? client.predictedFundingRateHistory({ symbols, ...range(r) })
          : client.fundingRateHistory({ symbols, ...range(r) }),
      ),
  );

  server.registerTool(
    "coinalyze_liquidation_history",
    {
      description:
        "[Coinalyze] Historia likwidacji: l = longi, s = shorty. Z `aggregate` zwraca sumy w USD.",
      inputSchema: {
        ...czHistoryParams,
        convert_to_usd: z.boolean().default(true),
        aggregate: czAggregate,
      },
    },
    ({ symbols, convert_to_usd, aggregate, ...r }) =>
      toResult(async () => {
        const data = await client.liquidationHistory({
          symbols, ...range(r), convertToUsd: aggregate || convert_to_usd,
        });
        return aggregate ? sumByTime(data, ["l", "s"]) : data;
      }),
  );

  server.registerTool(
    "coinalyze_long_short_ratio_history",
    {
      description: "[Coinalyze] Historia long/short ratio: r = ratio, l = % longów, s = % shortów.",
      inputSchema: czHistoryParams,
    },
    ({ symbols, ...r }) => toResult(() => client.longShortRatioHistory({ symbols, ...range(r) })),
  );

  server.registerTool(
    "coinalyze_ohlcv_history",
    {
      description:
        "[Coinalyze] Świece OHLCV: v = wolumen, bv = wolumen kupna, tx = liczba transakcji, btx = transakcje kupna.",
      inputSchema: czHistoryParams,
    },
    ({ symbols, ...r }) => toResult(() => client.ohlcvHistory({ symbols, ...range(r) })),
  );
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "krypto-kal", version: "1.0.0" });
  if (coinglass) registerCoinglass(server, coinglass);
  if (coinalyze) registerCoinalyze(server, coinalyze);
  return server;
}

// Tryb bezstanowy: nowy serwer + transport na każde żądanie.
const http = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  if (path !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (!authorized(req)) {
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
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

http.listen(PORT, HOST, () => {
  const providers = [coinglass && "Coinglass", coinalyze && "Coinalyze"].filter(Boolean).join(", ");
  console.log(`MCP server: http://${HOST}:${PORT}/mcp (${providers})`);
});
