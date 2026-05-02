'use client';

// Browser-side helper for calling the 6away Engine /v1/coherence/gcp-state
// endpoint. Goes through the GCP Pro Next.js proxy at /api/gcp-state so the
// Engine API key never enters the client bundle.

export type GcpStatePayload = {
  symbol:        string;
  timeframe:     string;
  windowMinutes: number;

  current: {
    netVariance: number;
    regime:      string;
    regimeName:  string;
  };

  series: Array<{ t: number; v: number }>;

  metrics: {
    slope:                number;
    curvature:            number;
    ced:                  number;
    compressionDuration:  number;
    oscillationTightness: number;
    pss:                  number;
  };

  recentPatterns: Array<{
    patternCode: string;
    patternName: string;
    tStart:      number;
    confidence:  number;
    pss?:        number;
  }>;

  goldContext?: {
    trend:      'up' | 'down' | 'sideways' | 'unknown';
    return15m?: number;
    return30m?: number;
    return60m?: number;
  };

  // v11.14: prior classification carried forward so the Engine can
  // detect state transitions instead of only point-in-time labels.
  priorState?: {
    state:      string;
    stateCode:  string;
    direction:  string;
    phase:      string;
    confidence: number;
  };

  // v11.21: timeframe context — tells the Engine what time scale the
  // user is looking at vs the time scale the analysis applies to.
  // No Engine code change required; this is metadata + UI clarity.
  timeframeContext?: {
    chartTf:        string;
    analysisTf:     string;
    forwardHorizon: string;
  };

  // v11.23.1: optional GCP feed-quality flag. The Engine can use it
  // to lower confidence when the feed has gaps or staleness; if
  // ignored, no behavioural change. Tiny token impact.
  gcpQuality?: {
    stale:            boolean;
    lastUpdateAgeSec: number;
    gapCount:         number;
    largestGapSec:    number;
  };
};

export type GcpStateResponse = {
  state:
    | 'Compression State'
    | 'Dead Drift'
    | 'Ignition State'
    | 'Alignment Trend'
    | 'Synchronization State'
    | 'Climax State'
    | 'Shock State'
    | 'Failed Alignment State'
    | 'Discharge State';

  stateCode:
    | 'CS' | 'DD' | 'IS' | 'AT' | 'SS'
    | 'CL' | 'SH' | 'FA' | 'DS';

  direction: 'Up' | 'Down' | 'Neutral' | 'Mixed';
  phase:     'Early' | 'Mid' | 'Late' | 'Exhausted';

  strength:   number;
  confidence: number;

  coherenceType:
    | 'Compression' | 'Continuation' | 'Exhaustion'
    | 'Shock' | 'Noise' | 'Reversal Risk';

  marketBias:         string;
  goldInterpretation: string;
  reasoningShort:     string;
  invalidators:       string[];
  watchNext:          string[];
};

export async function classifyGcpState(
  payload: GcpStatePayload,
  opts: { manual?: boolean } = {},
): Promise<GcpStateResponse | null> {
  // v11.18.5: server-side kill switch. The proxy refuses any request
  // that doesn't explicitly mark itself as a manual run, so the LLM
  // is never invoked unless the user clicked RUN AI ANALYSIS. Stale
  // tabs / old PWAs / cached JS still firing the auto-loop will be
  // blocked at the proxy with `manual_required`. Only set the flag
  // when the caller passes manual: true.
  const body: unknown = opts.manual === true
    ? { ...payload, manual: true }
    : payload;

  const serialized = JSON.stringify(body);

  // v11.18.6: dev-only payload diagnostic. Logs JSON byte size, series
  // length, patterns length, and top-level keys before the request
  // fires so the user can confirm the trimmed shape is actually being
  // sent. Warns if the payload exceeds 10 KB — a real signal that
  // something upstream is over-feeding the Engine.
  if (process.env.NODE_ENV !== 'production') {
    const bytes = new Blob([serialized]).size;
    const seriesLen   = Array.isArray(payload.series) ? payload.series.length : 0;
    const patternsLen = Array.isArray(payload.recentPatterns) ? payload.recentPatterns.length : 0;
    const keys = Object.keys(payload as Record<string, unknown>);
    console.log(
      `[AI STATE] payload size: ${bytes} bytes · series ${seriesLen} · patterns ${patternsLen} · keys [${keys.join(', ')}]`,
    );
    if (bytes > 10_240) {
      console.warn(`[AI STATE] payload too large (${bytes} bytes) — expected < 10 KB`);
    }
  }

  try {
    const res = await fetch('/api/gcp-state', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    serialized,
      // Has to exceed the proxy + Engine ceiling. Engine maxDuration=45s,
      // proxy timeout=35s, so 40s here means the client waits long enough
      // for the proxy's own 35s timeout to fire and return a clean 502
      // envelope rather than the client aborting first and discarding it.
      signal:  AbortSignal.timeout(40_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    // v11.14a: the proxy returns { ok: false, error } envelopes on
    // failure paths. Recognise the envelope shape and treat it as
    // null even if it arrives with a 2xx status.
    if ((data as { ok?: boolean }).ok === false) return null;
    return data as GcpStateResponse;
  } catch {
    return null;
  }
}
