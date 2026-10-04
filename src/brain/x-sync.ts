// x-sync.ts – pulls new posts from a curated list of X accounts into brain/raw/x/ as one
// Markdown file per post in the brain (raw/x/<YYYY-MM-DD>/<username>-<id>.md, date in UTC).
//
// The account list and topic keywords live in x-accounts.json in the brain root. Enabled accounts are batched
// into as few recent-search queries as fit X's query length limit; accounts with `filter: true` only
// contribute posts matching one of the topics. Each query remembers the newest post id it has seen,
// so a run only fetches new posts.
//
// Cost control (pay-per-use bills every object returned): the search requests no expansions,
// account profiles are looked up once and cached for a week, and every read is charged against a
// daily and an optional total budget kept in .x-spend.json in the brain root. A run stops before exceeding it.

import type { Brain } from "./brain.ts";
import { createLogger } from "../core/logger.ts";
import { X_MAX_QUERY_LENGTH, X_PRICE, type XClient, type XPost, type XUser } from "../providers/x/x-client.ts";

const log = createLogger("x-sync");

export interface XAccount {
  username: string; // without "@"
  category: string; // e.g. wire, official, osint, markets
  filter: boolean; // true = only posts matching `topics`
  enabled?: boolean; // default true; false keeps the account on the list without syncing it
  note?: string; // why this account is on the list / how reliable it is
}

export interface XAccountsConfig {
  topics: string[];
  accounts: XAccount[];
}

interface SyncState {
  queries: Record<string, { newestId: string; syncedAt: string }>;
}

type CachedUser = XUser & { checkedAt: string; missing?: boolean };
interface UsersState {
  users: Record<string, CachedUser>; // key: lowercase username
}

interface SpendState {
  days: Record<string, number>; // UTC day -> estimated USD
}

export interface XBudget {
  dailyUsd?: number | undefined; // undefined = no daily cap
  totalUsd?: number | undefined; // undefined = no total cap
}

export interface SyncOptions {
  backfillHours?: number; // how far back a query that has never run reaches (max 7 days)
  maxPostsPerQuery?: number; // caps paid reads per query per run
  requireVerified?: boolean; // drop posts whose author is not verified on X
  budget?: XBudget;
}

export interface SpendSummary {
  todayUsd: number;
  totalUsd: number;
  leftUsd: number | null; // null = no cap
}

export interface SyncResult {
  queries: number;
  fetched: number;
  saved: string[]; // relative paths of new raw files
  skippedUnverified: string[]; // usernames
  capped: string[]; // queries that stopped early (post cap or budget); older posts of that run were skipped
  budgetExhausted: boolean; // the run stopped to stay within budget
  costUsd: number; // estimated cost of this run
  spend: SpendSummary;
}

const CONFIG_FILE = "x-accounts.json";
const PROFILE_MAX_AGE_MS = 7 * 86_400_000;
const MIN_PAGE = 10; // smallest max_results recent search accepts

export class BudgetExceededError extends Error {
  readonly kind = "budget";
}

export async function loadAccounts(brain: Brain): Promise<XAccountsConfig> {
  const config = JSON.parse(await brain.read(CONFIG_FILE)) as XAccountsConfig;
  if (!Array.isArray(config.accounts) || !Array.isArray(config.topics)) {
    throw new Error(`${CONFIG_FILE} must have "topics" and "accounts" arrays`);
  }
  return config;
}

const uname = (a: XAccount) => a.username.replace(/^@/, "");
const isEnabled = (a: XAccount) => a.enabled !== false;
const utcDay = () => new Date().toISOString().slice(0, 10);

// --- spend tracking (estimates from X_PRICE; the X Developer Console shows the real usage) ---

class Spend {
  private readonly brain: Brain;
  private readonly budget: XBudget;
  private state: SpendState = { days: {} };

  constructor(brain: Brain, budget: XBudget) {
    this.brain = brain;
    this.budget = budget;
  }

  async load() {
    this.state = await this.brain.readState<SpendState>("x-spend", { days: {} });
    return this;
  }

  private get today() {
    return this.state.days[utcDay()] ?? 0;
  }

  private get total() {
    return Object.values(this.state.days).reduce((a, b) => a + b, 0);
  }

  get left(): number {
    return Math.max(0, Math.min(
      this.budget.dailyUsd === undefined ? Infinity : this.budget.dailyUsd - this.today,
      this.budget.totalUsd === undefined ? Infinity : this.budget.totalUsd - this.total,
    ));
  }

  async charge(usd: number) {
    if (usd <= 0) return;
    const day = utcDay();
    this.state.days[day] = Math.round(((this.state.days[day] ?? 0) + usd) * 10_000) / 10_000;
    await this.brain.writeState("x-spend", this.state);
  }

  summary(): SpendSummary {
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return { todayUsd: r(this.today), totalUsd: r(this.total), leftUsd: Number.isFinite(this.left) ? r(this.left) : null };
  }
}

// --- account profiles (cached, so searches need no billed author expansion) ---

async function resolveUsers(client: XClient, brain: Brain, usernames: string[], spend: Spend): Promise<Map<string, CachedUser>> {
  const state = await brain.readState<UsersState>("x-users", { users: {} });
  const stale = usernames.filter((u) => {
    const c = state.users[u.toLowerCase()];
    return !c || Date.now() - Date.parse(c.checkedAt) > PROFILE_MAX_AGE_MS;
  });
  for (let i = 0; i < stale.length; i += 100) {
    const chunk = stale.slice(i, i + 100);
    if (spend.left < chunk.length * X_PRICE.user) {
      if (!usernames.some((u) => state.users[u.toLowerCase()])) {
        throw new BudgetExceededError("X budget too low to look up account profiles");
      }
      log.warn("budget too low to refresh profiles, using cached ones", { stale: chunk.length });
      break;
    }
    const found = await client.usersByUsernames(chunk);
    await spend.charge(found.length * X_PRICE.user);
    const now = new Date().toISOString();
    for (const u of chunk) state.users[u.toLowerCase()] = { id: "", username: u, name: u, checkedAt: now, missing: true };
    for (const u of found) state.users[u.username.toLowerCase()] = { ...u, checkedAt: now };
    await brain.writeState("x-users", state);
  }
  const out = new Map<string, CachedUser>();
  for (const u of usernames) {
    const c = state.users[u.toLowerCase()];
    if (c) out.set(u.toLowerCase(), c);
  }
  return out;
}

// The account list with live profile data (verification, followers); profiles are cached for a week.
export async function accountsOverview(client: XClient, brain: Brain, budget: XBudget = {}) {
  const config = await loadAccounts(brain);
  const spend = await new Spend(brain, budget).load();
  const users = await resolveUsers(client, brain, config.accounts.map(uname), spend);
  return {
    topics: config.topics,
    spend: spend.summary(),
    accounts: config.accounts.map((a) => {
      const u = users.get(uname(a).toLowerCase());
      return {
        ...a,
        enabled: isEnabled(a),
        found: u ? !u.missing : undefined,
        verified_type: u && !u.missing ? (u.verified ? (u.verified_type ?? "unknown") : "none") : undefined,
        followers: u?.public_metrics?.followers_count,
      };
    }),
  };
}

// --- queries ---

const quoteTerm = (t: string) => (/[\s"]/.test(t) ? `"${t.replace(/"/g, "")}"` : t);

// Packs enabled accounts into queries of at most `maxLength` chars:
// "(from:a OR from:b) (topic1 OR topic2) -is:retweet" or, for unfiltered accounts, without topics.
export function buildQueries(config: XAccountsConfig, maxLength = X_MAX_QUERY_LENGTH): string[] {
  const topics = config.topics.length ? ` (${config.topics.map(quoteTerm).join(" OR ")})` : "";
  const suffix = " -is:retweet";
  const queries: string[] = [];
  for (const filtered of [false, true]) {
    const tail = (filtered ? topics : "") + suffix;
    const froms = config.accounts.filter((a) => isEnabled(a) && a.filter === filtered).map((a) => `from:${uname(a)}`);
    let batch: string[] = [];
    const flush = () => {
      if (batch.length) queries.push(`(${batch.join(" OR ")})${tail}`);
      batch = [];
    };
    for (const f of froms) {
      if (`(${[...batch, f].join(" OR ")})${tail}`.length > maxLength) flush();
      if (`(${f})${tail}`.length > maxLength) throw new Error(`Topics list too long for the ${maxLength}-char query limit`);
      batch.push(f);
    }
    flush();
  }
  return queries;
}

// Creation time (ms epoch) encoded in an X post id.
export const snowflakeTime = (id: string) => Number(BigInt(id) >> 22n) + 1288834974657;

// YAML-safe scalar: JSON strings are valid YAML.
const y = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

function postKind(p: XPost): "post" | "reply" | "quote" {
  if (p.referenced_tweets?.some((r) => r.type === "quoted")) return "quote";
  if (p.referenced_tweets?.some((r) => r.type === "replied_to")) return "reply";
  return "post";
}

export function renderPost(p: XPost, author: XUser, account: XAccount | undefined): string {
  const m = p.public_metrics;
  const links = (p.entities?.urls ?? []).map((u) => u.expanded_url ?? u.url).filter((u) => !/^https:\/\/(x|twitter)\.com\/.+\/status\//.test(u));
  const ref = (type: string) => p.referenced_tweets?.find((r) => r.type === type)?.id;
  const quoted = ref("quoted");
  const repliedTo = ref("replied_to");
  return [
    "---",
    "source: x",
    `id: ${y(p.id)}`,
    `url: https://x.com/${author.username}/status/${p.id}`,
    `author: ${y(`@${author.username}`)}`,
    `author_name: ${y(author.name)}`,
    `verified_type: ${y(author.verified ? (author.verified_type ?? "unknown") : "none")}`,
    `category: ${y(account?.category ?? "unknown")}`,
    `kind: ${postKind(p)}`,
    `created_at: ${y(p.created_at)}`,
    `fetched_at: ${y(new Date().toISOString())}`,
    p.lang ? `lang: ${y(p.lang)}` : undefined,
    m ? `metrics: { likes: ${m.like_count}, reposts: ${m.retweet_count}, replies: ${m.reply_count}, quotes: ${m.quote_count}${m.impression_count !== undefined ? `, views: ${m.impression_count}` : ""} }` : undefined,
    links.length ? `links: [${links.map(y).join(", ")}]` : undefined,
    // Referenced posts are linked, not fetched: their text would be billed as extra reads.
    quoted ? `quotes: https://x.com/i/status/${quoted}` : undefined,
    repliedTo ? `reply_to: https://x.com/i/status/${repliedTo}` : undefined,
    "---",
    "",
    p.note_tweet?.text ?? p.text,
    "",
  ].filter((l) => l !== undefined).join("\n");
}

// --- sync ---

export async function syncX(client: XClient, brain: Brain, opts: SyncOptions = {}): Promise<SyncResult> {
  const backfillHours = Math.min(opts.backfillHours ?? 24, 7 * 24 - 1);
  const maxPosts = opts.maxPostsPerQuery ?? 200;
  const requireVerified = opts.requireVerified ?? true;

  const config = await loadAccounts(brain);
  const enabled = config.accounts.filter(isEnabled);
  const accounts = new Map(enabled.map((a) => [uname(a).toLowerCase(), a]));
  const queries = buildQueries(config);
  const state = await brain.readState<SyncState>("x-sync", { queries: {} });
  const spend = await new Spend(brain, opts.budget ?? {}).load();
  const startTotal = spend.summary().totalUsd;
  const result: SyncResult = {
    queries: queries.length, fetched: 0, saved: [], skippedUnverified: [], capped: [],
    budgetExhausted: false, costUsd: 0, spend: spend.summary(),
  };
  const unverified = new Set<string>();

  let usersById = new Map<string, CachedUser>();
  try {
    const users = await resolveUsers(client, brain, enabled.map(uname), spend);
    usersById = new Map([...users.values()].map((u) => [u.id, u]));
  } catch (e) {
    if (!(e instanceof BudgetExceededError)) throw e;
    result.budgetExhausted = true;
  }

  for (const query of queries) {
    if (result.budgetExhausted) break;
    // Recent search rejects a since_id older than its 7-day window; fall back to start_time then.
    const cursor = state.queries[query]?.newestId;
    const sinceId = cursor && Date.now() - snowflakeTime(cursor) < 6.9 * 86_400_000 ? cursor : undefined;
    const startTime = new Date(Date.now() - backfillHours * 3_600_000).toISOString();
    let newestId: string | undefined;
    let nextToken: string | undefined;
    let fetched = 0;

    do {
      const affordable = Math.floor(spend.left / X_PRICE.post + 1e-9);
      if (affordable < MIN_PAGE) {
        result.budgetExhausted = true;
        break;
      }
      const page = await client.searchRecent({ query, sinceId, startTime, nextToken, maxResults: Math.min(100, maxPosts - fetched, affordable) });
      await spend.charge(page.posts.length * X_PRICE.post);
      newestId ??= page.newestId; // the first page carries the newest post of the whole result
      nextToken = page.nextToken;
      fetched += page.posts.length;

      for (const p of page.posts) {
        const author: XUser = usersById.get(p.author_id) ?? { id: p.author_id, username: `id${p.author_id}`, name: "" };
        if (requireVerified && !author.verified) {
          unverified.add(author.username);
          continue;
        }
        const path = `x/${p.created_at.slice(0, 10)}/${author.username}-${p.id}.md`;
        if (await brain.writeRawOnce(path, renderPost(p, author, accounts.get(author.username.toLowerCase())))) {
          result.saved.push(`raw/${path}`);
        }
      }
    } while (nextToken && fetched < maxPosts);

    if (nextToken) {
      result.capped.push(query);
      log.warn("query stopped early, older posts of this run skipped", { query, maxPosts, budget: result.budgetExhausted });
    }
    result.fetched += fetched;
    if (newestId) {
      state.queries[query] = { newestId, syncedAt: new Date().toISOString() };
      await brain.writeState("x-sync", state);
    }
  }

  // Forget cursors of queries that no longer exist (account list or topics changed).
  for (const q of Object.keys(state.queries)) if (!queries.includes(q)) delete state.queries[q];
  await brain.writeState("x-sync", state);

  result.skippedUnverified = [...unverified];
  result.spend = spend.summary();
  result.costUsd = Math.round((result.spend.totalUsd - startTotal) * 1000) / 1000;
  if (unverified.size) log.warn("posts from unverified authors skipped", { authors: result.skippedUnverified.join(",") });
  if (result.budgetExhausted) log.warn("X budget reached, sync stopped", { ...result.spend });
  log.info("sync finished", { queries: queries.length, fetched: result.fetched, saved: result.saved.length, costUsd: result.costUsd });
  return result;
}

export interface RawXPost {
  path: string;
  author: string;
  created_at: string;
  url: string;
  category: string;
  verified_type: string;
  kind: string;
  text: string;
}

function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const raw = line.slice(i + 1).trim();
    try {
      meta[line.slice(0, i).trim()] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
    } catch {
      meta[line.slice(0, i).trim()] = raw;
    }
  }
  return { meta, body: m[2]!.trim() };
}

// Reads archived posts (no API calls), newest first.
export async function recentRawPosts(brain: Brain, p: { since: Date; author?: string | undefined; contains?: string | undefined; limit: number }): Promise<RawXPost[]> {
  const sinceDay = p.since.toISOString().slice(0, 10);
  let days: string[];
  try {
    days = (await brain.list("raw/x")).filter((e) => e.type === "dir" && e.path.slice(-10) >= sinceDay).map((e) => e.path);
  } catch {
    return []; // nothing synced yet
  }
  const author = p.author?.replace(/^@/, "").toLowerCase();
  const contains = p.contains?.toLowerCase();
  const out: RawXPost[] = [];
  for (const day of days) {
    for (const f of await brain.list(day)) {
      if (f.type !== "file") continue;
      if (author && !f.path.toLowerCase().includes(`/${author}-`)) continue;
      const { meta, body } = parseFrontmatter(await brain.read(f.path));
      if (!meta.created_at || new Date(meta.created_at) < p.since) continue;
      if (contains && !body.toLowerCase().includes(contains)) continue;
      out.push({
        path: f.path,
        author: meta.author ?? "",
        created_at: meta.created_at,
        url: meta.url ?? "",
        category: meta.category ?? "",
        verified_type: meta.verified_type ?? "",
        kind: meta.kind ?? "",
        text: body,
      });
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, p.limit);
}
