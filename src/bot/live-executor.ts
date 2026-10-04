// live-executor.ts – the placeholder for a real exchange executor. Iteration 1 cannot place a real order: the
// constructor always throws, whatever the config says, so no code path can ever obtain a live executor.
// Building the real one is a separate, explicitly approved step (stage 2: minimum-size orders, see the status doc).

import type {
  AccountState, Executor, FuturesFill, FuturesOpenOrder, FuturesPosition, OrderAck, OrderEdit, OrderRequest, PlacedOrder,
} from "./executor.ts";

export const LIVE_NOT_IMPLEMENTED = "LiveExecutor is not implemented in iteration 1";

export class LiveExecutor implements Executor {
  readonly kind = "live" as const;

  constructor(_options?: unknown) {
    throw new Error(LIVE_NOT_IMPLEMENTED);
  }

  // Unreachable (the constructor throws); present only to satisfy the interface.
  placeOrder(_req: OrderRequest): Promise<OrderAck> { throw new Error(LIVE_NOT_IMPLEMENTED); }
  editOrder(_edit: OrderEdit): Promise<OrderAck> { throw new Error(LIVE_NOT_IMPLEMENTED); }
  cancelOrder(_id: { cliOrdId: string } | { orderId: string }): Promise<void> { throw new Error(LIVE_NOT_IMPLEMENTED); }
  cancelAll(_symbol: string): Promise<void> { throw new Error(LIVE_NOT_IMPLEMENTED); }
  getPositions(): Promise<FuturesPosition[]> { throw new Error(LIVE_NOT_IMPLEMENTED); }
  getOpenOrders(): Promise<FuturesOpenOrder[]> { throw new Error(LIVE_NOT_IMPLEMENTED); }
  getFills(_since: Date): Promise<FuturesFill[]> { throw new Error(LIVE_NOT_IMPLEMENTED); }
  getOrderHistory(_since: Date): Promise<PlacedOrder[]> { throw new Error(LIVE_NOT_IMPLEMENTED); }
  getAccount(): Promise<AccountState> { throw new Error(LIVE_NOT_IMPLEMENTED); }
}

// The launcher's guard: iteration 1 runs only in dry-run, whatever the config file says.
export function assertDryRunOnly(config: { mode: string }): void {
  if (config.mode !== "dry-run") {
    throw new Error(`mode "${config.mode}" is not available in iteration 1: the bot runs only in dry-run`);
  }
}
