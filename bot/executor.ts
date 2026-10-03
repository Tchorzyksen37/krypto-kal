// executor.ts – the boundary between the engine and an exchange. The engine and the watchdog read all account
// state and place all orders through an Executor, so dry-run and live run the very same code.
// Rules (spec section 7): an ack is not a confirmation (read back with getOpenOrders/getPositions), every order has
// a deterministic cliOrdId, rejections are typed, and nothing here retries.

import type { FuturesCandle, FuturesFill, FuturesOpenOrder, FuturesPosition } from "../kraken-futures-client.ts";
import type { Clock } from "./clock.ts";

export type { FuturesFill, FuturesOpenOrder, FuturesPosition };

export type OrderRole = "entry" | "sl" | "tp1" | "tp2" | "tp3" | "close";

const ROLES: readonly OrderRole[] = ["entry", "sl", "tp1", "tp2", "tp3", "close"];

// Every order the bot creates starts with this; anything else on the symbol is foreign (e.g. a manual order).
export const BOT_ORDER_PREFIX = "bot-";

// Deterministic id: a retry after a lost ack reuses it, so the same order is never created twice.
export function makeCliOrdId(policyId: number, role: OrderRole, seq: number): string {
  if (!Number.isInteger(policyId) || policyId < 0) throw new RangeError(`invalid policy id ${policyId}`);
  if (!ROLES.includes(role)) throw new RangeError(`invalid order role ${role}`);
  if (!Number.isInteger(seq) || seq < 0) throw new RangeError(`invalid order sequence ${seq}`);
  return `${BOT_ORDER_PREFIX}${policyId}-${role}-${seq}`;
}

export function parseCliOrdId(id: string): { policyId: number; role: OrderRole; seq: number } | undefined {
  const m = /^bot-(\d+)-(entry|sl|tp1|tp2|tp3|close)-(\d+)$/.exec(id);
  return m ? { policyId: Number(m[1]), role: m[2] as OrderRole, seq: Number(m[3]) } : undefined;
}

export const isBotOrder = (cliOrdId: string | undefined): boolean => !!cliOrdId && cliOrdId.startsWith(BOT_ORDER_PREFIX);

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  orderType: "lmt" | "post" | "mkt" | "stp" | "take_profit";
  size: number;
  limitPrice?: number; // lmt, post
  stopPrice?: number; // stp, take_profit (stop-market only: no limitPrice)
  reduceOnly: boolean;
  triggerSignal?: "mark" | "last"; // stp, take_profit; defaults to mark
  cliOrdId: string;
  processBefore?: string; // ISO 8601
}

export interface OrderEdit {
  cliOrdId: string;
  stopPrice?: number;
  limitPrice?: number;
  size?: number;
}

export type RejectKind = "insufficient_margin" | "reduce_only_violation" | "would_cross" | "rate_limited" | "unknown";

export type OrderAck = { ok: true; orderId: string } | { ok: false; kind: RejectKind; message: string };

export interface AccountState {
  equity: number; // start equity + realized - fees - funding + unrealized
  availableMargin: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  funding: number;
}

export interface PriceEvent {
  t: number; // epoch ms
  mark: number;
  last: number;
  bid: number;
  ask: number;
}

export interface Executor {
  readonly kind: "dry-run" | "live";
  placeOrder(req: OrderRequest): Promise<OrderAck>;
  editOrder(edit: OrderEdit): Promise<OrderAck>;
  cancelOrder(id: { cliOrdId: string } | { orderId: string }): Promise<void>; // idempotent
  cancelAll(symbol: string): Promise<void>;
  getPositions(): Promise<FuturesPosition[]>;
  getOpenOrders(): Promise<FuturesOpenOrder[]>;
  getFills(since: Date): Promise<FuturesFill[]>;
  getAccount(): Promise<AccountState>;
}

// Market data always comes from the real read-only client, in dry-run too.
export interface MarketData {
  ticker(): Promise<PriceEvent>;
  candles(resolution: string, n: number): Promise<FuturesCandle[]>;
  fundingRates(): Promise<{ t: number; rate: number }[]>;
  clock: Clock;
}
