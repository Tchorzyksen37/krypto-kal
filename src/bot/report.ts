// report.ts – what the bot did and how it went (spec section 9), built from the BotStore alone: the dry-run
// exchange's fills, orders and account, the decision journal, incidents and policies.
//
//  - netPnl: realised PnL of the window's fills minus fees (maker/taker by fill type) minus the funding charged in the
//    window. Slippage is already inside the fill prices; `slippageCost` shows how much of it came from stops filling
//    worse than their trigger.
//  - trades: closed trades rebuilt from the fills (a trade runs from flat to flat under one policy id); R is the net
//    result over the planned risk (entry to stop times size) taken from the journal snapshot of that trade.
//  - calibration: average R per conviction tercile of the policy that opened the trade, with n per bucket.
//  - rejectedByReason: journal rows in which the bot had a scenario and was flat but decided not to enter, by reason.
//    The journal writes a row when something changes and once a minute otherwise, so these are row counts, not cycles.

import type { BotStore, Incident } from "./bot-store.ts";
import type { BotConfig } from "./config.ts";
import type { Snapshot, TradeRecord } from "./engine.ts";
import { loadEngineRecord } from "./engine-state.ts";
import { type FuturesFill, parseCliOrdId } from "./executor.ts";

export interface BotTrade {
  policyId: number;
  direction: "long" | "short";
  entryCliOrdId: string;
  openedMs: number;
  closedMs: number;
  size: number; // the largest size held
  entryAvg: number;
  exitAvg: number;
  gross: number; // realised PnL before fees
  fees: number;
  net: number;
  riskUsd?: number; // planned risk: |entry - stop| x planned size
  r?: number;
  conviction?: number;
  exits: string[]; // roles of the closing fills: sl, tp1.., close
}

export type Tercile = "low" | "mid" | "high";

export interface BotReport {
  sinceMs: number;
  nowMs: number;
  state: string;
  halt: { reason: string; manualAck: boolean; untilMs: number | null } | null;
  openPosition: { side: "long" | "short"; size: number; avgPrice: number; unrealizedPnl: number } | null;
  netPnl: number;
  realized: number;
  fees: number;
  funding: number;
  slippageCost: number;
  equity: number;
  trades: BotTrade[];
  policyAccuracy: { policies: number; withScenario: number; tradesClosed: number; wins: number; winRate?: number; avgR?: number };
  rejectedByReason: Record<string, number>;
  incidents: number;
  incidentsByKind: Record<string, number>;
  recentIncidents: Incident[];
  calibration: { tercile: Tercile; avgR: number; n: number }[];
}

interface SimOrderDoc {
  req: { orderType: string; stopPrice?: number; limitPrice?: number; side: "buy" | "sell" };
}

const feeOf = (f: FuturesFill, config: BotConfig) =>
  (f.size * f.price * (f.fillType === "maker" ? config.fees_bps.maker : config.fees_bps.taker)) / 10_000;

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// Closed trades from all fills of the bot's orders, oldest first.
export function rebuildTrades(fills: FuturesFill[], config: BotConfig): BotTrade[] {
  const open = new Map<number, { t: BotTrade; net: number; inQty: number; inVal: number; outQty: number; outVal: number }>();
  const out: BotTrade[] = [];
  const sorted = [...fills].sort((a, b) => Date.parse(a.fillTime) - Date.parse(b.fillTime));
  for (const f of sorted) {
    const id = f.cliOrdId ? parseCliOrdId(f.cliOrdId) : undefined;
    if (!id) continue;
    const t = Date.parse(f.fillTime);
    const signed = f.side === "buy" ? f.size : -f.size;
    let cur = open.get(id.policyId);
    if (!cur) {
      if (id.role !== "entry") continue; // an exit without its entry (history before the window): not a trade we can judge
      cur = {
        t: {
          policyId: id.policyId, direction: f.side === "buy" ? "long" : "short", entryCliOrdId: f.cliOrdId!, openedMs: t, closedMs: t,
          size: 0, entryAvg: 0, exitAvg: 0, gross: 0, fees: 0, net: 0, exits: [],
        },
        net: 0, inQty: 0, inVal: 0, outQty: 0, outVal: 0,
      };
      open.set(id.policyId, cur);
    }
    const opening = Math.sign(signed) === (cur.t.direction === "long" ? 1 : -1);
    if (opening) {
      cur.inQty += f.size;
      cur.inVal += f.size * f.price;
    } else {
      cur.outQty += f.size;
      cur.outVal += f.size * f.price;
      if (!cur.t.exits.includes(id.role)) cur.t.exits.push(id.role);
    }
    cur.net = Number((cur.net + signed).toFixed(12));
    cur.t.size = Math.max(cur.t.size, Math.abs(cur.net));
    cur.t.gross += f.realized_pnl ?? 0;
    cur.t.fees += feeOf(f, config);
    if (Math.abs(cur.net) < 1e-12 && cur.outQty > 0) {
      cur.t.closedMs = t;
      cur.t.entryAvg = cur.inQty ? cur.inVal / cur.inQty : 0;
      cur.t.exitAvg = cur.outQty ? cur.outVal / cur.outQty : 0;
      cur.t.net = cur.t.gross - cur.t.fees;
      out.push(cur.t);
      open.delete(id.policyId);
    }
  }
  return out;
}

// Planned risk per entry order, from the journal snapshots that carried the trade record.
function plannedRisk(store: BotStore, sinceMs: number): Map<string, number> {
  const risk = new Map<string, number>();
  for (const row of store.listJournal(sinceMs, "cycle")) {
    const trade = (row.snapshot as Snapshot | null)?.trade as TradeRecord | null | undefined;
    if (!trade || risk.has(trade.entryCliOrdId)) continue;
    const r = Math.abs(trade.entryPrice - trade.plan.stop) * trade.plan.size;
    if (Number.isFinite(r) && r > 0) risk.set(trade.entryCliOrdId, r);
  }
  return risk;
}

export const tercileOf = (conviction: number): Tercile => (conviction < 1 / 3 ? "low" : conviction < 2 / 3 ? "mid" : "high");

export function buildReport(store: BotStore, sinceMs: number, config: BotConfig, nowMs: number): BotReport {
  const allFills = store.listDocs<FuturesFill>("sim_fill", 0);
  const windowFills = allFills.filter((f) => Date.parse(f.fillTime) >= sinceMs);

  const realized = windowFills.reduce((a, f) => a + (f.realized_pnl ?? 0), 0);
  const fees = windowFills.reduce((a, f) => a + feeOf(f, config), 0);
  const account = store.getDoc<{ realizedPnl: number; fees: number; funding: number }>("sim_account", "acct") ?? { realizedPnl: 0, fees: 0, funding: 0 };
  const marks = store.listDocs<{ t: number; funding: number }>("funding_mark", 0).filter((m) => m.t <= sinceMs);
  const fundingAtStart = sinceMs <= 0 ? 0 : (marks[marks.length - 1]?.funding ?? 0);
  const funding = account.funding - fundingAtStart;

  let slippageCost = 0;
  for (const f of windowFills) {
    if (!f.cliOrdId) continue;
    const o = store.getDoc<SimOrderDoc>("sim_order_done", f.cliOrdId) ?? store.getDoc<SimOrderDoc>("sim_order_open", f.cliOrdId);
    const trigger = o?.req.stopPrice;
    if (!o || trigger === undefined || (o.req.orderType !== "stp" && o.req.orderType !== "take_profit")) continue;
    slippageCost += Math.max(0, (f.side === "buy" ? f.price - trigger : trigger - f.price) * f.size);
  }

  const risk = plannedRisk(store, 0);
  const trades = rebuildTrades(allFills, config)
    .filter((t) => t.closedMs >= sinceMs)
    .map((t) => {
      const riskUsd = risk.get(t.entryCliOrdId);
      const conviction = store.getPolicy(t.policyId)?.policy.conviction;
      return {
        ...t,
        ...(riskUsd ? { riskUsd: round(riskUsd), r: round(t.net / riskUsd, 3) } : {}),
        ...(conviction !== undefined ? { conviction } : {}),
      };
    });

  const policies = store.latestPolicies(100_000).filter((p) => p.createdAtMs >= sinceMs);
  const withR = trades.filter((t) => t.r !== undefined);
  const wins = trades.filter((t) => t.net > 0).length;
  const policyAccuracy: BotReport["policyAccuracy"] = {
    policies: policies.length, withScenario: policies.filter((p) => p.policy.scenario).length, tradesClosed: trades.length, wins,
  };
  if (trades.length) policyAccuracy.winRate = round(wins / trades.length, 3);
  if (withR.length) policyAccuracy.avgR = round(withR.reduce((a, t) => a + t.r!, 0) / withR.length, 3);

  const rejectedByReason: Record<string, number> = {};
  for (const row of store.listJournal(sinceMs, "cycle")) {
    const snap = row.snapshot as Snapshot | null;
    if (!snap || snap.state !== "FLAT" || !snap.policy?.scenario) continue;
    if (!row.decision.split(";").every((d) => d.startsWith("skip:"))) continue;
    rejectedByReason[row.reason || "unknown"] = (rejectedByReason[row.reason || "unknown"] ?? 0) + 1;
  }

  const incidents = store.listIncidents(sinceMs);
  const incidentsByKind: Record<string, number> = {};
  for (const i of incidents) incidentsByKind[i.kind] = (incidentsByKind[i.kind] ?? 0) + 1;

  const calibration = (["low", "mid", "high"] as Tercile[]).map((tercile) => {
    const inT = withR.filter((t) => t.conviction !== undefined && tercileOf(t.conviction) === tercile);
    return { tercile, n: inT.length, avgR: inT.length ? round(inT.reduce((a, t) => a + t.r!, 0) / inT.length, 3) : 0 };
  });

  const pos = store.getDoc<{ size: number; avgPrice: number }>("sim_position", config.symbol);
  const mark = store.getDoc<{ price: { mark: number } | null }>("sim_meta", "meta")?.price?.mark;
  const openPosition = pos && pos.size !== 0
    ? { side: pos.size > 0 ? "long" as const : "short" as const, size: Math.abs(pos.size), avgPrice: pos.avgPrice, unrealizedPnl: round(pos.size * ((mark ?? pos.avgPrice) - pos.avgPrice)) }
    : null;
  const equity = config.trading_capital_usd + account.realizedPnl - account.fees - account.funding + (openPosition?.unrealizedPnl ?? 0);

  let state = "unknown";
  let halt: BotReport["halt"] = null;
  try {
    const rec = loadEngineRecord(store);
    state = rec.state;
    halt = rec.halt;
  } catch {
    state = "unreadable";
  }

  return {
    sinceMs, nowMs, state, halt, openPosition,
    netPnl: round(realized - fees - funding), realized: round(realized), fees: round(fees), funding: round(funding),
    slippageCost: round(slippageCost), equity: round(equity),
    trades, policyAccuracy, rejectedByReason, incidents: incidents.length, incidentsByKind, recentIncidents: incidents.slice(-10),
    calibration,
  };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const usd = (x: number) => `${x >= 0 ? "" : "-"}$${Math.abs(x).toFixed(2)}`;

export function renderReport(r: BotReport): string {
  const lines = [
    `# Bot report (dry-run)`,
    "",
    `Window ${iso(r.sinceMs)} to ${iso(r.nowMs)}. **No real orders: every fill below is simulated.**`,
    "",
    `**State:** ${r.state}${r.halt ? ` (halted: ${r.halt.reason}${r.halt.manualAck ? ", needs \`ack-halt\`" : r.halt.untilMs ? `, clears at ${iso(r.halt.untilMs)}` : ""})` : ""}`,
    r.openPosition
      ? `**Open position:** ${r.openPosition.side} ${r.openPosition.size} @ ${r.openPosition.avgPrice}, unrealised ${usd(r.openPosition.unrealizedPnl)}`
      : "**Open position:** none",
    "",
    "| Net PnL | Realised | Fees | Funding | Stop slippage (in the fills) | Equity |",
    "|---|---|---|---|---|---|",
    `| ${usd(r.netPnl)} | ${usd(r.realized)} | ${usd(r.fees)} | ${usd(r.funding)} | ${usd(r.slippageCost)} | ${usd(r.equity)} |`,
    "",
  ];
  if (r.incidents) {
    lines.push(`> [!warning] ${r.incidents} incident(s): ${Object.entries(r.incidentsByKind).map(([k, n]) => `${k} x${n}`).join(", ")}`, "");
    for (const i of r.recentIncidents) lines.push(`- ${iso(i.tMs)} **${i.kind}**: ${i.detail}`);
    lines.push("");
  } else lines.push("No incidents.", "");

  lines.push("## Trades", "");
  if (!r.trades.length) lines.push("No closed trades in this window.", "");
  else {
    lines.push("| Closed | Policy | Side | Size | Entry | Exit | Exits | Net | R | Conviction |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const t of r.trades) {
      lines.push(`| ${iso(t.closedMs)} | ${t.policyId} | ${t.direction} | ${t.size} | ${t.entryAvg.toFixed(1)} | ${t.exitAvg.toFixed(1)} | ${t.exits.join(", ")} | ${usd(t.net)} | ${t.r?.toFixed(2) ?? "-"} | ${t.conviction ?? "-"} |`);
    }
    lines.push("");
  }
  const a = r.policyAccuracy;
  lines.push(
    "## Policies",
    "",
    `${a.policies} policies (${a.withScenario} with a scenario); ${a.tradesClosed} closed trade(s), ${a.wins} profitable${a.winRate !== undefined ? ` (${Math.round(a.winRate * 100)}%)` : ""}${a.avgR !== undefined ? `, average ${a.avgR.toFixed(2)}R` : ""}.`,
    "",
    "| Conviction | Trades | Average R |", "|---|---|---|",
    ...r.calibration.map((c) => `| ${c.tercile} | ${c.n} | ${c.n ? c.avgR.toFixed(2) : "-"} |`),
    "",
    "## Entries not taken (journal rows, flat with a scenario)",
    "",
  );
  const rej = Object.entries(r.rejectedByReason).sort((x, y) => y[1] - x[1]);
  if (!rej.length) lines.push("None.", "");
  else lines.push("| Reason | Rows |", "|---|---|", ...rej.map(([k, n]) => `| ${k} | ${n} |`), "");
  return `${lines.join("\n")}\n`;
}
