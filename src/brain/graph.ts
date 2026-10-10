// graph.ts – the wiki as a graph, so related knowledge is found in one call instead of page-by-page reading:
//   nodes  = pages under wiki/<folder>/ (events, actors, people, places, themes, markets, sources, ...);
//   edges  = [[links]] (both directions: a page also knows who links to it) and shared raw sources (two pages citing
//            the same X post). The lists at the wiki root (index.md, timeline.md, log.md) link to everything, so they
//            are not nodes: walking through them would make every page related to every other.
// Deterministic: built from the files as they are, ranked by fixed rules (distance, then strength, then date, then
// slug). Read-only: nothing here writes to the vault.

import { type Brain } from "./brain.ts";
import { parseFrontmatter } from "./x-sync.ts";

export interface WikiNode {
  slug: string; // file name without .md, the [[link]] target
  path: string; // wiki/<folder>/<slug>.md
  title: string;
  type: string; // frontmatter type, else the folder name
  updated: string; // frontmatter updated (YYYY-MM-DD) or ""
  out: Set<string>; // slugs this page links to (existing pages only)
  in: Set<string>; // slugs linking here
  unresolved: string[]; // link targets with no page, sorted
  sources: Set<string>; // raw post file names cited (e.g. Reuters-123.md)
}

export interface WikiGraph {
  nodes: Map<string, WikiNode>;
  bySource: Map<string, Set<string>>; // raw post file name -> slugs citing it
  duplicates: string[]; // slugs defined by more than one file (the first path in sort order wins)
}

const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g; // [[slug]], [[folder/slug]], [[slug#heading|alias]]
const RAW_FILE = /raw\/[^\s,\])"'`]*?([A-Za-z0-9_]+-\d+\.md)/g; // cited raw post, by file name

const slugOf = (target: string) => target.trim().replace(/\.md$/i, "").split("/").pop()!.toLowerCase();

// Builds the graph from every .md file in a subfolder of wiki/.
export async function buildWikiGraph(brain: Brain): Promise<WikiGraph> {
  const graph: WikiGraph = { nodes: new Map(), bySource: new Map(), duplicates: [] };
  let entries;
  try {
    entries = await brain.list("wiki", true);
  } catch {
    return graph; // no wiki yet
  }
  const md = entries.filter((e) => e.type === "file" && e.path.endsWith(".md")).map((e) => e.path).sort();
  const files = md.filter((p) => p.split("/").length >= 3);
  const lists = new Set(md.filter((p) => p.split("/").length === 2).map(slugOf)); // index, timeline, log: not nodes, not missing
  const links = new Map<string, string[]>();
  for (const path of files) {
    const slug = slugOf(path);
    if (graph.nodes.has(slug)) {
      graph.duplicates.push(slug);
      continue;
    }
    const text = await brain.read(path);
    const { meta } = parseFrontmatter(text);
    const node: WikiNode = {
      slug, path, title: unquote(meta.title) || slug, type: unquote(meta.type) || path.split("/")[1]!,
      updated: unquote(meta.updated), out: new Set(), in: new Set(), unresolved: [], sources: new Set(),
    };
    for (const m of text.matchAll(RAW_FILE)) node.sources.add(m[1]!);
    links.set(slug, [...text.matchAll(LINK)].map((m) => slugOf(m[1]!)).filter((s) => s && s !== slug));
    graph.nodes.set(slug, node);
  }
  for (const [slug, targets] of links) {
    const node = graph.nodes.get(slug)!;
    const unresolved = new Set<string>();
    for (const t of targets) {
      const target = graph.nodes.get(t);
      if (!target) {
        if (!lists.has(t)) unresolved.add(t);
        continue;
      }
      node.out.add(t);
      target.in.add(slug);
    }
    node.unresolved = [...unresolved].sort();
    for (const s of node.sources) {
      const set = graph.bySource.get(s) ?? new Set<string>();
      set.add(slug);
      graph.bySource.set(s, set);
    }
  }
  graph.duplicates = [...new Set(graph.duplicates)].sort();
  return graph;
}

const unquote = (v: string | undefined) => (v ?? "").trim().replace(/^["']|["']$/g, "");

// Finds a page by slug, path or title (case-insensitive); otherwise returns close candidates.
export function findPage(graph: WikiGraph, query: string): { node?: WikiNode; candidates: WikiNode[] } {
  const q = query.trim().toLowerCase();
  const bySlug = graph.nodes.get(slugOf(q));
  if (bySlug) return { node: bySlug, candidates: [] };
  const all = [...graph.nodes.values()];
  const byTitle = all.find((n) => n.title.toLowerCase() === q);
  if (byTitle) return { node: byTitle, candidates: [] };
  const words = q.split(/[\s-]+/).filter((w) => w.length > 1);
  const candidates = all
    .map((n) => ({ n, hits: words.filter((w) => n.slug.includes(w) || n.title.toLowerCase().includes(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.n.updated.localeCompare(a.n.updated) || a.n.slug.localeCompare(b.n.slug))
    .slice(0, 10)
    .map((x) => x.n);
  return { candidates };
}

export interface Relation {
  node: WikiNode;
  distance: number; // 1 = direct neighbour
  linksTo: boolean; // the start (or, at distance 2+, the previous page) links to it
  linkedFrom: boolean; // it links back
  sharedSources: number; // raw posts cited by both it and the page it was reached from
  via?: string; // previous page on the shortest path (distance 2+)
}

export interface RelatedOptions {
  depth?: number; // 1..3, default 1
  limit?: number; // max relations returned, default 30
  sharedSources?: boolean; // count pages citing the same raw posts as neighbours, default true
  type?: string; // only relations of this type (e.g. "event")
}

// Pages around `start`, breadth-first over links (both directions) and shared sources. Within a distance, stronger
// relations come first: linked both ways, then one-way links with more shared sources, then shared sources only;
// ties break on the newer `updated`, then the slug, so the order is stable.
export function related(graph: WikiGraph, start: WikiNode, o: RelatedOptions = {}): { relations: Relation[]; total: number } {
  const depth = Math.min(3, Math.max(1, o.depth ?? 1));
  const useSources = o.sharedSources ?? true;
  const seen = new Map<string, Relation>();
  let frontier = [start.slug];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: Relation[] = [];
    for (const from of frontier) {
      const f = graph.nodes.get(from)!;
      for (const [slug, rel] of neighbours(graph, f, useSources)) {
        if (slug === start.slug || seen.has(slug)) continue;
        const prev = next.find((r) => r.node.slug === slug);
        const candidate: Relation = { ...rel, distance: d, ...(d > 1 ? { via: from } : {}) };
        if (!prev) next.push(candidate);
        else if (strength(candidate) > strength(prev)) next.splice(next.indexOf(prev), 1, candidate);
      }
    }
    for (const r of next) seen.set(r.node.slug, r);
    frontier = next.map((r) => r.node.slug).sort();
  }
  const all = [...seen.values()]
    .filter((r) => !o.type || r.node.type === o.type)
    .sort((a, b) => a.distance - b.distance || strength(b) - strength(a) || b.node.updated.localeCompare(a.node.updated) || a.node.slug.localeCompare(b.node.slug));
  return { relations: all.slice(0, o.limit ?? 30), total: all.length };
}

function neighbours(graph: WikiGraph, f: WikiNode, useSources: boolean): Map<string, Omit<Relation, "distance" | "via">> {
  const out = new Map<string, Omit<Relation, "distance" | "via">>();
  const get = (slug: string) => {
    let r = out.get(slug);
    if (!r) out.set(slug, (r = { node: graph.nodes.get(slug)!, linksTo: false, linkedFrom: false, sharedSources: 0 }));
    return r;
  };
  for (const s of f.out) get(s).linksTo = true;
  for (const s of f.in) get(s).linkedFrom = true;
  if (useSources) {
    for (const src of f.sources) for (const s of graph.bySource.get(src) ?? []) if (s !== f.slug) get(s).sharedSources++;
  }
  return out;
}

const strength = (r: Pick<Relation, "linksTo" | "linkedFrom" | "sharedSources">) =>
  (r.linksTo && r.linkedFrom ? 3 : r.linksTo || r.linkedFrom ? 2 : 0) * 1000 + r.sharedSources;

// ---- text the model reads ----

const describe = (n: WikiNode) => `[[${n.slug}]] ${n.type}${n.updated ? `, updated ${n.updated}` : ""} – ${n.title} (${n.path})`;

function relationText(r: Relation): string {
  const why: string[] = [];
  if (r.linksTo && r.linkedFrom) why.push(r.via ? `linked both ways with [[${r.via}]]` : "linked both ways");
  else if (r.linksTo) why.push(r.via ? `linked from [[${r.via}]]` : "linked from it");
  else if (r.linkedFrom) why.push(r.via ? `links to [[${r.via}]]` : "links to it");
  if (r.sharedSources) why.push(`${r.sharedSources} shared source${r.sharedSources === 1 ? "" : "s"}${r.via ? ` with [[${r.via}]]` : ""}`);
  return `- ${describe(r.node)}: ${why.join("; ")}`;
}

export function renderRelated(graph: WikiGraph, start: WikiNode, o: RelatedOptions = {}): string {
  const depth = Math.min(3, Math.max(1, o.depth ?? 1));
  const { relations, total } = related(graph, start, o);
  const lines = [
    `wiki graph around ${describe(start)}`,
    `page: links to ${start.out.size}, linked from ${start.in.size}, cites ${start.sources.size} raw source${start.sources.size === 1 ? "" : "s"}${start.unresolved.length ? `; unresolved links: ${start.unresolved.map((s) => `[[${s}]]`).join(", ")}` : ""}`,
    `${total} related page${total === 1 ? "" : "s"} within ${depth} step${depth === 1 ? "" : "s"}${o.type ? ` of type ${o.type}` : ""}${relations.length < total ? `, the ${relations.length} strongest shown` : ""} (nearest and strongest first; read them with brain_read):`,
  ];
  let d = 0;
  for (const r of relations) {
    if (r.distance !== d) {
      d = r.distance;
      lines.push(d === 1 ? "direct:" : `${d} steps away:`);
    }
    lines.push(relationText(r));
  }
  if (!relations.length) lines.push("- none: the page has no links, backlinks or shared sources yet");
  return lines.join("\n");
}

// The whole graph at a glance: the biggest hubs per type, the newest pages, and what needs fixing.
export function renderOverview(graph: WikiGraph, perType = 5): string {
  const nodes = [...graph.nodes.values()];
  if (!nodes.length) return "wiki graph: no pages under wiki/<folder>/ yet";
  const degree = (n: WikiNode) => new Set([...n.out, ...n.in]).size;
  const types = [...new Set(nodes.map((n) => n.type))].sort();
  const edges = nodes.reduce((s, n) => s + n.out.size, 0);
  const lines = [`wiki graph: ${nodes.length} page${nodes.length === 1 ? "" : "s"}, ${edges} link${edges === 1 ? "" : "s"}, ${graph.bySource.size} raw source${graph.bySource.size === 1 ? "" : "s"} cited`];
  lines.push(`pages per type: ${types.map((t) => `${t} ${nodes.filter((n) => n.type === t).length}`).join(", ")}`);
  lines.push("", `hubs (most connected pages per type, connections = distinct pages linked to or from):`);
  for (const t of types) {
    const top = nodes.filter((n) => n.type === t).sort((a, b) => degree(b) - degree(a) || b.updated.localeCompare(a.updated) || a.slug.localeCompare(b.slug)).slice(0, perType);
    lines.push(`- ${t}: ${top.map((n) => `[[${n.slug}]] (${degree(n)})`).join(", ")}`);
  }
  const recent = [...nodes].filter((n) => n.updated).sort((a, b) => b.updated.localeCompare(a.updated) || a.slug.localeCompare(b.slug)).slice(0, 10);
  if (recent.length) lines.push("", "recently updated:", ...recent.map((n) => `- ${n.updated} ${describe(n)}`));
  const orphans = nodes.filter((n) => degree(n) === 0).map((n) => `[[${n.slug}]]`).sort();
  const unresolved = new Map<string, number>();
  for (const n of nodes) for (const u of n.unresolved) unresolved.set(u, (unresolved.get(u) ?? 0) + 1);
  lines.push("", "to fix:");
  lines.push(`- orphans (no links in or out): ${orphans.length ? orphans.join(", ") : "none"}`);
  lines.push(`- links to missing pages: ${unresolved.size ? [...unresolved].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([s, c]) => `[[${s}]] (${c})`).join(", ") : "none"}`);
  if (graph.duplicates.length) lines.push(`- slugs used by more than one file: ${graph.duplicates.map((s) => `[[${s}]]`).join(", ")}`);
  return lines.join("\n");
}
