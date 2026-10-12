// present/resample.ts – deterministic aggregation of bars to a coarser interval, used by the row budget: recent bars
// keep their native interval, older ones are merged into epoch-aligned buckets. Each output row says how many native
// bars it holds, so a partial bucket (at the start of the window, or with missing bars) is visible, never hidden.

import type { Agg } from "./units.ts";

export interface Row {
  t: number; // epoch seconds, bar (or bucket) start
  v: (number | undefined)[]; // one value per base column
  bars: number; // native bars in this row
}

// Bucket factors tried in order: 1h bars become 2h, 3h, 4h, 6h, 8h, 12h, 1d, 2d, 3d, 1w, 2w, 30d.
export const FACTORS = [2, 3, 4, 6, 8, 12, 24, 48, 72, 168, 336, 720] as const;

function aggregate(values: (number | undefined)[], agg: Agg): number | undefined {
  const xs = values.filter((x): x is number => x !== undefined && Number.isFinite(x));
  if (!xs.length) return undefined;
  switch (agg) {
    case "first":
      return xs[0];
    case "last":
      return xs[xs.length - 1];
    case "max":
      return Math.max(...xs);
    case "min":
      return Math.min(...xs);
    case "sum":
      return xs.reduce((a, b) => a + b, 0);
  }
}

// Merges time-ordered rows into buckets of `bucketSec` aligned to the epoch. Values aggregate per column with `aggs`.
export function resample(rows: Row[], bucketSec: number, aggs: Agg[]): Row[] {
  const out: Row[] = [];
  let group: Row[] = [];
  const flush = () => {
    if (!group.length) return;
    out.push({
      t: Math.floor(group[0]!.t / bucketSec) * bucketSec,
      v: aggs.map((agg, i) => aggregate(group.map((r) => r.v[i]), agg)),
      bars: group.reduce((n, r) => n + r.bars, 0),
    });
    group = [];
  };
  for (const r of rows) {
    if (group.length && Math.floor(r.t / bucketSec) !== Math.floor(group[0]!.t / bucketSec)) flush();
    group.push(r);
  }
  flush();
  return out;
}

export interface BudgetPlan {
  bucketSec: number; // interval of the resampled older rows
  boundary: number; // rows with t >= boundary stay native
  rows: Row[]; // the resampled older rows followed by the native recent rows
}

// Fits `rows` into `maxRows`: the newest `recent` rows (at most half the budget) stay native, the older ones are
// resampled with the smallest factor of FACTORS that fits. The last older bucket ends at the boundary and can be partial; its `bars` says so.
// Returns undefined when the rows already fit.
export function fitRows(rows: Row[], stepSec: number, maxRows: number, recent: number, aggs: Agg[]): BudgetPlan | undefined {
  if (rows.length <= maxRows) return undefined;
  const keep = Math.max(1, Math.min(recent, Math.floor(maxRows / 2)));
  const boundary = rows[rows.length - keep]!.t;
  const native = rows.slice(rows.length - keep);
  const olderRows = rows.slice(0, rows.length - keep);
  let plan: BudgetPlan | undefined;
  for (const factor of FACTORS) {
    const bucketSec = stepSec * factor;
    const older = resample(olderRows, bucketSec, aggs);
    plan = { bucketSec, boundary, rows: [...older, ...native] };
    if (plan.rows.length <= maxRows) return plan;
  }
  return plan; // even the coarsest factor does not fit: return it anyway, the header shows the row count
}
