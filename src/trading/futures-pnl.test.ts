// futures-pnl.test.ts – offline tests of trade building, statistics and the fill sync (in-memory SQLite, fake API).
// Run: npm run test:offline

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTrades, report, summarize, syncFills, type PnlFill } from "./futures-pnl.ts";
import type { FuturesFill } from "../providers/kraken/kraken-futures-client.ts";
import { setLogLevel } from "../core/logger.ts";
import { TradeStore } from "./trade-store.ts";

setLogLevel("error");

const T0 = Date.parse("2026-09-01T00:00:00Z");
let n = 0;
const fill = (side: "buy" | "sell", size: number, price: number, minutes: number, symbol = "PF_XBTUSD"): PnlFill => ({
  id: `f${++n}`, symbol, side, size, price, ts: T0 + minutes * 60_000,
});

describe("buildTrades", () => {
  test("long round trip", () => {
    const { trades } = buildTrades([fill("buy", 2, 100, 0), fill("sell", 2, 110, 5)]);
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.direction, "long");
    assert.equal(trades[0]!.pnl, 20);
    assert.equal(trades[0]!.size, 2);
  });

  test("short round trip", () => {
    const { trades } = buildTrades([fill("sell", 1, 100, 0), fill("buy", 1, 90, 5)]);
    assert.equal(trades[0]!.direction, "short");
    assert.equal(trades[0]!.pnl, 10);
  });

  test("scaling in uses the average entry, partial exits stay one trade", () => {
    const { trades } = buildTrades([
      fill("buy", 1, 100, 0), fill("buy", 1, 120, 1), // avg 110
      fill("sell", 1, 130, 2), fill("sell", 1, 100, 3), // +20 and -10
    ]);
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.entryPrice, 110);
    assert.equal(trades[0]!.exitPrice, 115);
    assert.equal(trades[0]!.pnl, 10);
    assert.equal(trades[0]!.fills, 4);
  });

  test("a reversal closes one trade and opens the next", () => {
    const { trades } = buildTrades([fill("buy", 1, 100, 0), fill("sell", 3, 110, 1), fill("buy", 2, 100, 2)]);
    assert.equal(trades.length, 2);
    assert.deepEqual(trades.map((t) => [t.direction, t.pnl]), [["long", 10], ["short", 20]]);
  });

  test("a position that is still open is not a closed trade", () => {
    assert.equal(buildTrades([fill("buy", 1, 100, 0)]).trades.length, 0);
  });

  test("symbols are independent and inverse contracts are skipped", () => {
    const { trades, skippedSymbols } = buildTrades([
      fill("buy", 1, 100, 0, "PF_ETHUSD"), fill("buy", 1, 50000, 0, "PI_XBTUSD"),
      fill("sell", 1, 90, 1, "PF_ETHUSD"), fill("sell", 1, 51000, 1, "PI_XBTUSD"),
    ]);
    assert.deepEqual(trades.map((t) => [t.symbol, t.pnl]), [["PF_ETHUSD", -10]]);
    assert.deepEqual(skippedSymbols, ["PI_XBTUSD"]);
  });

  test("fills given out of order are sorted by time", () => {
    const { trades } = buildTrades([fill("sell", 1, 110, 5), fill("buy", 1, 100, 0)]);
    assert.equal(trades[0]!.pnl, 10);
  });
});

describe("summarize / report", () => {
  const { trades } = buildTrades([
    fill("buy", 1, 100, 0), fill("sell", 1, 130, 10), // +30
    fill("buy", 1, 100, 20), fill("sell", 1, 80, 30), // -20
    fill("buy", 1, 100, 40), fill("sell", 1, 90, 50), // -10
    fill("buy", 1, 100, 24 * 60), fill("sell", 1, 150, 24 * 60 + 10), // +50, next day
  ]);

  test("statistics", () => {
    const s = summarize(trades);
    assert.equal(s.trades, 4);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 2);
    assert.equal(s.winRate, 0.5);
    assert.equal(s.totalPnl, 50);
    assert.equal(s.profitFactor, 80 / 30);
    assert.equal(s.avgWin, 40);
    assert.equal(s.avgLoss, -15);
    assert.equal(s.bestTrade, 50);
    assert.equal(s.worstTrade, -20);
    assert.equal(s.maxDrawdown, 30); // 30 -> 10 -> 0
    assert.equal(s.avgHoldSeconds, 600);
  });

  test("empty input has null ratios", () => {
    const s = summarize([]);
    assert.equal(s.trades, 0);
    assert.equal(s.winRate, null);
    assert.equal(s.profitFactor, null);
  });

  test("per symbol and per day with a running total", () => {
    const r = report(trades);
    assert.deepEqual(Object.keys(r.bySymbol), ["PF_XBTUSD"]);
    assert.deepEqual(r.byDay.map((d) => [d.day, d.trades, d.pnl, d.cumulativePnl]), [
      ["2026-09-01", 3, 0, 0], ["2026-09-02", 1, 50, 50],
    ]);
  });
});

describe("syncFills", () => {
  const apiFill = (id: number, minutes: number, side: "buy" | "sell", price: number): FuturesFill => ({
    fill_id: `a${id}`, order_id: `o${id}`, symbol: "PF_XBTUSD", side, size: 1, price,
    fillTime: new Date(T0 + minutes * 60_000).toISOString(), fillType: "taker",
  });

  // A fake /fills: newest first, `limit` per page, `lastFillTime` = only fills strictly older.
  const fakeSource = (all: FuturesFill[], limit = 2) => {
    const requests: (string | undefined)[] = [];
    return {
      requests,
      async fills(lastFillTime?: string) {
        requests.push(lastFillTime);
        const before = lastFillTime ? Date.parse(lastFillTime) : Infinity;
        return all.filter((f) => Date.parse(f.fillTime) < before).sort((a, b) => Date.parse(b.fillTime) - Date.parse(a.fillTime)).slice(0, limit);
      },
    };
  };

  const history = [apiFill(1, 0, "buy", 100), apiFill(2, 10, "sell", 110), apiFill(3, 20, "buy", 100), apiFill(4, 30, "sell", 95), apiFill(5, 40, "buy", 100)];

  test("pages back through the whole history and stores trades", async () => {
    const db = new TradeStore(":memory:");
    const source = fakeSource(history);
    const res = await syncFills(source, db);
    assert.equal(res.inserted, 5);
    assert.equal(res.totalFills, 5);
    assert.equal(res.closedTrades, 2);
    assert.equal(res.firstFill, new Date(T0).toISOString());
    assert.deepEqual(db.trades().map((t) => t.pnl), [10, -5]);
    assert.equal(db.fills({}, 2).length, 2);
    assert.equal(db.fills({ from: T0 + 30 * 60_000 })[0]!.id, "a5");
    db.close();
  });

  test("a second sync is incremental and does not duplicate", async () => {
    const db = new TradeStore(":memory:");
    await syncFills(fakeSource(history), db);
    const more = [...history, apiFill(6, 50, "sell", 130)];
    const source = fakeSource(more);
    const res = await syncFills(source, db);
    assert.equal(res.inserted, 1);
    assert.equal(res.totalFills, 6);
    assert.equal(res.closedTrades, 3);
    assert.ok(source.requests.length <= 3, "stops once it reaches stored fills");
    assert.deepEqual(db.trades({ from: T0 + 45 * 60_000 }).map((t) => t.pnl), [30]);
    db.close();
  });

  test("keeps the order id and maker/taker type, and backfills them into fills stored without", async () => {
    const db = new TradeStore(":memory:");
    db.saveFills([{ id: "a1", symbol: "PF_XBTUSD", side: "buy", size: 1, price: 100, ts: T0 }]); // as an older version stored it
    await syncFills(fakeSource(history), db);
    const byId = new Map(db.fills().map((f) => [f.id, f]));
    assert.equal(byId.get("a1")!.fillType, "taker");
    assert.equal(byId.get("a1")!.orderId, "o1");
    assert.equal(byId.get("a2")!.orderId, "o2");
    db.close();
  });

  test("migrates a database created before the order id and fill type columns", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(await mkdtemp(join(tmpdir(), "trade-store-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE futures_fills (fill_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL)");
    old.exec(`INSERT INTO futures_fills VALUES ('x1', ${T0}, 'PF_XBTUSD', 'buy', 1, 100)`);
    old.close();
    const db = new TradeStore(path);
    assert.deepEqual(db.fills(), [{ id: "x1", ts: T0, symbol: "PF_XBTUSD", side: "buy", size: 1, price: 100 }]);
    db.saveFills([{ id: "x2", symbol: "PF_XBTUSD", side: "sell", size: 1, price: 101, ts: T0 + 1, orderId: "o9", fillType: "taker" }]);
    assert.equal(db.fills({}, 1)[0]!.fillType, "taker");
    db.close();
  });

  test("stops when the cursor does not move", async () => {
    const db = new TradeStore(":memory:");
    const same = [apiFill(1, 0, "buy", 100), apiFill(2, 0, "sell", 100)];
    const source = { async fills() { return same; } };
    const res = await syncFills(source, db, 10);
    assert.equal(res.pages, 2);
    db.close();
  });
});
