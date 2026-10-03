// reconcile.ts – what the bot does at start, before any entry is allowed: bring its own record and the exchange (or the
// simulation) back into agreement, or stop and say so. Run it once at every start (and again after the user clears a halt).
//
//  1. Clear the `reconciled` flag at once. It is only set again by a CLEAN run, so a crash half-way or an unreadable
//     exchange leaves entries blocked.
//  2. Simulation only: replay the minutes the bot was down through the DryRunExecutor, so stops and targets that would
//     have fired do fire (once), and charge the funding of the hours held. Real exchanges did this on their own.
//  3. Rebuild the daily counters from the order history (a max, never an add), so a restart cannot reset the budget.
//  4. Compare the record with the exchange:
//       - a position the bot has no trade record for, or on the wrong side of it: halt for acknowledgement, never close it
//         (it may be the user's own);
//       - a bot position whose stop is missing: halt for acknowledgement, and the engine closes it at market;
//       - orders the bot created that no trade explains: cancel them;
//       - orders the bot did not create: report them and leave them alone (entries stay blocked while they exist).
//  A halt, an unreadable exchange, a failed or impossible replay with something open, and a corrupt record are NOT clean.

import type { FuturesCandle } from "../kraken-futures-client.ts";
import type { Incident } from "./bot-store.ts";
import { type EngineRecord, loadEngineRecord, saveEngineRecord } from "./engine-state.ts";
import { type FuturesOpenOrder, isBotOrder, parseCliOrdId } from "./executor.ts";
import { dayStartMs, rebuildCounters } from "./limits.ts";
import type { TraderDeps } from "./trader.ts";

// The simulated exchange's catch-up: DryRunExecutor satisfies it.
export interface Replayer {
  replay(candles: FuturesCandle[], intervalSec?: number): void;
  accrueFunding(rates: { t: number; rate: number }[]): void;
  lastTickMs(): number;
}

export interface ReconcileResult {
  clean: boolean;
  incidents: Incident[];
}

const MAX_REPLAY_MINUTES = 2000; // one page of one-minute candles
const LIVE_STATES = ["ENTERING", "PROTECTING", "OPEN", "REDUCING"];

export async function reconcile(d: TraderDeps, opts: { replayer?: Replayer } = {}): Promise<ReconcileResult> {
  const { store, clock, config, executor, market } = d;
  const nowMs = clock.now();
  const incidents: Incident[] = [];
  const report = (kind: string, detail: string) => {
    const incident = { tMs: nowMs, kind, detail };
    incidents.push(incident);
    try {
      store.addIncident(incident);
    } catch {
      /* the returned list still carries it */
    }
  };

  let rec: EngineRecord;
  try {
    rec = loadEngineRecord(store);
  } catch (e) {
    report("cannot_verify", e instanceof Error ? e.message : String(e));
    return { clean: false, incidents };
  }
  rec.reconciled = false; // only a clean run sets it again
  saveEngineRecord(store, rec);

  const haltManual = (reason: string) => {
    if (rec.state === "HALTED" && rec.halt?.manualAck) return; // keep the first reason
    rec.state = "HALTED";
    rec.sinceMs = nowMs;
    rec.halt = { reason, manualAck: true, untilMs: null };
  };
  const finish = (clean: boolean): ReconcileResult => {
    rec.reconciled = clean;
    saveEngineRecord(store, rec);
    return { clean, incidents };
  };
  const readSymbol = async () => {
    const [positions, orders] = await Promise.all([executor.getPositions(), executor.getOpenOrders()]);
    return {
      position: positions.find((p) => p.symbol === config.symbol) ?? null,
      orders: orders.filter((o) => o.symbol === config.symbol),
    };
  };

  try {
    // 2. Catch the simulation up on the time it was not watched.
    const before = await readSymbol();
    const exposed = before.position !== null || before.orders.some((o) => isBotOrder(o.cliOrdId));
    if (opts.replayer && exposed) {
      const last = opts.replayer.lastTickMs();
      if (last > 0 && nowMs > last) {
        const minutes = Math.ceil((nowMs - last) / 60_000) + 2;
        if (minutes > MAX_REPLAY_MINUTES) {
          report("replay_gap_too_large", `${minutes} minutes of downtime with something open: more than ${MAX_REPLAY_MINUTES} candles`);
          haltManual("replay_gap_too_large");
          return finish(false);
        }
        let candles: FuturesCandle[];
        try {
          candles = await market.candles("1m", minutes);
        } catch (e) {
          report("replay_failed", `cannot fetch the candles for ${minutes} minutes of downtime: ${e instanceof Error ? e.message : String(e)}`);
          haltManual("replay_failed");
          return finish(false);
        }
        opts.replayer.replay(candles);
      }
      try {
        opts.replayer.accrueFunding(await market.fundingRates());
      } catch {
        /* funding is a small cost; a missing rate must not block a restart */
      }
    }

    // 3. Counters.
    const since = new Date(dayStartMs(nowMs, config.day_reset_utc_hour));
    const history = (await executor.getOrderHistory(since))
      .filter((h) => isBotOrder(h.cliOrdId))
      .map((h) => ({ placedAtMs: h.placedAtMs, isEntry: parseCliOrdId(h.cliOrdId ?? "")?.role === "entry" }));
    rebuildCounters(store, config, history);

    // 4. Compare the record with the exchange (after the replay).
    const { position, orders } = await readSymbol();
    const mine = orders.filter((o): o is FuturesOpenOrder & { cliOrdId: string } => isBotOrder(o.cliOrdId));
    const foreign = orders.filter((o) => !isBotOrder(o.cliOrdId));
    const trade = rec.trade;
    const tradeLive = trade !== null && LIVE_STATES.includes(rec.state);
    let clean = true;

    if (position) {
      if (!trade || !tradeLive) {
        report("unexplained_position", `a ${position.side} position of ${position.size} with no trade record: left alone`);
        haltManual("unexplained_position");
        clean = false;
      } else if (position.side !== trade.direction) {
        report("position_on_wrong_side", `the trade is ${trade.direction} but the position is ${position.side}`);
        haltManual("position_on_wrong_side");
        clean = false;
      } else if ((rec.state === "PROTECTING" || rec.state === "OPEN") && !mine.some((o) => isStopOf(o, trade.policyId))) {
        report("unprotected_position", `a ${position.side} position of ${position.size} has no stop`);
        haltManual("unprotected_position");
        clean = false;
      }
    } else if (rec.state === "PROTECTING" || rec.state === "OPEN") {
      report("closed_during_downtime", `the position of the ${rec.state} trade is gone; the engine winds it down`);
    }

    // Orders of the bot that no trade explains. The stops of a position nobody can explain are kept: they protect it.
    for (const o of mine) {
      const explained = tradeLive && trade !== null && parseCliOrdId(o.cliOrdId)?.policyId === trade.policyId;
      if (explained || (position && !tradeLive)) continue;
      try {
        await executor.cancelOrder({ cliOrdId: o.cliOrdId });
        report("orphan_bot_order", `cancelled ${o.cliOrdId}`);
      } catch (e) {
        report("executor_error", `could not cancel ${o.cliOrdId}: ${e instanceof Error ? e.message : String(e)}`);
        clean = false;
      }
    }
    for (const o of foreign) report("foreign_order", `${o.cliOrdId ?? "(no id)"} on ${o.symbol} was not created by the bot: left alone`);

    return finish(clean);
  } catch (e) {
    report("cannot_verify", e instanceof Error ? e.message : String(e));
    return finish(false);
  }
}

const isStopOf = (o: { cliOrdId: string }, policyId: number): boolean => {
  const id = parseCliOrdId(o.cliOrdId);
  return id?.policyId === policyId && id.role === "sl";
};
