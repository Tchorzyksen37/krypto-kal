// x.test.ts – end-to-end test of the brain tools (always) and the X tools (real API, needs
// X_BEARER_TOKEN). Uses a temporary BRAIN_DIR, so the real brain is never touched.
// Run: npm run test:x  (X reads are paid: the sync is limited to 10 posts per query from the last hour)

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DEFAULT_BRAIN_DIR } from "../../src/brain/brain.ts";
import { call, serverTests, useMcpServer } from "./test-helpers.ts";

const BRAIN_TOOLS = ["x_recent", "brain_list", "brain_read", "brain_search", "brain_write"];
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
