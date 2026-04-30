// Build the request body the Engine /v1/coherence/gcp-state endpoint
// expects. Returns null when the input would fail server-side validation
// (e.g. fewer than 10 series points), so the hook can skip the call
// entirely instead of triggering a 400.
//
// v11.18.4: aggressive token-cost reduction. Each Engine call was
// running ~7-8k input tokens, dominated by:
//   - long NV series (60-120 points) with full-precision values
//   - all six metric fields with 6-12 decimal places
//   - up to 3 patterns with name, tStart, confidence, pss
//   - gold context with multiple return windows
// Goal is < 1.5k tokens per call. We can't drop required schema fields
// without breaking the Engine, so we reduce point counts and round
// every numeric to its useful precision (NV to 1 dp, slope/curvature
// to 4 dp, confidence to 3 dp). The Engine still receives every field
// it validates against; the values are just a lot shorter.

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

  windowMinutes?: number; // override; default = min(15, series.length)

  // v11.14: previous Engine classification, injected by useGcpState
  // from its own state via a ref. The builder forwards a flattened
  // priorState struct so the Engine sees the prior label without
  // having to ingest the full prior response.
  previousState?: GcpStateResponse | null;
}

export const ENGINE_MIN_SERIES = 10;

// v11.18.4 helpers — round to fixed precision and back to a number so
// JSON.stringify emits short literals (e.g. 107.4 instead of
// 107.42857142857143).
const r = (n: number, dp: number): number => +n.toFixed(dp);

export function buildGcpStatePayload(
  inputs: GcpStateInputs,
): GcpStatePayload | null {
  const { series, metrics, regime, recentPatterns, goldContext } = inputs;
  if (!Array.isArray(series) || series.length < ENGINE_MIN_SERIES) return null;

  const last = series[series.length - 1];
  if (!last || typeof last.v !== 'number') return null;

  // v11.18.4: window slashed from 30 to 15. Engine validates min 10,
  // so 15 stays above the floor and 15 NV ticks is enough to recognise
  // local shape (slope / curvature / compression / coil) at the time
  // resolution we use. Series length is the largest single contributor
  // to token cost, so this matters most.
  const win = Math.min(
    inputs.windowMinutes ?? 15,
    series.length,
  );
  // Round t to integer (no fractional ms) and v to 1 dp (NV scale is
  // 0-300; one decimal is plenty for trend/curvature evaluation).
  const slice = series.slice(-win).map(p => ({
    t: Math.round(p.t),
    v: r(p.v, 1),
  }));

  return {
    symbol:        inputs.symbol,
    timeframe:     inputs.timeframe,
    windowMinutes: win,
    current: {
      netVariance: r(last.v, 1),
      regime:      regime.code,
      regimeName:  regime.name,
    },
    series: slice,
    // Engine requires all six metric fields. Round every value so
    // long-tail decimal noise doesn't bloat the payload.
    metrics: {
      slope:                r(metrics.slope,                4),
      curvature:            r(metrics.curvature,            4),
      ced:                  r(metrics.ced,                  4),
      compressionDuration:  r(metrics.compressionDuration,  2),
      oscillationTightness: r(metrics.oscillationTightness, 4),
      pss:                  r(metrics.pss,                  3),
    },
    // v11.18.4: only the most-recent pattern (was 2). One pattern is
    // enough context for the Engine to factor "what just happened" into
    // the classification; older patterns rarely shift the answer.
    recentPatterns: recentPatterns.slice(-1).map(p => ({
      patternCode: p.patternCode,
      patternName: p.patternName,
      tStart:      Math.round(p.tStart),
      confidence:  r(p.confidence, 3),
      pss:         p.pss != null ? r(p.pss, 3) : undefined,
    })),
    // v11.18.4: gold context reduced to trend only. The numeric returns
    // (15m/30m/60m) added 4-6 fields per call but the Engine's prompt
    // mainly uses the discrete up/down/sideways label anyway.
    goldContext: goldContext ? { trend: goldContext.trend } : undefined,
    priorState: inputs.previousState ? {
      state:      inputs.previousState.state,
      stateCode:  inputs.previousState.stateCode,
      direction:  inputs.previousState.direction,
      phase:      inputs.previousState.phase,
      confidence: r(inputs.previousState.confidence, 3),
    } : undefined,
  };
}
