// dry-run-executor.ts – a simulated exchange behind the Executor interface. Orders, fills, the position and the
// account live in the BotStore, never in memory: the trader and the watchdog are separate processes sharing one
// SQLite file, so every call reads fresh state inside a transaction.
//
// The fill model is pessimistic on purpose (an ambiguity always goes against the bot):
//  - a resting limit fills only when the LAST price trades through it (a touch is not a fill), at the limit, as maker;
//  - market orders, marketable limits and triggered stops fill as taker; stops at the worse of the stop price and
//    the current quote, plus slippage (a gap is not rounded in the bot's favour);
//  - stops are checked before limits within one price tick;
//  - a reduce-only order is capped at the position and cancelled if it fires with nothing to reduce, but it stays
//    open after the position closed until it fires (the orphan hazard the engine must clean up).
// Funding is charged hourly to the position held at the funding time. Replay walks 1-minute candles through the
// adverse extreme first, so a stop beats a target inside one candle. Faults (lost acks, rejections, partial fills,
// delays) can be injected one-shot for tests.
// Assumed, not verified against the exchange: trigger direction of stp / take_profit, the orphan behaviour, and that
// a positive funding rate means longs pay shorts.

import type { FuturesCandle } from "../kraken-futures-client.ts";
import type { BotStore } from "./bot-store.ts";
import type { Clock } from "./clock.ts";
import type { BotConfig } from "./config.ts";
import type {
  AccountState, Executor, FuturesFill, FuturesOpenOrder, FuturesPosition, OrderAck, OrderEdit, OrderRequest,
  PlacedOrder, PriceEvent, RejectKind,
} from "./executor.ts";

interface SimOrder {
  orderId: string;
  req: OrderRequest;
  status: "open" | "filled" | "cancelled";
  filledSize: number;
  receivedMs: number;
  updatedMs: number;
}

interface SimPosition {
  size: number; // signed: positive long, negative short
  avgPrice: number;
  fundingPaid?: number; // charged to this position since it opened (a cost is positive)
  openedAtMs?: number; // when this position (or its current direction) was opened
}

interface SimAccount {
  realizedPnl: number;
  fees: number;
  funding: number;
}

interface SimMeta {
  nextOrderId: number;
  nextFillId: number;
  lastTickMs: number;
  lastFundingMs?: number; // newest funding time already processed
  price: PriceEvent | null;
}

// Document kinds in the store. Open and finished orders are separate so listing open orders stays cheap,
// while a finished order still answers a retry with the same cliOrdId.
const OPEN = "sim_order_open";
const DONE = "sim_order_done";
const FILL = "sim_fill";
const POSITION = "sim_position";
const ACCOUNT = "sim_account";
const META = "sim_meta";
const HISTORY = "sim_position_history"; // [{ t, size }]: the signed position after each fill, for funding

const EPS = 1e-12;
const ok = (orderId: string): OrderAck => ({ ok: true, orderId });
const rejected = (kind: RejectKind, message: string): OrderAck => ({ ok: false, kind, message });
const finitePos = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

export interface DryRunOptions {
  store: BotStore;
  clock: Clock;
  config: BotConfig;
  sleep?: (ms: number) => void; // called for an injected delay; tests wire it to the fake clock
}

export interface Faults {
  dropAck?: number; // the next n mutating calls take effect, then throw (the ack is lost)
  rejectNext?: RejectKind; // the next placeOrder / editOrder is refused and has no effect
  partialFill?: number; // the next fill executes only this fraction (0 < f < 1) of what it would have
  delayMs?: number; // the next mutating call takes effect, then waits this long before returning
}

export class DryRunExecutor implements Executor {
  readonly kind = "dry-run" as const;
  private readonly store: BotStore;
  private readonly clock: Clock;
  private readonly config: BotConfig;
  private readonly sleep: (ms: number) => void;
  private faults: Faults = {}; // in memory on purpose: faults exist for tests

  constructor(o: DryRunOptions) {
    this.store = o.store;
    this.clock = o.clock;
    this.config = o.config;
    this.sleep = o.sleep ?? (() => {});
  }

  // Arms one-shot faults (see Faults). New settings are added to what is already armed.
  inject(f: Faults): void {
    if (f.partialFill !== undefined && !(f.partialFill > 0 && f.partialFill < 1)) throw new RangeError("partialFill must be in (0, 1)");
    if (f.dropAck !== undefined && !(Number.isInteger(f.dropAck) && f.dropAck >= 0)) throw new RangeError("dropAck must be a non-negative integer");
    if (f.delayMs !== undefined && !(Number.isFinite(f.delayMs) && f.delayMs >= 0)) throw new RangeError("delayMs must be non-negative");
    this.faults = { ...this.faults, ...f };
  }

  // Feeds one quote: stores it, then fires every resting order it triggers. Older quotes are ignored.
  onPrice(e: PriceEvent): void {
    this.feed(e, false);
  }

  // Walks candles (oldest first) to find what would have fired while the bot was down. Each candle is visited
  // open -> adverse extreme -> favourable extreme -> close, where adverse is the low for a long and the high for a
  // short (a flat account is walked low first). So a stop beats a target inside one candle. Orders placed after a
  // candle never fire in it. Candles older than the last quote and malformed candles are skipped.
  // Candle t is in epoch SECONDS, as in the client. The whole replay is one transaction.
  replay(candles: FuturesCandle[], intervalSec = 60): void {
    this.store.transaction(() => {
      for (const c of [...candles].sort((a, b) => a.t - b.t)) {
        if (![c.o, c.h, c.l, c.c, c.t].every(finitePos) || c.h < c.l) continue;
        const startMs = c.t * 1000;
        const path = this.position().size < 0 ? [c.o, c.h, c.l, c.c] : [c.o, c.l, c.h, c.c];
        path.forEach((p, k) => {
          this.feed({ t: startMs + Math.floor((k * intervalSec * 1000) / 4), mark: p, last: p, bid: p, ask: p }, true);
        });
      }
    });
  }

  // Charges hourly funding to the position held at each funding time. Rates are { t: epoch ms, rate: fraction of the
  // price per hour, positive = longs pay }. A time is charged once; times in the future, while flat, or before the
  // position opened cost nothing. The mark used is the latest one (an approximation within the hour).
  accrueFunding(rates: { t: number; rate: number }[]): void {
    this.store.transaction(() => {
      const meta = this.loadMeta();
      const nowMs = this.clock.now();
      const last = meta.lastFundingMs ?? 0;
      const due = rates
        .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.rate) && r.t > last && r.t <= nowMs)
        .sort((a, b) => a.t - b.t);
      if (!due.length) return;

      const history = this.store.getDoc<{ t: number; size: number }[]>(HISTORY, "hist") ?? [];
      const pos = this.position();
      const acct = this.account0();
      const mark = meta.price?.mark ?? pos.avgPrice;
      for (const r of due) {
        // The position at funding time is the newest one that existed strictly before it (a position closed at the
        // exact funding time still pays).
        let size = 0;
        for (const h of history) if (h.t < r.t) size = h.size;
        const payment = size * mark * r.rate;
        acct.funding += payment;
        if (pos.size !== 0 && r.t > (pos.openedAtMs ?? 0)) pos.fundingPaid = (pos.fundingPaid ?? 0) + payment;
      }
      meta.lastFundingMs = due[due.length - 1]!.t;
      this.store.putDoc(ACCOUNT, "acct", nowMs, acct);
      this.store.putDoc(POSITION, this.config.symbol, nowMs, pos);
      this.saveMeta(meta);
    });
  }

  async placeOrder(req: OrderRequest): Promise<OrderAck> {
    const refusal = this.takeRejection();
    if (refusal) return refusal;
    const ack = this.store.transaction(() => this.place(req));
    this.afterEffect();
    return ack;
  }

  async editOrder(edit: OrderEdit): Promise<OrderAck> {
    const refusal = this.takeRejection();
    if (refusal) return refusal;
    const ack = this.store.transaction(() => this.edit(edit));
    this.afterEffect();
    return ack;
  }

  async cancelOrder(id: { cliOrdId: string } | { orderId: string }): Promise<void> {
    this.store.transaction(() => {
      const order = "cliOrdId" in id ? this.getOrder(id.cliOrdId) : this.openOrders().find((o) => o.orderId === id.orderId);
      if (order?.status === "open") this.saveOrder({ ...order, status: "cancelled", updatedMs: this.clock.now() });
    });
    this.afterEffect();
  }

  async cancelAll(symbol: string): Promise<void> {
    this.store.transaction(() => {
      for (const order of this.openOrders()) {
        if (order.req.symbol === symbol) this.saveOrder({ ...order, status: "cancelled", updatedMs: this.clock.now() });
      }
    });
    this.afterEffect();
  }

  async getPositions(): Promise<FuturesPosition[]> {
    return this.store.transaction(() => {
      const pos = this.position();
      if (pos.size === 0) return [];
      const mark = this.loadMeta().price?.mark ?? pos.avgPrice;
      return [{
        symbol: this.config.symbol, side: pos.size > 0 ? "long" : "short", size: Math.abs(pos.size), price: pos.avgPrice,
        unrealizedPnl: pos.size * (mark - pos.avgPrice), unrealizedFunding: -(pos.fundingPaid ?? 0), pnlCurrency: "USD",
      }];
    });
  }

  async getOpenOrders(): Promise<FuturesOpenOrder[]> {
    return this.store.transaction(() => this.openOrders().sort((a, b) => a.receivedMs - b.receivedMs).map(toOpenOrder));
  }

  async getFills(since: Date): Promise<FuturesFill[]> {
    return this.store.transaction(() => this.store.listDocs<FuturesFill>(FILL, since.getTime()));
  }

  async getOrderHistory(since: Date): Promise<PlacedOrder[]> {
    return this.store.transaction(() => {
      const all = [...this.store.listDocs<SimOrder>(OPEN, since.getTime()), ...this.store.listDocs<SimOrder>(DONE, since.getTime())];
      return all.map((o) => ({ cliOrdId: o.req.cliOrdId, placedAtMs: o.receivedMs })).sort((a, b) => a.placedAtMs - b.placedAtMs);
    });
  }

  async getAccount(): Promise<AccountState> {
    return this.store.transaction(() => this.account());
  }

  // The time of the newest quote seen (0 if none): how far a downtime replay has to reach back.
  lastTickMs(): number {
    return this.store.transaction(() => this.loadMeta().lastTickMs);
  }

  // ---- faults ------------------------------------------------------------------------------------------------

  // The cost of a lost or slow ack: the call has already taken effect.
  private afterEffect(): void {
    if (this.faults.delayMs !== undefined) {
      const ms = this.faults.delayMs;
      this.faults.delayMs = undefined;
      this.sleep(ms);
    }
    if ((this.faults.dropAck ?? 0) > 0) {
      this.faults.dropAck = (this.faults.dropAck ?? 0) - 1;
      throw new Error("injected fault: ack lost");
    }
  }

  private takeRejection(): OrderAck | undefined {
    const kind = this.faults.rejectNext;
    if (!kind) return undefined;
    this.faults.rejectNext = undefined;
    return rejected(kind, "injected rejection");
  }

  // ---- placement ---------------------------------------------------------------------------------------------

  private place(req: OrderRequest): OrderAck {
    const problem = this.validate(req);
    if (problem) return rejected("unknown", problem);

    const existing = this.getOrder(req.cliOrdId);
    if (existing) return ok(existing.orderId); // a retry never creates a second order, whatever became of the first

    const meta = this.loadMeta();
    const price = meta.price;
    const buy = req.side === "buy";
    const pos = this.position();

    if (req.reduceOnly && closable(pos, req.side) <= 0) return rejected("reduce_only_violation", "nothing to reduce");
    if (req.orderType === "mkt" && !price) return rejected("unknown", "no price yet");
    if (req.orderType === "post" && price && (buy ? req.limitPrice! >= price.ask : req.limitPrice! <= price.bid)) {
      return rejected("would_cross", "post-only order would take liquidity");
    }
    if (!req.reduceOnly && price) {
      const signed = buy ? req.size : -req.size;
      const extra = Math.max(0, Math.abs(pos.size + signed) - Math.abs(pos.size));
      const ref = req.orderType === "mkt" ? (buy ? price.ask : price.bid) : (req.limitPrice ?? req.stopPrice ?? price.mark);
      if ((extra * ref) / this.config.max_leverage > this.account().availableMargin + 1e-9) {
        return rejected("insufficient_margin", "not enough available margin");
      }
    }

    const nowMs = this.clock.now();
    const order: SimOrder = {
      orderId: `sim-${meta.nextOrderId++}`, req, status: "open", filledSize: 0, receivedMs: nowMs, updatedMs: nowMs,
    };
    this.saveOrder(order);
    if (price) this.match(meta, order, price, nowMs, true);
    this.saveMeta(meta);
    return ok(order.orderId);
  }

  private edit(edit: OrderEdit): OrderAck {
    const order = this.getOrder(edit.cliOrdId);
    if (!order || order.status !== "open") return rejected("unknown", `no open order ${edit.cliOrdId}`);
    const r = order.req;
    const isStop = r.orderType === "stp" || r.orderType === "take_profit";
    if (edit.stopPrice !== undefined && (!isStop || !finitePos(edit.stopPrice))) return rejected("unknown", "invalid stopPrice");
    if (edit.limitPrice !== undefined && (isStop || r.orderType === "mkt" || !finitePos(edit.limitPrice))) {
      return rejected("unknown", "invalid limitPrice");
    }
    if (edit.size !== undefined && (!finitePos(edit.size) || edit.size < order.filledSize)) return rejected("unknown", "invalid size");

    const nowMs = this.clock.now();
    const next: SimOrder = {
      ...order,
      updatedMs: nowMs,
      req: {
        ...r,
        ...(edit.stopPrice !== undefined ? { stopPrice: edit.stopPrice } : {}),
        ...(edit.limitPrice !== undefined ? { limitPrice: edit.limitPrice } : {}),
        ...(edit.size !== undefined ? { size: edit.size } : {}),
      },
    };
    this.saveOrder(next);
    // A stop moved beyond the current price fires at once.
    const meta = this.loadMeta();
    if (meta.price) this.match(meta, next, meta.price, nowMs, false);
    this.saveMeta(meta);
    return ok(order.orderId);
  }

  // Returns the first problem with a request, or undefined.
  private validate(r: OrderRequest): string | undefined {
    if (r.symbol !== this.config.symbol) return `symbol ${r.symbol} is not ${this.config.symbol}`;
    if (typeof r.cliOrdId !== "string" || r.cliOrdId.length === 0 || r.cliOrdId.length > 100) return "cliOrdId must be 1-100 characters";
    if (!finitePos(r.size)) return "size must be a positive number";
    switch (r.orderType) {
      case "mkt":
        if (r.limitPrice !== undefined || r.stopPrice !== undefined) return "a market order takes no price";
        break;
      case "lmt":
      case "post":
        if (!finitePos(r.limitPrice) || r.stopPrice !== undefined) return "a limit order needs a limitPrice only";
        break;
      case "stp":
      case "take_profit":
        if (!finitePos(r.stopPrice)) return "a stop order needs a stopPrice";
        if (r.limitPrice !== undefined) return "stop-limit orders are not supported: stop-market only";
        break;
      default:
        return `unsupported order type ${String(r.orderType)}`;
    }
    if (r.processBefore !== undefined) {
      const by = Date.parse(r.processBefore);
      if (Number.isNaN(by) || by <= this.clock.now()) return "processBefore has already passed";
    }
    return undefined;
  }

  // ---- matching ----------------------------------------------------------------------------------------------

  private feed(e: PriceEvent, replaying: boolean): void {
    this.store.transaction(() => {
      const meta = this.loadMeta();
      if (e.t < meta.lastTickMs) return;
      meta.lastTickMs = e.t;
      meta.price = e;
      const rank = (o: SimOrder) => (o.req.orderType === "stp" ? 0 : o.req.orderType === "take_profit" ? 1 : 2);
      const open = this.openOrders().sort((a, b) => rank(a) - rank(b) || a.receivedMs - b.receivedMs);
      for (const order of open) {
        if (replaying && order.receivedMs > e.t) continue; // the order did not exist yet at this point of the replay
        const current = this.getOrder(order.req.cliOrdId);
        if (current?.status === "open") this.match(meta, current, e, e.t, false);
      }
      this.saveMeta(meta);
    });
  }

  // Fires `order` against quote `e` if it triggers. `onPlacement` lets a marketable limit take liquidity at once.
  private match(meta: SimMeta, order: SimOrder, e: PriceEvent, tMs: number, onPlacement: boolean): void {
    const r = order.req;
    const buy = r.side === "buy";
    const slip = this.config.slippage_cap_bps / 10_000;
    let price: number | undefined;
    let fillType: "maker" | "taker" = "taker";

    switch (r.orderType) {
      case "mkt":
        price = buy ? e.ask * (1 + slip) : e.bid * (1 - slip);
        break;
      case "lmt":
      case "post": {
        const limit = r.limitPrice!;
        if (onPlacement) {
          if (buy ? limit >= e.ask : limit <= e.bid) price = buy ? e.ask : e.bid; // marketable: takes the quote
        } else if (buy ? e.last < limit : e.last > limit) {
          price = limit; // traded through (even by a gap): filled as a resting order, at the limit
          fillType = "maker";
        }
        break;
      }
      case "stp":
      case "take_profit": {
        const stop = r.stopPrice!;
        const signal = (r.triggerSignal ?? "mark") === "mark" ? e.mark : e.last;
        const triggersDown = (r.orderType === "stp") === !buy; // stp sell and take_profit buy fire on a falling price
        if (triggersDown ? signal <= stop : signal >= stop) {
          price = buy ? Math.max(stop, e.ask) * (1 + slip) : Math.min(stop, e.bid) * (1 - slip);
        }
        break;
      }
    }
    if (price === undefined) return;

    let qty = r.size - order.filledSize;
    let finish = true; // the order is over after this fill
    if (r.reduceOnly) {
      const room = closable(this.position(), r.side);
      if (room <= 0) {
        this.saveOrder({ ...order, status: "cancelled", updatedMs: tMs }); // nothing left to reduce
        return;
      }
      qty = Math.min(qty, room);
    }
    const fraction = this.faults.partialFill;
    if (fraction !== undefined) {
      this.faults.partialFill = undefined;
      qty *= fraction;
      finish = r.orderType === "mkt"; // a market order's remainder is dropped, a resting order's stays open
    }
    this.applyFill(meta, order, price, qty, fillType, tMs, finish);
  }

  private applyFill(
    meta: SimMeta, order: SimOrder, price: number, qty: number, fillType: "maker" | "taker", tMs: number, finish: boolean,
  ): void {
    const r = order.req;
    const pos = this.position();
    const acct = this.account0();
    const sign = r.side === "buy" ? 1 : -1;

    // Average-cost netting; a fill larger than the position closes it and opens the remainder the other way.
    let realized = 0;
    let avg = pos.avgPrice;
    if (pos.size === 0 || Math.sign(pos.size) === sign) {
      avg = (Math.abs(pos.size) * pos.avgPrice + qty * price) / (Math.abs(pos.size) + qty);
    } else {
      const closing = Math.min(qty, Math.abs(pos.size));
      realized = closing * (price - pos.avgPrice) * Math.sign(pos.size);
      if (qty > Math.abs(pos.size)) avg = price;
    }
    let size = Number((pos.size + sign * qty).toFixed(12));
    if (Math.abs(size) < EPS) {
      size = 0;
      avg = 0;
    }
    // A new position (opened, flipped or reopened) starts its own funding tally.
    const fresh = pos.size === 0 || Math.sign(pos.size) !== Math.sign(size);
    const fundingPaid = fresh ? 0 : (pos.fundingPaid ?? 0);
    const openedAtMs = fresh ? tMs : (pos.openedAtMs ?? tMs);
    const history = this.store.getDoc<{ t: number; size: number }[]>(HISTORY, "hist") ?? [];
    this.store.putDoc(HISTORY, "hist", tMs, [...history, { t: tMs, size }].slice(-500));

    const bps = fillType === "maker" ? this.config.fees_bps.maker : this.config.fees_bps.taker;
    acct.realizedPnl += realized;
    acct.fees += (qty * price * bps) / 10_000;

    const fillId = `simfill-${String(meta.nextFillId++).padStart(8, "0")}`;
    const fill: FuturesFill = {
      fill_id: fillId, order_id: order.orderId, cliOrdId: r.cliOrdId, symbol: r.symbol, side: r.side, size: qty, price,
      fillTime: new Date(tMs).toISOString(), fillType, realized_pnl: realized,
    };
    this.store.putDoc(FILL, fillId, tMs, fill);
    this.store.putDoc(POSITION, this.config.symbol, tMs, { size, avgPrice: avg, fundingPaid, openedAtMs } satisfies SimPosition);
    this.store.putDoc(ACCOUNT, "acct", tMs, acct);

    const filledSize = order.filledSize + qty;
    const done = finish || filledSize >= r.size - EPS;
    this.saveOrder({ ...order, filledSize, status: done ? "filled" : "open", updatedMs: tMs });
  }

  // ---- state -------------------------------------------------------------------------------------------------

  private loadMeta(): SimMeta {
    return this.store.getDoc<SimMeta>(META, "meta") ?? { nextOrderId: 1, nextFillId: 1, lastTickMs: 0, price: null };
  }

  private saveMeta(m: SimMeta): void {
    this.store.putDoc(META, "meta", m.lastTickMs, m);
  }

  private getOrder(cliOrdId: string): SimOrder | undefined {
    return this.store.getDoc<SimOrder>(OPEN, cliOrdId) ?? this.store.getDoc<SimOrder>(DONE, cliOrdId);
  }

  private openOrders(): SimOrder[] {
    return this.store.listDocs<SimOrder>(OPEN);
  }

  private saveOrder(o: SimOrder): void {
    const open = o.status === "open";
    this.store.putDoc(open ? OPEN : DONE, o.req.cliOrdId, o.receivedMs, o);
    this.store.deleteDoc(open ? DONE : OPEN, o.req.cliOrdId);
  }

  private position(): SimPosition {
    return this.store.getDoc<SimPosition>(POSITION, this.config.symbol) ?? { size: 0, avgPrice: 0 };
  }

  private account0(): SimAccount {
    return this.store.getDoc<SimAccount>(ACCOUNT, "acct") ?? { realizedPnl: 0, fees: 0, funding: 0 };
  }

  private account(): AccountState {
    const a = this.account0();
    const pos = this.position();
    const mark = this.loadMeta().price?.mark ?? pos.avgPrice;
    const unrealizedPnl = pos.size * (mark - pos.avgPrice);
    const equity = this.config.trading_capital_usd + a.realizedPnl - a.fees - a.funding + unrealizedPnl;
    const availableMargin = equity - (Math.abs(pos.size) * mark) / this.config.max_leverage;
    return { equity, availableMargin, realizedPnl: a.realizedPnl, unrealizedPnl, fees: a.fees, funding: a.funding };
  }
}

// How much of the position an order on `side` can reduce.
function closable(pos: SimPosition, side: "buy" | "sell"): number {
  return side === "sell" ? Math.max(0, pos.size) : Math.max(0, -pos.size);
}

function toOpenOrder(o: SimOrder): FuturesOpenOrder {
  const r = o.req;
  const isStop = r.orderType === "stp" || r.orderType === "take_profit";
  return {
    order_id: o.orderId,
    cliOrdId: r.cliOrdId,
    symbol: r.symbol,
    side: r.side,
    orderType: r.orderType === "post" || r.orderType === "mkt" ? "lmt" : r.orderType,
    status: o.filledSize > 0 ? "partiallyFilled" : "untouched",
    ...(r.limitPrice !== undefined ? { limitPrice: r.limitPrice } : {}),
    ...(r.stopPrice !== undefined ? { stopPrice: r.stopPrice } : {}),
    filledSize: o.filledSize,
    unfilledSize: r.size - o.filledSize,
    reduceOnly: r.reduceOnly,
    ...(isStop ? { triggerSignal: r.triggerSignal ?? "mark" } : {}),
    receivedTime: new Date(o.receivedMs).toISOString(),
    lastUpdateTime: new Date(o.updatedMs).toISOString(),
  };
}
