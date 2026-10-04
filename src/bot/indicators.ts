// indicators.ts – small pure market-data helpers for the engine.

import type { FuturesCandle } from "../providers/kraken/kraken-futures-client.ts";

const RESOLUTION_SECONDS: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14_400, "12h": 43_200, "1d": 86_400, "1w": 604_800,
};

// Average true range over the last `period` CLOSED candles, or null when it cannot be trusted: too few candles, a
// gap between candles, a malformed candle, or an unknown resolution. A null ATR means "no entry"; it is never
// replaced by a guess. The candle still forming (its interval has not ended) is ignored. Candle t is in epoch SECONDS.
export function atr(candles: FuturesCandle[], period: number, resolution: string, nowMs: number): number | null {
  const step = RESOLUTION_SECONDS[resolution];
  if (step === undefined || !Number.isInteger(period) || period < 1 || !Number.isFinite(nowMs)) return null;

  const closed = [...candles].sort((a, b) => a.t - b.t).filter((c) => (c.t + step) * 1000 <= nowMs);
  if (closed.length < period + 1) return null;
  const window = closed.slice(-(period + 1)); // one extra candle for the first true range's previous close

  let sum = 0;
  for (let i = 0; i < window.length; i++) {
    const c = window[i]!;
    if (![c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0) || c.h < c.l) return null;
    if (i === 0) continue;
    const prev = window[i - 1]!;
    if (c.t - prev.t !== step) return null; // a gap: the true range across it would be wrong
    sum += Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
  }
  return sum / period;
}
