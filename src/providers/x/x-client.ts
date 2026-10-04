// x-client.ts  (Node >= 18, no dependencies)
// Client for the X (Twitter) API v2, read-only: recent search and user lookup.
// Needs an app Bearer token (X_BEARER_TOKEN). Pay-per-use billing counts every object returned,
// including expansions ($0.005 per post, $0.01 per user), so the search requests no expansions and
// callers should pass `sinceId` / `startTime` to fetch only new posts.

import { RequestQueue, withRetry } from "../../core/http-utils.ts";
import { createLogger } from "../../core/logger.ts";

const log = createLogger("x");

const BASE_URL = "https://api.x.com";

// Longest `query` the recent search accepts on non-Pro plans.
export const X_MAX_QUERY_LENGTH = 512;

// Pay-per-use prices in USD per object returned.
export const X_PRICE = { post: 0.005, user: 0.01 };

// 429s whose window resets further away than this are reported instead of waited out.
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

export class XError extends Error {
  readonly kind: "http" | "network" | "parse";
  readonly status: number | undefined;
  readonly resetAt: number | undefined; // ms epoch when the rate-limit window resets (429 only)

  constructor(message: string, kind: "http" | "network" | "parse", status?: number, resetAt?: number) {
    super(message);
    this.name = "XError";
    this.kind = kind;
    this.status = status;
    this.resetAt = resetAt;
  }
}

export interface XPost {
  id: string;
  text: string; // truncated for long posts – prefer note_tweet.text when present
  author_id: string;
  created_at: string; // ISO
  lang?: string;
  conversation_id?: string;
  note_tweet?: { text: string };
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    impression_count?: number;
  };
  referenced_tweets?: { type: "retweeted" | "quoted" | "replied_to"; id: string }[];
  entities?: { urls?: { url: string; expanded_url?: string }[] };
}

export interface XUser {
  id: string;
  username: string;
  name: string;
  verified?: boolean;
  verified_type?: string; // "blue" | "business" | "government" | "none"
  description?: string;
  public_metrics?: { followers_count: number };
}

interface ApiResponse<T> {
  data?: T;
  meta?: { newest_id?: string; oldest_id?: string; result_count?: number; next_token?: string };
  errors?: { title?: string; detail?: string; message?: string }[];
}

export interface SearchPage {
  posts: XPost[];
  newestId: string | undefined;
  nextToken: string | undefined;
}

const TWEET_FIELDS = "created_at,author_id,lang,conversation_id,public_metrics,referenced_tweets,entities,note_tweet";
const USER_FIELDS = "username,name,verified,verified_type,description,public_metrics";

export interface XClientOptions {
  bearerToken?: string; // defaults to process.env.X_BEARER_TOKEN
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  minIntervalMs?: number; // spacing between requests
}

export class XClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly queue: RequestQueue;

  constructor(opts: XClientOptions = {}) {
    const token = opts.bearerToken ?? process.env.X_BEARER_TOKEN;
    if (!token) throw new Error("X_BEARER_TOKEN is not set");
    this.token = token;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.queue = new RequestQueue(log, opts.minIntervalMs ?? 1100);
  }

  // Posts from the last 7 days matching `query` (X search syntax, e.g. "(from:Reuters) Iran -is:retweet").
  async searchRecent(p: {
    query: string;
    sinceId?: string | undefined;
    startTime?: string | undefined; // ISO; ignored by X when sinceId is set
    maxResults?: number; // 10–100 per page
    nextToken?: string | undefined;
  }): Promise<SearchPage> {
    const body = await this.get<XPost[]>("/2/tweets/search/recent", {
      query: p.query,
      since_id: p.sinceId,
      start_time: p.sinceId ? undefined : p.startTime,
      max_results: Math.min(100, Math.max(10, p.maxResults ?? 100)),
      next_token: p.nextToken,
      "tweet.fields": TWEET_FIELDS, // no expansions: they would be billed as extra reads
    });
    return {
      posts: body.data ?? [],
      newestId: body.meta?.newest_id,
      nextToken: body.meta?.next_token,
    };
  }

  // Profile and verification status of up to 100 accounts.
  async usersByUsernames(usernames: string[]): Promise<XUser[]> {
    const body = await this.get<XUser[]>("/2/users/by", {
      usernames: usernames.join(","),
      "user.fields": USER_FIELDS,
    });
    return body.data ?? [];
  }

  // --- core ---

  private get<T>(path: string, params: Record<string, string | number | undefined>): Promise<ApiResponse<T>> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return withRetry(() => this.queue.run(1, () => this.request<T>(url)), {
      maxRetries: this.maxRetries,
      log,
      label: path,
      // A short 429 wait is pushed into the queue, so retry right away; long windows fail fast.
      isRetryable: (e) => {
        const err = e as XError;
        if (err.status === 429) return (err.resetAt ?? Infinity) - Date.now() <= MAX_RATE_LIMIT_WAIT_MS;
        return err.kind === "network" || (err.kind === "http" && (err.status ?? 0) >= 500);
      },
      delayMs: (e, attempt) => ((e as XError).status === 429 ? 0 : 2 ** attempt * 1000 + Math.random() * 250),
    });
  }

  private async request<T>(url: URL): Promise<ApiResponse<T>> {
    const path = url.pathname;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      log.warn("api request failed", { path, ms: Date.now() - started, error: e });
      throw new XError(`Network error/timeout: ${(e as Error).message}`, "network");
    }

    let body: ApiResponse<T> & { title?: string; detail?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      if (!res.ok) throw new XError(`HTTP ${res.status}`, "http", res.status);
      throw new XError("Invalid JSON in response", "parse");
    }

    if (!res.ok) {
      const message = body.detail ?? body.title ?? body.errors?.[0]?.message ?? `HTTP ${res.status}`;
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-rate-limit-reset")); // UNIX seconds
        const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
        if (resetAt) this.queue.delayUntil(resetAt);
        log.warn("rate limited", { path, resetAt: resetAt && new Date(resetAt).toISOString() });
        const when = resetAt ? ` until ${new Date(resetAt).toISOString()}` : "";
        throw new XError(`Rate limited${when}: ${message}`, "http", 429, resetAt);
      }
      log.warn("api request failed", { path, status: res.status, ms: Date.now() - started, error: message });
      throw new XError(message, "http", res.status);
    }

    // Partial errors (e.g. one of several usernames not found) come with HTTP 200.
    if (body.errors?.length) {
      log.debug("partial errors", { path, errors: body.errors.map((e) => e.detail ?? e.message) });
    }
    log.info("api request", { path, status: res.status, results: body.meta?.result_count, ms: Date.now() - started });
    return body;
  }
}
