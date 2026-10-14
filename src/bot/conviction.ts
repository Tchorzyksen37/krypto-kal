// conviction.ts – corrects a bet's stated probability with the scorecard history. Pure apart from
// loadCalibration, which reads bets-log.json. Global pooled ratio: observed take-profit hits over the
// hits the stated probabilities promised, shrunk toward 1 by K pseudo-bets that were perfectly calibrated.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutOverlaps } from "../speculation/overlap.ts";
import type { LoggedBet } from "../speculation/types.ts";

export const CALIBRATION_K = 10;

const TOUCHED = new Set(["tp", "sl", "ttl"]);

export function calibrationRatio(
  log: LoggedBet[],
  k = CALIBRATION_K,
): { ratio: number; touched: number; hits: number; expected: number } {
  const bets = withoutOverlaps(log).filter(
    (b) => b.hypothetical && TOUCHED.has(b.hypothetical.status) && Number.isFinite(b.probability),
  );
  const touched = bets.length;
  if (touched === 0) return { ratio: 1, touched: 0, hits: 0, expected: 0 };
  const hits = bets.filter((b) => b.hypothetical?.status === "tp").length;
  const expected = bets.reduce((sum, b) => sum + b.probability, 0);
  const prior = k * (expected / touched);
  const denominator = expected + prior;
  return { ratio: denominator > 0 ? (hits + prior) / denominator : 1, touched, hits, expected };
}

export const calibratedConviction = (stated: number, ratio: number): number =>
  Math.min(1, Math.max(0, stated * ratio));

export function loadCalibration(
  speculationDir: string,
  k = CALIBRATION_K,
): { ratio: number; touched: number; warning?: string } {
  const path = join(speculationDir, "bets-log.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("not a JSON array");
    const { ratio, touched } = calibrationRatio(parsed as LoggedBet[], k);
    return { ratio, touched };
  } catch (e) {
    return {
      ratio: 1,
      touched: 0,
      warning: `bets log unreadable (${path}): ${e instanceof Error ? e.message : String(e)}; using the stated probability`,
    };
  }
}
