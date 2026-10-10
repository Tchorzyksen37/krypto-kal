// present/round.ts – deterministic rounding and number-to-text for what the model reads.
// One rule per field class, so the same value always prints the same way on every machine. Rounding only uses
// toPrecision / toFixed (no locale, no Intl), and numbers are never printed in exponent form.

export type RoundRule =
  | { kind: "sig"; digits: number } // significant figures
  | { kind: "fixed"; decimals: number } // fixed decimals
  | { kind: "scaled"; divisor: number; decimals: number }; // value / divisor, fixed decimals (USD in k or M)

export const PRICE: RoundRule = { kind: "sig", digits: 7 }; // keeps 102345.7 and 0.5234567; drops float32 noise
export const QUANTITY: RoundRule = { kind: "sig", digits: 6 }; // volumes, contract counts
export const COUNT: RoundRule = { kind: "fixed", decimals: 0 }; // trades
export const RATIO: RoundRule = { kind: "fixed", decimals: 3 }; // long/short ratio, shares 0..1
export const PERCENT: RoundRule = { kind: "fixed", decimals: 2 }; // % of accounts
export const FUNDING: RoundRule = { kind: "sig", digits: 4 }; // funding in %, often 0.00xx

export function round(x: number, rule: RoundRule): number {
  if (!Number.isFinite(x)) return x;
  switch (rule.kind) {
    case "sig":
      return x === 0 ? 0 : Number(x.toPrecision(rule.digits));
    case "fixed":
      return Number(x.toFixed(rule.decimals)) || 0; // || 0 turns -0 into 0
    case "scaled":
      return Number((x / rule.divisor).toFixed(rule.decimals)) || 0;
  }
}

// A number as plain decimal text: no exponent, no trailing zeros, "" for a missing or non-finite value.
export function num(x: number | undefined | null): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return "";
  const s = String(x);
  if (!/e/i.test(s)) return s;
  const fixed = Math.abs(x) < 1 ? x.toFixed(20) : BigInt(Math.round(x)).toString();
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

export interface UsdScale {
  rule: RoundRule;
  suffix: "usd" | "kusd" | "musd";
  label: string;
}

// One scale for a whole USD column, picked from its largest absolute value, so the column reads at one magnitude:
// >= 100M in millions (2 decimals = 10k USD steps), >= 100k in thousands (1 decimal = 100 USD), else whole USD.
export function usdScale(values: Iterable<number>): UsdScale {
  let max = 0;
  for (const v of values) if (Number.isFinite(v)) max = Math.max(max, Math.abs(v));
  if (max >= 1e8) return { rule: { kind: "scaled", divisor: 1e6, decimals: 2 }, suffix: "musd", label: "USD millions" };
  if (max >= 1e5) return { rule: { kind: "scaled", divisor: 1e3, decimals: 1 }, suffix: "kusd", label: "USD thousands" };
  return { rule: { kind: "fixed", decimals: 0 }, suffix: "usd", label: "USD" };
}
