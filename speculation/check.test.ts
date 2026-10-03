// speculation/check.test.ts – offline tests of bet validation and report patching.
// Run: node --test speculation/check.test.ts

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_CHECK, fmtPrice, patchReport, renderBestBets, runCheck, validateBets } from "./check.ts";
import type { BetInput, LoggedBet, ReportMeta } from "./types.ts";

const meta = (bets: BetInput[], over: Partial<ReportMeta> = {}): ReportMeta => ({
  generated: "2026-10-03T13:52:00Z",
  window: ["2026-10-03T14:00:00Z", "2026-10-03T15:00:00Z"],
  symbols: [
    { symbol: "XRP", futures: "PF_XRPUSD", last: 2.4, atr_1h: 0.03, why: "core" },
    { symbol: "BTC", futures: "PF_XBTUSD", last: 65000, atr_1h: 400, why: "core" },
    { symbol: "ETH", futures: "PF_ETHUSD", last: 3000, atr_1h: 20, why: "core" },
  ],
  bets,
  ...over,
});

const xrpLong: BetInput = { symbol: "XRP", side: "long", entry: 2.39, stop_loss: 2.36, take_profit: 2.45, ttl_minutes: 45, probability: 0.4, rationale: "squeeze" };
const reasons = (m: ReportMeta) => validateBets(m).dropped.map((d) => d.reason);

describe("validateBets", () => {
  test("keeps a sound long and computes id, R:R and times", () => {
    const r = validateBets(meta([xrpLong]));
    assert.equal(r.dropped.length, 0);
    const b = r.bets[0]!;
    assert.equal(b.id, "20261003-14Z-XRP-1");
    assert.equal(b.futures, "PF_XRPUSD");
    assert.equal(b.rr, 2);
    assert.equal(b.fill_from, "2026-10-03T14:00:00.000Z");
    assert.equal(b.entry_deadline, "2026-10-03T14:30:00.000Z");
    assert.equal(b.latest_close, "2026-10-03T15:15:00.000Z");
  });

  test("keeps a sound short", () => {
    const r = validateBets(meta([{ symbol: "BTC", side: "short", entry: 65100, stop_loss: 65400, take_profit: 64500, ttl_minutes: 30, probability: 0.35 }]));
    assert.equal(r.bets.length, 1);
    assert.equal(r.bets[0]!.rr, 2);
  });

  test("drops wrong level ordering", () => {
    assert.match(reasons(meta([{ ...xrpLong, stop_loss: 2.42 }]))[0]!, /SL < entry < TP/);
    assert.match(reasons(meta([{ ...xrpLong, side: "short" }]))[0]!, /TP < entry < SL/);
  });

  test("drops an entry far from the last price", () => {
    assert.match(reasons(meta([{ ...xrpLong, entry: 2.3, stop_loss: 2.27, take_profit: 2.36 }]))[0]!, /away from last price/);
  });

  test("drops a stop inside the noise", () => {
    assert.match(reasons(meta([{ ...xrpLong, stop_loss: 2.388, take_profit: 2.45 }]))[0]!, /stop inside noise/);
  });

  test("drops a take profit that does not clear costs", () => {
    const m = meta([{ symbol: "BTC", side: "long", entry: 65000, stop_loss: 64940, take_profit: 65020, ttl_minutes: 20, probability: 0.5 }]);
    assert.match(reasons(m)[0]!, /does not clear costs/);
  });

  test("drops poor reward:risk", () => {
    assert.match(reasons(meta([{ ...xrpLong, take_profit: 2.41 }]))[0]!, /reward:risk/);
  });

  test("drops bad ttl, probability, symbol and non-numbers", () => {
    assert.match(reasons(meta([{ ...xrpLong, ttl_minutes: 90 }]))[0]!, /ttl 90/);
    assert.match(reasons(meta([{ ...xrpLong, probability: 1.4 }]))[0]!, /probability/);
    assert.match(reasons(meta([{ ...xrpLong, symbol: "DOGE" }]))[0]!, /unknown symbol/);
    assert.match(reasons(meta([{ ...xrpLong, entry: Number.NaN }]))[0]!, /non-positive/);
  });

  test("one bet per symbol (best expected value wins) and a cap on the total", () => {
    const better = { ...xrpLong, probability: 0.6 };
    const worse = { ...xrpLong, probability: 0.3 };
    const r = validateBets(meta([worse, better]));
    assert.equal(r.bets.length, 1);
    assert.equal(r.bets[0]!.probability, 0.6);
    assert.match(r.dropped[0]!.reason, /second bet for XRP/);

    const btc: BetInput = { symbol: "BTC", side: "long", entry: 64950, stop_loss: 64600, take_profit: 65650, ttl_minutes: 30, probability: 0.4 };
    const eth: BetInput = { symbol: "ETH", side: "long", entry: 2995, stop_loss: 2970, take_profit: 3045, ttl_minutes: 30, probability: 0.4 };
    const capped = validateBets(meta([xrpLong, btc, eth]), { maxBets: 2 });
    assert.equal(capped.bets.length, 2);
    assert.equal(capped.dropped.length, 1);
    assert.match(capped.dropped[0]!.reason, /limit of 2/);
    assert.deepEqual(capped.bets.map((b) => b.id.slice(-1)), ["1", "2"]);
  });

  test("randomized: no kept bet breaks ordering, deviation, R:R or ttl rules", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
    for (let n = 0; n < 2000; n++) {
      const last = 2.4;
      const entry = last * (1 + (rnd() - 0.5) * 0.04);
      const bet: BetInput = {
        symbol: "XRP",
        side: rnd() < 0.5 ? "long" : "short",
        entry,
        stop_loss: entry * (1 + (rnd() - 0.5) * 0.06),
        take_profit: entry * (1 + (rnd() - 0.5) * 0.06),
        ttl_minutes: Math.floor(rnd() * 120),
        probability: rnd() * 1.2,
      };
      for (const b of validateBets(meta([bet])).bets) {
        const long = b.side === "long";
        assert.ok(long ? b.stop_loss < b.entry && b.entry < b.take_profit : b.take_profit < b.entry && b.entry < b.stop_loss);
        assert.ok(Math.abs(b.entry - last) / last <= DEFAULT_CHECK.maxEntryDeviation + 1e-12);
        assert.ok(b.rr >= DEFAULT_CHECK.minRewardRisk - 1e-9);
        assert.ok(b.ttl_minutes >= DEFAULT_CHECK.minTtl && b.ttl_minutes <= DEFAULT_CHECK.maxTtl);
        assert.ok(b.probability > 0 && b.probability <= 1);
      }
    }
  });
});

describe("rendering and patching", () => {
  test("fmtPrice scales digits with magnitude", () => {
    assert.equal(fmtPrice(65000.55), "65000.6");
    assert.equal(fmtPrice(2.4), "2.400");
    assert.equal(fmtPrice(0.5123), "0.5123");
    assert.equal(fmtPrice(0.05123), "0.05123");
  });

  test("renders a table, callouts and dropped bets; 'no bet' when empty", () => {
    const m = meta([xrpLong, { ...xrpLong, symbol: "DOGE" }]);
    const text = renderBestBets(validateBets(m), m);
    assert.match(text, /^## Best bets \(next 1h\)/);
    assert.match(text, /\| 1 \| XRP \| long \| 2\.390 \| 2\.360 \| 2\.450 \| 14:30Z \| 45 min \| 15:15Z \| 40% \| 2\.00 \|/);
    assert.match(text, /\[!tip\] 1\. XRP long/);
    assert.match(text, /### Dropped bets/);
    assert.match(text, /DOGE long: unknown symbol/);

    const none = meta([]);
    assert.match(renderBestBets(validateBets(none), none), /No bet this hour/);
  });

  test("patchReport replaces only the Best bets section and keeps later sections", () => {
    const md = "# R\n\n## Risks\n- x\n\n## Best bets (next 1h)\nold\n\n## Footer\nkeep\n";
    const out = patchReport(md, "## Best bets (next 1h)\nnew\n");
    assert.match(out, /## Risks\n- x\n\n## Best bets \(next 1h\)\nnew\n\n## Footer\nkeep/);
    assert.ok(!out.includes("old"));
  });

  test("patchReport appends when the section is missing and is idempotent", () => {
    const once = patchReport("# R\n\ntext\n", "## Best bets (next 1h)\nnew\n");
    assert.match(once, /text\n\n## Best bets \(next 1h\)\nnew/);
    assert.equal(patchReport(once, "## Best bets (next 1h)\nnew\n"), once);
  });
});

describe("runCheck (files)", () => {
  test("patches the .md, writes results into the meta and appends to the log once", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-"));
    const day = join(root, "2026-10-03");
    await mkdir(day, { recursive: true });
    const metaPath = join(day, "1400Z.meta.json");
    await writeFile(metaPath, JSON.stringify(meta([xrpLong])), "utf8");
    await writeFile(join(day, "1400Z.md"), "# Report\n\n## Risks\n- a\n", "utf8");

    const r = await runCheck(metaPath);
    assert.equal(r.bets.length, 1);
    const md = await readFile(join(day, "1400Z.md"), "utf8");
    assert.match(md, /## Risks\n- a\n\n## Best bets \(next 1h\)/);
    assert.match(md, /20261003-14Z-XRP-1/);
    const saved = JSON.parse(await readFile(metaPath, "utf8")) as ReportMeta;
    assert.equal(saved.validated?.length, 1);

    await runCheck(metaPath); // rerun must not duplicate the log entry
    const log = JSON.parse(await readFile(join(root, "bets-log.json"), "utf8")) as LoggedBet[];
    assert.equal(log.length, 1);
    assert.equal(log[0]!.id, "20261003-14Z-XRP-1");
  });

  test("rejects a meta file without the required arrays", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-"));
    const p = join(root, "x.meta.json");
    await writeFile(p, "{}", "utf8");
    await assert.rejects(() => runCheck(p), /needs symbols/);
  });
});
