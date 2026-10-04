// speculation/score.test.ts – offline tests of bet resolution, fill matching and statistics.
// Run: node --test src/speculation/score.test.ts

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  actualOutcome, biasStats, calibration, chanceOfTp, resolveBias, scoreReports, edgeLine, groupFills, meanCI, wilson, matchFills, normalizeCandle, normalizeFill, renderDay, renderScorecard,
  resolveBet, scoreFiles, scoreLog, summarize,
} from "./score.ts";
import type { Bet, Candle, Fill, LoggedBet, ReportLogEntry } from "./types.ts";

const T0 = Date.parse("2026-10-03T14:00:00Z") / 1000;
const MS = (min: number) => (T0 + min * 60) * 1000;

const long: Bet = {
  id: "20261003-14Z-XRP-1", symbol: "XRP", futures: "PF_XRPUSD", side: "long",
  entry: 2.39, stop_loss: 2.36, take_profit: 2.45, ttl_minutes: 45, probability: 0.4, rr: 2, ev_r: 0.12, break_even: 0.36,
  fill_from: "2026-10-03T14:00:00.000Z", entry_deadline: "2026-10-03T14:30:00.000Z", latest_close: "2026-10-03T15:15:00.000Z",
};
const short: Bet = {
  ...long, id: "20261003-14Z-XRP-2", side: "short", entry: 2.41, stop_loss: 2.44, take_profit: 2.35, rr: 2,
};

// One candle per minute starting at T0; `bars` maps minute -> [low, high] (open/close mid unless given).
function candles(bars: Record<number, [number, number] | [number, number, number]>, upTo: number, base = 2.4): Candle[] {
  const out: Candle[] = [];
  for (let m = 0; m <= upTo; m++) {
    const b = bars[m];
    const [l, h] = b ?? [base - 0.001, base + 0.001];
    out.push({ t: T0 + m * 60, o: base, h, l, c: b?.[2] ?? base });
  }
  return out;
}

describe("resolveBet", () => {
  test("take profit after the touch", () => {
    const h = resolveBet(long, candles({ 5: [2.389, 2.395], 12: [2.4, 2.452] }, 80));
    assert.equal(h.status, "tp");
    assert.equal(h.touchedAt, T0 + 5 * 60);
    assert.equal(h.exitPrice, 2.45);
    assert.equal(h.r, 2);
    assert.ok(h.netR! < 2 && h.netR! > 1.9);
  });

  test("fees per leg: maker entry, maker take-profit, taker stop", () => {
    const tp = resolveBet(long, candles({ 5: [2.389, 2.395], 12: [2.4, 2.452] }, 80));
    assert.equal(tp.netR, Math.round((2 - (2.39 * 2 + 2.45 * 2) / 10_000 / 0.03) * 1000) / 1000);
    const sl = resolveBet(long, candles({ 5: [2.389, 2.395], 9: [2.355, 2.4] }, 80));
    assert.equal(sl.netR, Math.round((-1 - (2.39 * 2 + 2.36 * 5) / 10_000 / 0.03) * 1000) / 1000);
    const free = resolveBet(long, candles({ 5: [2.389, 2.395], 9: [2.355, 2.4] }, 80), { makerFeeBps: 0, takerFeeBps: 0 });
    assert.equal(free.netR, -1);
  });

  test("stop loss after the touch", () => {
    const h = resolveBet(long, candles({ 5: [2.389, 2.395], 9: [2.355, 2.4] }, 80));
    assert.equal(h.status, "sl");
    assert.equal(h.r, -1);
    assert.ok(h.netR! < -1);
  });

  test("stop and take profit in the same later bar count as a stop", () => {
    assert.equal(resolveBet(long, candles({ 5: [2.389, 2.395], 9: [2.355, 2.455] }, 80)).status, "sl");
  });

  test("in the touch bar only the stop can trigger", () => {
    assert.equal(resolveBet(long, candles({ 5: [2.389, 2.46] }, 80)).status, "ttl"); // TP extreme may predate the touch
    assert.equal(resolveBet(long, candles({ 5: [2.35, 2.395] }, 80)).status, "sl");
  });

  test("expires at the TTL at the last close", () => {
    const h = resolveBet(long, candles({ 5: [2.389, 2.395], 49: [2.4, 2.41, 2.41] }, 80));
    assert.equal(h.status, "ttl");
    assert.equal(h.exitAt, T0 + (5 + 45) * 60);
    assert.equal(h.exitPrice, 2.41); // candle 49 is the last one before the expiry at minute 50
  });

  test("a bar after the TTL cannot trigger anything", () => {
    assert.equal(resolveBet(long, candles({ 5: [2.389, 2.395], 55: [2.3, 2.5] }, 80)).status, "ttl");
  });

  test("entry never touched by the deadline", () => {
    assert.equal(resolveBet(long, candles({ 40: [2.38, 2.4] }, 80)).status, "not_touched"); // touch after 14:30 does not count
  });

  test("open while data does not yet cover the deadline or the TTL", () => {
    assert.equal(resolveBet(long, candles({}, 10)).status, "open");
    assert.equal(resolveBet(long, candles({ 5: [2.389, 2.395] }, 20)).status, "open");
    assert.equal(resolveBet(long, []).status, "open");
  });

  test("short side mirrors the long logic", () => {
    assert.equal(resolveBet(short, candles({ 3: [2.4, 2.411], 8: [2.34, 2.4] }, 80)).status, "tp");
    assert.equal(resolveBet(short, candles({ 3: [2.4, 2.411], 8: [2.4, 2.445] }, 80)).status, "sl");
    const h = resolveBet(short, candles({ 3: [2.4, 2.411], 8: [2.34, 2.4] }, 80));
    assert.equal(h.r, 2);
  });
});

const fill = (id: string, o: Partial<Fill> & { min: number }): Fill => ({
  id, symbol: "PF_XRPUSD", side: "buy", size: 100, price: 2.39, ts: MS(o.min), ...o,
});

describe("fills", () => {
  test("partial fills of one order become one volume-weighted fill", () => {
    const g = groupFills([
      fill("a", { min: 5, orderId: "o1", size: 100, price: 2.39 }),
      fill("b", { min: 6, orderId: "o1", size: 300, price: 2.38 }),
      fill("c", { min: 7, size: 10 }),
    ]);
    assert.equal(g.length, 2);
    const o1 = g.find((f) => f.orderId === "o1")!;
    assert.equal(o1.size, 400);
    assert.ok(Math.abs(o1.price - 2.3825) < 1e-9);
    assert.equal(o1.ts, MS(5));
  });

  test("matches entry and exit automatically, ignores unrelated fills", () => {
    const fills = [
      fill("e", { min: 6, price: 2.3905 }),
      fill("x", { min: 20, side: "sell", price: 2.4502 }),
      fill("other", { min: 6, symbol: "PF_ETHUSD", price: 3000 }),
      fill("late", { min: 90 }),
    ];
    const r = matchFills([long], fills);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.entry.id, "e");
    assert.equal(r.matches[0]!.exit?.id, "x");
    assert.deepEqual(r.unmatchedFills.map((f) => f.id).sort(), ["late", "other"]);
  });

  test("a fill far from the entry price or outside the window does not match", () => {
    assert.equal(matchFills([long], [fill("far", { min: 6, price: 2.5 })]).matches.length, 0);
    assert.equal(matchFills([long], [fill("early", { min: -10 })]).matches.length, 0);
    assert.equal(matchFills([long], [fill("wrongside", { min: 6, side: "sell" })]).matches.length, 0);
  });

  test("a fill that fits two bets equally well is flagged, never guessed", () => {
    const twin: Bet = { ...long, id: "twin" };
    const r = matchFills([long, twin], [fill("e", { min: 6 })]);
    assert.equal(r.matches.length, 0);
    assert.deepEqual(r.ambiguous.sort(), ["20261003-14Z-XRP-1", "twin"]);
  });

  test("each fill is used at most once; the closer fill wins", () => {
    const r = matchFills([long], [fill("near", { min: 8, price: 2.3901 }), fill("far", { min: 6, price: 2.392 })]);
    assert.equal(r.matches[0]!.entry.id, "near");
  });

  test("classifies exits and computes slippage and net R", () => {
    const m = (price: number, min: number) => ({ betId: long.id, entry: fill("e", { min: 6, price: 2.3915 }), exit: fill("x", { min, side: "sell", price }) });
    const tp = actualOutcome(long, m(2.45, 20));
    assert.equal(tp.exitReason, "tp");
    assert.equal(tp.slippagePct, 0.063); // (2.3915 - 2.39) / 2.39, adverse for a long
    assert.ok(tp.netR! > 1.8 && tp.netR! < 2);
    assert.equal(actualOutcome(long, m(2.3601, 20)).exitReason, "sl");
    assert.equal(actualOutcome(long, m(2.41, 50)).exitReason, "ttl");
    assert.equal(actualOutcome(long, m(2.41, 20)).exitReason, "other");
    assert.equal(actualOutcome(long, { betId: long.id, entry: fill("e", { min: 6 }) }).exitReason, undefined);
  });

  test("actual fees follow the fill type; an unknown type counts as taker", () => {
    const m = (entryType?: string, exitType?: string) => ({
      betId: long.id,
      entry: fill("e", { min: 6, price: 2.39, ...(entryType ? { fillType: entryType } : {}) }),
      exit: fill("x", { min: 20, side: "sell", price: 2.45, ...(exitType ? { fillType: exitType } : {}) }),
    });
    const makerBoth = actualOutcome(long, m("maker", "maker"));
    const takerBoth = actualOutcome(long, m("taker", "taker"));
    const unknown = actualOutcome(long, m());
    assert.equal(makerBoth.feeR, Math.round(((2.39 * 2 + 2.45 * 2) / 10_000 / 0.03) * 1000) / 1000);
    assert.equal(takerBoth.feeR, Math.round(((2.39 * 5 + 2.45 * 5) / 10_000 / 0.03) * 1000) / 1000);
    assert.equal(unknown.feeR, takerBoth.feeR);
    assert.ok(makerBoth.netR! > takerBoth.netR!);
    assert.equal(makerBoth.entryFillId, "e");
    assert.equal(makerBoth.exitFillId, "x");
  });

  test("a grouped order is maker only if every part was", () => {
    const parts = (t2: string) => groupFills([
      fill("a", { min: 5, orderId: "o1", fillType: "maker" }),
      fill("b", { min: 6, orderId: "o1", fillType: t2 }),
    ])[0]!.fillType;
    assert.equal(parts("maker"), "maker");
    assert.equal(parts("taker"), "taker");
  });

  test("short slippage is positive when filled below the suggested entry", () => {
    const a = actualOutcome(short, { betId: short.id, entry: fill("e", { min: 6, side: "sell", price: 2.405 }) });
    assert.equal(a.slippagePct, 0.207);
  });
});

const logged = (b: Bet, over: Partial<LoggedBet> = {}): LoggedBet => ({ ...b, report: "r.md", generated: "2026-10-03T13:52:00Z", ...over });

describe("edge over chance", () => {
  const touchedBet = (id: string, p: number, status: "tp" | "sl", rr = 2): LoggedBet => {
    const risk = 0.03;
    return logged({ ...long, id, probability: p, take_profit: long.entry + rr * risk, stop_loss: long.entry - risk }, { hypothetical: { status, netR: status === "tp" ? rr : -1 } });
  };

  test("chance of reaching take profit first is 1 / (1 + R:R)", () => {
    assert.ok(Math.abs(chanceOfTp(long) - 1 / 3) < 1e-9);
    assert.ok(Math.abs(chanceOfTp({ ...long, take_profit: long.entry + 0.03 }) - 0.5) < 1e-9);
  });

  test("Wilson interval and mean interval", () => {
    assert.deepEqual(wilson(0, 0), undefined);
    const w = wilson(5, 10)!;
    assert.ok(w.lo < 0.5 && w.hi > 0.5 && Math.abs(0.5 - w.lo - (w.hi - 0.5)) < 1e-3);
    assert.deepEqual(wilson(10, 10)!.hi, 1);
    assert.equal(meanCI([1]), undefined);
    const m = meanCI([1, -1, 1, -1])!;
    assert.ok(m.lo < 0 && m.hi > 0);
  });

  test("summarize scores take-profit hits against stated P and chance (Brier skill)", () => {
    // 40 bets at 2:1 (chance 33%), stated 50%, half reach TP: the stated P is right, chance is beaten
    const log = Array.from({ length: 40 }, (_, i) => touchedBet(`b${i}`, 0.5, i % 2 === 0 ? "tp" : "sl"));
    const s = summarize(log);
    assert.equal(s.tp, 20);
    assert.equal(s.tpRate, 0.5);
    assert.equal(s.meanStated, 0.5);
    assert.equal(s.meanChance, 0.333);
    assert.ok(s.skill! > 0);
    assert.match(edgeLine(s), /Brier skill vs chance \+0\.\d\d: not distinguishable from chance yet|above chance/);
  });

  test("a model that is always too confident scores below chance", () => {
    const log = Array.from({ length: 40 }, (_, i) => touchedBet(`b${i}`, 0.8, i % 3 === 0 ? "tp" : "sl"));
    const s = summarize(log);
    assert.ok(s.skill! < 0);
  });

  test("the verdict needs 30 bets and a confidence interval clear of chance", () => {
    const few = summarize(Array.from({ length: 10 }, (_, i) => touchedBet(`b${i}`, 0.6, "tp")));
    assert.match(edgeLine(few), /too few bets/);
    const many = summarize(Array.from({ length: 60 }, (_, i) => touchedBet(`b${i}`, 0.6, i % 5 === 0 ? "sl" : "tp")));
    assert.match(edgeLine(many), /above chance/);
    const bad = summarize(Array.from({ length: 60 }, (_, i) => touchedBet(`b${i}`, 0.6, i % 10 === 0 ? "tp" : "sl")));
    assert.match(edgeLine(bad), /BELOW chance/);
    assert.match(edgeLine(summarize([])), /No touched bets/);
  });

  test("a profitable time-out is not a take-profit hit", () => {
    const ttl = logged({ ...long, id: "t" }, { hypothetical: { status: "ttl", netR: 0.4 } });
    const s = summarize([ttl]);
    assert.equal(s.wins, 1);
    assert.equal(s.tp, 0);
    assert.equal(calibration([ttl]).find((c) => c.n === 1)!.realized, 0);
  });
});

describe("statistics", () => {
  const win = (id: string, p: number, netR = 1.9): LoggedBet => logged({ ...long, id, probability: p }, { hypothetical: { status: "tp", netR } });
  const loss = (id: string, p: number): LoggedBet => logged({ ...long, id, probability: p }, { hypothetical: { status: "sl", netR: -1.1 } });
  const none = (id: string): LoggedBet => logged({ ...long, id }, { hypothetical: { status: "not_touched" } });
  const open = (id: string): LoggedBet => logged({ ...long, id }, { hypothetical: { status: "open" } });

  test("summarize counts only final bets and separates never-touched", () => {
    const s = summarize([win("a", 0.5), loss("b", 0.5), none("c"), open("d"), logged(long)]);
    assert.equal(s.bets, 3);
    assert.equal(s.touched, 2);
    assert.equal(s.notTouched, 1);
    assert.equal(s.winRate, 0.5);
    assert.equal(s.meanNetR, 0.4);
    assert.equal(s.taken, 0);
  });

  test("summarize tracks the bets the user took", () => {
    const taken = logged(long, { hypothetical: { status: "tp", netR: 1.9 }, actual: { entryFill: 2.39, entryAt: 1, slippagePct: 0, size: 1, netR: 1.5, exitReason: "tp" } });
    const s = summarize([taken, win("a", 0.5)]);
    assert.equal(s.taken, 1);
    assert.equal(s.takenClosed, 1);
    assert.equal(s.takenMeanNetR, 1.5);
  });

  test("calibration buckets stated probability against realised wins", () => {
    const c = calibration([win("a", 0.3), loss("b", 0.35), win("c", 0.7), win("d", 0.75), none("e"), loss("f", 1)]);
    const b = (range: string) => c.find((x) => x.range === range)!;
    assert.deepEqual([b("20-40%").n, b("20-40%").realized], [2, 0.5]);
    assert.deepEqual([b("60-80%").n, b("60-80%").realized], [2, 1]);
    assert.deepEqual([b("80-100%").n, b("80-100%").realized], [1, 0]);
    assert.equal(b("0-20%").n, 0);
    assert.equal(b("0-20%").realized, undefined);
  });
});

describe("scoreLog and rendering", () => {
  const input = (over: Partial<Parameters<typeof scoreLog>[1]> = {}) => ({
    fills: [fill("e", { min: 6, price: 2.3905 }), fill("x", { min: 20, side: "sell", price: 2.4502 })],
    candles: { PF_XRPUSD: candles({ 5: [2.389, 2.395], 12: [2.4, 2.452] }, 80) },
    nowSec: T0 + 100 * 60,
    ...over,
  });

  test("resolves, matches and is idempotent on a second run", () => {
    const first = scoreLog([logged(long)], input());
    assert.deepEqual(first.resolved, [long.id]);
    assert.deepEqual(first.matched, [long.id]);
    const b = first.log[0]!;
    assert.equal(b.hypothetical?.status, "tp");
    assert.equal(b.actual?.exitReason, "tp");

    const second = scoreLog(first.log, input());
    assert.deepEqual(second.resolved, []);
    assert.deepEqual(second.matched, []);
    assert.deepEqual(second.log, first.log);
  });

  test("fills matched in an earlier run are not reported as stray in the next one", () => {
    const first = scoreLog([logged(long)], input());
    assert.deepEqual(first.unmatchedFills, []);
    const second = scoreLog(first.log, input());
    assert.deepEqual(second.unmatchedFills, []);
  });

  test("a bet that is not finished yet stays pending and unmatched", () => {
    const r = scoreLog([logged(long)], input({ nowSec: T0 + 20 * 60, candles: { PF_XRPUSD: candles({}, 15) } }));
    assert.equal(r.log[0]!.hypothetical?.status, "open");
    assert.equal(r.log[0]!.actual, undefined);
  });

  test("reports fills that belong to no report", () => {
    const r = scoreLog([logged(long)], input({ fills: [fill("stray", { min: 6, symbol: "PF_SOLUSD", price: 150 })] }));
    assert.deepEqual(r.unmatchedFills.map((f) => f.id), ["stray"]);
    assert.match(renderDay(r.log, "2026-10-03", r), /Fills that belong to no report/);
  });

  test("scorecard prints N next to percentages and warns about small samples", () => {
    const r = scoreLog([logged(long)], input());
    const text = renderScorecard(r.log, T0 + 100 * 60);
    assert.match(text, /100% \[21%, 100%\] \(N=1\)/);
    assert.match(text, /too few bets/);
    assert.match(text, /### Calibration/);
    assert.match(text, /\| XRP \| 1 \|/);
  });

  test("scorecard splits results by session and by agreement with the report's bias", () => {
    const a = logged({ ...long, id: "a", session: "night_asia", vs_bias: "with" }, { hypothetical: { status: "tp", netR: 1.9 } });
    const b = logged({ ...long, id: "b", session: "us", vs_bias: "against" }, { hypothetical: { status: "sl", netR: -1.1 } });
    const text = renderScorecard([a, b], T0 + 100 * 60);
    assert.match(text, /### By session[\s\S]*\| night_asia \| 1 \| 100% \|[\s\S]*\| us \| 1 \| 0% \|/);
    assert.match(text, /### By vs bias[\s\S]*\| against \| 1 \| 0% \|[\s\S]*\| with \| 1 \| 100% \|/);
  });

  test("normalizes the raw tool shapes", () => {
    const f = normalizeFill({ fill_id: "f1", order_id: "o1", symbol: "PF_XRPUSD", side: "sell", size: 5, price: "2.4", fillTime: "2026-10-03T14:06:00.000Z", fillType: "maker" } as Record<string, unknown>);
    assert.deepEqual([f.id, f.orderId, f.ts, f.price, f.fillType], ["f1", "o1", MS(6), 2.4, "maker"]);
    const c = normalizeCandle({ time: (T0 + 60) * 1000, open: "1", high: "2", low: "0.5", close: "1.5" });
    assert.deepEqual(c, { t: T0 + 60, o: 1, h: 2, l: 0.5, c: 1.5 });
    assert.throws(() => normalizeFill({ symbol: "x" }), /unreadable fill/);
    assert.throws(() => normalizeCandle({ t: "abc" }), /unreadable candle/);
  });

  test("scoreFiles writes the log, the day note and the scorecard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-score-"));
    await writeFile(join(dir, "bets-log.json"), JSON.stringify([logged(long)]), "utf8");
    const inputPath = join(dir, "input.json");
    await writeFile(inputPath, JSON.stringify({ fills: input().fills, candles: input().candles, nowSec: T0 + 6000 }), "utf8");

    const run = await scoreFiles(dir, inputPath, "2026-10-03");
    assert.deepEqual(run.matched, [long.id]);
    const log = JSON.parse(await readFile(join(dir, "bets-log.json"), "utf8")) as LoggedBet[];
    assert.equal(log[0]!.hypothetical?.status, "tp");
    assert.match(await readFile(join(dir, "2026-10-03", "_day.md"), "utf8"), /20261003-14Z-XRP-1/);
    assert.match(await readFile(join(dir, "_scorecard.md"), "utf8"), /Last 7 days/);
  });
});

describe("bias scoring", () => {
  // 4-hour window from T0; BTC and XRP 1m candles with a linear drift from `from` to `to`
  const drift = (from: number, to: number, minutes = 240): Candle[] =>
    Array.from({ length: minutes }, (_, m) => {
      const o = from + ((to - from) * m) / minutes;
      const c = from + ((to - from) * (m + 1)) / minutes;
      return { t: T0 + m * 60, o, h: Math.max(o, c), l: Math.min(o, c), c };
    });
  const entry = (over: Partial<ReportLogEntry> = {}): ReportLogEntry => ({
    report: "r.md", session: "eu_us_overlap",
    window: ["2026-10-03T14:00:00Z", "2026-10-03T18:00:00Z"], generated: "2026-10-03T13:40:00Z",
    bias: { direction: "long", probability: 0.6 },
    symbols: [
      { symbol: "BTC", futures: "PF_XBTUSD", last: 65000, atr_1h: 400, bias: "long" },
      { symbol: "XRP", futures: "PF_XRPUSD", last: 2.4, atr_1h: 0.03, bias: "short" },
    ],
    ...over,
  });

  test("judges each lean on the session move, with a dead zone of 0.25 x ATR x sqrt(hours)", () => {
    // BTC +600 (dead zone 0.25*400*2 = 200): up. XRP +0.01 (dead zone 0.015): flat.
    const o = resolveBias(entry(), { PF_XBTUSD: drift(65000, 65600), PF_XRPUSD: drift(2.4, 2.41) })!;
    const btc = o.symbols.find((x) => x.symbol === "BTC")!;
    const xrp = o.symbols.find((x) => x.symbol === "XRP")!;
    assert.deepEqual([btc.result, btc.correct], ["up", true]);
    assert.deepEqual([xrp.result, xrp.correct], ["flat", false]);
    assert.equal(btc.deadZonePct, Math.round((200 / 65000) * 100 * 1000) / 1000);
    assert.deepEqual(o.headline, { symbol: "BTC", direction: "long", probability: 0.6, result: "up", correct: true });
  });

  test("a NEUTRAL call is right only in a flat session; the headline falls back to the first symbol without BTC", () => {
    const e = entry({ bias: { direction: "neutral" }, symbols: [{ symbol: "XRP", futures: "PF_XRPUSD", last: 2.4, atr_1h: 0.03 }] });
    const o = resolveBias(e, { PF_XRPUSD: drift(2.4, 2.405) })!;
    assert.deepEqual([o.headline!.symbol, o.headline!.result, o.headline!.correct], ["XRP", "flat", true]);
  });

  test("not scored until candles cover the whole window or the window has ended", () => {
    assert.equal(resolveBias(entry(), { PF_XBTUSD: drift(65000, 65600, 100), PF_XRPUSD: drift(2.4, 2.41) }), undefined);
    const early = scoreReports([entry()], { PF_XBTUSD: drift(65000, 65600), PF_XRPUSD: drift(2.4, 2.41) }, T0 + 3600);
    assert.deepEqual(early.scored, []);
    const done = scoreReports([entry()], { PF_XBTUSD: drift(65000, 65600), PF_XRPUSD: drift(2.4, 2.41) }, T0 + 5 * 3600);
    assert.deepEqual(done.scored, ["r.md"]);
    const again = scoreReports(done.entries, {}, T0 + 6 * 3600);
    assert.deepEqual(again.scored, []); // already scored, kept
    assert.ok(again.entries[0]!.outcome);
  });

  test("bias statistics: hit rate, flat share, Brier and per-symbol leans", () => {
    const candles = (btcTo: number) => ({ PF_XBTUSD: drift(65000, btcTo), PF_XRPUSD: drift(2.4, 2.35) });
    const scored = [
      { e: entry({ report: "a" }), c: candles(65600) }, // long, up: right
      { e: entry({ report: "b" }), c: candles(64400) }, // long, down: wrong
      { e: entry({ report: "c", bias: { direction: "short", probability: 0.7 } }), c: candles(64400) }, // short, down: right
      { e: entry({ report: "d", bias: { direction: "neutral" } }), c: candles(65050) }, // neutral, flat: right
    ].map(({ e, c }) => ({ ...e, outcome: resolveBias(e, c)! }));
    const st = biasStats(scored);
    assert.equal(st.reports, 4);
    assert.equal(st.directional, 3);
    assert.equal(st.correct, 2);
    assert.equal(st.hitRate, 0.667);
    assert.equal(st.neutral, 1);
    assert.equal(st.neutralCorrect, 1);
    assert.equal(st.flatShare, 0.25);
    assert.equal(st.brier, Math.round(((0.6 - 1) ** 2 + (0.6 - 0) ** 2 + (0.7 - 1) ** 2) / 3 * 1000) / 1000);
    assert.equal(st.leans, 8); // two leans per report
    assert.equal(st.leansCorrect, 5); // BTC lean long is right only in a; XRP lean short is right in all four
    assert.match(renderScorecard([], T0, scored), /### Bias \(headline call, judged on BTC\)[\s\S]*\| 4 \| 3 \| 67% \[/);
  });

  test("the scorecard says when nothing has been scored", () => {
    assert.match(renderScorecard([], T0, []), /No session has been scored yet/);
  });
});
