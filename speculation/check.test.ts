// speculation/check.test.ts – offline tests of bet validation and report patching.
// Run: node --test speculation/check.test.ts

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_CHECK, biasError, breakEven, expectedR, feeR, upsertReportBets, fmtPrice, patchBias, patchReport, renderBestBets, renderBias, runCheck, validateBets } from "./check.ts";
import type { BetInput, LoggedBet, ReportMeta } from "./types.ts";

const meta = (bets: BetInput[], over: Partial<ReportMeta> = {}): ReportMeta => ({
  generated: "2026-10-03T13:52:00Z",
  bias: { direction: "long", probability: 0.58, summary: "shorts crowded after the flush" },
  window: ["2026-10-03T14:00:00Z", "2026-10-03T15:00:00Z"],
  symbols: [
    { symbol: "XRP", futures: "PF_XRPUSD", last: 2.4, atr_1h: 0.03, why: "core", bias: "long" },
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
    assert.equal(b.id, "20261003-1400Z-XRP-1");
    assert.equal(b.futures, "PF_XRPUSD");
    assert.equal(b.rr, 2);
    assert.equal(b.vs_bias, "with");
    assert.equal(b.fill_from, "2026-10-03T14:00:00.000Z");
    assert.equal(b.entry_deadline, "2026-10-03T14:30:00.000Z");
    assert.equal(b.latest_close, "2026-10-03T15:15:00.000Z");
  });

  test("keeps a sound short", () => {
    const r = validateBets(meta([{ symbol: "BTC", side: "short", entry: 65100, stop_loss: 65500, take_profit: 64300, ttl_minutes: 30, probability: 0.45 }]));
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
    const worse = { ...xrpLong, probability: 0.45 };
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

  test("drops a bet whose probability does not beat break-even after fees", () => {
    // R:R 1.5 at P 30%: EV = 0.45 - 0.70 - fees < 0
    const neg = { ...xrpLong, stop_loss: 2.36, take_profit: 2.435, probability: 0.3 };
    assert.match(reasons(meta([neg]))[0]!, /no edge: probability 30% is below the break-even 4\d%/);
    assert.equal(validateBets(meta([{ ...neg, probability: 0.5 }])).bets.length, 1);
  });

  test("drops a stop so tight that fees eat more than 0.2R", () => {
    // BTC $60 stop: round-trip taker fees are about $65, i.e. 1.08R
    const m = meta([{ symbol: "BTC", side: "long", entry: 64990, stop_loss: 64930, take_profit: 65200, ttl_minutes: 30, probability: 0.6 }]);
    assert.match(reasons(m)[0]!, /fees cost 1\.08R/);
  });

  test("a limit entry must wait for the market: long at or below last, short at or above", () => {
    assert.match(reasons(meta([{ ...xrpLong, entry: 2.41, stop_loss: 2.38, take_profit: 2.47 }]))[0]!, /long limit above the last price/);
    const short: BetInput = { symbol: "XRP", side: "short", entry: 2.39, stop_loss: 2.42, take_profit: 2.33, ttl_minutes: 30, probability: 0.5 };
    assert.match(reasons(meta([short]))[0]!, /short limit below the last price/);
    assert.equal(validateBets(meta([{ ...xrpLong, entry: 2.4, stop_loss: 2.37, take_profit: 2.46 }])).bets.length, 1); // at the last price is fine
  });

  test("ranks by expected value, not by probability x R:R", () => {
    // p 0.2 x RR 5 ties p 0.5 x RR 2 on the old score, but EV is about 0R vs +0.5R
    const longshot: BetInput = { symbol: "BTC", side: "long", entry: 64950, stop_loss: 64550, take_profit: 66950, ttl_minutes: 60, probability: 0.22 };
    const solid: BetInput = { symbol: "ETH", side: "long", entry: 2995, stop_loss: 2965, take_profit: 3055, ttl_minutes: 60, probability: 0.5 };
    const r = validateBets(meta([longshot, solid]));
    assert.deepEqual(r.bets.map((b) => b.symbol), ["ETH", "BTC"]);
    assert.ok(r.bets[0]!.ev_r > r.bets[1]!.ev_r);
  });

  test("fee, EV and break-even helpers agree", () => {
    const b = { ...xrpLong, probability: breakEven(xrpLong, 5) };
    assert.ok(Math.abs(expectedR(b, 5)) < 1e-12);
    assert.ok(Math.abs(feeR(xrpLong, 5) - (2 * 5 * 2.39) / 10_000 / 0.03) < 1e-12);
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
        assert.ok(long ? b.entry <= last : b.entry >= last);
        assert.ok(feeR(b, DEFAULT_CHECK.feeBps) <= DEFAULT_CHECK.maxFeeR + 1e-12);
        assert.ok(expectedR(b, DEFAULT_CHECK.feeBps) > 0);
      }
    }
  });
});

describe("sessions", () => {
  const nightMeta = (bets: BetInput[]): ReportMeta =>
    meta(bets, { session: "night_asia", window: ["2026-10-03T20:00:00Z", "2026-10-04T06:00:00Z"], generated: "2026-10-03T19:40:00Z" });

  test("session limits replace the 1h defaults: longer ttl and entry deadline, ids carry minutes", () => {
    const m = nightMeta([{ ...xrpLong, ttl_minutes: 240, take_profit: 2.47 }]);
    const r = validateBets(m);
    assert.equal(r.dropped.length, 0, JSON.stringify(r.dropped));
    const b = r.bets[0]!;
    assert.equal(b.id, "20261003-2000Z-XRP-1");
    assert.equal(b.session, "night_asia");
    assert.equal(b.entry_deadline, "2026-10-03T23:00:00.000Z"); // 180 min after the window opens
    assert.equal(b.latest_close, "2026-10-04T03:00:00.000Z");
    assert.match(renderBestBets(r, m), /^## Best bets \(Night \(Asia\)\)/);
  });

  test("the night session keeps at most 2 bets and wants reward:risk 1.5", () => {
    const m = nightMeta([{ ...xrpLong, take_profit: 2.41 }]); // R:R 0.67
    assert.match(validateBets(m).dropped[0]!.reason, /reward:risk .* < 1\.5/);
    const btc: BetInput = { symbol: "BTC", side: "long", entry: 64950, stop_loss: 64300, take_profit: 66000, ttl_minutes: 120, probability: 0.5 };
    const eth: BetInput = { symbol: "ETH", side: "long", entry: 2995, stop_loss: 2960, take_profit: 3060, ttl_minutes: 120, probability: 0.4 };
    const r = validateBets(nightMeta([{ ...xrpLong, take_profit: 2.47, ttl_minutes: 120 }, btc, eth]));
    assert.equal(r.bets.length, 2);
    assert.match(r.dropped[0]!.reason, /limit of 2/);
  });

  test("a ttl above the session maximum is dropped", () => {
    assert.match(validateBets(nightMeta([{ ...xrpLong, ttl_minutes: 400 }])).dropped[0]!.reason, /ttl 400/);
  });

  test("longer holds need wider stops", () => {
    // ATR 0.07: a 0.015 stop is 0.21 ATR, enough for a 60-minute hold (0.15) but not for 240 minutes (0.30)
    const wide = (bets: BetInput[]): ReportMeta => ({ ...nightMeta(bets), symbols: [{ symbol: "XRP", futures: "PF_XRPUSD", last: 2.4, atr_1h: 0.07 }] });
    const bet = { ...xrpLong, stop_loss: 2.375, take_profit: 2.43, ttl_minutes: 60 };
    assert.equal(validateBets(wide([bet])).dropped.length, 0, JSON.stringify(validateBets(wide([bet])).dropped));
    assert.match(validateBets(wide([{ ...bet, ttl_minutes: 240 }])).dropped[0]!.reason, /stop inside noise/);
  });

  test("a manual run after the window opened fills from the generation time", () => {
    const m = meta([xrpLong], { session: "eu_us_overlap", window: ["2026-10-03T11:30:00Z", "2026-10-03T15:30:00Z"], generated: "2026-10-03T13:00:00Z" });
    const b = validateBets(m).bets[0]!;
    assert.equal(b.id, "20261003-1130Z-XRP-1"); // id keeps the window start
    assert.equal(b.fill_from, "2026-10-03T13:00:00.000Z");
    assert.equal(b.entry_deadline, "2026-10-03T13:45:00.000Z"); // overlap session: 45 min
  });
});

describe("bias", () => {
  test("every report must state long, short or neutral", () => {
    assert.match(biasError({ ...meta([]), bias: undefined })!, /must state its bias/);
    assert.match(biasError({ ...meta([]), bias: { direction: "long" } })!, /needs a probability/);
    assert.equal(biasError({ ...meta([]), bias: { direction: "neutral" } }), undefined);
    assert.equal(biasError(meta([])), undefined);
    assert.match(biasError(meta([], { symbols: [{ symbol: "X", futures: "F", last: 1, atr_1h: 1, bias: "up" as never }] }))!, /invalid bias for X/);
  });

  test("renders a clear callout with per-symbol leans", () => {
    const text = renderBias(meta([], { bias: { direction: "short", probability: 0.61, summary: "US data risk" } }));
    assert.match(text, /\[!abstract\] Bias: SHORT \(61%\)\. US data risk/);
    assert.match(text, /Per symbol: XRP LONG/);
    assert.match(renderBias(meta([], { bias: { direction: "neutral" } })), /NEUTRAL, no directional edge/);
  });

  test("patchBias inserts once under the title, updates in place and mirrors the frontmatter", () => {
    const m = meta([]);
    const once = patchBias("---\ntype: speculation\n---\n# Report\n\ntext\n", m);
    assert.match(once, /^---\ntype: speculation\nbias: long\n---/);
    assert.match(once, /# Report\n\n<!-- bias:start -->\n> \[!abstract\] Bias: LONG \(58%\)/);
    const flipped = patchBias(once, { ...m, bias: { direction: "short", probability: 0.7 } });
    assert.equal(flipped.match(/bias:start/g)!.length, 1);
    assert.match(flipped, /^---\ntype: speculation\nbias: short\n---/);
    assert.match(flipped, /Bias: SHORT \(70%\)/);
    assert.ok(!flipped.includes("LONG (58%)"));
  });

  test("patchBias adds frontmatter when the note has none", () => {
    assert.match(patchBias("plain text\n", meta([])), /^---\ntype: speculation\nbias: long\n---/);
  });

  test("a bet against the symbol's bias is flagged", () => {
    const short: BetInput = { symbol: "XRP", side: "short", entry: 2.41, stop_loss: 2.44, take_profit: 2.35, ttl_minutes: 30, probability: 0.4 };
    const m = meta([short]);
    const r = validateBets(m);
    assert.equal(r.bets[0]!.vs_bias, "against");
    assert.match(renderBestBets(r, m), /Counter-bias/);
  });

  test("runCheck refuses a report without a bias and writes it into the note otherwise", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-bias-"));
    const day = join(root, "2026-10-03");
    await mkdir(day, { recursive: true });
    const p = join(day, "1400Z.meta.json");
    await writeFile(p, JSON.stringify({ ...meta([xrpLong]), bias: undefined }), "utf8");
    await assert.rejects(() => runCheck(p), /must state its bias/);
    await writeFile(p, JSON.stringify(meta([xrpLong])), "utf8");
    await writeFile(join(day, "1400Z.md"), "# Report\n", "utf8");
    await runCheck(p);
    assert.match(await readFile(join(day, "1400Z.md"), "utf8"), /Bias: LONG \(58%\)/);
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
    assert.match(text, /\| 1 \| XRP \| long \| 2\.390 \| 2\.360 \| 2\.450 \| 14:30Z \| 45 min \| 15:15Z \| 40% \| 36% \| 2\.00 \| \+0\.12R \|/);
    assert.match(text, /\[!tip\] 1\. XRP long/);
    assert.match(text, /### Dropped bets/);
    assert.match(text, /DOGE long: unknown symbol/);

    const none = meta([]);
    assert.match(renderBestBets(validateBets(none), none), /No bet this session/);
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
    assert.match(md, /20261003-1400Z-XRP-1/);
    const saved = JSON.parse(await readFile(metaPath, "utf8")) as ReportMeta;
    assert.equal(saved.validated?.length, 1);

    await runCheck(metaPath); // rerun must not duplicate the log entry
    const log = JSON.parse(await readFile(join(root, "bets-log.json"), "utf8")) as LoggedBet[];
    assert.equal(log.length, 1);
    assert.equal(log[0]!.id, "20261003-1400Z-XRP-1");
  });

  test("a rerun replaces this report's unscored bets, but never one already scored", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-"));
    const day = join(root, "2026-10-03");
    await mkdir(day, { recursive: true });
    const metaPath = join(day, "1400Z.meta.json");
    await writeFile(metaPath, JSON.stringify(meta([xrpLong])), "utf8");
    await runCheck(metaPath);
    await writeFile(metaPath, JSON.stringify(meta([{ ...xrpLong, entry: 2.395, stop_loss: 2.37 }])), "utf8");
    await runCheck(metaPath);
    const log = JSON.parse(await readFile(join(root, "bets-log.json"), "utf8")) as LoggedBet[];
    assert.equal(log.length, 1);
    assert.deepEqual([log[0]!.entry, log[0]!.stop_loss], [2.395, 2.37]);
  });

  test("upsertReportBets keeps other reports and frozen bets", () => {
    const b = validateBets(meta([xrpLong])).bets[0]!;
    const other: LoggedBet = { ...b, id: "other", report: "b.md", generated: "g" };
    const scored: LoggedBet = { ...b, report: "a.md", generated: "g", hypothetical: { status: "tp", netR: 1.9 } };
    const stale: LoggedBet = { ...b, id: "stale", report: "a.md", generated: "g" };
    const out = upsertReportBets([other, scored, stale], [{ ...b, entry: 2.395 }], "a.md", "g2");
    assert.deepEqual(out.map((x) => x.id).sort(), ["20261003-1400Z-XRP-1", "other"]);
    assert.equal(out.find((x) => x.id === b.id)!.entry, 2.39); // frozen: the scored bet wins
  });

  test("rejects a meta file without the required arrays", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-"));
    const p = join(root, "x.meta.json");
    await writeFile(p, "{}", "utf8");
    await assert.rejects(() => runCheck(p), /needs symbols/);
  });
});
