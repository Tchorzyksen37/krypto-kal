// futures-risk.ts – pre-trade risk limits for the futures bot. A pure function with no I/O, so the
// same rules run in backtests, paper trading and live, and are easy to test exhaustively.
//
// Every order goes through checkOrder() before it is sent. The rules:
// - Reduce-only orders are always allowed (closing must never be blocked by a limit). Plain orders
//   count as closing only for the part that closes the position even in the worst case below,
//   so the bot should close with reduceOnly: true.
// - Orders that open or increase exposure are checked against all caps and are shrunk to the
//   largest size that fits, or rejected when nothing fits.
// - Exposure is counted WORST CASE: the current position plus every open non-reduce-only order on
//   the same side, as if they all filled. Otherwise several resting orders could bypass the caps.
//
// Sizes are in contracts of linear PF_ perpetuals, where 1 contract = 1 unit of the base asset,
// so notional = size × price. Inverse (PI_) contracts are not supported here.

export interface RiskLimits {
  symbols: string[]; // only these may be opened or increased
  maxPositionNotional: number; // USD, absolute worst-case exposure per symbol
  maxTotalNotional: number; // USD, gross worst-case exposure across all symbols
  maxLeverage: number; // gross worst-case exposure / account equity
  maxOpenPositions: number; // symbols with a position or a pending opening order
  maxOrderNotional: number; // USD, one order
  maxOpenOrders: number; // resting orders of any kind
  maxOrdersPerHour: number; // opening orders; guards against a bot stuck in a loop
  maxDailyLoss: number; // USD below the day's starting equity; then only reducing orders pass
}

export interface RiskState {
  equity: number; // current portfolio value incl. unrealized PnL, USD
  dayStartEquity: number;
  positions: { symbol: string; size: number }[]; // signed: + long, − short
  openOrders: { symbol: string; side: "buy" | "sell"; size: number; reduceOnly: boolean }[]; // unfilled size
  prices: Record<string, number>; // mark price per symbol
  ordersLastHour: number;
  halted?: boolean; // manual or automatic kill switch
}

export interface OrderIntent {
  symbol: string;
  side: "buy" | "sell";
  size: number; // contracts, > 0
  reduceOnly?: boolean;
  minSize?: number; // exchange minimum; a clamped size below this is rejected
}

export type RiskDecision =
  | { action: "allow"; size: number; clampedBy?: string } // `size` may be smaller than requested
  | { action: "reject"; reason: string };

export interface SymbolExposure {
  position: number; // signed
  worstLong: number; // position if all opening buy orders fill (>= position)
  worstShort: number; // position if all opening sell orders fill (<= position)
  worstAbs: number; // max(|worstLong|, |worstShort|)
}

const key = (s: string) => s.toUpperCase();
const EPS = 1e-12;

export function exposure(state: RiskState): Map<string, SymbolExposure> {
  const out = new Map<string, SymbolExposure>();
  const get = (symbol: string) => {
    let e = out.get(key(symbol));
    if (!e) out.set(key(symbol), (e = { position: 0, worstLong: 0, worstShort: 0, worstAbs: 0 }));
    return e;
  };
  for (const p of state.positions) {
    const e = get(p.symbol);
    e.position += p.size;
    e.worstLong += p.size;
    e.worstShort += p.size;
  }
  for (const o of state.openOrders) {
    if (o.reduceOnly) continue; // can only shrink the position
    const e = get(o.symbol);
    if (o.side === "buy") e.worstLong += o.size;
    else e.worstShort -= o.size;
  }
  for (const e of out.values()) e.worstAbs = Math.max(Math.abs(e.worstLong), Math.abs(e.worstShort));
  return out;
}

export function grossNotional(state: RiskState): number {
  let total = 0;
  for (const [symbol, e] of exposure(state)) total += e.worstAbs * (priceOf(state, symbol) ?? 0);
  return total;
}

export function dailyLoss(state: RiskState): number {
  return Math.max(0, state.dayStartEquity - state.equity);
}

export function checkOrder(intent: OrderIntent, state: RiskState, limits: RiskLimits): RiskDecision {
  if (!(intent.size > 0) || !Number.isFinite(intent.size)) return reject(`invalid size ${intent.size}`);

  const exp = exposure(state);
  const e = exp.get(key(intent.symbol)) ?? { position: 0, worstLong: 0, worstShort: 0, worstAbs: 0 };
  const dir = intent.side === "buy" ? 1 : -1;

  if (intent.reduceOnly) {
    // The exchange caps a reduce-only order at the position; mirror that here.
    const reducible = Math.sign(e.position) === -dir ? Math.abs(e.position) : 0;
    return reducible > 0
      ? allow(Math.min(intent.size, reducible), intent.size, "reduce-only: position size")
      : reject("reduce-only order has nothing to reduce");
  }

  // The part of the order that surely closes exposure: what is left of the position on the
  // opposite side even if every resting order on the order's side fills first. Anything beyond
  // that may open a new position in the worst case. (A halted bot should cancel its opening
  // orders first, so its closing orders are not mistaken for opening ones.)
  const worstSide = dir > 0 ? e.worstLong : e.worstShort;
  const reducing = Math.min(intent.size, Math.max(0, -dir * worstSide));
  const opening = intent.size - reducing;
  if (opening <= EPS) return allow(intent.size, intent.size);

  // From here on the order adds exposure; each check yields the opening size it still permits.
  const blockOpening = (reason: string): RiskDecision =>
    reducing > 0 ? allow(reducing, intent.size, reason) : reject(reason);

  if (state.halted) return blockOpening("trading halted");
  if (dailyLoss(state) >= limits.maxDailyLoss) return blockOpening(`daily loss limit (${limits.maxDailyLoss} USD) reached`);
  if (!limits.symbols.some((s) => key(s) === key(intent.symbol))) return blockOpening(`${intent.symbol} is not in the allowed symbols`);
  if (state.ordersLastHour >= limits.maxOrdersPerHour) return blockOpening(`max ${limits.maxOrdersPerHour} orders per hour`);
  if (state.openOrders.length >= limits.maxOpenOrders) return blockOpening(`max ${limits.maxOpenOrders} open orders`);

  const price = priceOf(state, intent.symbol);
  if (!price || !(price > 0)) return blockOpening(`no price for ${intent.symbol}`);
  if (!(state.equity > 0)) return blockOpening("no account equity");
  // Without a price an existing exposure would count as 0 USD and the caps would be too loose.
  for (const [symbol, x] of exp) {
    if (x.worstAbs > EPS && !(priceOf(state, symbol)! > 0)) return blockOpening(`no price for ${symbol}`);
  }

  // Is this a new position? (Nothing held or pending in this symbol yet.)
  if (e.worstAbs <= EPS) {
    let active = 0;
    for (const x of exp.values()) if (x.worstAbs > EPS) active++;
    if (active >= limits.maxOpenPositions) return blockOpening(`max ${limits.maxOpenPositions} open positions`);
  }

  // Worst-case position on the order's side after it fills; the order's reducing part only
  // moves the position toward zero first, so on that side the growth is `opening`.
  const symbolRoom = limits.maxPositionNotional / price - Math.max(0, dir * worstSide + reducing);

  // Gross exposure grows only if this symbol's worst case grows.
  const totalNow = grossNotional(state);
  const symbolGrowth = (opening: number) => Math.max(0, Math.max(0, dir * worstSide + reducing) + opening - e.worstAbs);
  const grossCap = Math.min(limits.maxTotalNotional, limits.maxLeverage * state.equity);
  const grossRoomNotional = grossCap - totalNow;

  const caps: [number, string][] = [
    [symbolRoom, `max position ${limits.maxPositionNotional} USD in ${intent.symbol}`],
    [solveGrowth(opening, symbolGrowth, grossRoomNotional / price), limits.maxLeverage * state.equity < limits.maxTotalNotional
      ? `max leverage ${limits.maxLeverage}x` : `max total exposure ${limits.maxTotalNotional} USD`],
    [Math.max(0, limits.maxOrderNotional / price - reducing), `max order ${limits.maxOrderNotional} USD`],
  ];
  let allowedOpening = opening;
  let binding = "";
  for (const [room, reason] of caps) {
    if (room < allowedOpening - EPS) {
      allowedOpening = Math.max(0, room);
      binding = reason;
    }
  }

  const size = reducing + allowedOpening;
  if (allowedOpening <= EPS) return blockOpening(binding || "no room");
  if (intent.minSize !== undefined && size < intent.minSize) return reject(`${binding}: allowed size ${size} is below the minimum ${intent.minSize}`);
  return allow(size, intent.size, binding);
}

// Largest opening size x <= max with growth(x) <= room; growth is 0 up to some point, then rises 1:1.
function solveGrowth(max: number, growth: (x: number) => number, room: number): number {
  if (growth(max) <= room + EPS) return max;
  const free = max - growth(max); // the part of `max` that doesn't grow gross exposure
  return Math.max(0, free + Math.max(0, room));
}

function priceOf(state: RiskState, symbol: string): number | undefined {
  const k = key(symbol);
  for (const [s, p] of Object.entries(state.prices)) if (key(s) === k) return p;
  return undefined;
}

const reject = (reason: string): RiskDecision => ({ action: "reject", reason });
const allow = (size: number, requested: number, reason?: string): RiskDecision =>
  size < requested - EPS && reason ? { action: "allow", size, clampedBy: reason } : { action: "allow", size };
