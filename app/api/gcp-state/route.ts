import { NextResponse } from 'next/server';
import {
  EngineBudgetExceededError,
  EngineProviderUnavailableError,
  EngineRateLimitedError,
  EngineRouteMissingError,
  EngineUnavailableError,
  type GcpStateRequest,
  type GcpStateResponse,
} from '@/lib/engine-sdk';
import {
  getEngineClient,
  isEngineConfigured,
  lastClassificationCache,
} from '@/lib/engineClient';

// v12.0.0 — Server proxy for the 6away Engine /v1/coherence/gcp-state
// endpoint, now driven by the Engine SDK (EngineClient).
//
// Boundary (unchanged): GCP Pro owns ingestion, payload construction,
// anchor / shockDecay / transition / pressure / stance / history.
// The Engine only owns classification + routing + memory + status.
//
// What this route does now:
//   1. Read body (and the GCP-Pro-internal `manual` kill-switch flag).
//   2. Refuse non-manual calls — server-side spend gate, identical to
//      v11.18.5 behavior. Stale tabs / auto-loops can never reach the
//      LLM.
//   3. Strip `manual` before forwarding (SDK never sees it).
//   4. Call EngineClient.classifyGcpState(payload). The SDK handles
//      X-API-Key auth, exponential backoff retry on retryable failures,
//      and typed error classification.
//   5. On success, snapshot to LastClassificationCache for future
//      stale fallback, then return the body (with optional `_meta`).
//   6. On failure, try the cache. If a recent entry exists, return it
//      with `stale: true` + `staleReason` so the UI can show a degraded
//      banner without losing the last good read. If nothing is cached,
//      surface the typed error class to the client.
//
// SW behavior: this remains POST-only. The v11.11+ service worker only
// caches GET /api/* — no caching here.
//
// IMPORTANT: This file is a server route; it is the ONLY place in the
// app that imports lib/engineClient (which reads the API key). Never
// import either from a client component.

// Vercel function ceiling. Must exceed the SDK timeout (35s) + a small
// buffer so the SDK's timeout fires before Vercel kills us.
export const maxDuration = 40;

// Cache key. v12.0 keeps it at task-level granularity; per-(symbol,tf)
// staleness would mean a cache miss on every symbol switch. Caller's
// UI already deals with "no data yet" cleanly, so task-level is fine.
const CACHE_KEY = 'gcp_state';

// Caller-visible reason a response is being served from cache.
type StaleReason =
  | 'engine_unavailable'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'route_missing'
  | 'provider_unavailable'
  | 'config_missing'
  | 'unknown_error';

function fail(status: number, error = 'engine_unavailable', extra?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, error, ...(extra ?? {}) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

// Try to recover a stale entry. When found, return a 200 with the body
// + the diagnostics fields the UI expects. When not, return null and
// the caller surfaces the original failure.
function staleFallback(reason: StaleReason): NextResponse | null {
  const cached = lastClassificationCache.get(CACHE_KEY);
  if (!cached) return null;
  const ageMs = Date.now() - cached.capturedAt;
  const body = {
    ...cached.response,
    _meta: cached.meta ?? undefined,
    stale: true as const,
    staleReason: reason,
    staleAgeMs: ageMs,
  };
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: Request) {
  if (!isEngineConfigured()) {
    // Fall through to cache if we have one — a misconfigured server is
    // identical to a network outage from the client's POV.
    const stale = staleFallback('config_missing');
    return stale ?? fail(503, 'config_missing');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_request');
  }

  // v11.18.5 carry-over: refuse anything that isn't an explicit user
  // run. The Engine cost gate lives ABOVE the SDK — we never want a
  // background auto-loop firing classifications even if the SDK +
  // Engine would gladly accept them.
  const isManual = !!(body && typeof body === 'object'
    && (body as { manual?: unknown }).manual === true);
  if (!isManual) {
    console.warn('[gcp-state] blocked non-manual request');
    return fail(403, 'manual_required');
  }
  // Strip `manual` before forwarding — the SDK + Engine don't expect
  // it (and the field is GCP-Pro-internal anyway).
  const payload = (() => {
    if (!body || typeof body !== 'object') return body as GcpStateRequest;
    const { manual: _manual, ...rest } = body as Record<string, unknown>;
    return rest as GcpStateRequest;
  })();

  // v12.0.1: dev-only passthrough sanity log. Confirms patternStory /
  // priorPlan / gcpQuality / timeframeContext / priorState landed on
  // the request body and survived the manual-strip step. If any of
  // these surfaces as `false` and we're seeing FA regressions, the
  // payload builder upstream is the problem — not the SDK.
  if (process.env.NODE_ENV !== 'production') {
    const p = (payload ?? {}) as Record<string, unknown>;
    console.log('[gcp-state] forwarding keys', {
      keys:             Object.keys(p),
      hasPatternStory:  !!p.patternStory,
      hasPriorPlan:     !!p.priorPlan,
      hasGcpQuality:    !!p.gcpQuality,
      hasTimeframeCtx:  !!p.timeframeContext,
      hasPriorState:    !!p.priorState,
    });
  }

  const engine = getEngineClient();
  try {
    const result = await engine.classifyGcpState(payload);
    lastClassificationCache.put(CACHE_KEY, result);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    // Map the typed SDK error → stale reason. Each branch tries the
    // cache first; only fall through to a hard fail when nothing is
    // cached. Always log for ops triage.
    let reason: StaleReason = 'unknown_error';
    let httpStatus = 502;
    if (err instanceof EngineBudgetExceededError) {
      reason = 'budget_exceeded';
      httpStatus = 429;
    } else if (err instanceof EngineRateLimitedError) {
      reason = 'rate_limited';
      httpStatus = 429;
    } else if (err instanceof EngineRouteMissingError) {
      reason = 'route_missing';
      httpStatus = 503;
    } else if (err instanceof EngineProviderUnavailableError) {
      reason = 'provider_unavailable';
      httpStatus = 503;
    } else if (err instanceof EngineUnavailableError) {
      reason = 'engine_unavailable';
      httpStatus = 502;
    }
    console.warn('[gcp-state] engine call failed', {
      class:  err instanceof Error ? err.constructor.name : typeof err,
      reason,
      msg:    err instanceof Error ? err.message : String(err),
    });
    const stale = staleFallback(reason);
    if (stale) return stale;
    return fail(httpStatus, reason);
  }
}

// Type-only re-exports so consumers in this repo can keep importing
// the Engine SDK response shape from a stable surface.
export type { GcpStateResponse };
