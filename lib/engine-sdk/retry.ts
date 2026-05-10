import { EngineError, EngineRateLimitedError, EngineUnavailableError } from "./errors";

/**
 * Phase 10C — retry policy.
 *
 * Decision is deterministic given an error:
 *   - EngineUnavailableError (network / timeout / 5xx) → retry
 *   - EngineRateLimitedError → retry (the per-minute bucket may
 *     have rolled over by the time we back off + retry)
 *   - Anything else (4xx, budget_exceeded, route_missing,
 *     provider_unavailable) → no retry; deliberate failure
 *
 * Backoff is exponential with a 5s ceiling and ±20% jitter so
 * concurrent callers don't synchronise.
 */

export const MAX_BACKOFF_MS = 5_000;

export function isRetriable(err: unknown): boolean {
  if (err instanceof EngineUnavailableError) return true;
  if (err instanceof EngineRateLimitedError) return true;
  return false;
}

export function backoffFor(attempt: number, baseMs: number): number {
  // attempt is 0-indexed: 0 = first retry, 1 = second retry, …
  const exp = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exp, MAX_BACKOFF_MS);
  // ±20% jitter to spread synchronised callers.
  const jitter = capped * (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.round(capped + jitter));
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `fn` up to `retries + 1` times, sleeping `backoffFor(i, base)`
 * between attempts. Surfaces the FINAL error when all attempts
 * exhaust; surfaces non-retriable errors immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number; signal?: AbortSignal },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof EngineError) || !isRetriable(err)) {
        throw err;
      }
      if (attempt === opts.retries) break;
      await sleep(backoffFor(attempt, opts.baseDelayMs), opts.signal);
    }
  }
  // Type-narrowed: lastErr was set in the catch above before any throw.
  throw lastErr;
}
