// Build the request body the Engine /v1/coherence/gcp-state endpoint
// expects. Returns null when the input would fail server-side validation
// (e.g. fewer than 10 series points), so the hook can skip the call
// entirely instead of triggering a 400.

import type { GcpStatePayload, GcpStateResponse } from './engine-gcp';

export interface GcpStateInputs {
  symbol:    string;
  timeframe: string;

  series: Array<{ t: number; v: number }>;

  metrics: {
    slope:                number;
    curvature:            number;
    ced:                  number;
    compressionDuration:  number;
    oscillationTightness: number;
    pss:                  number;
  };

  regime: { code: string; name: string };

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

  windowMinutes?: number; // override; default = min(30, series.length)

  // v11.14: previous Engine classification, injected by useGcpState
  // from its own state via a ref. The builder forwards a flattened
  // priorState struct so the Engine sees the prior label without
  // having to ingest the full prior response.
  previousState?: GcpStateResponse | null;
}

export const ENGINE_MIN_SERIES = 10;

export function buildGcpStatePayload(
  inputs: GcpStateInputs,
): GcpStatePayload | null {
  const { series, metrics, regime, recentPatterns, goldContext } = inputs;
  if (!Array.isArray(series) || series.length < ENGINE_MIN_SERIES) return null;

  const last = series[series.length - 1];
  if (!last || typeof last.v !== 'number') return null;

  // v11.18.3: window slashed from 120 to 30 to cut LLM token cost.
  // The Engine prompt only needs enough series to recognise the local
  // shape; 30 minutes of NV ticks is sufficient for slope / curvature
  // / compression evaluation. Engine validates min 10, so 30 stays
  // well above the floor while shrinking the payload by ~75%.
  const win = Math.min(
    inputs.windowMinutes ?? 30,
    series.length,
  );
  const slice = series.slice(-win).map(p => ({ t: p.t, v: p.v }));

  return {
    symbol:        inputs.symbol,
    timeframe:     inputs.timeframe,
    windowMinutes: win,
    current: {
      netVariance: last.v,
      regime:      regime.code,
      regimeName:  regime.name,
    },
    series: slice,
    metrics: {
      slope:                metrics.slope,
      curvature:            metrics.curvature,
      ced:                  metrics.ced,
      compressionDuration:  metrics.compressionDuration,
      oscillationTightness: metrics.oscillationTightness,
      pss:                  metrics.pss,
    },
    // v11.18.3: trimmed to most-recent 2 patterns (was 3) for token cost.
    recentPatterns: recentPatterns.slice(-2).map(p => ({
      patternCode: p.patternCode,
      patternName: p.patternName,
      tStart:      p.tStart,
      confidence:  p.confidence,
      pss:         p.pss,
    })),
    goldContext,
    priorState: inputs.previousState ? {
      state:      inputs.previousState.state,
      stateCode:  inputs.previousState.stateCode,
      direction:  inputs.previousState.direction,
      phase:      inputs.previousState.phase,
      confidence: inputs.previousState.confidence,
    } : undefined,
  };
}
