// x-sync.test.ts – offline tests of XClient, the X → brain/raw sync and Brain file access
// (fake X API, temporary brain directory, no network).
// Run: npm run test:offline

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { Brain } from "./brain.ts";
import { setLogLevel } from "./logger.ts";
import { XClient, XError, type XPost, type XUser } from "./x-client.ts";
import { buildQueries, recentRawPosts, snowflakeTime, syncX, type XAccountsConfig } from "./x-sync.ts";

setLogLevel("error");

// A post id whose embedded timestamp is `msAgo` in the past (X ids are snowflakes).
const idAgo = (msAgo: number, seq = 0) => String(((BigInt(Date.now() - msAgo) - 1288834974657n) << 22n) + BigInt(seq));

const USERS: XUser[] = [
  { id: "1", username: "Reuters", name: "Reuters", verified: true, verified_type: "business" },
  { id: "2", username: "Faytuks", name: "Faytuks News", verified: true, verified_type: "blue" },
  { id: "3", username: "randomguy", name: "Random", verified: false },
];

interface FakeApi {
  calls: URL[];
  posts: XPost[]; // all posts the fake search can return
  status?: number;
  resetIn?: number; // seconds until x-rate-limit-reset on 429
}

let api: FakeApi;

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  api.calls.push(url);
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers }));
  if (api.status === 429) {
    return json({ title: "Too Many Requests", detail: "Too Many Requests" }, 429, {
      "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + (api.resetIn ?? 900)),
    });
  }
  if (url.pathname === "/2/users/by") {
    const names = url.searchParams.get("usernames")!.split(",");
    return json({ data: USERS.filter((u) => names.includes(u.username)) });
  }
  const q = url.searchParams;
  const sinceId = q.get("since_id");
  const max = Number(q.get("max_results"));
  const offset = Number(q.get("next_token") ?? 0);
  const from = [...q.get("query")!.matchAll(/from:(\w+)/g)].map((m) => USERS.find((u) => u.username === m[1])?.id);
  const matching = api.posts
    .filter((p) => (from.length === 0 || from.includes(p.author_id)) && (!sinceId || BigInt(p.id) > BigInt(sinceId)))
    .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  assert.equal(q.get("expansions"), null, "expansions are billed, so the search must not request them");
  const page = matching.slice(offset, offset + max);
  return json({
    data: page.length ? page : undefined,
    meta: {
      result_count: page.length,
      newest_id: page[0]?.id,
      next_token: offset + max < matching.length ? String(offset + max) : undefined,
    },
  });
}

const post = (id: string, author: string, text: string, extra: Partial<XPost> = {}): XPost => ({
  id, text, author_id: USERS.find((u) => u.username === author)!.id,
  created_at: new Date(snowflakeTime(id)).toISOString(), ...extra,
});

const CONFIG: XAccountsConfig = {
  topics: ["Iran", "Red Sea"],
  accounts: [
    { username: "Reuters", category: "wire", filter: true },
    { username: "Faytuks", category: "osint", filter: false },
    { username: "randomguy", category: "osint", filter: false },
  ],
};

describe("X sync", () => {
  let dir: string;
  let brain: Brain;
  const client = () => new XClient({ bearerToken: "test-token", minIntervalMs: 0, maxRetries: 1 });

  beforeEach(() => {
    api = { calls: [], posts: [] };
    mock.method(globalThis, "fetch", fakeFetch);
    dir = mkdtempSync(join(tmpdir(), "brain-test-"));
    writeFileSync(join(dir, "x-accounts.json"), JSON.stringify(CONFIG));
    brain = new Brain(dir);
  });

  afterEach(() => {
    mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  });

  test("buildQueries separates filtered accounts and respects the length limit", () => {
    assert.deepEqual(buildQueries(CONFIG), [
      "(from:Faytuks OR from:randomguy) -is:retweet",
      '(from:Reuters) (Iran OR "Red Sea") -is:retweet',
    ]);
    const many: XAccountsConfig = {
      topics: CONFIG.topics,
      accounts: Array.from({ length: 60 }, (_, i) => ({ username: `account_number_${i}`, category: "x", filter: i % 2 === 0 })),
    };
    const queries = buildQueries(many, 200);
    assert.ok(queries.length > 2);
    for (const q of queries) assert.ok(q.length <= 200, `${q.length} chars`);
    assert.equal(queries.join(" ").match(/from:/g)!.length, 60);
  });

  test("saves verified posts once, skips unverified authors, then fetches only new posts", async () => {
    const a = idAgo(3_600_000, 1);
    const b = idAgo(1_800_000, 2);
    api.posts = [
      post(a, "Reuters", "Iran says ...", { lang: "en", public_metrics: { like_count: 5, retweet_count: 1, reply_count: 0, quote_count: 0 } }),
      post(b, "Faytuks", "short", { note_tweet: { text: "Full long text about the Red Sea" }, referenced_tweets: [{ type: "quoted", id: a }] }),
      post(idAgo(1_000_000, 3), "randomguy", "spam"),
    ];

    const first = await syncX(client(), brain, { backfillHours: 24 });
    assert.equal(first.queries, 2);
    // 3 profiles ($0.01 each) + 3 posts ($0.005 each)
    assert.equal(first.costUsd, 0.045);
    assert.equal(api.calls.filter((u) => u.pathname === "/2/users/by").length, 1);
    assert.deepEqual(first.skippedUnverified, ["randomguy"]);
    assert.equal(first.saved.length, 2);
    const firstSearch = api.calls.find((u) => u.pathname === "/2/tweets/search/recent")!;
    assert.ok(firstSearch.searchParams.get("start_time"), "first run uses start_time");
    assert.equal(firstSearch.searchParams.get("since_id"), null);

    const day = new Date(snowflakeTime(b)).toISOString().slice(0, 10);
    const md = readFileSync(join(dir, "raw", "x", day, `Faytuks-${b}.md`), "utf8");
    assert.match(md, /url: https:\/\/x\.com\/Faytuks\/status\//);
    assert.match(md, /verified_type: "blue"/);
    assert.match(md, /kind: quote/);
    assert.match(md, /Full long text about the Red Sea/, "long posts use note_tweet");
    assert.match(md, new RegExp(`quotes: https://x\.com/i/status/${a}`));

    // Second run: since_id cursors and cached profiles, nothing new → nothing saved, nothing spent.
    api.calls = [];
    const second = await syncX(client(), brain);
    assert.equal(second.saved.length, 0);
    assert.equal(second.costUsd, 0);
    assert.equal(api.calls.filter((u) => u.pathname === "/2/users/by").length, 0, "profiles come from the cache");
    for (const u of api.calls) assert.ok(u.searchParams.get("since_id"), "later runs use since_id");

    // A new post arrives.
    const c = idAgo(10_000, 4);
    api.posts.push(post(c, "Reuters", "Iran update"));
    const third = await syncX(client(), brain);
    assert.equal(third.saved.length, 1);
    assert.ok(third.saved[0]!.endsWith(`Reuters-${c}.md`));

    const recent = await recentRawPosts(brain, { since: new Date(Date.now() - 86_400_000), limit: 10 });
    assert.deepEqual(recent.map((r) => r.author), ["@Reuters", "@Faytuks", "@Reuters"]);
    assert.equal(recent[0]!.text, "Iran update");
    const filtered = await recentRawPosts(brain, { since: new Date(0), author: "faytuks", contains: "red sea", limit: 10 });
    assert.equal(filtered.length, 1);
  });

  test("paginates up to maxPostsPerQuery and reports the cap", async () => {
    api.posts = Array.from({ length: 25 }, (_, i) => post(idAgo(100_000, i), "Faytuks", `post ${i}`));
    const res = await syncX(client(), brain, { maxPostsPerQuery: 20 });
    assert.equal(res.saved.length, 20);
    assert.deepEqual(res.capped, ["(from:Faytuks OR from:randomguy) -is:retweet"]);
  });

  test("disabled accounts are not queried", async () => {
    writeFileSync(join(dir, "x-accounts.json"), JSON.stringify({
      ...CONFIG,
      accounts: CONFIG.accounts.map((a) => (a.username === "randomguy" ? { ...a, enabled: false } : a)),
    }));
    await syncX(client(), brain);
    const queries = api.calls.filter((u) => u.pathname === "/2/tweets/search/recent").map((u) => u.searchParams.get("query"));
    assert.ok(queries.every((q) => !q!.includes("randomguy")));
    assert.ok(!api.calls.find((u) => u.pathname === "/2/users/by")!.searchParams.get("usernames")!.includes("randomguy"));
  });

  test("the daily budget limits page size and stops the run", async () => {
    api.posts = Array.from({ length: 50 }, (_, i) => post(idAgo(100_000, i), "Faytuks", `post ${i}`));
    // $0.03 for 3 profiles leaves $0.10 = 20 posts.
    const res = await syncX(client(), brain, { budget: { dailyUsd: 0.13 } });
    assert.equal(res.fetched, 20);
    assert.equal(res.budgetExhausted, true);
    assert.deepEqual(res.spend, { todayUsd: 0.13, totalUsd: 0.13, leftUsd: 0 });
    const searches = api.calls.filter((u) => u.pathname === "/2/tweets/search/recent");
    assert.equal(searches[0]!.searchParams.get("max_results"), "20");

    // Nothing left: no further API calls today.
    api.calls = [];
    const again = await syncX(client(), brain, { budget: { dailyUsd: 0.13 } });
    assert.equal(again.budgetExhausted, true);
    assert.equal(api.calls.length, 0);
  });

  test("the total budget counts all days", async () => {
    writeFileSync(join(dir, ".x-spend.json"), JSON.stringify({ days: { "2026-01-01": 9.99 } }));
    const res = await syncX(client(), brain, { budget: { dailyUsd: 1, totalUsd: 10 } });
    assert.equal(res.budgetExhausted, true);
    assert.equal(api.calls.length, 0, "$0.01 cannot cover 3 profile lookups");
  });

  test("a stale since_id (older than 7 days) falls back to start_time", async () => {
    const query = "(from:Faytuks OR from:randomguy) -is:retweet";
    writeFileSync(join(dir, ".x-sync.json"), JSON.stringify({ queries: { [query]: { newestId: idAgo(8 * 86_400_000), syncedAt: "" } } }));
    await syncX(client(), brain);
    const call = api.calls.find((u) => u.searchParams.get("query") === query)!;
    assert.equal(call.searchParams.get("since_id"), null);
    assert.ok(call.searchParams.get("start_time"));
  });

  test("a long rate-limit window fails fast with the reset time", async () => {
    api.status = 429;
    await assert.rejects(client().searchRecent({ query: "x" }), (e: XError) => {
      assert.equal(e.status, 429);
      assert.match(e.message, /Rate limited until/);
      return true;
    });
    assert.equal(api.calls.length, 1, "not retried");
  });
});

describe("Brain", () => {
  let dir: string;
  let brain: Brain;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-test-"));
    brain = new Brain(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes only .md files in wiki/ and output/", async () => {
    assert.deepEqual(await brain.write("wiki/places/hormuz.md", "# Hormuz"), { path: "wiki/places/hormuz.md", created: true });
    assert.equal((await brain.write("wiki/places/hormuz.md", "# Strait of Hormuz")).created, false);
    assert.equal(await brain.read("wiki/places/hormuz.md"), "# Strait of Hormuz");
    await brain.write("output/brief.md", "x");
    await assert.rejects(brain.write("raw/x/fake.md", "x"), /writable/);
    await assert.rejects(brain.write("CLAUDE.md", "x"), /writable/);
    await assert.rejects(brain.write("wiki/a.js", "x"), /\.md/);
    await assert.rejects(brain.write("wiki/../../escape.md", "x"), /outside/);
    await assert.rejects(brain.read("../secret"), /outside/);
  });

  test("raw files are never overwritten", async () => {
    assert.equal(await brain.writeRawOnce("x/d/a.md", "one"), true);
    assert.equal(await brain.writeRawOnce("x/d/a.md", "two"), false);
    assert.equal(await brain.read("raw/x/d/a.md"), "one");
  });

  test("search matches all terms on a line and lists recursively", async () => {
    await brain.write("wiki/a.md", "Iran closed the Strait of Hormuz\nunrelated line");
    await brain.write("wiki/sub/b.md", "Hormuz traffic normal");
    assert.deepEqual(await brain.search("hormuz IRAN"), [{ path: "wiki/a.md", line: 1, text: "Iran closed the Strait of Hormuz" }]);
    assert.equal((await brain.search("hormuz")).length, 2);
    assert.deepEqual((await brain.list("wiki", true)).map((e) => e.path), ["wiki/a.md", "wiki/sub", "wiki/sub/b.md"]);
  });
});
