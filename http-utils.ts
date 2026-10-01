// http-utils.ts – building blocks shared by the API clients:
// a serializing request queue with rate-limit spacing, retry with backoff, and a small TTL cache.

import type { Logger } from "./logger.ts";

// Serializes requests and spaces them out. After a request of weight W starts, the next one
// may start no earlier than W * msPerUnit later (e.g. Coinalyze counts every symbol as one call).
export class RequestQueue {
  private readonly log: Logger;
  private readonly msPerUnit: number;
  private queue: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(log: Logger, msPerUnit: number) {
    this.log = log;
    this.msPerUnit = msPerUnit;
  }

  run<T>(weight: number, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.nextAllowedAt - Date.now();
      if (wait > 0) {
        this.log.debug("throttling", { waitMs: wait });
        await sleep(wait);
      }
      this.nextAllowedAt = Date.now() + weight * this.msPerUnit;
      return fn();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  // Holds all queued requests until `atMs` (e.g. from a Retry-After header).
  delayUntil(atMs: number) {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, atMs);
  }
}

// Errors thrown by the clients carry `kind` and optionally `status`.
export interface ClassifiedError {
  kind: string;
  status?: number | undefined;
}

// Network errors, HTTP 429 and 5xx are worth retrying.
export function isTransient(e: unknown): boolean {
  const err = e as Partial<ClassifiedError>;
  return err.kind === "network" || (err.kind === "http" && (err.status === 429 || (err.status ?? 0) >= 500));
}

export interface RetryOptions {
  maxRetries: number;
  log: Logger;
  label: string; // shown in logs, e.g. the API path
  isRetryable?: (e: unknown) => boolean; // default: isTransient
  delayMs?: (e: unknown, attempt: number) => number; // default: exponential backoff with jitter
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? isTransient;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt >= opts.maxRetries) throw e;
      const delay = opts.delayMs?.(e, attempt) ?? 2 ** attempt * 1000 + Math.random() * 250;
      opts.log.warn("retrying", {
        path: opts.label, attempt: attempt + 1, of: opts.maxRetries, delayMs: Math.round(delay),
        error: (e as Error).message,
      });
      if (delay > 0) await sleep(delay);
      attempt++;
    }
  }
}

// In-memory cache with a per-entry TTL.
export class TtlCache {
  private readonly entries = new Map<string, { expiresAt: number; value: unknown }>();

  get<T>(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  set(key: string, value: unknown, ttlMs: number) {
    if (ttlMs > 0) this.entries.set(key, { expiresAt: Date.now() + ttlMs, value });
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
