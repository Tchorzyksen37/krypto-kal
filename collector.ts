// collector.ts – periodically pulls history for selected symbols into the persistent cache,
// so it outlives the providers' retention (Coinalyze keeps ~1500–2000 intraday points,
// Yahoo serves 1m data for 30 days and 5m–30m for 60 days). Thanks to the cache, each run
// fetches only new closed intervals.

import { INTERVAL_SECONDS, type CoinalyzeClient, type CoinalyzeInterval, type HistoryParams } from "./coinalyze-client.ts";
import { createLogger } from "./logger.ts";
import type { YahooClient, YahooInterval } from "./yahoo-client.ts";

const log = createLogger("collector");

// One unit of collection work; `run` fetches (and thereby caches) one slice of history.
export interface CollectorJob {
  name: string;
  run(): Promise<unknown>;
}

const COINALYZE_WINDOW_POINTS = 2000; // how far back the first run reaches (Coinalyze has no more than that)
const COINALYZE_CHUNK = 20; // max symbols per request

// Same variants (e.g. convert_to_usd) the MCP tools use by default – so they hit the same cache.
const COINALYZE_METRICS: [string, (c: CoinalyzeClient, p: HistoryParams) => Promise<unknown>][] = [
  ["open-interest", (c, p) => c.openInterestHistory({ ...p, convertToUsd: true })],
  ["funding-rate", (c, p) => c.fundingRateHistory(p)],
  ["predicted-funding-rate", (c, p) => c.predictedFundingRateHistory(p)],
  ["liquidations", (c, p) => c.liquidationHistory({ ...p, convertToUsd: true })],
  ["long-short-ratio", (c, p) => c.longShortRatioHistory(p)],
  ["ohlcv", (c, p) => c.ohlcvHistory(p)],
];

// 6 metrics × intervals × symbol chunks. Closed intervals only – the live tail is never cached anyway.
export function coinalyzeJobs(client: CoinalyzeClient, symbols: string[], intervals: CoinalyzeInterval[]): CollectorJob[] {
  const jobs: CollectorJob[] = [];
  for (const interval of intervals) {
    for (let i = 0; i < symbols.length; i += COINALYZE_CHUNK) {
      const chunk = symbols.slice(i, i + COINALYZE_CHUNK);
      for (const [metric, fetch] of COINALYZE_METRICS) {
        jobs.push({
          name: `coinalyze ${metric} ${interval} ${chunk.join(",")}`,
          run: () => {
            const to = client.closedUntil(interval);
            return fetch(client, { symbols: chunk, interval, from: to - COINALYZE_WINDOW_POINTS * INTERVAL_SECONDS[interval], to });
          },
        });
      }
    }
  }
  return jobs;
}

// One job per symbol × interval, reaching back as far as Yahoo serves the interval.
export function yahooJobs(client: YahooClient, symbols: string[], intervals: YahooInterval[]): CollectorJob[] {
  return intervals.flatMap((interval) =>
    symbols.map((symbol) => ({
      name: `yahoo ${interval} ${symbol}`,
      run: () =>
        client.history({ symbols: [symbol], interval, from: client.earliestAvailable(interval), to: client.closedUntil(interval) }),
    })),
  );
}

export function startCollector(jobs: CollectorJob[], everyMinutes: number) {
  let running = false;

  const run = async () => {
    if (running) {
      log.warn("previous run still in progress, skipping");
      return;
    }
    running = true;
    const started = Date.now();
    let errors = 0;
    log.info("run started", { jobs: jobs.length });
    try {
      for (const job of jobs) {
        try {
          await job.run();
        } catch (e) {
          errors++;
          log.error("job failed", { job: job.name, error: e });
        }
      }
    } finally {
      running = false;
      log.info("run finished", { seconds: Math.round((Date.now() - started) / 1000), errors });
    }
  };

  log.info("started", { jobs: jobs.length, everyMinutes });
  void run();
  setInterval(() => void run(), everyMinutes * 60_000).unref();
}
