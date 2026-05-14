// v13.7: Thesis Stability — replaces "Fragility" framing.
//
// Pre-v13.7 the 4-meter strip showed FRAGILITY: HIGH/MODERATE/LOW
// which read backwards (a "high" reading is bad). v13.7 inverts to
// THESIS STABILITY: HIGH/MED/LOW where high = good, low = bad.
//
// "How stable the current Guru thesis is" — answers the question
// "is this read trustworthy enough to act on?"
//
// Inputs:
//   - aiState.confidence — clarity of the environment read
//   - aiState.stateCode / phase — known-fragile states score lower
//   - aiState.invalidators — explicit invalidation conditions
//
// Pure derivation. Reads only the existing GcpStateResponse.

import type { GcpStateResponse } from '@/lib/engine-gcp';

export type ThesisStabilityLevel = 'HIGH' | 'MED' | 'LOW';

export interface ThesisStabilityRead {
  level:             ThesisStabilityLevel;
  /** 0..1 — high stability ⇒ high bar. Inverted from the old
   *  "fragility" framing. */
  bar:               number;
  /** Hex color: green for HIGH, amber MED, red LOW. */
  color:             string;
  /** One-line helper text — "thesis intact" / "some drift" / etc. */
  hint:              string;
  /** Number of invalidators currently listed on the response. */
  invalidatorCount:  number;
}

export function deriveThesisStability(
  aiState: GcpStateResponse | null,
): ThesisStabilityRead {
  if (!aiState) {
    return {
      level: 'LOW',
      bar:   0.20,
      color: '#7F98A3',
      hint:  'No Guru read yet',
      invalidatorCount: 0,
    };
  }
  const code      = aiState.stateCode;
  const phase     = aiState.phase;
  const conf      = aiState.confidence;
  const invs      = aiState.invalidators ?? [];
  const invCount  = invs.length;

  // Known-unstable / event-class states. These read as LOW regardless
  // of confidence — the environment itself is the destabilizing factor.
  const lowStates = new Set(['FA', 'SH', 'CL', 'DC']);
  if (lowStates.has(code)) {
    return {
      level: 'LOW',
      bar:   0.18,
      color: '#c45a5a',
      hint:  code === 'FA' ? 'Failed alignment — invalidation risk'
           : code === 'SH' ? 'Shock event — read unreliable'
           : code === 'CL' ? 'Climax exhaustion — peak fading'
           :                 'Coherence decay — directional weakening',
      invalidatorCount: invCount,
    };
  }

  // Plateau / late-phase / exhausted-phase — MED. The original
  // thesis still holds but drift is real.
  if (code === 'PS'
      || phase === 'Late' || phase === 'Exhausted') {
    return {
      level: 'MED',
      bar:   0.55,
      color: '#d4a028',
      hint:  code === 'PS'
        ? 'Plateau saturation — some drift'
        : `${phase} phase — some drift`,
      invalidatorCount: invCount,
    };
  }

  // Confidence-banded for everything else (CS / IS / AT / SS / DD).
  // The clarity of the read AND the invalidator count together
  // determine stability.
  if (conf >= 0.65 && invCount <= 1) {
    return {
      level: 'HIGH',
      bar:   0.85,
      color: '#22c55e',
      hint:  'Thesis intact — original conditions in place',
      invalidatorCount: invCount,
    };
  }
  if (conf >= 0.40) {
    return {
      level: 'MED',
      bar:   0.55,
      color: '#d4a028',
      hint:  invCount > 1
        ? `${invCount} invalidators armed — monitor drift`
        : 'Some drift — monitor invalidators',
      invalidatorCount: invCount,
    };
  }
  return {
    level: 'LOW',
    bar:   0.25,
    color: '#c45a5a',
    hint:  'Unstable — invalidation risk',
    invalidatorCount: invCount,
  };
}
