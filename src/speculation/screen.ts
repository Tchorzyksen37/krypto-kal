// speculation/screen.ts – picks which symbols a speculation report covers.
// Core symbols are always included. Extra symbols must pass liquidity filters (a bet nobody can fill is
// worthless) and are then ranked by a "setup score" built only from measured inputs. Pure core plus a CLI:
//   node src/speculation/screen.ts <candidates.json>   (a JSON array of Candidate; prints the picks as JSON)

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface Candidate {
  symbol: string; // short name, e.g. "SOL"
  futures: string; // Kraken Futures contract
  volumeUsd24h: number;
  openInterestUsd: number;
  spreadBps: number;
  depthUsd: number; // book depth within 0.2% of mid, both sides' minimum
  candlesOk: boolean; // recent candles without gaps
  atrRatio: number; // 1h ATR / 24h median of 1h ATR
  oiChange1hPct: number;
  oiChange4hPct: number;
  fundingPct8h: number; // funding in percent per 8 hours (Kraken quotes hourly; context.ts converts)
  longShortRatio: number; // longs / shorts
  liqBurst: number; // last-hour liquidations / average hourly liquidations of the last 24h
  heatmapDistancePct?: number; // distance to the nearest ESTIMATED liquidation cluster
  xMentions?: number; // recent verified X mentions
}

export interface ScreenOptions {
  core: string[];
  extra: number;
  minVolumeUsd: number;
  minOpenInterestUsd: number;
  maxSpreadBps: number;
  minDepthUsd: number;
}

export const DEFAULT_SCREEN: ScreenOptions = {
  core: ["BTC", "ETH", "XRP"],
  extra: 3,
  minVolumeUsd: 20_000_000,
  minOpenInterestUsd: 5_000_000,
  maxSpreadBps: 5,
  minDepthUsd: 100_000,
};

export interface Pick {
  symbol: string;
  futures: string;
  why: string; // "core" or "screen: <reason>"
  score?: number;
  warnings: string[]; // e.g. a core symbol that fails the liquidity filters
}

export interface Excluded {
  symbol: string;
  reason: string;
}

export interface ScreenResult {
  picks: Pick[]; // core first (in the configured order), then extras by score
  excluded: Excluded[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// Components in [0, weight]; the reason names the strongest ones.
export function setupScore(c: Candidate): { score: number; reason: string } {
  const parts: [string, number][] = [
    [`ATR ${c.atrRatio.toFixed(1)}x its 24h median`, clamp01(c.atrRatio - 1) * 3],
    [`OI ${c.oiChange1hPct >= 0 ? "+" : ""}${c.oiChange1hPct.toFixed(1)}% 1h / ${c.oiChange4hPct >= 0 ? "+" : ""}${c.oiChange4hPct.toFixed(1)}% 4h`, clamp01(Math.max(Math.abs(c.oiChange1hPct) / 2, Math.abs(c.oiChange4hPct) / 5)) * 2],
    [`funding ${c.fundingPct8h.toFixed(3)}%/8h`, clamp01(Math.abs(c.fundingPct8h) / 0.05) * 2],
    [`long/short ${c.longShortRatio.toFixed(2)}`, c.longShortRatio > 0 ? clamp01(Math.abs(Math.log(c.longShortRatio)) / Math.log(2)) * 1.5 : 0],
    [`liquidations ${c.liqBurst.toFixed(1)}x normal`, clamp01((c.liqBurst - 1) / 3) * 1.5],
    [`ESTIMATED cluster ${c.heatmapDistancePct?.toFixed(2) ?? "?"}% away`, c.heatmapDistancePct === undefined ? 0 : clamp01(1 - c.heatmapDistancePct) * 0.5],
    [`${c.xMentions ?? 0} verified X mentions`, clamp01((c.xMentions ?? 0) / 3) * 0.5],
  ];
  const score = parts.reduce((s, [, v]) => s + v, 0);
  const top = parts
    .filter(([, v]) => v > 0.3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label]) => label);
  return { score: Math.round(score * 100) / 100, reason: top.length > 0 ? top.join(", ") : "no strong signal" };
}

export function filterReason(c: Candidate, o: ScreenOptions): string | undefined {
  if (c.volumeUsd24h < o.minVolumeUsd) return `24h volume ${Math.round(c.volumeUsd24h / 1e6)}M < ${Math.round(o.minVolumeUsd / 1e6)}M`;
  if (c.openInterestUsd < o.minOpenInterestUsd) return `open interest ${Math.round(c.openInterestUsd / 1e6)}M < ${Math.round(o.minOpenInterestUsd / 1e6)}M`;
  if (c.spreadBps > o.maxSpreadBps) return `spread ${c.spreadBps.toFixed(1)} bps > ${o.maxSpreadBps}`;
  if (c.depthUsd < o.minDepthUsd) return `depth ${Math.round(c.depthUsd / 1e3)}k < ${Math.round(o.minDepthUsd / 1e3)}k`;
  if (!c.candlesOk) return "candles missing or stale";
  return undefined;
}

export function screen(candidates: Candidate[], options: Partial<ScreenOptions> = {}): ScreenResult {
  const o = { ...DEFAULT_SCREEN, ...options };
  const core = new Set(o.core);
  const bySymbol = new Map(candidates.map((c) => [c.symbol, c]));
  const picks: Pick[] = [];
  const excluded: Excluded[] = [];

  for (const symbol of o.core) {
    const c = bySymbol.get(symbol);
    if (!c) {
      excluded.push({ symbol, reason: "core symbol missing from the candidate data" });
      continue;
    }
    const reason = filterReason(c, o);
    picks.push({ symbol, futures: c.futures, why: "core", warnings: reason ? [`core symbol fails filter: ${reason}`] : [] });
  }

  const ranked: { c: Candidate; score: number; reason: string }[] = [];
  for (const c of candidates) {
    if (core.has(c.symbol)) continue;
    const reason = filterReason(c, o);
    if (reason) {
      excluded.push({ symbol: c.symbol, reason });
      continue;
    }
    ranked.push({ c, ...setupScore(c) });
  }
  ranked.sort((a, b) => b.score - a.score || a.c.symbol.localeCompare(b.c.symbol));
  for (const r of ranked.slice(0, Math.max(0, o.extra))) {
    picks.push({ symbol: r.c.symbol, futures: r.c.futures, why: `screen: ${r.reason}`, score: r.score, warnings: [] });
  }
  for (const r of ranked.slice(Math.max(0, o.extra))) excluded.push({ symbol: r.c.symbol, reason: `ranked below the top ${o.extra} (score ${r.score})` });
  return { picks, excluded };
}

export function screenOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ScreenOptions> {
  const out: Partial<ScreenOptions> = {};
  const num = (k: string) => (env[k] ? Number(env[k]) : undefined);
  if (env.SPECULATION_SYMBOLS) out.core = env.SPECULATION_SYMBOLS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const extra = num("SPECULATION_SCREEN_EXTRA");
  const vol = num("SPECULATION_MIN_VOLUME_USD");
  const depth = num("SPECULATION_MIN_DEPTH_USD");
  if (extra !== undefined && Number.isFinite(extra)) out.extra = extra;
  if (vol !== undefined && Number.isFinite(vol)) out.minVolumeUsd = vol;
  if (depth !== undefined && Number.isFinite(depth)) out.minDepthUsd = depth;
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node src/speculation/screen.ts <candidates.json>");
    process.exit(2);
  }
  try {
    const candidates = JSON.parse(await readFile(path, "utf8")) as Candidate[];
    console.log(JSON.stringify(screen(candidates, screenOptionsFromEnv()), null, 2));
  } catch (e) {
    console.error(`screen failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
