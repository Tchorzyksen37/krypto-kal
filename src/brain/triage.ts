// triage.ts – decides what the brain-ingest skill reads first. Instead of "the 40 oldest posts", it ranks every raw X
// post that is not yet ingested by how likely it is to move markets, groups posts about the same event into clusters
// (corroboration across independent accounts raises a cluster), and separates obvious noise.
//
// Score of a post (documented so the ranking can be argued with):
//   source   account weight 0..3 (x-accounts.json `weight`, or its category: official/wire 3, markets 2.5, ...),
//            times the reliability recorded in wiki/sources/<user>.md (`reliability: high | medium | low`)
//   content  market-moving terms in the text, by group (kinetic, energy and chokepoints, escalation and diplomacy,
//            macro and crypto, urgency), each group counted once
//   kind     original post 1, quote 0.8, reply 0.4
//   reach    engagement on a log scale, plus a bonus when the post did much better than its author's other posts
//   noise    promotion, or a short reply/post with no market-moving term and no link, is set aside as noise
// Cluster score = best post score x (1 + 0.25 per extra independent author, up to +100%).
//
// What is done is remembered in <BRAIN_DIR>/.ingest-state.json (written by markIngested, the MCP tool
// brain_ingest_mark) and by the raw file names that wiki pages cite, so nothing is read twice.

import { fileURLToPath } from "node:url";
import { Brain } from "./brain.ts";
import { type XAccountsConfig, accountWeight, loadAccounts, parseFrontmatter } from "./x-sync.ts";

export const TERM_GROUPS: Record<string, { weight: number; terms: string[] }> = {
  kinetic: { weight: 3, terms: ["strike", "strikes", "airstrike", "missile", "missiles", "drone", "drones", "attack", "attacked", "explosion", "explosions", "killed", "invasion", "intercept", "intercepted", "rocket", "rockets", "bombing", "mobilization", "mobilisation", "retaliation", "retaliate", "assassinat"] },
  energy: { weight: 3, terms: ["hormuz", "red sea", "bab el-mandeb", "bab al-mandab", "suez", "tanker", "tankers", "oil", "crude", "brent", "refinery", "pipeline", "opec", "lng", "gas field", "shipping", "kharg"] },
  escalation: { weight: 2.5, terms: ["ceasefire", "truce", "talks", "negotiat", "deal", "sanction", "ultimatum", "nuclear", "enrichment", "iaea", "escalat", "de-escalat", "evacuat", "state of emergency", "martial law", "declares war", "war"] },
  macro: { weight: 2, terms: ["fed", "fomc", "powell", "rate cut", "rate hike", "interest rate", "cpi", "inflation", "payrolls", "jobs report", "yields", "treasury", "dollar", "tariff", "recession", "bitcoin", "btc", "crypto", "etf", "sec", "liquidat", "stablecoin"] },
  urgency: { weight: 1.5, terms: ["breaking", "urgent", "flash", "just in", "confirmed", "official", "statement", "announces", "announced"] },
};

const PROMO = /\b(subscribe|giveaway|sponsored|promo code|newsletter|podcast|join us|sign up|watch live|tune in|link in bio|our app)\b/i;
const STOP = new Set("the a an and or of to in on for at by with from is are was were be been it its this that as after over into about says said will has have had not but more than new also who what when where which their they them he she his her we our you your i".split(" "));

export interface PendingPost {
  path: string; // raw/x/<date>/<user>-<id>.md
  author: string; // without @, as in the file name
  category: string;
  kind: string;
  createdAtMs: number;
  text: string;
  hasLink: boolean;
  engagement: number; // reposts x3 + quotes x2 + likes + replies
}

export interface ScoredPost extends PendingPost {
  score: number;
  reasons: string[];
  noise?: string; // why it looks like noise
}

export interface Cluster {
  id: string;
  score: number;
  label: string; // the strongest shared terms
  authors: string[];
  firstAt: string;
  lastAt: string;
  corroborated: boolean; // two or more independent accounts
  read: string[]; // the posts to read for this event (best first, at most `perCluster`)
  alsoInEvent: string[]; // further posts of the same event: cite them, no need to read them
}

export interface TriageResult {
  pending: number;
  selected: Cluster[]; // read these, in this order
  deferred: Cluster[]; // not selected this run (lower score); they compete again next run
  noise: { path: string; reason: string }[]; // mark as skipped unless a quick look says otherwise
  stale: string[]; // deferred posts older than staleHours: mark as skipped, they will not become news
  accounts: { author: string; pending: number; noise: number; avgScore: number; ingestedEver: number; skippedEver: number }[];
}

export interface IngestState {
  done: Record<string, { status: "ingested" | "skipped"; reason?: string; atMs: number }>;
}

export interface TriageOptions {
  maxPosts: number; // how many posts to read this run
  perCluster: number; // at most this many posts read per event
  windowHours: number; // posts this close in time can belong to one event
  similarity: number; // shared-term ratio for one event
  staleHours: number;
  nowMs: number;
}

export const DEFAULT_TRIAGE: Omit<TriageOptions, "nowMs"> = { maxPosts: 40, perCluster: 4, windowHours: 6, similarity: 0.3, staleHours: 72 };

const lower = (s: string) => s.toLowerCase();

export function termHits(text: string): { group: string; term: string }[] {
  const t = ` ${lower(text).replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ")} `;
  const hits: { group: string; term: string }[] = [];
  for (const [group, g] of Object.entries(TERM_GROUPS)) {
    for (const term of g.terms) {
      // whole word for short terms, prefix match for stems like "negotiat"
      const re = term.length <= 4 || term.includes(" ") ? new RegExp(`\\s${term.replace(/[-]/g, "\\-")}\\s`) : new RegExp(`\\s${term.replace(/[-]/g, "\\-")}`);
      if (re.test(t)) hits.push({ group, term });
    }
  }
  return hits;
}

// Words that identify an event: market-moving terms plus longer content words and capitalised names.
export function keyTerms(text: string): Set<string> {
  const out = new Set(termHits(text).map((h) => h.term));
  for (const w of text.replace(/https?:\/\/\S+/g, " ").split(/[^\p{L}\p{N}]+/u)) {
    const l = lower(w);
    if (l.length >= 5 && !STOP.has(l)) out.add(l);
  }
  return out;
}

const metricsOf = (raw: string | undefined) => {
  const n = (k: string) => Number(new RegExp(`${k}:\\s*(\\d+)`).exec(raw ?? "")?.[1] ?? 0);
  return n("reposts") * 3 + n("quotes") * 2 + n("likes") + n("replies");
};

export function parsePending(path: string, md: string): PendingPost {
  const { meta, body } = parseFrontmatter(md);
  const file = path.split("/").pop() ?? path;
  const author = (meta.author ?? file.replace(/-\d+\.md$/, "")).replace(/^@/, "");
  return {
    path, author, category: meta.category ?? "unknown", kind: meta.kind ?? "post",
    createdAtMs: Date.parse(meta.created_at ?? "") || 0, text: body,
    hasLink: Boolean(meta.links) || /https?:\/\//.test(body), engagement: metricsOf(meta.metrics),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export function scorePosts(posts: PendingPost[], config: XAccountsConfig, reliability: Record<string, number> = {}): ScoredPost[] {
  const accounts = new Map(config.accounts.map((a) => [a.username.replace(/^@/, "").toLowerCase(), a]));
  const byAuthor = new Map<string, number[]>();
  for (const p of posts) byAuthor.set(lower(p.author), [...(byAuthor.get(lower(p.author)) ?? []), p.engagement]);

  return posts.map((p) => {
    const reasons: string[] = [];
    const acct = accounts.get(lower(p.author));
    const rel = reliability[lower(p.author)] ?? 1;
    const source = (acct ? accountWeight(acct) : accountWeight({ category: p.category })) * rel;
    reasons.push(`source ${source.toFixed(2)}${rel !== 1 ? ` (reliability x${rel})` : ""}`);

    const hits = termHits(p.text);
    const groups = [...new Set(hits.map((h) => h.group))];
    const content = groups.reduce((a, g) => a + TERM_GROUPS[g]!.weight, 0);
    if (groups.length) reasons.push(`terms: ${groups.join(", ")}`);

    const kind = p.kind === "reply" ? 0.4 : p.kind === "quote" ? 0.8 : 1;
    const reach = Math.min(1.5, Math.log10(1 + p.engagement) / 3);
    const typical = median(byAuthor.get(lower(p.author)) ?? []);
    const surge = typical > 0 && p.engagement >= 3 * typical ? 0.75 : 0;
    if (surge) reasons.push("far above the author's usual engagement");

    const score = Math.round((source * (1 + content) * kind + reach + surge) * 100) / 100;
    const out: ScoredPost = { ...p, score, reasons };
    if (PROMO.test(p.text)) out.noise = "promotion";
    else if (!hits.length && !p.hasLink && (p.kind === "reply" || p.text.length < 80)) out.noise = "short or reply, no market-moving term";
    return out;
  });
}

// Greedy single-link clustering: a post joins the first cluster that has a post within the window sharing enough terms.
export function clusterPosts(posts: ScoredPost[], o: Pick<TriageOptions, "windowHours" | "similarity" | "perCluster">): Cluster[] {
  const sorted = [...posts].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const groups: { posts: ScoredPost[]; terms: Set<string>[] }[] = [];
  const windowMs = o.windowHours * 3_600_000;
  for (const p of sorted) {
    const terms = keyTerms(p.text);
    const home = groups.find((g) => g.posts.some((q, i) => {
      if (Math.abs(q.createdAtMs - p.createdAtMs) > windowMs) return false;
      const other = g.terms[i]!;
      const shared = [...terms].filter((t) => other.has(t)).length;
      return shared >= 2 && shared / Math.min(terms.size, other.size) >= o.similarity;
    }));
    if (home) {
      home.posts.push(p);
      home.terms.push(terms);
    } else groups.push({ posts: [p], terms: [terms] });
  }
  return groups.map((g) => {
    const best = [...g.posts].sort((a, b) => b.score - a.score);
    const authors = [...new Set(g.posts.map((p) => lower(p.author)))];
    const counts = new Map<string, number>();
    for (const ts of g.terms) for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
    const label = [...counts].filter(([, n]) => n >= Math.min(2, g.posts.length)).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 5).map(([t]) => t).join(", ");
    const score = Math.round(best[0]!.score * (1 + Math.min(1, 0.25 * (authors.length - 1))) * 100) / 100;
    const times = g.posts.map((p) => p.createdAtMs);
    return {
      id: best[0]!.path, score, label, authors, corroborated: authors.length >= 2,
      firstAt: new Date(Math.min(...times)).toISOString(), lastAt: new Date(Math.max(...times)).toISOString(),
      read: best.slice(0, o.perCluster).map((p) => p.path), alsoInEvent: best.slice(o.perCluster).map((p) => p.path),
    };
  }).sort((a, b) => b.score - a.score);
}

export function triage(
  pending: PendingPost[], config: XAccountsConfig, state: IngestState, reliability: Record<string, number>, options: Partial<TriageOptions> = {},
): TriageResult {
  const o: TriageOptions = { ...DEFAULT_TRIAGE, nowMs: Date.now(), ...options };
  const scored = scorePosts(pending, config, reliability);
  const noise = scored.filter((p) => p.noise);
  const clusters = clusterPosts(scored.filter((p) => !p.noise), o);

  const selected: Cluster[] = [];
  const deferred: Cluster[] = [];
  let budget = o.maxPosts;
  for (const c of clusters) {
    if (budget > 0 && c.read.length <= budget) {
      selected.push(c);
      budget -= c.read.length;
    } else deferred.push(c);
  }
  const staleBefore = o.nowMs - o.staleHours * 3_600_000;
  const stale = deferred.flatMap((c) => (Date.parse(c.lastAt) < staleBefore ? [...c.read, ...c.alsoInEvent] : []));

  const perAuthor = new Map<string, { pending: number; noise: number; sum: number }>();
  for (const p of scored) {
    const k = lower(p.author);
    const a = perAuthor.get(k) ?? { pending: 0, noise: 0, sum: 0 };
    a.pending++;
    if (p.noise) a.noise++;
    a.sum += p.score;
    perAuthor.set(k, a);
  }
  const history = new Map<string, { ingested: number; skipped: number }>();
  for (const [path, d] of Object.entries(state.done)) {
    const author = lower((path.split("/").pop() ?? "").replace(/-\d+\.md$/, ""));
    const h = history.get(author) ?? { ingested: 0, skipped: 0 };
    if (d.status === "ingested") h.ingested++;
    else h.skipped++;
    history.set(author, h);
  }
  const names = new Set([...perAuthor.keys(), ...history.keys()]);
  const accounts = [...names].map((author) => {
    const a = perAuthor.get(author) ?? { pending: 0, noise: 0, sum: 0 };
    const h = history.get(author) ?? { ingested: 0, skipped: 0 };
    return { author, pending: a.pending, noise: a.noise, avgScore: a.pending ? Math.round((a.sum / a.pending) * 100) / 100 : 0, ingestedEver: h.ingested, skippedEver: h.skipped };
  }).sort((a, b) => b.avgScore - a.avgScore);

  return { pending: pending.length, selected, deferred, noise: noise.map((p) => ({ path: p.path, reason: p.noise! })), stale, accounts };
}

// ---- brain I/O ----

const RAW_NAME = /[A-Za-z0-9_]+-\d+\.md/g;

// Raw file names cited anywhere in the wiki (links and `sources:` lines): those posts are ingested.
export async function citedInWiki(brain: Brain): Promise<Set<string>> {
  const out = new Set<string>();
  let entries;
  try {
    entries = await brain.list("wiki", true);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.type !== "file" || !e.path.endsWith(".md")) continue;
    for (const m of (await brain.read(e.path)).matchAll(RAW_NAME)) out.add(m[0]);
  }
  return out;
}

// reliability: high / medium / low in the frontmatter of wiki/sources/<user>.md.
export async function sourceReliability(brain: Brain): Promise<Record<string, number>> {
  const factor: Record<string, number> = { high: 1.3, medium: 1, low: 0.6 };
  const out: Record<string, number> = {};
  let entries;
  try {
    entries = await brain.list("wiki/sources");
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.type !== "file" || !e.path.endsWith(".md")) continue;
    const r = /^reliability:\s*(high|medium|low)\s*$/m.exec(await brain.read(e.path))?.[1];
    if (r) out[(e.path.split("/").pop() ?? "").replace(/\.md$/, "").toLowerCase()] = factor[r]!;
  }
  return out;
}

export async function loadIngestState(brain: Brain): Promise<IngestState> {
  return brain.readState<IngestState>("ingest-state", { done: {} });
}

export async function pendingPosts(brain: Brain, state: IngestState): Promise<PendingPost[]> {
  const cited = await citedInWiki(brain);
  let days;
  try {
    days = (await brain.list("raw/x")).filter((e) => e.type === "dir");
  } catch {
    return [];
  }
  const out: PendingPost[] = [];
  for (const day of days) {
    for (const f of await brain.list(day.path)) {
      if (f.type !== "file" || !f.path.endsWith(".md")) continue;
      const name = f.path.split("/").pop()!;
      if (cited.has(name) || state.done[f.path]) continue;
      out.push(parsePending(f.path, await brain.read(f.path)));
    }
  }
  return out;
}

export async function runTriage(brain: Brain, options: Partial<TriageOptions> = {}): Promise<TriageResult> {
  const state = await loadIngestState(brain);
  let config: XAccountsConfig = { topics: [], accounts: [] };
  try {
    config = await loadAccounts(brain);
  } catch {
    /* without the account list every source gets its category's weight */
  }
  return triage(await pendingPosts(brain, state), config, state, await sourceReliability(brain), options);
}

// Records posts as ingested or skipped so triage never offers them again. Only raw/x paths are accepted.
export async function markIngested(
  brain: Brain, p: { ingested?: string[]; skipped?: { path: string; reason: string }[] }, nowMs = Date.now(),
): Promise<{ ingested: number; skipped: number; rejected: string[] }> {
  const state = await loadIngestState(brain);
  const rejected: string[] = [];
  const ok = (path: string) => /^raw\/x\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_]+-\d+\.md$/.test(path);
  let ingested = 0;
  let skipped = 0;
  for (const path of p.ingested ?? []) {
    if (!ok(path)) rejected.push(path);
    else {
      state.done[path] = { status: "ingested", atMs: nowMs };
      ingested++;
    }
  }
  for (const s of p.skipped ?? []) {
    if (!ok(s.path)) rejected.push(s.path);
    else if (state.done[s.path]?.status !== "ingested") {
      state.done[s.path] = { status: "skipped", reason: s.reason, atMs: nowMs };
      skipped++;
    }
  }
  await brain.writeState("ingest-state", state);
  return { ingested, skipped, rejected };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const max = Number(process.argv[2] ?? DEFAULT_TRIAGE.maxPosts);
  runTriage(new Brain(), { maxPosts: Number.isFinite(max) ? max : DEFAULT_TRIAGE.maxPosts }).then(
    (r) => console.log(JSON.stringify(r, null, 2)),
    (e) => {
      console.error(`triage failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
