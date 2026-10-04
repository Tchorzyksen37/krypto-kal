// approving-executor.ts – a decorator that asks the user before an order that opens exposure reaches the inner
// executor (config.manual_approval). Everything that only reduces risk passes without asking: cancels, reads and
// reduce-only orders (stops, targets, closes). Asking before a protective order would leave a fresh position
// unprotected while the question waits, which is worse than the risk the question is meant to control.

import type {
  AccountState, Executor, FuturesFill, FuturesOpenOrder, FuturesPosition, OrderAck, OrderEdit, OrderRequest, PlacedOrder,
} from "./executor.ts";

export type Ask = (summary: string) => Promise<boolean>;

export function describeOrder(r: OrderRequest): string {
  const price = r.limitPrice !== undefined ? ` limit ${r.limitPrice}` : r.stopPrice !== undefined ? ` stop ${r.stopPrice}` : "";
  return `${r.side.toUpperCase()} ${r.size} ${r.symbol} ${r.orderType}${price}${r.reduceOnly ? " reduce-only" : ""} (${r.cliOrdId})`;
}

export class ApprovingExecutor implements Executor {
  readonly kind: Executor["kind"];
  private readonly inner: Executor;
  private readonly ask: Ask;

  constructor(inner: Executor, ask: Ask) {
    this.inner = inner;
    this.ask = ask;
    this.kind = inner.kind;
  }

  async placeOrder(req: OrderRequest): Promise<OrderAck> {
    if (req.reduceOnly) return this.inner.placeOrder(req);
    const summary = describeOrder(req);
    let approved = false;
    try {
      approved = await this.ask(summary);
    } catch {
      approved = false; // a question that cannot be asked is a no
    }
    if (!approved) return { ok: false, kind: "unknown", message: `denied by the user: ${summary}` };
    return this.inner.placeOrder(req);
  }

  // Edits only move a stop toward the market or resize protection: never gated.
  editOrder(edit: OrderEdit): Promise<OrderAck> { return this.inner.editOrder(edit); }
  cancelOrder(id: { cliOrdId: string } | { orderId: string }): Promise<void> { return this.inner.cancelOrder(id); }
  cancelAll(symbol: string): Promise<void> { return this.inner.cancelAll(symbol); }
  getPositions(): Promise<FuturesPosition[]> { return this.inner.getPositions(); }
  getOpenOrders(): Promise<FuturesOpenOrder[]> { return this.inner.getOpenOrders(); }
  getFills(since: Date): Promise<FuturesFill[]> { return this.inner.getFills(since); }
  getOrderHistory(since: Date): Promise<PlacedOrder[]> { return this.inner.getOrderHistory(since); }
  getAccount(): Promise<AccountState> { return this.inner.getAccount(); }
}
