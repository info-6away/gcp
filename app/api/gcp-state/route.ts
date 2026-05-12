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

// v12.0.5: defensive classification normalizer. Engine currently
// returns the classification at the top level, but we tolerate
// `{ data: <classification> }`, `{ classification: ... }`, and
// `{ result: ... }` envelopes so the proxy survives any future
// SDK / Engine API contract drift without silent null returns.
// Returns null when nothing usable was found — caller must handle.
function normalizeClassification(raw: unknown): GcpStateResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  // Direct shape — preferred.
  if (typeof obj.stateCode === 'string') {
    return obj as unknown as GcpStateResponse;
  }
  // Common wrapper shapes — try each in turn, return the first that
  // has a stateCode at its top level.
  const candidates: Array<unknown> = [
    obj.classification,
    obj.data,
    obj.result,
    obj.response,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object'
        && typeof (c as Record<string, unknown>).stateCode === 'string') {
      return c as unknown as GcpStateResponse;
    }
  }
  return null;
}

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
  // v12.0.5: SDK returned a body we could not normalize into a
  // GcpStateResponse — the classification was missing the stateCode
  // field after trying every known unwrap location. Distinct from
  // engine_unavailable because the Engine IS reachable; the shape
  // contract is what broke.
  | 'invalid_classification_shape'
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
  // v12.0.4: also read `source` (button name) for traceability — both
  // manual + source fields are stripped before forwarding to the SDK.
  const isManual  = !!(body && typeof body === 'object'
    && (body as { manual?: unknown }).manual === true);
  const reqSource = body && typeof body === 'object'
    ? String((body as { source?: unknown }).source ?? 'unknown')
    : 'unknown';

  if (process.env.NODE_ENV !== 'production') {
    console.log('[gcp-state] incoming', { manual: isManual, source: reqSource });
  }

  if (!isManual) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[gcp-state] blocked non-manual request', { source: reqSource });
    }
    return errorEnvelope(
      403,
      'manual_required',
      'Engine calls require a deliberate user trigger; auto-loop requests are blocked by the server-side cost gate.',
    );
  }
  // Strip `manual` + `source` before forwarding — the SDK + Engine
  // don't expect either (they're GCP-Pro-internal cost-gate metadata).
  const payload = (() => {
    if (!body || typeof body !== 'object') return body as GcpStateRequest;
    const {
      manual: _manual,
      source: _source,
      ...rest
    } = body as Record<string, unknown>;
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
    const raw = await engine.classifyGcpState(payload) as unknown;

    // v12.0.5: raw response diagnostics. Engine admin logs proved the
    // server is returning valid classification bodies, but the
    // frontend was seeing classify_returned_null. Log the raw shape
    // BEFORE any unwrap / cache step so we can compare exactly what
    // the SDK handed back vs what we forward to the client.
    if (process.env.NODE_ENV !== 'production') {
      const r = (raw ?? {}) as Record<string, unknown>;
      console.log('[ENGINE PROXY] raw response', {
        type:              typeof raw,
        isNull:            raw === null,
        isUndefined:       raw === undefined,
        keys:              raw && typeof raw === 'object' ? Object.keys(r) : [],
        hasStateCode:      !!r.stateCode,
        hasState:          !!r.state,
        hasData:           !!r.data,
        hasClassification: !!r.classification,
        hasResult:         !!r.result,
        hasResponse:       !!r.response,
      });
    }

    // v12.0.5: normalize. The Engine currently returns the classification
    // directly at the top level, BUT we tolerate two common
    // pre-existing wrappers (`.classification`, `.data`, `.result`)
    // before falling back to the body itself. Any of them is valid as
    // long as a `stateCode` lands at the normalized top level. If none
    // does, we throw — never silently return null / undefined.
    const normalized = normalizeClassification(raw);
    if (!normalized || !normalized.stateCode) {
      const r = (raw ?? {}) as Record<string, unknown>;
      throw new Error(
        `Invalid Engine classification shape — no stateCode at top level or in {data,classification,result}. Got keys: [${
          raw && typeof raw === 'object' ? Object.keys(r).join(', ') : 'none'
        }]`,
      );
    }

    lastClassificationCache.put(CACHE_KEY, normalized);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[ENGINE PROXY] normalized response', {
        stateCode:  normalized.stateCode,
        state:      normalized.state,
        phase:      normalized.phase,
        confidence: normalized.confidence,
        keys:       Object.keys(normalized as Record<string, unknown>),
        model:      normalized._meta?.model     ?? null,
        provider:   normalized._meta?.provider  ?? null,
        latencyMs:  normalized._meta?.latencyMs ?? null,
      });
    }
    return NextResponse.json(normalized, {
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
    } else if (err instanceof Error
        && err.message.startsWith('Invalid Engine classification shape')) {
      // v12.0.5: thrown by the normalizer above when the Engine
      // response has no stateCode at any known unwrap location.
      // Distinct from engine_unavailable — Engine IS reachable; the
      // schema contract is what failed.
      type = 'invalid_classification_shape';
      httpStatus = 502;
      message = err.message;
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
