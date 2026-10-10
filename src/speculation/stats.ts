// speculation/stats.ts – small statistics shared by the scorer (score.ts) and the macro-driver scorer (drivers.ts).

export interface Interval {
  lo: number;
  hi: number;
}

export const round3 = (x: number) => Math.round(x * 1000) / 1000;

// 95% Wilson score interval of a proportion k/n.
export function wilson(k: number, n: number, z = 1.96): Interval | undefined {
  if (n === 0) return undefined;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: round3(Math.max(0, c - h)), hi: round3(Math.min(1, c + h)) };
}
