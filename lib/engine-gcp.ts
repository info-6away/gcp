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
): Promise<GcpStateResponse | null> {
  try {
    const res = await fetch('/api/gcp-state', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    return data as GcpStateResponse;
  } catch {
    return null;
  }
}
