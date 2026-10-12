import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HistoryStore, type Range } from "./history-store.ts";
import { createLogger } from "./logger.ts";
import { RunStats, countPoints, percentile, readStatsLog, renderSnapshot, runStats, statsLogPathFromEnv } from "./run-stats.ts";
import { cachedSeries } from "./series-cache.ts";

const T0 = Date.parse("2026-10-06T12:00:00Z");

test("recordTool measures characters, a token estimate, series points and errors", () => {
  const stats = new RunStats({ now: () => T0 });
  const data = [{ symbol: "BTC", history: [{ t: 1, c: 2 }, { t: 2, c: 3 }] }, { fills: [{ ts: 5, price: 1 }] }];
  const text = JSON.stringify(data);
  const e = stats.recordTool({ tool: "x_tool", ok: true, ms: 12.4, text, data, args: { symbols: ["BTC"] } });
  assert.equal(e.chars, text.length);
  assert.equal(e.estTokens, Math.round(text.length / 3));
  assert.equal(e.points, 3);
  assert.equal(e.ms, 12);
  assert.equal(e.args, '{"symbols":["BTC"]}');
  assert.equal(e.at, "2026-10-06T12:00:00.000Z");

  stats.recordTool({ tool: "x_tool", ok: false, ms: 40, text: "http 500: boom", error: "http 500: boom" });
  const s = stats.snapshot();
  assert.equal(s.tools.length, 1);
  assert.deepEqual(
    { calls: s.tools[0]!.calls, errors: s.tools[0]!.errors, msMax: s.tools[0]!.msMax, pointsMax: s.tools[0]!.pointsMax },
    { calls: 2, errors: 1, msMax: 40, pointsMax: 3 },
  );
  assert.equal(s.totals.chars, text.length + "http 500: boom".length);
});

test("long arguments are truncated", () => {
  const stats = new RunStats();
  const e = stats.recordTool({ tool: "t", ok: true, ms: 1, text: "", args: { s: "x".repeat(1000) } });
  assert.equal(e.args.length, 300);
  assert.ok(e.args.endsWith("…"));
});

test("snapshot orders tools by total output, and percentiles use nearest rank", () => {
  const stats = new RunStats();
  for (const ms of [10, 20, 30, 40, 100]) stats.recordTool({ tool: "small", ok: true, ms, text: "ab" });
  stats.recordTool({ tool: "big", ok: true, ms: 5, text: "x".repeat(50) });
  const s = stats.snapshot();
  assert.deepEqual(s.tools.map((t) => t.tool), ["big", "small"]);
  const small = s.tools[1]!;
  assert.equal(small.msP50, 30);
  assert.equal(small.msP95, 100);
  assert.equal(percentile([], 0.5), 0);
});

test("countPoints finds nested series and ignores plain arrays", () => {
  assert.equal(countPoints({ a: [1, 2, 3], b: { c: [{ t: 1 }, { t: 2 }, { x: 1 }] } }), 2);
  assert.equal(countPoints("text"), 0);
  assert.equal(countPoints(null), 0);
});

test("cache events from cachedSeries are attributed to the tool call that caused them", async () => {
  const stats = runStats;
  stats.reset();
  const store = new HistoryStore(":memory:");
  const H = 3600;
  const fetches: Range[] = [];
  const fetch = async (symbols: string[], range: Range) => {
    fetches.push(range);
    const out = new Map<string, { t: number; c: number }[]>();
    for (const s of symbols) {
      const pts = [];
      for (let t = Math.ceil(range.from / H) * H; t <= range.to; t += H) pts.push({ t, c: t / H });
      out.set(s, pts);
    }
    return out;
  };
  const request = { store, log: createLogger("test"), kind: "k", interval: "1hour", symbols: ["A"], range: { from: 0, to: 10 * H }, closedUntil: 8 * H - 1, tailTo: 10 * H, alignSeconds: H, fetch };

  // First call: the whole closed range is fetched together with the open tail, in one request.
  await stats.inTool("first_tool", () => cachedSeries(request));
  // Second call: closed points come from the store, only the tail is fetched.
  await stats.inTool("second_tool", () => cachedSeries(request));
  // Outside a tool call (e.g. the collector): no tool attribution.
  await cachedSeries(request);

  const s = stats.snapshot();
  assert.equal(s.cache.length, 1);
  const c = s.cache[0]!;
  assert.equal(c.calls, 3);
  assert.equal(c.served, 3 * 11); // t = 0..10h, 8 closed + 3 tail per call
  assert.equal(c.fetched, 8);
  assert.equal(c.fromStore, 2 * 8);
  assert.equal(c.tail, 3 * 3);
  assert.equal(c.requests, 3);
  assert.equal(fetches.length, 3);
  assert.equal(s.totals.apiRequests, 3);
  stats.reset();
  store.close();
});

test("events are appended to the log in order and a replay gives the same figures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-stats-"));
  try {
    const path = join(dir, "nested", "stats.jsonl");
    let now = T0;
    const stats = new RunStats({ logPath: path, now: () => now });
    for (let i = 0; i < 5; i++) {
      now += 1000;
      stats.recordTool({ tool: i % 2 ? "a" : "b", ok: i !== 3, ms: 10 * i, text: "x".repeat(i * 10), data: [{ t: i }] });
    }
    stats.recordCache({ kind: "k", interval: "1h", symbols: 1, served: 10, fromStore: 7, fetched: 0, tail: 3, requests: 1 });
    await stats.flush();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 6);
    assert.deepEqual(lines.slice(0, 5).map((l) => (JSON.parse(l) as { ms: number }).ms), [0, 10, 20, 30, 40]);

    const replay = await readStatsLog(path);
    assert.equal(replay.events, 6);
    assert.equal(replay.skipped, 0);
    const a = stats.snapshot();
    const b = replay.stats.snapshot();
    assert.deepEqual(b.tools, a.tools);
    assert.deepEqual(b.cache, a.cache);
    assert.equal(b.cache[0]!.storeShare, 0.7);

    const since = await readStatsLog(path, T0 + 3500);
    assert.equal(since.events, 3); // tool events at +4s and +5s, the cache event at +5s

    assert.match(renderSnapshot(b), /^stats 2026-10-06T12:00:01\.000Z \.\. 2026-10-06T12:00:05\.000Z/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing log never fails the recording", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-stats-"));
  try {
    const file = join(dir, "a-file");
    await writeFile(file, "");
    const stats = new RunStats({ logPath: join(file, "stats.jsonl") }); // a directory that is a file: ENOTDIR
    stats.recordTool({ tool: "t", ok: true, ms: 1, text: "x" });
    stats.recordTool({ tool: "t", ok: true, ms: 1, text: "y" });
    await stats.flush();
    assert.equal(stats.snapshot().totals.calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the log path comes from the environment and can be turned off", () => {
  assert.equal(statsLogPathFromEnv({ STATS_LOG: "false" }), undefined);
  assert.equal(statsLogPathFromEnv({ STATS_LOG_PATH: "/tmp/s.jsonl" }), "/tmp/s.jsonl");
  assert.match(statsLogPathFromEnv({}) ?? "", /tool-stats\.jsonl$/);
});
