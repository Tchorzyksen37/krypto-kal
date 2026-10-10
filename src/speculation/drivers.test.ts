// speculation/drivers.test.ts – offline tests of scoring the macro drivers of speculation reports.
// Run: node --test src/speculation/drivers.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DRIVERS, driverMove, driverStats, renderDrivers, resolveDrivers, scoreDrivers } from "./drivers.ts";
import { driverRanges } from "./fetch.ts";
import type { Candle, ReportLogEntry } from "./types.ts";

const START = Date.parse("2026-10-09T11:30:00Z") / 1000;
const END = START + 4 * 3600;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const nasdaq = DRIVERS.find((d) => d.id === "nasdaq")!;
const yields = DRIVERS.find((d) => d.id === "yields")!;

// 15m bars from `startSec` that walk linearly from `from` to `to`.
function bars(from: number, to: number, startSec = START, endSec = END): Candle[] {
  const n = Math.floor((endSec - startSec) / 900);
  return Array.from({ length: n }, (_, i) => {
    const o = from + ((to - from) * i) / n;
    const c = from + ((to - from) * (i + 1)) / n;
    return { t: startSec + i * 900, o, h: Math.max(o, c), l: Math.min(o, c), c };
  });
}

// A report whose bias was already scored: BTC moved `btcPct` over the window.
function report(btcPct: number, over: Partial<ReportLogEntry> = {}): ReportLogEntry {
  const result = Math.abs(btcPct) < 0.2 ? "flat" : btcPct > 0 ? "up" : "down";
  return {
    report: `r-${btcPct}-${Math.random()}`, window: [iso(START), iso(END)], generated: iso(START),
    bias: { direction: "long", probability: 0.6 },
    symbols: [{ symbol: "BTC", futures: "PF_XBTUSD", last: 80000, atr_1h: 300 }],
    outcome: {
      symbols: [
        { symbol: "BTC", open: 80000, close: 80000 * (1 + btcPct / 100), movePct: btcPct, deadZonePct: 0.2, result },
        { symbol: "ETH", open: 2500, close: 2500 * (1 + (btcPct * 1.8) / 100), movePct: btcPct * 1.8, deadZonePct: 0.3, result },
      ],
      headline: { symbol: "BTC", direction: "long", result, correct: result === "up" },
    },
    ...over,
  };
}

describe("driverMove", () => {
  test("measures the move in % for futures and in basis points for yields, with a dead zone", () => {
    const up = driverMove(nasdaq, bars(31000, 31155), [START, END])!;
    assert.equal(up.move, 0.5);
    assert.equal(up.result, "up");
    const y = driverMove(yields, bars(5.2, 5.23), [START, END])!;
    assert.equal(y.move, 3);
    assert.equal(y.result, "up");
    assert.equal(driverMove(nasdaq, bars(31000, 31010), [START, END])!.result, "flat");
  });

  test("returns undefined when the bars do not cover the window (for example yields outside Cboe hours)", () => {
    assert.equal(driverMove(yields, bars(5.2, 5.23, START + 3 * 3600, END), [START, END]), undefined); // 1 of 4 hours
    assert.equal(driverMove(yields, bars(5.2, 5.23, START, START + 3600), [START, END]), undefined);
    assert.equal(driverMove(yields, [], [START, END]), undefined);
  });

  test("a move over at least half of the window is kept and marked partial", () => {
    const m = driverMove(yields, bars(5.2, 5.23, START + 2 * 3600, END), [START, END])!;
    assert.equal(m.partial, true);
    assert.equal(m.move, 3);
    assert.equal(driverMove(yields, bars(5.2, 5.23), [START, END])!.partial, undefined);
  });
});

describe("resolveDrivers", () => {
  test("marks a driver aligned when it moved the risk-way with BTC, and checks the report's view", () => {
    const e = report(1.0, { drivers: [{ driver: "nasdaq", expect: "up", weight: 0.6 }, { driver: "oil", expect: "up" }] });
    const out = resolveDrivers(e, {
      "NQ=F": bars(31000, 31310), // +1%: up with BTC up -> aligned
      "CL=F": bars(90, 91.8), // +2%: oil up with BTC up -> not aligned (oil is risk-off)
    })!;
    const nq = out.drivers.find((d) => d.driver === "nasdaq")!;
    const oil = out.drivers.find((d) => d.driver === "oil")!;
    assert.equal(nq.aligned, true);
    assert.equal(nq.expectedCorrect, true);
    assert.equal(oil.aligned, false);
    assert.equal(oil.expectedCorrect, true); // it expected oil up and it was up
    assert.equal(out.leader?.movePct, 1.0);
    assert.equal(out.biasVsNasdaq, "agreed"); // LONG with Nasdaq up
  });

  test("a flat driver or a flat BTC is neither aligned nor not aligned", () => {
    const flatBtc = resolveDrivers(report(0.05), { "NQ=F": bars(31000, 31310) })!;
    assert.equal(flatBtc.drivers[0]!.aligned, undefined);
    const flatNq = resolveDrivers(report(1.0), { "NQ=F": bars(31000, 31001) })!;
    assert.equal(flatNq.drivers[0]!.aligned, undefined);
    assert.equal(flatNq.biasVsNasdaq, "n/a");
  });

  test("needs the bias outcome and at least one driver", () => {
    const { outcome: _, ...noOutcome } = report(1.0);
    assert.equal(resolveDrivers(noOutcome as ReportLogEntry, { "NQ=F": bars(1, 2) }), undefined);
    assert.equal(resolveDrivers(report(1.0), {}), undefined);
  });
});

describe("scoreDrivers and driverStats", () => {
  test("scores finished reports once and skips the others", () => {
    const e = report(1.0);
    const future = report(1.0, { window: [iso(START + 86400), iso(END + 86400)] });
    const r = scoreDrivers([e, future], { "NQ=F": bars(31000, 31310) }, END + 600);
    assert.equal(r.scored.length, 1);
    assert.ok(r.entries[0]!.driverOutcome);
    assert.equal(r.entries[1]!.driverOutcome, undefined);
    assert.equal(scoreDrivers(r.entries, { "NQ=F": bars(31000, 31310) }, END + 600).scored.length, 0);
  });

  test("fits a beta and R² only from MIN_FIT_N sessions, and the beta is BTC % per 1% of Nasdaq", () => {
    const sessions = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const nqPct = i % 2 ? -0.5 - i * 0.1 : 0.4 + i * 0.1;
        return scoreDrivers([report(nqPct * 1.5, { betas: { ETH: 1.5 } })], { "NQ=F": bars(31000, 31000 * (1 + nqPct / 100)) }, END + 600).entries[0]!;
      });
    const few = driverStats(sessions(5));
    assert.equal(few.drivers[0]!.beta, undefined);
    assert.equal(few.drivers[0]!.alignedRate, 1);
    const many = driverStats(sessions(10));
    assert.equal(many.sessions, 10);
    assert.ok(Math.abs(many.drivers[0]!.beta! - 1.5) < 0.01);
    assert.ok(many.drivers[0]!.r2! > 0.99);
    const eth = many.alts.find((a) => a.symbol === "ETH")!;
    assert.ok(Math.abs(eth.realized! - 1.8) < 0.01);
    assert.equal(eth.assumed, 1.5);
  });

  test("renders a table, the caveat and a section for no data", () => {
    assert.match(renderDrivers([]).join("\n"), /No session has driver data yet/);
    const e = scoreDrivers([report(1.0)], { "NQ=F": bars(31000, 31310) }, END + 600).entries;
    const text = renderDrivers(e).join("\n");
    assert.match(text, /Nasdaq \(NQ=F\)/);
    assert.match(text, /under 30 nothing here is a conclusion/);
    assert.match(text, /Last sessions/);
  });
});

describe("driverRanges", () => {
  test("pads and merges the windows of finished reports without a driver outcome", () => {
    const a = report(1);
    const b = report(1, { window: [iso(END + 600), iso(END + 3 * 3600)] });
    const done = report(1, { driverOutcome: { drivers: [] } });
    const open = report(1, { window: [iso(END + 86400), iso(END + 90000)] });
    const r = driverRanges([a, b, done, open], END + 4 * 3600);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.from, START - 1800);
    assert.equal(r[0]!.to, END + 3 * 3600 + 1800);
  });
});
