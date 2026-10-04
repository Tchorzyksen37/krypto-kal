// x.test.ts – end-to-end test of the brain tools (always) and the X tools (real API, needs
// X_BEARER_TOKEN). Uses a temporary BRAIN_DIR, so the real brain is never touched.
// Run: npm run test:x  (X reads are paid: the sync is limited to 10 posts per query from the last hour)

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DEFAULT_BRAIN_DIR } from "../../src/brain/brain.ts";
import { call, serverTests, useMcpServer } from "./test-helpers.ts";

const BRAIN_TOOLS = ["x_recent", "brain_list", "brain_read", "brain_search", "brain_write", "brain_triage", "brain_ingest_mark"];
const X_TOOLS = ["x_sync", "x_accounts"];

const dir = mkdtempSync(join(tmpdir(), "brain-e2e-"));
copyFileSync(join(process.env.BRAIN_DIR ?? DEFAULT_BRAIN_DIR, "x-accounts.json"), join(dir, "x-accounts.json"));
after(() => rmSync(dir, { recursive: true, force: true }));

const env = { CACHE_DB_PATH: ":memory:", BRAIN_DIR: dir, X_BACKFILL_HOURS: "1", X_MAX_POSTS_PER_QUERY: "10" };

describe("Second brain", () => {
  const ctx = useMcpServer(env);

  describe("MCP server", () => serverTests(ctx, BRAIN_TOOLS));

  test("brain_write, brain_read, brain_search and brain_list work together", async () => {
    await call(ctx, "brain_write", { path: "wiki/places/strait-of-hormuz.md", content: "# Strait of Hormuz\nIran threatens closure" });
    assert.equal(await call(ctx, "brain_read", { path: "wiki/places/strait-of-hormuz.md" }), "# Strait of Hormuz\nIran threatens closure");
    const hits = (await call(ctx, "brain_search", { query: "iran closure" })) as { path: string }[];
    assert.deepEqual(hits.map((h) => h.path), ["wiki/places/strait-of-hormuz.md"]);
    const files = (await call(ctx, "brain_list", { dir: "wiki", recursive: true })) as { path: string }[];
    assert.ok(files.some((f) => f.path === "wiki/places/strait-of-hormuz.md"));
  });

  test("speculation_score scores the speculation folder of the brain and writes the scorecard", { skip: process.env.KRAKEN_FUTURES_ENABLED === "false" && "KRAKEN_FUTURES_ENABLED=false" }, async () => {
    const data = (await call(ctx, "speculation_score", { day: "2026-10-04" })) as {
      edge: string; stats: { bets: number }; changed: { betsResolved: string[] }; files: string[];
    };
    assert.equal(data.stats.bets, 0);
    assert.match(data.edge, /No touched bets/);
    assert.deepEqual(data.changed.betsResolved, []);
    assert.ok(existsSync(join(dir, "output", "speculation", "_scorecard.md")));
    assert.ok(existsSync(join(dir, "output", "speculation", "2026-10-04", "_day.md")));
  });

  test("brain_triage ranks pending raw posts and brain_ingest_mark takes them off the list", async () => {
    const day = join(dir, "raw", "x", "2026-10-04");
    mkdirSync(day, { recursive: true });
    const raw = (author: string, text: string) =>
      ["---", "source: x", `author: "@${author}"`, "category: wire", "kind: post", 'created_at: "2026-10-04T10:00:00.000Z"', "---", "", text, ""].join("\n");
    writeFileSync(join(day, "Reuters-111.md"), raw("Reuters", "Iranian missiles hit a tanker near the Strait of Hormuz"));
    writeFileSync(join(day, "Reuters-112.md"), raw("Reuters", "Thanks for reading."));
    const t = (await call(ctx, "brain_triage", { max_posts: 10 })) as { pending: number; selected: { read: string[] }[]; noise: { path: string }[] };
    assert.equal(t.pending, 2);
    assert.deepEqual(t.selected[0]!.read, ["raw/x/2026-10-04/Reuters-111.md"]);
    assert.deepEqual(t.noise.map((x) => x.path), ["raw/x/2026-10-04/Reuters-112.md"]);
    await call(ctx, "brain_ingest_mark", { ingested: ["raw/x/2026-10-04/Reuters-111.md"], skipped: [{ path: "raw/x/2026-10-04/Reuters-112.md", reason: "noise" }] });
    assert.equal(((await call(ctx, "brain_triage", {})) as { pending: number }).pending, 0);
  });

  test("raw/ cannot be written", async () => {
    const res = await ctx.client.callTool({ name: "brain_write", arguments: { path: "raw/x/fake.md", content: "x" } });
    assert.equal(res.isError, true);
  });
});

describe("X", { skip: !process.env.X_BEARER_TOKEN && "X_BEARER_TOKEN not set" }, () => {
  const ctx = useMcpServer(env);

  describe("MCP server", () => serverTests(ctx, X_TOOLS));

  test("x_accounts finds the configured accounts on X", async () => {
    const data = (await call(ctx, "x_accounts")) as { accounts: { username: string; found: boolean; verified_type?: string }[] };
    assert.ok(data.accounts.length > 0);
    const missing = data.accounts.filter((a) => !a.found).map((a) => a.username);
    assert.deepEqual(missing, [], `accounts not found on X: ${missing.join(",")}`);
  });

  test("x_sync saves posts that x_recent then returns", async () => {
    const res = (await call(ctx, "x_sync")) as { queries: number; saved: string[] };
    assert.ok(res.queries > 0);
    const recent = (await call(ctx, "x_recent", { hours: 2 })) as { path: string; url: string }[];
    assert.equal(recent.length, res.saved.length);
    for (const p of recent) assert.match(p.url, /^https:\/\/x\.com\/\w+\/status\/\d+$/);
  });
});
