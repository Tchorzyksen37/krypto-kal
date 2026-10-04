// triage.test.ts – offline tests of the ingest triage: scoring, event clusters, noise, stale posts, the ingest state
// and the sync order of accounts. Run: node --test src/brain/triage.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Brain } from "./brain.ts";
import { clusterPosts, markIngested, parsePending, runTriage, scorePosts, termHits, triage, type PendingPost } from "./triage.ts";
import { accountWeight, prioritizeQueries, type XAccountsConfig } from "./x-sync.ts";
import { setLogLevel } from "../core/logger.ts";

setLogLevel("error");

const NOW = Date.parse("2026-10-04T12:00:00Z");
const H = 3_600_000;

const CONFIG: XAccountsConfig = {
  topics: ["iran"],
  accounts: [
    { username: "Reuters", category: "wire", filter: true },
    { username: "IDF", category: "official", filter: false },
    { username: "Faytuks", category: "osint", filter: false },
    { username: "hypeguy", category: "commentary", filter: false },
    { username: "MarketDesk", category: "markets", filter: true, weight: 0.5 },
  ],
};

let n = 1000;
const post = (author: string, text: string, hoursAgo: number, over: Partial<PendingPost> = {}): PendingPost => ({
  path: `raw/x/2026-10-04/${author}-${n++}.md`, author, category: CONFIG.accounts.find((a) => a.username === author)?.category ?? "unknown",
  kind: "post", createdAtMs: NOW - hoursAgo * H, text, hasLink: false, engagement: 10, ...over,
});

describe("scoring", () => {
  test("market-moving terms are found by group, short terms only as whole words", () => {
    const groups = (t: string) => [...new Set(termHits(t).map((h) => h.group))].sort();
    assert.deepEqual(groups("BREAKING: Iran fires missiles at tankers near the Strait of Hormuz"), ["energy", "kinetic", "urgency"]);
    assert.deepEqual(groups("Ceasefire talks resume in Cairo"), ["escalation"]);
    assert.deepEqual(groups("The Fed holds rates; bitcoin jumps"), ["macro"]);
    assert.deepEqual(groups("A soiled federal document"), []); // "oil" and "fed" are not inside other words
  });

  test("an official or wire report of a strike outranks commentary, and a reply ranks below a post", () => {
    const [wire, comment, reply] = scorePosts([
      post("Reuters", "Israel strikes targets in Iran, explosions reported in Isfahan", 1),
      post("hypeguy", "Israel strikes targets in Iran, explosions reported in Isfahan", 1),
      post("Reuters", "Israel strikes targets in Iran, explosions reported in Isfahan", 1, { kind: "reply" }),
    ], CONFIG);
    assert.ok(wire!.score > comment!.score * 2);
    assert.ok(reply!.score < wire!.score);
    assert.match(wire!.reasons.join("; "), /source 3\.00; terms: kinetic/);
  });

  test("an explicit account weight and the wiki's reliability rating both count", () => {
    const [md] = scorePosts([post("MarketDesk", "Brent oil jumps 5%", 1)], CONFIG);
    assert.match(md!.reasons[0]!, /source 0\.50/);
    const [low] = scorePosts([post("Reuters", "Brent oil jumps 5%", 1)], CONFIG, { reuters: 0.6 });
    assert.match(low!.reasons[0]!, /source 1\.80 \(reliability x0\.6\)/);
  });

  test("a post far above its author's usual engagement gets a bonus", () => {
    const posts = [1, 2, 3].map((i) => post("Faytuks", `Update ${i} on the region`, i, { engagement: 10 }));
    const viral = post("Faytuks", "Update 4 on the region", 0.5, { engagement: 500 });
    const scored = scorePosts([...posts, viral], CONFIG);
    assert.ok(scored[3]!.reasons.includes("far above the author's usual engagement"));
  });

  test("promotion and short posts without market-moving terms are noise", () => {
    const [promo, short, link, news] = scorePosts([
      post("hypeguy", "Subscribe to our newsletter for daily Middle East updates and strikes analysis", 1),
      post("hypeguy", "Interesting times.", 1),
      post("hypeguy", "Thread", 1, { hasLink: true }),
      post("hypeguy", "Missile alert", 1),
    ], CONFIG);
    assert.equal(promo!.noise, "promotion");
    assert.match(short!.noise!, /no market-moving term/);
    assert.equal(link!.noise, undefined);
    assert.equal(news!.noise, undefined);
  });

  test("parsePending reads the raw file's frontmatter and engagement", () => {
    const p = parsePending("raw/x/2026-10-04/Reuters-123.md", [
      "---", "source: x", 'author: "@Reuters"', "category: wire", "kind: post", 'created_at: "2026-10-04T10:00:00.000Z"',
      "metrics: { likes: 10, reposts: 5, replies: 2, quotes: 1, views: 9000 }", "---", "", "Iran says talks will resume.", "",
    ].join("\n"));
    assert.deepEqual([p.author, p.category, p.createdAtMs, p.engagement, p.text], ["Reuters", "wire", Date.parse("2026-10-04T10:00:00Z"), 29, "Iran says talks will resume."]);
  });
});

describe("events", () => {
  test("posts about the same event from different accounts form one corroborated cluster", () => {
    const scored = scorePosts([
      post("Reuters", "Iranian missiles hit tanker near Strait of Hormuz, shipping halted", 2),
      post("Faytuks", "Tanker hit by Iranian missiles in the Strait of Hormuz, shipping traffic halted", 1.5),
      post("IDF", "IDF intercepted drones launched from Yemen over Eilat", 1),
    ], CONFIG);
    const clusters = clusterPosts(scored, { windowHours: 6, similarity: 0.3, perCluster: 4 });
    assert.equal(clusters.length, 2);
    const hormuz = clusters.find((c) => c.authors.includes("reuters"))!;
    assert.deepEqual(hormuz.authors.sort(), ["faytuks", "reuters"]);
    assert.equal(hormuz.corroborated, true);
    assert.match(hormuz.label, /hormuz|tanker|missiles/);
  });

  test("the same words a day apart are two events", () => {
    const scored = scorePosts([
      post("Reuters", "Ceasefire talks resume in Cairo between Israel and Hamas", 30),
      post("Reuters", "Ceasefire talks resume in Cairo between Israel and Hamas", 1),
    ], CONFIG);
    assert.equal(clusterPosts(scored, { windowHours: 6, similarity: 0.3, perCluster: 4 }).length, 2);
  });

  test("triage reads the strongest events first within the post budget and defers the rest", () => {
    const pending = [
      ...Array.from({ length: 6 }, (_, i) => post(i % 2 ? "Reuters" : "Faytuks", `Iranian missiles hit tanker near Strait of Hormuz, shipping halted, report ${i}`, 2 - i * 0.1)),
      post("hypeguy", "Markets look interesting today with many charts moving around a lot, let us see where this all goes next", 1),
      post("IDF", "IDF intercepted drones launched from Yemen over Eilat", 1),
      post("hypeguy", "Interesting times.", 1),
    ];
    const r = triage(pending, CONFIG, { done: {} }, {}, { maxPosts: 5, perCluster: 4, nowMs: NOW });
    assert.equal(r.pending, 9);
    assert.equal(r.selected[0]!.read.length, 4);
    assert.equal(r.selected[0]!.alsoInEvent.length, 2, "the rest of the event is cited, not read");
    assert.equal(r.selected.reduce((a, c) => a + c.read.length, 0), 5);
    assert.ok(r.deferred.length >= 1);
    assert.deepEqual(r.noise.map((x) => x.reason), ["short or reply, no market-moving term"]);
    assert.ok(r.accounts.find((a) => a.author === "hypeguy")!.noise === 1);
  });

  test("deferred events older than staleHours are offered for skipping", () => {
    const old = post("hypeguy", "Some long analysis about regional politics and history without market terms whatsoever", 100);
    const r = triage([old, post("Reuters", "Missile strike on oil refinery", 1)], CONFIG, { done: {} }, {}, { maxPosts: 1, nowMs: NOW });
    assert.deepEqual(r.stale, [old.path]);
  });
});

describe("brain state", () => {
  const brainWith = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "brain-triage-"));
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return new Brain(root);
  };
  const raw = (author: string, text: string) =>
    ["---", "source: x", `author: "@${author}"`, "category: wire", "kind: post", 'created_at: "2026-10-04T10:00:00.000Z"', "---", "", text, ""].join("\n");

  test("posts cited in the wiki or recorded in the ingest state are not pending; marking updates the state", async () => {
    const brain = brainWith({
      "x-accounts.json": JSON.stringify(CONFIG),
      "raw/x/2026-10-04/Reuters-1.md": raw("Reuters", "Iran missile strike on tanker in Hormuz"),
      "raw/x/2026-10-04/Reuters-2.md": raw("Reuters", "Oil jumps after strike"),
      "raw/x/2026-10-04/hypeguy-3.md": raw("hypeguy", "Interesting times."),
      "wiki/events/2026-10-04-tanker.md": "---\nsources: [raw/x/2026-10-04/Reuters-1.md]\n---\n",
      "wiki/sources/reuters.md": "---\ntitle: Reuters\nreliability: high\n---\n",
    });
    const first = await runTriage(brain, { nowMs: NOW });
    assert.equal(first.pending, 2);
    assert.match(first.selected[0]!.id, /Reuters-2/);

    const marked = await markIngested(brain, {
      ingested: ["raw/x/2026-10-04/Reuters-2.md"],
      skipped: [{ path: "raw/x/2026-10-04/hypeguy-3.md", reason: "noise" }, { path: "../etc/passwd", reason: "x" }],
    }, NOW);
    assert.deepEqual(marked, { ingested: 1, skipped: 1, rejected: ["../etc/passwd"] });
    const second = await runTriage(brain, { nowMs: NOW });
    assert.equal(second.pending, 0);
    const reuters = second.accounts.find((a) => a.author === "reuters")!;
    assert.equal(reuters.ingestedEver, 1);
  });

  test("a skip never overwrites an ingest", async () => {
    const brain = brainWith({});
    await markIngested(brain, { ingested: ["raw/x/2026-10-04/Reuters-9.md"] }, NOW);
    const r = await markIngested(brain, { skipped: [{ path: "raw/x/2026-10-04/Reuters-9.md", reason: "dup" }] }, NOW);
    assert.equal(r.skipped, 0);
  });

  test("an empty brain has nothing pending", async () => {
    assert.equal((await runTriage(brainWith({}), { nowMs: NOW })).pending, 0);
  });
});

describe("sync order", () => {
  test("account weight: explicit, then category, then default", () => {
    assert.equal(accountWeight({ category: "wire" }), 3);
    assert.equal(accountWeight({ category: "osint" }), 1.5);
    assert.equal(accountWeight({ category: "wire", weight: 0.5 }), 0.5);
    assert.equal(accountWeight({ category: "whatever" }), 1);
    assert.equal(accountWeight({ category: "wire", weight: 9 }), 3);
  });

  test("queries run with the most important accounts first, and the query strings are unchanged", () => {
    const queries = ["(from:hypeguy) -is:retweet", "(from:Faytuks OR from:IDF) -is:retweet", "(from:MarketDesk) (iran) -is:retweet"];
    const ordered = prioritizeQueries(queries, CONFIG);
    assert.equal(ordered[0], queries[1]); // contains IDF (official, 3)
    assert.equal(ordered[2], queries[2]); // MarketDesk weight 0.5 is the least important
    assert.deepEqual([...ordered].sort(), [...queries].sort());
  });
});
