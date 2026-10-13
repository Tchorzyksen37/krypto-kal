import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withoutOverlaps } from "./overlap.ts";
import type { LoggedBet } from "./types.ts";

const bet = (id: string, from: string, to: string, over: Partial<LoggedBet> = {}): LoggedBet => ({
  id, symbol: "BTC", futures: "PF_XBTUSD", side: "long", entry: 100, stop_loss: 99, take_profit: 102, ttl_minutes: 60,
  probability: 0.4, rr: 2, ev_r: 0.1, break_even: 0.36, fill_from: from, entry_deadline: from, latest_close: to,
  report: "r.md", generated: from, ...over,
});

const A = ["2026-10-12T10:00:00Z", "2026-10-12T12:00:00Z"] as const;
const B = ["2026-10-12T11:00:00Z", "2026-10-12T13:00:00Z"] as const;
const C = ["2026-10-12T12:00:00Z", "2026-10-12T14:00:00Z"] as const;

describe("withoutOverlaps", () => {
  test("drops the later of two overlapping bets on the same symbol and side", () => {
    const out = withoutOverlaps([bet("b", ...B), bet("a", ...A)]);
    assert.deepEqual(out.map((x) => x.id), ["a"]);
  });
  test("keeps both when the side differs", () => {
    assert.equal(withoutOverlaps([bet("a", ...A), bet("b", ...B, { side: "short" })]).length, 2);
  });
  test("keeps both when the symbols differ", () => {
    assert.equal(withoutOverlaps([bet("a", ...A), bet("b", ...B, { symbol: "ETH" })]).length, 2);
  });
  test("keeps back-to-back bets", () => {
    assert.equal(withoutOverlaps([bet("a", ...A), bet("c", ...C)]).length, 2);
  });
  test("keeps the first of a chain and compares against kept bets only", () => {
    const out = withoutOverlaps([bet("a", ...A), bet("b", ...B), bet("c", ...C)]);
    assert.deepEqual(out.map((x) => x.id), ["a", "c"]);
  });
  test("ties on fill_from are ordered by id", () => {
    const out = withoutOverlaps([bet("z", ...A), bet("y", ...A)]);
    assert.deepEqual(out.map((x) => x.id), ["y"]);
  });
  test("empty log", () => {
    assert.deepEqual(withoutOverlaps([]), []);
  });
  test("does not mutate its input", () => {
    const input = [bet("b", ...B), bet("a", ...A)];
    withoutOverlaps(input);
    assert.deepEqual(input.map((x) => x.id), ["b", "a"]);
  });
});
