// Build the request body the Engine /v1/coherence/gcp-state endpoint
// expects. Returns null when the input would fail server-side validation
// (e.g. fewer than 10 series points), so the hook can skip the call
// entirely instead of triggering a 400.

import type { GcpStatePayload } from './engine-gcp';

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

  windowMinutes?: number; // override; default = min(120, series.length)
}

export const ENGINE_MIN_SERIES = 10;

export function buildGcpStatePayload(
  inputs: GcpStateInputs,
): GcpStatePayload | null {
  const { series, metrics, regime, recentPatterns, goldContext } = inputs;
  if (!Array.isArray(series) || series.length < ENGINE_MIN_SERIES) return null;

  const last = series[series.length - 1];
  if (!last || typeof last.v !== 'number') return null;

  const win = Math.min(
    inputs.windowMinutes ?? 120,
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
    recentPatterns: recentPatterns.slice(-3).map(p => ({
      patternCode: p.patternCode,
      patternName: p.patternName,
      tStart:      p.tStart,
      confidence:  p.confidence,
      pss:         p.pss,
    })),
    goldContext,
  };
}
