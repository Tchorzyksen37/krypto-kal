// speculation/positioning.ts – MEASURED rhythm of open interest and behaviour after sharp moves, from hourly bars.
//  * hourlyOiProfile: in which UTC hours (Monday-Friday) open interest moves most, and in which it is built or unwound
//    on average. A rise in open interest means positions are opened, a fall means they are closed or liquidated.
//  * postShockStats: what usually follows a sharp one-hour price move: open interest (it follows the move and fades),
//    how much of the move is given back after a day or two, and how range and volume decay.
// Pure functions; hourly bars with `t` = hour start in epoch seconds. A heuristic from a short sample: quote `n`.

export interface HourBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base units
}

export interface OiPoint {
  t: number; // hour start; `c` is open interest at the end of that hour
  c: number;
}

const HOUR = 3600;
export const MIN_OI_DAYS = 5;
export const MIN_SHOCKS = 3;

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d + 0; // + 0 turns -0 into 0
const median = (a: number[]): number | undefined => {
  if (!a.length) return undefined;
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const finite = (a: (number | undefined)[]): number[] => a.filter((x): x is number => x !== undefined && Number.isFinite(x));

// ---- when positions are opened and closed ----

export interface HourlyOiProfile {
  days: number; // weekdays covered
  busiest_hours_utc: { hour: number; median_abs_change_pct: number }[]; // largest typical change, either direction
  quietest_hours_utc: { hour: number; median_abs_change_pct: number }[];
  build_hours_utc: { hour: number; mean_change_pct: number }[]; // open interest grows on average
  unwind_hours_utc: { hour: number; mean_change_pct: number }[]; // open interest shrinks on average
}

export function hourlyOiProfile(oi: OiPoint[]): HourlyOiProfile | undefined {
  const byT = new Map(oi.map((p) => [p.t, p.c]));
  const perHour: number[][] = Array.from({ length: 24 }, () => []);
  const days = new Set<string>();
  for (const p of oi) {
    const prev = byT.get(p.t - HOUR);
    if (prev === undefined || prev <= 0) continue;
    const d = new Date(p.t * 1000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    perHour[d.getUTCHours()]!.push(((p.c - prev) / prev) * 100);
    days.add(d.toISOString().slice(0, 10));
  }
  if (days.size < MIN_OI_DAYS || perHour.some((x) => !x.length)) return undefined;
  const rows = perHour.map((x, hour) => ({ hour, abs: median(x.map(Math.abs))!, net: mean(x) }));
  const top = <K extends string>(sorted: typeof rows, n: number, key: K, pick: (r: (typeof rows)[number]) => number) =>
    sorted.slice(0, n).map((r) => ({ hour: r.hour, [key]: round(pick(r)) }));
  return {
    days: days.size,
    busiest_hours_utc: top([...rows].sort((a, b) => b.abs - a.abs), 3, "median_abs_change_pct", (r) => r.abs) as HourlyOiProfile["busiest_hours_utc"],
    quietest_hours_utc: top([...rows].sort((a, b) => a.abs - b.abs), 2, "median_abs_change_pct", (r) => r.abs) as HourlyOiProfile["quietest_hours_utc"],
    build_hours_utc: top([...rows].sort((a, b) => b.net - a.net), 3, "mean_change_pct", (r) => r.net) as HourlyOiProfile["build_hours_utc"],
    unwind_hours_utc: top([...rows].sort((a, b) => a.net - b.net), 3, "mean_change_pct", (r) => r.net) as HourlyOiProfile["unwind_hours_utc"],
  };
}

// ---- what follows a sharp move ----

export interface ShockOptions {
  percentile: number; // an hour is a shock when |close-to-close return| is at least this quantile of all hours ...
  minMovePct: number; // ... and at least this many percent, and at least three times the median hourly move
  separationHours: number; // events closer than this to the previous one are part of it
}
export const DEFAULT_SHOCK: ShockOptions = { percentile: 0.985, minMovePct: 0.5, separationHours: 6 };

export interface OiFollow {
  n: number;
  oi_at_shock_pct?: number; // open interest change during the shocked hour
  oi_after_4h_pct?: number; // change from the end of the shocked hour to +4h / +24h / +48h
  oi_after_24h_pct?: number;
  oi_after_48h_pct?: number;
}

export interface ShockStats {
  threshold_pct: number;
  events: number; // shocks with at least 24h of follow-up
  up_events: number;
  down_events: number;
  up?: OiFollow;
  down?: OiFollow;
  retraced_24h?: number; // median share of the move given back: 1 = all of it, 0 = none, negative = it went on
  retraced_48h?: number;
  range_ratio_next_12h?: number; // average hourly range in the 12h after / in the 12h before
  range_ratio_13_36h?: number; // the same for hours 13-36 after
  volume_ratio_next_24h?: number; // volume of the 24h after / of the 24h before
}

export function postShockStats(price: HourBar[], oi: OiPoint[], opts: Partial<ShockOptions> = {}): ShockStats | undefined {
  const o = { ...DEFAULT_SHOCK, ...opts };
  const px = new Map(price.map((b) => [b.t, b]));
  const oiAt = new Map(oi.map((p) => [p.t, p.c]));
  const sorted = [...price].sort((a, b) => a.t - b.t);
  const rets: { t: number; r: number }[] = [];
  for (const b of sorted) {
    const prev = px.get(b.t - HOUR);
    if (prev && prev.c > 0) rets.push({ t: b.t, r: b.c / prev.c - 1 });
  }
  if (rets.length < 48) return undefined;
  const abs = rets.map((x) => Math.abs(x.r)).sort((a, b) => a - b);
  const q = abs[Math.min(abs.length - 1, Math.floor(abs.length * o.percentile))]!;
  const thr = Math.max(q, 3 * median(abs)!, o.minMovePct / 100);

  const shocks: { t: number; r: number }[] = [];
  let last = -Infinity;
  for (const x of rets) {
    if (Math.abs(x.r) >= thr && x.t - last > o.separationHours * HOUR) {
      shocks.push(x);
      last = x.t;
    }
  }

  const avgRange = (t: number, from: number, to: number) => {
    const rs: number[] = [];
    for (let k = from; k < to; k++) {
      const b = px.get(t + k * HOUR);
      if (!b) return undefined;
      rs.push((b.h - b.l) / b.o);
    }
    return mean(rs);
  };
  const volume = (t: number, from: number, to: number) => {
    let sum = 0;
    for (let k = from; k < to; k++) {
      const b = px.get(t + k * HOUR);
      if (!b) return undefined;
      sum += b.v;
    }
    return sum;
  };

  const rows = shocks.flatMap((s) => {
    const pre = px.get(s.t - HOUR)!.c, post = px.get(s.t)!.c;
    const g24 = px.get(s.t + 24 * HOUR);
    const oi0 = oiAt.get(s.t), oiPrev = oiAt.get(s.t - HOUR), oi24 = oiAt.get(s.t + 24 * HOUR);
    if (!g24 || oi0 === undefined || oiPrev === undefined || oi24 === undefined) return []; // not enough follow-up yet
    const g48 = px.get(s.t + 48 * HOUR), oi4 = oiAt.get(s.t + 4 * HOUR), oi48 = oiAt.get(s.t + 48 * HOUR);
    const rPre = avgRange(s.t, -12, 0), r12 = avgRange(s.t, 1, 13), rLate = avgRange(s.t, 13, 37);
    const vPre = volume(s.t, -24, 0), vPost = volume(s.t, 1, 25);
    return [{
      up: s.r > 0,
      oiAtShock: ((oi0 - oiPrev) / oiPrev) * 100,
      oi4: oi4 === undefined ? undefined : ((oi4 - oi0) / oi0) * 100,
      oi24: ((oi24 - oi0) / oi0) * 100,
      oi48: oi48 === undefined ? undefined : ((oi48 - oi0) / oi0) * 100,
      retr24: (g24.c - post) / (pre - post),
      retr48: g48 ? (g48.c - post) / (pre - post) : undefined,
      range12: rPre && r12 !== undefined ? r12 / rPre : undefined,
      rangeLate: rPre && rLate !== undefined ? rLate / rPre : undefined,
      vol: vPre && vPost !== undefined ? vPost / vPre : undefined,
    }];
  });
  if (rows.length < MIN_SHOCKS) return undefined;

  const follow = (sel: typeof rows): OiFollow | undefined => {
    if (sel.length < 2) return undefined;
    const out: OiFollow = { n: sel.length };
    const set = (key: Exclude<keyof OiFollow, "n">, vals: (number | undefined)[]) => {
      const m = median(finite(vals));
      if (m !== undefined) out[key] = round(m);
    };
    set("oi_at_shock_pct", sel.map((r) => r.oiAtShock));
    set("oi_after_4h_pct", sel.map((r) => r.oi4));
    set("oi_after_24h_pct", sel.map((r) => r.oi24));
    set("oi_after_48h_pct", sel.map((r) => r.oi48));
    return out;
  };
  const stats: ShockStats = {
    threshold_pct: round(thr * 100), events: rows.length,
    up_events: rows.filter((r) => r.up).length, down_events: rows.filter((r) => !r.up).length,
  };
  const up = follow(rows.filter((r) => r.up)), down = follow(rows.filter((r) => !r.up));
  if (up) stats.up = up;
  if (down) stats.down = down;
  const put = (key: "retraced_24h" | "retraced_48h" | "range_ratio_next_12h" | "range_ratio_13_36h" | "volume_ratio_next_24h", vals: (number | undefined)[]) => {
    const m = median(finite(vals));
    if (m !== undefined) stats[key] = round(m);
  };
  put("retraced_24h", rows.map((r) => r.retr24));
  put("retraced_48h", rows.map((r) => r.retr48));
  put("range_ratio_next_12h", rows.map((r) => r.range12));
  put("range_ratio_13_36h", rows.map((r) => r.rangeLate));
  put("volume_ratio_next_24h", rows.map((r) => r.vol));
  return stats;
}
