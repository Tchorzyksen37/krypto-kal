// present/thresholds.ts – the named thresholds the facts use. One place, so a fact always says which threshold it
// applied, and the skills' playbook (.claude/skills/crypto-market-sentiment/references/derivatives-playbook.md)
// quotes the same numbers. They are heuristics from a small sample, not calibrated values.

export const FUNDING_CROWDED_PCTL = 80; // funding at or above this percentile of the window: longs crowded
export const FUNDING_QUIET_PCTL = 20; // at or below: shorts crowded (or longs leaving)
export const TAKER_SELLERS_SHARE = 0.48; // taker buy share below this: aggressive sellers dominate
export const TAKER_BUYERS_SHARE = 0.52; // above this: aggressive buyers dominate
export const OI_NEAR_HIGH = 0.98; // open interest within 2% of the window's highest close
export const LS_ABOVE_MEDIAN = 1.05; // long/short ratio 5% above the window median: clearly long
export const LS_BELOW_MEDIAN = 0.95; // 5% below: clearly short
export const SPIKE_QUANTILE = 0.95; // liquidation bars above this quantile of the window are spikes
export const QUADRANT_FLAT_PCT = 0.1; // price or OI moves smaller than this (in %) count as flat
export const SWING_SIDE = 3; // a swing high/low must beat this many bars on each side
export const ATR_PERIOD = 14;
export const QUOTE_STALE_MINUTES = 30; // a quote whose last price is older than this is "stale" (closed market)
