import { NextResponse } from 'next/server';
import {
  EngineBudgetExceededError,
  EngineError,
  EngineProviderUnavailableError,
  EngineRateLimitedError,
  EngineRouteMissingError,
  EngineUnavailableError,
  type GcpStateRequest,
  type GcpStateResponse,
} from '@/lib/engine-sdk';
import {
  getEngineClient,
  getEngineEnv,
  isEngineConfigured,
  lastClassificationCache,
} from '@/lib/engineClient';

// v12.0.0 — Server proxy for the 6away Engine /v1/coherence/gcp-state
// endpoint, driven by the Engine SDK (EngineClient).
//
// v12.0.3 — Restructured failure paths. Every non-success now returns
// `{ ok: false, error: { type, message, status, provider, model } }`
// alongside the HTTP status code so the frontend can render a
// meaningful "ENGINE OFFLINE" message instead of falling through to a
// null. Also exposes the [ENGINE PROXY] diagnostic so the dev console
// shows env presence + payload keys + resolved URL on every call.
//
// Boundary (unchanged): GCP Pro owns ingestion, payload construction,
// anchor / shockDecay / transition / pressure / stance / history.
// The Engine only owns classification + routing + memory + status.

// Vercel function ceiling. Must exceed the SDK timeout (35s) + a small
// buffer so the SDK's timeout fires before Vercel kills us.
export const maxDuration = 40;

// Cache key. Task-level granularity; per-(symbol,tf) staleness would
// mean a cache miss on every symbol switch.
const CACHE_KEY    = 'gcp_state';
const ENGINE_PATH  = '/v1/coherence/gcp-state';

// Stable error-type tags surfaced in the proxy response envelope.
// These are GCP-Pro-facing values; the SDK's class names map onto
// these so the frontend has a single switch to render copy.
type ProxyErrorType =
  | 'manual_required'
  | 'bad_request'
  | 'engine_unavailable'
  | 'engine_forbidden'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'route_missing'
  | 'provider_unavailable'
  | 'config_missing'
  | 'unknown_error';

interface ProxyErrorEnvelope {
  ok:       false;
  error: {
    type:      ProxyErrorType;
    message:   string;
    status:    number | null;
    provider:  string | null;
    model:     string | null;
  };
}

function errorEnvelope(
  httpStatus: number,
  type:       ProxyErrorType,
  message:    string,
  extra: {
    status?:   number | null;
    provider?: string | null;
    model?:    string | null;
  } = {},
): NextResponse {
  const body: ProxyErrorEnvelope = {
    ok: false,
    error: {
      type,
      message,
      status:   extra.status   ?? null,
      provider: extra.provider ?? null,
      model:    extra.model    ?? null,
    },
  };
  return NextResponse.json(body, {
    status:  httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// Stale-cache success response. Returns the cached body + the proxy's
// stale diagnostics; never an error envelope.
function staleSuccess(reason: ProxyErrorType): NextResponse | null {
  const cached = lastClassificationCache.get(CACHE_KEY);
  if (!cached) return null;
  const ageMs = Date.now() - cached.capturedAt;
  const body = {
    ...cached.response,
    _meta:       cached.meta ?? undefined,
    stale:       true as const,
    staleReason: reason,
    staleAgeMs:  ageMs,
  };
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: Request) {
  // v12.0.3 step 1 — env + config diagnostics. Runs ONCE per call,
  // before any side effects, so the dev console shows what the server
  // is actually seeing. Never logs the API key value; only its
  // presence + length so a "key not set" vs "key truncated" vs "key
  // OK" triage is one log away.
  const env = getEngineEnv();
  const apiKeyLen = env.apiKey?.length ?? 0;
  // We can't read the resolved env-name through getEngineEnv (it dedupes
  // the lookup); re-read here only so the diagnostic shows which name
  // the value actually came from.
  const resolvedBaseUrlName =
    process.env.ENGINE_BASE_URL ? 'ENGINE_BASE_URL'
    : process.env.GCP_ENGINE_BASE_URL ? 'GCP_ENGINE_BASE_URL'
    : null;
  const resolvedApiKeyName =
    process.env.ENGINE_API_KEY ? 'ENGINE_API_KEY'
    : process.env.GCP_ENGINE_API_KEY ? 'GCP_ENGINE_API_KEY'
    : null;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    console.warn('[ENGINE PROXY]', { stage: 'parse_body_failed' });
    return errorEnvelope(400, 'bad_request', 'Request body was not valid JSON.');
  }

  if (process.env.NODE_ENV !== 'production') {
    const p = (body ?? {}) as Record<string, unknown>;
    console.log('[ENGINE PROXY]', {
      hasBaseUrl:        !!env.baseUrl,
      hasApiKey:         !!env.apiKey,
      apiKeyLen,
      baseUrl:           env.baseUrl,
      resolvedBaseUrlName,
      resolvedApiKeyName,
      finalUrl:          env.baseUrl ? `${env.baseUrl}${ENGINE_PATH}` : null,
      payloadKeys:       Object.keys(p),
      hasPatternStory:   !!p.patternStory,
      hasPriorState:     !!p.priorState,
      manual:            !!p.manual,
    });
  }

  if (!isEngineConfigured()) {
    // Fall through to cache if we have one — a misconfigured server is
    // identical to a network outage from the client's POV.
    const stale = staleSuccess('config_missing');
    if (stale) return stale;
    return errorEnvelope(
      503,
      'config_missing',
      'Engine is not configured on the server (ENGINE_BASE_URL / ENGINE_API_KEY missing).',
    );
  }

  // v11.18.5 carry-over: refuse anything that isn't an explicit user
  // run. The Engine cost gate lives ABOVE the SDK — we never want a
  // background auto-loop firing classifications even if the SDK +
  // Engine would gladly accept them. Auto-loop runCall(false) is
  // expected to land here; the structured envelope makes it explicit.
  const isManual = !!(body && typeof body === 'object'
    && (body as { manual?: unknown }).manual === true);
  if (!isManual) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[gcp-state] blocked non-manual request');
    }
    return errorEnvelope(
      403,
      'manual_required',
      'Engine calls require a deliberate user trigger; auto-loop requests are blocked by the server-side cost gate.',
    );
  }
  // Strip `manual` before forwarding — the SDK + Engine don't expect
  // it (and the field is GCP-Pro-internal anyway).
  const payload = (() => {
    if (!body || typeof body !== 'object') return body as GcpStateRequest;
    const { manual: _manual, ...rest } = body as Record<string, unknown>;
    return rest as GcpStateRequest;
  })();

  // v12.0.3 step 1 — pre-call payload trace. Stays in dev only so prod
  // logs don't fill with payloads.
  if (process.env.NODE_ENV !== 'production') {
    const p = payload as Record<string, unknown>;
    console.log('[gcp-state] forwarding to engine', {
      finalUrl:         `${env.baseUrl}${ENGINE_PATH}`,
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
    if (process.env.NODE_ENV !== 'production') {
      console.log('[ENGINE PROXY] success', {
        stateCode:  result.stateCode,
        confidence: result.confidence,
        model:      result._meta?.model     ?? null,
        provider:   result._meta?.provider  ?? null,
        latencyMs:  result._meta?.latencyMs ?? null,
      });
    }
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    // Map the typed SDK error → typed proxy error envelope. Each
    // branch tries the cache first; only fall through to a hard fail
    // when nothing is cached. Always log for ops triage.
    let type: ProxyErrorType  = 'unknown_error';
    let httpStatus            = 502;
    let status: number | null = null;
    let provider: string | null = null;
    let model: string | null = null;
    let message               = 'Engine classification failed.';

    if (err instanceof EngineBudgetExceededError) {
      type = 'budget_exceeded';
      httpStatus = 429;
      status = err.status;
      message = err.message || 'Engine budget exceeded.';
    } else if (err instanceof EngineRateLimitedError) {
      type = 'rate_limited';
      httpStatus = 429;
      status = err.status;
      message = err.message || 'Engine rate-limited.';
    } else if (err instanceof EngineRouteMissingError) {
      type = 'route_missing';
      httpStatus = 503;
      status = err.status;
      message = err.message || 'No routing rule configured for gcp_state on this workspace.';
    } else if (err instanceof EngineProviderUnavailableError) {
      type = 'provider_unavailable';
      httpStatus = 503;
      status = err.status;
      message = err.message || 'Engine provider unavailable.';
    } else if (err instanceof EngineUnavailableError) {
      type = 'engine_unavailable';
      httpStatus = 502;
      status = err.status;
      message = err.message || `Engine call ${err.cause}.`;
    } else if (err instanceof EngineError) {
      // Generic EngineError covers 401 / 403 / other non-2xx not
      // narrowed by classifyResponseError — auth/config failures
      // surface here. Map to engine_forbidden when status is 401/403
      // for a cleaner UI label.
      status = err.status;
      if (err.status === 401 || err.status === 403) {
        type = 'engine_forbidden';
        httpStatus = 403;
        message = err.message || 'Engine refused the request (auth / route).';
      } else {
        type = 'unknown_error';
        httpStatus = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
        message = err.message || `Engine returned HTTP ${err.status ?? '???'}.`;
      }
    }

    console.warn('[ENGINE PROXY] failed', {
      class:   err instanceof Error ? err.constructor.name : typeof err,
      type,
      status,
      message,
    });

    const stale = staleSuccess(type);
    if (stale) return stale;
    return errorEnvelope(httpStatus, type, message, { status, provider, model });
  }
}

// Type-only re-exports so consumers in this repo can keep importing
// the Engine SDK response shape from a stable surface.
export type { GcpStateResponse };
export type { ProxyErrorEnvelope };
