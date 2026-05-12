'use client';

// v11.15: shared helpers for surfacing AI State (from useGcpState) into
// the UI. Includes:
//   - useStableAiState: caches the prior reference unless stateCode /
//     phase changed or confidence moved more than 5%. Stops the badge
//     and the dashboard card flickering on every 25 s poll when the
//     classification is essentially unchanged. Also preserves prior
//     state when the live value goes null (Engine error path) so the
//     UI never blanks.
//   - directionArrow / directionColor: per-direction visual mapping.
//   - stateAccent: per-state colour override. Shock and Failed Alignment
//     are red regardless of direction; Compression / Ignition / Climax
//     borrow regime colours so the "environment" matches what the user
//     already sees on the chart.
//   - DEFAULT_INTERPRETATION: short copy fallback per state code, used
//     when the Engine returns no reasoningShort.

import { useRef } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';

const CONFIDENCE_DELTA = 0.05;

export function useStableAiState(
  raw: GcpStateResponse | null,
): GcpStateResponse | null {
  const stableRef = useRef<GcpStateResponse | null>(null);

  // Engine error path — useGcpState already preserves prior state on
  // failure, but a fresh mount before any success starts at null. Hold
  // whatever we last stabilised; never blank.
  if (raw == null) return stableRef.current;

  const prev = stableRef.current;
  const meaningful =
    !prev ||
    prev.stateCode !== raw.stateCode ||
    prev.phase !== raw.phase ||
    Math.abs(prev.confidence - raw.confidence) > CONFIDENCE_DELTA;

  if (meaningful) stableRef.current = raw;
  return stableRef.current;
}

export type Direction = GcpStateResponse['direction'];
export type StateCode = GcpStateResponse['stateCode'];

export function directionArrow(d: Direction): string {
  if (d === 'Up')   return '↑';
  if (d === 'Down') return '↓';
  return '→';
}

// Per-state accent overrides direction colour where the state itself
// carries strong meaning (Shock = red, Failed Alignment = red, etc.).
// Returns null to fall back to direction-based colour.
function stateAccent(code: StateCode): string | null {
  switch (code) {
    case 'SH': return 'var(--red)';            // Shock
    case 'FA': return 'var(--red)';            // Failed Alignment
    case 'CL': return '#d46428';               // Climax (regime E)
    case 'CS': return '#4dd9e8';               // Compression (cyan)
    case 'IS': return '#4dd9e8';               // Ignition (cyan)
    case 'DD': return 'var(--fg-3)';           // Dead Drift (neutral)
    case 'DS': return '#d4a028';               // Discharge (amber)
    // v12.1: Plateau State — muted violet / silver-blue. Caution, not
    // failure: distinct from SS (sync, cyan) and CL (climax, orange).
    case 'PS': return '#8a8fb8';
    default:   return null;
  }
}

export function directionColor(d: Direction): string {
  if (d === 'Up')   return 'var(--green)';
  if (d === 'Down') return 'var(--red)';
  return 'var(--fg-3)';
}

export function stateColor(state: GcpStateResponse): string {
  return stateAccent(state.stateCode) ?? directionColor(state.direction);
}

export const DEFAULT_INTERPRETATION: Record<StateCode, string> = {
  CS: 'Energy compressing. Range-building before a release.',
  DD: 'Low coherence. Market inactive — avoid positioning.',
  IS: 'Ignition forming. Watch for confirmation into alignment.',
  AT: 'Trend environment. Continuation favoured.',
  SS: 'Synchronization peaking. Strongest trend zone.',
  CL: 'Climax burst. Volatility spike — exhaustion possible.',
  SH: 'Shock event. Expect extreme volatility either way.',
  FA: 'Sync attempt failed. Mean-reversion / fade setup.',
  DS: 'Trend discharging. Momentum fading.',
  // v12.1: local overlay — synchronization that has matured into a
  // saturated plateau. Direction is fragile, exposure should be
  // managed; not a failure but not a fresh-entry zone either.
  PS: 'Synchronized coherence has matured into plateau; direction is fragile.',
};
