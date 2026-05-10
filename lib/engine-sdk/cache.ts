/**
 * Phase 11A — Last-classification cache.
 *
 * Tiny in-memory cache that lets a calling app (e.g. GCP Pro) keep
 * showing the most recent successful Engine classification while the
 * Engine is degraded or unreachable, marked as "stale" so the UI can
 * communicate that to the user.
 *
 * Design notes:
 *   - Per-key (default key = task name) so callers can hold separate
 *     entries for different (symbol, timeframe) tuples without
 *     building their own keying.
 *   - In-memory only. Survives a single Node/serverless invocation,
 *     not a process restart. Persisting across restarts is a caller
 *     concern (localStorage on the browser, Redis/KV on the server).
 *     The Engine SDK stays storage-agnostic.
 *   - Keeps `_meta` next to the response so the diagnostics panel can
 *     show "last good run on Sonnet at 14:02" while the panel is in
 *     degraded mode.
 *
 * The cache is intentionally NOT used to suppress fresh Engine calls.
 * Callers always try the Engine first; the cache is the fallback the
 * UI falls back to if the Engine throws/degrades.
 */

import type { ClassificationMeta, GcpStateResponse } from "./types";

export type CachedClassification = {
  /** Cache key, e.g. `"gcp_state"` or `"gcp_state:BTC:1h"`. */
  key: string;
  /** Wall-clock timestamp of when this entry was written. */
  capturedAt: number;
  /** The validated response body (without `_meta`). */
  response: Omit<GcpStateResponse, "_meta">;
  /** Whatever `_meta` block came back, if any. */
  meta: ClassificationMeta | null;
};

/**
 * Minimal in-memory cache. Not exported directly — instances live
 * behind `LastClassificationCache`. Module-level `Map` would couple
 * different consumers and surprise anyone who instantiates two
 * EngineClients in the same process; an instance gives each app its
 * own scope.
 */
export class LastClassificationCache {
  private readonly entries = new Map<string, CachedClassification>();
  /** Default cap so a long-running app doesn't accumulate keys. */
  private readonly maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? 64);
  }

  /**
   * Record a successful classification. Strips `_meta` from the
   * domain payload and stores it next to it; that way callers can
   * reconstruct the exact response shape later, but the diagnostics
   * panel doesn't have to reach inside the response object.
   */
  put(key: string, response: GcpStateResponse): void {
    const { _meta, ...rest } = response;
    const entry: CachedClassification = {
      key,
      capturedAt: Date.now(),
      response: rest,
      meta: _meta ?? null,
    };
    // Light LRU: drop the oldest when over the cap. Map iteration
    // order is insertion order, so re-inserting the same key bumps
    // it to the most-recent slot only if we delete first.
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Read an entry (no mutation, no TTL — staleness is the caller's call). */
  get(key: string): CachedClassification | null {
    return this.entries.get(key) ?? null;
  }

  /**
   * Convenience — true when the entry exists AND is older than the
   * given threshold. The Engine itself doesn't pick a staleness
   * window; GCP Pro decides based on its own poll cadence (3-5min
   * is typical).
   */
  isStale(key: string, maxAgeMs: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    return Date.now() - entry.capturedAt > maxAgeMs;
  }

  /** Clear an entry. Useful on logout / workspace switch. */
  clear(key: string): void {
    this.entries.delete(key);
  }

  clearAll(): void {
    this.entries.clear();
  }
}
