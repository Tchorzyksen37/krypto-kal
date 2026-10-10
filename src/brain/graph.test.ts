import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { Brain } from "./brain.ts";
import { type WikiGraph, buildWikiGraph, findPage, related, renderOverview, renderRelated } from "./graph.ts";

const page = (title: string, type: string, updated: string, sources: string[], body: string) =>
  `---\ntitle: ${title}\ntype: ${type}\nupdated: ${updated}\nsources: [${sources.join(", ")}]\n---\n\n${body}\n`;

const VAULT: Record<string, string> = {
  "wiki/index.md": "# Index\n[[iran]] [[strait-of-hormuz]] [[2026-10-01-tanker-seized]] [[oil]] [[houthis]] [[lonely]]",
  "wiki/timeline.md": "- 2026-10-01 07:00 UTC – tanker seized → [[2026-10-01-tanker-seized]]",
  "wiki/log.md": "## 2026-10-01 – ingest",
  "wiki/actors/iran.md": page("Iran", "actor", "2026-10-02", [], "## Facts\n- seized a tanker\n\n## Related\n[[2026-10-01-tanker-seized]] · [[strait-of-hormuz]] · [[timeline]]"),
  "wiki/places/strait-of-hormuz.md": page("Strait of Hormuz", "place", "2026-10-01", [], "## Related\n[[iran]]"),
  "wiki/events/2026-10-01-tanker-seized.md": page(
    "Tanker seized near Hormuz (2026-10-01)", "event", "2026-10-01",
    ["raw/x/2026-10-01/Reuters-111.md", "raw/x/2026-10-01/IDF-222.md"],
    "## Facts\n- 07:00 UTC: seized ([Reuters](../../raw/x/2026-10-01/Reuters-111.md)) – confidence: reported\n\n## Related\n[[Iran|the Iranian navy]] · [[strait-of-hormuz#facts]] · [[oil]] · [[missing-page]]",
  ),
  "wiki/markets/oil.md": page("Oil", "market", "2026-09-30", [], "Brent reacts to Gulf shipping risk."),
  "wiki/actors/houthis.md": page("Houthis", "actor", "2026-09-29", ["raw/x/2026-10-01/Reuters-111.md"], "Cites the same Reuters post, no links."),
  "wiki/themes/lonely.md": page("Lonely theme", "theme", "2026-09-01", [], "Nobody links here."),
  "wiki/sources/iran.md": page("Duplicate slug", "source", "2026-09-01", [], "Same slug as the actor page."),
  "raw/x/2026-10-01/Reuters-111.md": "---\nauthor: Reuters\n---\nraw post",
};

let dir = "";
let graph: WikiGraph;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "wiki-graph-"));
  for (const [path, text] of Object.entries(VAULT)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  graph = await buildWikiGraph(new Brain(dir));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("nodes are the pages in wiki subfolders; root lists are neither nodes nor missing pages", () => {
  assert.deepEqual([...graph.nodes.keys()].sort(), ["2026-10-01-tanker-seized", "houthis", "iran", "lonely", "oil", "strait-of-hormuz"]);
  assert.deepEqual(graph.nodes.get("iran")!.unresolved, []); // [[timeline]] is a root list
  assert.deepEqual(graph.duplicates, ["iran"]);
  assert.equal(graph.nodes.get("iran")!.path, "wiki/actors/iran.md"); // the first path in sort order wins
});

test("links resolve aliases, headings and case, and are known in both directions", () => {
  const event = graph.nodes.get("2026-10-01-tanker-seized")!;
  assert.deepEqual([...event.out].sort(), ["iran", "oil", "strait-of-hormuz"]);
  assert.deepEqual(event.unresolved, ["missing-page"]);
  assert.deepEqual([...graph.nodes.get("oil")!.in], ["2026-10-01-tanker-seized"]);
  assert.equal(event.title, "Tanker seized near Hormuz (2026-10-01)");
});

test("sources are matched by raw file name, whether cited in the frontmatter or as a relative link", () => {
  assert.deepEqual([...graph.nodes.get("2026-10-01-tanker-seized")!.sources].sort(), ["IDF-222.md", "Reuters-111.md"]);
  assert.deepEqual([...graph.bySource.get("Reuters-111.md")!].sort(), ["2026-10-01-tanker-seized", "houthis"]);
});

test("golden: direct neighbours of an event, strongest first", () => {
  const event = graph.nodes.get("2026-10-01-tanker-seized")!;
  assert.equal(renderRelated(graph, event), [
    "wiki graph around [[2026-10-01-tanker-seized]] event, updated 2026-10-01 – Tanker seized near Hormuz (2026-10-01) (wiki/events/2026-10-01-tanker-seized.md)",
    "page: links to 3, linked from 1, cites 2 raw sources; unresolved links: [[missing-page]]",
    "4 related pages within 1 step (nearest and strongest first; read them with brain_read):",
    "direct:",
    "- [[iran]] actor, updated 2026-10-02 – Iran (wiki/actors/iran.md): linked both ways",
    "- [[strait-of-hormuz]] place, updated 2026-10-01 – Strait of Hormuz (wiki/places/strait-of-hormuz.md): linked from it",
    "- [[oil]] market, updated 2026-09-30 – Oil (wiki/markets/oil.md): linked from it",
    "- [[houthis]] actor, updated 2026-09-29 – Houthis (wiki/actors/houthis.md): 1 shared source",
  ].join("\n"));
});

test("depth 2 reaches pages through a neighbour and names the path", () => {
  const { relations } = related(graph, graph.nodes.get("oil")!, { depth: 2 });
  assert.deepEqual(relations.map((r) => [r.node.slug, r.distance, r.via ?? ""]), [
    ["2026-10-01-tanker-seized", 1, ""],
    ["iran", 2, "2026-10-01-tanker-seized"],
    ["strait-of-hormuz", 2, "2026-10-01-tanker-seized"],
    ["houthis", 2, "2026-10-01-tanker-seized"],
  ]);
  assert.match(renderRelated(graph, graph.nodes.get("oil")!, { depth: 2 }), /\n2 steps away:\n- \[\[iran\]\] .*: linked both ways with \[\[2026-10-01-tanker-seized\]\]\n- \[\[strait-of-hormuz\]\] .*: linked from \[\[2026-10-01-tanker-seized\]\]\n/);
});

test("filters: type, limit, and shared sources off", () => {
  const event = graph.nodes.get("2026-10-01-tanker-seized")!;
  assert.deepEqual(related(graph, event, { type: "actor" }).relations.map((r) => r.node.slug), ["iran", "houthis"]);
  const limited = related(graph, event, { limit: 2 });
  assert.equal(limited.relations.length, 2);
  assert.equal(limited.total, 4);
  assert.match(renderRelated(graph, event, { limit: 2 }), /4 related pages within 1 step, the 2 strongest shown/);
  assert.ok(!related(graph, event, { sharedSources: false }).relations.some((r) => r.node.slug === "houthis"));
});

test("an isolated page says so", () => {
  assert.match(renderRelated(graph, graph.nodes.get("lonely")!), /\n- none: the page has no links, backlinks or shared sources yet$/);
});

test("findPage by slug, path, title, and close candidates otherwise", () => {
  assert.equal(findPage(graph, "IRAN").node?.slug, "iran");
  assert.equal(findPage(graph, "wiki/places/strait-of-hormuz.md").node?.slug, "strait-of-hormuz");
  assert.equal(findPage(graph, "Strait of Hormuz").node?.slug, "strait-of-hormuz");
  const miss = findPage(graph, "hormuz tanker");
  assert.equal(miss.node, undefined);
  assert.deepEqual(miss.candidates.map((n) => n.slug), ["2026-10-01-tanker-seized", "strait-of-hormuz"]);
});

test("golden: overview with hubs, recent pages and what to fix", () => {
  assert.equal(renderOverview(graph, 2), [
    "wiki graph: 6 pages, 6 links, 2 raw sources cited",
    "pages per type: actor 2, event 1, market 1, place 1, theme 1",
    "",
    "hubs (most connected pages per type, connections = distinct pages linked to or from):",
    "- actor: [[iran]] (2), [[houthis]] (0)",
    "- event: [[2026-10-01-tanker-seized]] (3)",
    "- market: [[oil]] (1)",
    "- place: [[strait-of-hormuz]] (2)",
    "- theme: [[lonely]] (0)",
    "",
    "recently updated:",
    "- 2026-10-02 [[iran]] actor, updated 2026-10-02 – Iran (wiki/actors/iran.md)",
    "- 2026-10-01 [[2026-10-01-tanker-seized]] event, updated 2026-10-01 – Tanker seized near Hormuz (2026-10-01) (wiki/events/2026-10-01-tanker-seized.md)",
    "- 2026-10-01 [[strait-of-hormuz]] place, updated 2026-10-01 – Strait of Hormuz (wiki/places/strait-of-hormuz.md)",
    "- 2026-09-30 [[oil]] market, updated 2026-09-30 – Oil (wiki/markets/oil.md)",
    "- 2026-09-29 [[houthis]] actor, updated 2026-09-29 – Houthis (wiki/actors/houthis.md)",
    "- 2026-09-01 [[lonely]] theme, updated 2026-09-01 – Lonely theme (wiki/themes/lonely.md)",
    "",
    "to fix:",
    "- orphans (no links in or out): [[houthis]], [[lonely]]",
    "- links to missing pages: [[missing-page]] (1)",
    "- slugs used by more than one file: [[iran]]",
  ].join("\n"));
});

test("an empty or missing wiki gives an empty graph", async () => {
  const empty = await mkdtemp(join(tmpdir(), "wiki-graph-empty-"));
  try {
    const g = await buildWikiGraph(new Brain(empty));
    assert.equal(g.nodes.size, 0);
    assert.equal(renderOverview(g), "wiki graph: no pages under wiki/<folder>/ yet");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
