// liquidation-heatmap.ts – a rough ESTIMATE of where leveraged positions would be liquidated, built from public
// series only (price bars, open interest, long/short ratio). Exchanges publish no per-position data, so this is
// a model, not a measurement. The method (the same idea as the "OI delta" heatmaps):
//
// 1. Walk the bars oldest to newest and keep a set of position cohorts (entry price, side, leverage, USD size).
// 2. A cohort is liquidated when a later bar trades through its liquidation price, and is removed.
// 3. After that, the cohorts are scaled or topped up so that their total always equals the real open interest:
//    OI above the model adds a new cohort at the bar's close (split long/short by the long share and spread over
//    the assumed leverage tiers); OI below the model shrinks every surviving cohort proportionally (closed positions).
// 4. The cohorts alive at the end, placed at their liquidation prices, form the heatmap.
//
// Known biases: the OI that exists before the first bar is assumed to have been opened at the first close, so use
// a window long enough for it to wash out; the leverage mix is an assumption; cross margin, hedged books and
// partial liquidations are ignored.

export interface HeatmapBar {
  t: number; // epoch seconds
  h: number;
  l: number;
  c: number;
  oi: number; // open interest, USD
  longShare: number; // fraction of positions that are long, 0..1
}

export interface LeverageTier {
  leverage: number;
  weight: number; // relative share of new open interest
}

export const DEFAULT_TIERS: LeverageTier[] = [
  { leverage: 5, weight: 0.15 },
  { leverage: 10, weight: 0.3 },
  { leverage: 25, weight: 0.3 },
  { leverage: 50, weight: 0.15 },
  { leverage: 100, weight: 0.1 },
];

export interface HeatmapOptions {
  tiers?: LeverageTier[];
  maintenanceMargin?: number; // fraction of the position value, default 0.5%
  bucketPct?: number; // bucket width as % of the current price, default 0.5
  rangePct?: number; // show buckets within ±rangePct % of the current price, default 20
  topClusters?: number;
}

export interface HeatmapBucket {
  price: number; // bucket midpoint
  long: number; // USD of long positions liquidated here (below the price)
  short: number; // USD of short positions liquidated here (above the price)
}

export interface Heatmap {
  price: number;
  bars: number;
  buckets: HeatmapBucket[]; // ascending by price, empty buckets omitted
  clusters: (HeatmapBucket & { distancePct: number })[]; // biggest first
  totals: { longBelow: number; shortAbove: number; modelOi: number; actualOi: number };
  assumptions: { tiers: LeverageTier[]; maintenanceMargin: number; bucketPct: number; rangePct: number };
}

interface Cohort {
  long: boolean;
  liq: number;
  usd: number;
}

export function estimateLiquidationHeatmap(input: HeatmapBar[], opts: HeatmapOptions = {}): Heatmap {
  const tiers = (opts.tiers ?? DEFAULT_TIERS).filter((t) => t.leverage > 1 && t.weight > 0);
  if (tiers.length === 0) throw new Error("At least one leverage tier above 1x is required");
  const mmr = opts.maintenanceMargin ?? 0.005;
  const bucketPct = opts.bucketPct ?? 0.5;
  const rangePct = opts.rangePct ?? 20;
  const bars = [...input].sort((a, b) => a.t - b.t);
  const last = bars.at(-1);
  if (!last) throw new Error("No bars to build a heatmap from");

  const weightSum = tiers.reduce((s, t) => s + t.weight, 0);
  let cohorts: Cohort[] = [];

  for (const bar of bars) {
    // 1. liquidations by this bar's range
    cohorts = cohorts.filter((c) => (c.long ? bar.l > c.liq : bar.h < c.liq));

    // 2. reconcile with the real open interest
    const model = cohorts.reduce((s, c) => s + c.usd, 0);
    if (bar.oi > model) {
      const added = bar.oi - model;
      for (const tier of tiers) {
        const usd = (added * tier.weight) / weightSum;
        const margin = 1 / tier.leverage - mmr;
        if (margin <= 0) continue; // liquidated at once; nothing rests on the book
        cohorts.push({ long: true, liq: bar.c * (1 - margin), usd: usd * bar.longShare });
        cohorts.push({ long: false, liq: bar.c * (1 + margin), usd: usd * (1 - bar.longShare) });
      }
    } else if (model > 0 && bar.oi < model) {
      const k = bar.oi / model;
      for (const c of cohorts) c.usd *= k;
    }
  }

  const price = last.c;
  const width = (price * bucketPct) / 100;
  const lo = price * (1 - rangePct / 100);
  const hi = price * (1 + rangePct / 100);
  const byBucket = new Map<number, HeatmapBucket>();
  for (const c of cohorts) {
    if (c.usd <= 0 || c.liq < lo || c.liq > hi) continue;
    const i = Math.floor(c.liq / width);
    const b = byBucket.get(i) ?? { price: (i + 0.5) * width, long: 0, short: 0 };
    if (c.long) b.long += c.usd;
    else b.short += c.usd;
    byBucket.set(i, b);
  }
  const buckets = [...byBucket.values()].sort((a, b) => a.price - b.price).map(roundBucket);
  const clusters = [...buckets]
    .sort((a, b) => b.long + b.short - (a.long + a.short))
    .slice(0, opts.topClusters ?? 8)
    .map((b) => ({ ...b, distancePct: Math.round(((b.price - price) / price) * 10_000) / 100 }));

  return {
    price,
    bars: bars.length,
    buckets,
    clusters,
    totals: {
      longBelow: Math.round(cohorts.filter((c) => c.long && c.liq >= lo && c.liq <= price).reduce((s, c) => s + c.usd, 0)),
      shortAbove: Math.round(cohorts.filter((c) => !c.long && c.liq <= hi && c.liq >= price).reduce((s, c) => s + c.usd, 0)),
      modelOi: Math.round(cohorts.reduce((s, c) => s + c.usd, 0)),
      actualOi: Math.round(last.oi),
    },
    assumptions: { tiers, maintenanceMargin: mmr, bucketPct, rangePct },
  };
}

const roundBucket = (b: HeatmapBucket): HeatmapBucket => ({
  price: Math.round(b.price * 100) / 100, long: Math.round(b.long), short: Math.round(b.short),
});
