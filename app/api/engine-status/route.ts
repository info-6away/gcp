import { NextResponse } from 'next/server';
import {
  buildEngineDiagnostics,
  type EngineDiagnosticsPanel,
  type EngineStatusResponse,
} from '@/lib/engine-sdk';
import {
  getEngineClient,
  isEngineConfigured,
  lastClassificationCache,
} from '@/lib/engineClient';

// v12.0.0 — Engine diagnostics proxy.
//
// Pulls /v1/status?task=gcp_state from the Engine via the SDK, then
// projects it (+ the most recent ClassificationMeta from the warm
// cache) into the EngineDiagnosticsPanel shape the UI binds to.
//
// Method: GET. Safe to cache no-store; the answer changes every call.
// The service worker only caches GET /api/* — so we explicitly disable
// caching via Cache-Control.
//
// Failure modes — all return 200 with `reachable: false` rather than
// throwing, so the Settings panel always has a shape to render:
//   - Engine env missing            → reachable=false
//   - Engine reachable but degraded → reachable=true, degraded[…]
//   - Engine unreachable            → reachable=false, lastError captured

export const maxDuration = 20;

const CACHE_KEY = 'gcp_state';
const TASK      = 'gcp_state';

export type EngineStatusEnvelope = {
  panel: EngineDiagnosticsPanel;
  /** Last classification age in ms (from the in-memory cache). null
   *  when this serverless instance hasn't successfully classified
   *  anything since cold-start. */
  lastClassificationAgeMs: number | null;
  /** A short error string when the Engine call itself threw — useful
   *  for the diagnostics panel to show "engine unreachable: timeout"
   *  rather than just "off". */
  lastError: string | null;
  /** Convenience surface for the panel — true when either env is
   *  missing on the server. */
  configured: boolean;
  timestamp: string;
};

export async function GET() {
  const now = new Date().toISOString();
  const configured = isEngineConfigured();

  // Always read the most recent meta from the cache so the panel can
  // show "last call was Sonnet 14:02" even when the engine is down.
  const cached = lastClassificationCache.get(CACHE_KEY);
  const lastClassificationAgeMs = cached ? Date.now() - cached.capturedAt : null;

  if (!configured) {
    const panel = buildEngineDiagnostics({
      status:    null,
      lastMeta:  cached?.meta ?? null,
    });
    const envelope: EngineStatusEnvelope = {
      panel,
      lastClassificationAgeMs,
      lastError: 'engine_not_configured',
      configured,
      timestamp: now,
    };
    return NextResponse.json(envelope, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  let status: EngineStatusResponse | null = null;
  let lastError: string | null = null;
  try {
    const engine = getEngineClient();
    status = await engine.getStatus(TASK, { timeoutMs: 8_000, retries: 1 });
  } catch (err) {
    // Don't blow up the panel — surface as "unreachable".
    lastError = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.warn('[engine-status] getStatus failed', lastError);
  }

  const panel = buildEngineDiagnostics({
    status,
    lastMeta: cached?.meta ?? null,
  });

  const envelope: EngineStatusEnvelope = {
    panel,
    lastClassificationAgeMs,
    lastError,
    configured,
    timestamp: now,
  };
  return NextResponse.json(envelope, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
