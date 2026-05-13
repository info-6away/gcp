// v13.2: Temporal Pressure Intelligence layer.
//
// Local-only correction that gives directional pressure a sense of
// MEMORY. The pre-v13.2 stack derived pressure from the current state
// only, which produced emotionally and structurally incorrect reads
// in transitional states:
//
//   DC (Directional Decay)   → LONG 50 / SHORT 50
//   PS (Plateau State)       → LONG 50 / SHORT 50
//   DS (Discharge)           → LONG 50 / SHORT 50
//   CL (Climax)              → LONG 50 / SHORT 50
//
// All four communicate "weakness", but weakness is NOT neutrality.
// Each carries a directional inheritance from whatever the system
// was doing BEFORE it broke down:
//
//   DC after rally  → upside weakening      → short skew expected
//   DC after sell   → downside exhaustion   → long skew expected
//   PS after rally  → plateau on bullish    → slight short
//   PS after sell   → plateau on bearish    → slight long
//   DS after rally  → discharge of bulls    → downside skew
//   DS after sell   → discharge of bears    → rebound skew
//   CL after rally  → climax of bulls       → strong reversal short
//   CL after sell   → climax of bears       → strong reversal long
//
// PIPELINE PLACEMENT (in useGcpState.runCall):
//
//   Engine → anchor → transition → pressure
//   → plateau → decay → structural dominance (NO sanity)
//   → temporalPressure                ← THIS MODULE
//   → applyStructuralSanityGuard
//   → setState / appendAiStateHistory
//
// Temporal runs AFTER dominance so the inheritance read uses pressure
// that's already been corrected for structural context (penalties +
// amplification). It runs BEFORE the sanity guard so any temporal
// nudge that overshoots gets caught by the final cap.
//
// NUDGES ARE NOT OVERRIDES. These are small temporal corrections in
// the ±4 to ±18 range. The pre-existing pressure derivation continues
// to do the heavy lifting; this layer just adds memory.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';
import type { StructureRead } from '@/lib/priceStructure';

export type InheritedTrend = 'up' | 'down' | 'neutral';
export type MomentumState  = 'accelerating' | 'decelerating' | 'exhausted' | 'transitioning';

export interface TemporalPressureArgs {
  /** The post-dominance ai state. We read stateCode + phase + direction
   *  from this and ignore the pressure fields (caller passes those
   *  separately so we can return the adjusted deltas). */
  aiState:       GcpStateResponse | null;
  /** Last 5 (newest-first) anchored history records, for inheritance
   *  detection. Older entries are ignored because directional memory
   *  beyond ~5 classifications is too stale to act on. */
  recentHistory: AiStateHistoryRecord[];
  /** Current post-dominance pressure values. Read-only inputs;
   *  adjustments are returned as deltas. */
  currentPressure: { long: number; short: number };
  metrics:        { slope: number; curvature?: number } | null | undefined;
  priceStructure: StructureRead | null | undefined;
  latestPatternCode: string | null;
}

export interface TemporalPressureResult {
  /** Signed delta to long pressure (positive = boost long). */
  longAdjust:  number;
  /** Signed delta to short pressure. Always == -longAdjust by
   *  construction; surfaced for caller convenience. */
  shortAdjust: number;
  inheritedTrend: InheritedTrend;
  momentumState: MomentumState;
  reasons: string[];
}

// ──────────────────────────────────────────────────────────────────
// Inheritance — weighted scan of last 5 anchored records.
// ──────────────────────────────────────────────────────────────────

const RECENCY_WEIGHTS = [5, 4, 3, 2, 1];

function classifyInheritedTrend(history: AiStateHistoryRecord[]): {
  trend: InheritedTrend;
  upScore:   number;
  downScore: number;
} {
  let up   = 0;
  let down = 0;
  const slice = history.slice(0, 5);
  for (let i = 0; i < slice.length; i++) {
    const rec = slice[i];
    const w   = RECENCY_WEIGHTS[i] ?? 1;
    // Direction weight — every record contributes its directional
    // axis once.
    if (rec.direction === 'Up')   up   += w;
    if (rec.direction === 'Down') down += w;
    // Directional state bonus — AT / SS / IS are STRONG bullish or
    // bearish carries (depending on direction); double the weight.
    if (rec.stateCode === 'AT'
        || rec.stateCode === 'SS'
        || rec.stateCode === 'IS') {
      if (rec.direction === 'Up')   up   += w;
      if (rec.direction === 'Down') down += w;
    }
  }
  const diff = up - down;
  if (diff >=  4) return { trend: 'up',   upScore: up, downScore: down };
  if (diff <= -4) return { trend: 'down', upScore: up, downScore: down };
  return { trend: 'neutral', upScore: up, downScore: down };
}

// ──────────────────────────────────────────────────────────────────
// Momentum state — what's the trajectory of energy?
// ──────────────────────────────────────────────────────────────────

function classifyMomentumState(args: {
  state:       string;
  phase:       string;
  slope:       number;
  recentHistory: AiStateHistoryRecord[];
  inheritedTrend: InheritedTrend;
}): MomentumState {
  const { state, phase, slope, recentHistory } = args;

  // Transitioning — most-recent two records differ in stateCode.
  if (recentHistory.length >= 2
      && recentHistory[0].stateCode !== recentHistory[1].stateCode) {
    // Don't tag plateau / discharge / climax / decay as transitioning;
    // those states are themselves transitions but the user reads them
    // as their own momentum classes.
    if (state !== 'PS' && state !== 'DS' && state !== 'CL' && state !== 'DC') {
      return 'transitioning';
    }
  }

  // Accelerating — directional state + strong slope in the same
  // direction as state implies.
  if ((state === 'AT' || state === 'IS' || state === 'SS')
      && Math.abs(slope) >= 0.20) {
    return 'accelerating';
  }

  // Decelerating — DC / PS / late phase of any directional state /
  // slope flattening from a prior trend.
  if (state === 'DC' || state === 'PS')             return 'decelerating';
  if ((state === 'AT' || state === 'SS')
      && (phase === 'Late' || phase === 'Exhausted')) {
    return 'decelerating';
  }

  // Exhausted — DS / CL.
  if (state === 'DS' || state === 'CL') return 'exhausted';

  // Default — decelerating reads as the closest to "no specific
  // momentum tag" without being misleading; "transitioning" already
  // got the early-return. CS / DD / SH / FA without other context
  // map here.
  return 'decelerating';
}

// ──────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────

export function deriveTemporalPressureBias(
  args: TemporalPressureArgs,
): TemporalPressureResult {
  const {
    aiState, recentHistory, currentPressure, metrics,
    priceStructure, latestPatternCode,
  } = args;
  void priceStructure;       // reserved for future extension
  void latestPatternCode;    // reserved for future extension

  const reasons: string[] = [];

  if (!aiState) {
    return {
      longAdjust:    0,
      shortAdjust:   0,
      inheritedTrend: 'neutral',
      momentumState: 'transitioning',
      reasons:       ['no aiState'],
    };
  }

  const { trend: inheritedTrend, upScore, downScore } =
    classifyInheritedTrend(recentHistory);
  reasons.push(`inheritance scan: up=${upScore}, down=${downScore} → ${inheritedTrend}`);

  const slope = metrics?.slope ?? 0;
  const momentumState = classifyMomentumState({
    state:          aiState.stateCode,
    phase:          aiState.phase,
    slope,
    recentHistory,
    inheritedTrend,
  });
  reasons.push(`momentum: ${momentumState}`);

  // ── State-specific nudges ─────────────────────────────────────
  //
  // DC, PS, DS, CL: temporal correction based on inherited trend.
  // Other states: no adjustment — the upstream pressure derivation
  // is already correct for directional states (AT/IS/SS), neutral
  // states (CS/DD), and discrete events (SH/FA).
  let longAdjust  = 0;
  let shortAdjust = 0;

  const code = aiState.stateCode;

  if (code === 'DC') {
    // Decay = weakening of prior energy. If inheritance is up, the
    // bulls are losing → short skew. If down, the bears are losing
    // → long skew.
    if (inheritedTrend === 'up') {
      longAdjust  = -10;
      shortAdjust =  10;
      reasons.push('DC after bullish inheritance → -10 long');
    } else if (inheritedTrend === 'down') {
      longAdjust  =  10;
      shortAdjust = -10;
      reasons.push('DC after bearish inheritance → +10 long');
    } else {
      reasons.push('DC with neutral inheritance → no nudge');
    }
  }

  else if (code === 'PS') {
    // Plateau = subtle reversal-prone bias. Smaller magnitude than
    // DC because plateau can still resolve into continuation.
    if (inheritedTrend === 'up') {
      longAdjust  = -4;
      shortAdjust =  4;
      reasons.push('PS after bullish inheritance → -4 long');
    } else if (inheritedTrend === 'down') {
      longAdjust  =  4;
      shortAdjust = -4;
      reasons.push('PS after bearish inheritance → +4 long');
    }
  }

  else if (code === 'DS') {
    // Discharge = exhausted move, slight reversal bias.
    if (inheritedTrend === 'up') {
      longAdjust  = -8;
      shortAdjust =  8;
      reasons.push('DS after bullish rally → -8 long (downside skew)');
    } else if (inheritedTrend === 'down') {
      longAdjust  =  8;
      shortAdjust = -8;
      reasons.push('DS after bearish collapse → +8 long (rebound skew)');
    }
  }

  else if (code === 'CL') {
    // Climax = directional excess. Strongest reversal nudge. Heavier
    // when the most-recent record showed an aggressive slope in the
    // same direction.
    const lastRec = recentHistory[0];
    const lastDirAligned = lastRec
      && ((inheritedTrend === 'up'   && lastRec.direction === 'Up')
       || (inheritedTrend === 'down' && lastRec.direction === 'Down'));
    const magnitude = lastDirAligned ? 18 : 10;
    if (inheritedTrend === 'up') {
      longAdjust  = -magnitude;
      shortAdjust =  magnitude;
      reasons.push(`CL after bullish excess → -${magnitude} long`);
    } else if (inheritedTrend === 'down') {
      longAdjust  =  magnitude;
      shortAdjust = -magnitude;
      reasons.push(`CL after bearish excess → +${magnitude} long`);
    }
  }

  // ── Bounds check — never overshoot the 15..85 envelope ────────
  // The sanity guard runs after us anyway, but a sane intermediate
  // value keeps the dev log readable.
  const projectedLong  = currentPressure.long  + longAdjust;
  const projectedShort = currentPressure.short + shortAdjust;
  if (projectedLong < 10 || projectedLong > 90) {
    // Pull adjustment back so the result lands in 15..85 with room
    // for the sanity guard to refine.
    const clampedLong = Math.max(15, Math.min(85, projectedLong));
    longAdjust  = clampedLong - currentPressure.long;
    shortAdjust = -longAdjust;
    reasons.push(`temporal-bounds: adjustment clamped to keep result in 15..85 (long → ${clampedLong})`);
    void projectedShort;
  }

  return {
    longAdjust,
    shortAdjust,
    inheritedTrend,
    momentumState,
    reasons,
  };
}

// ──────────────────────────────────────────────────────────────────
// Display helpers — one-line copy for the MOMENTUM UI row.
// ──────────────────────────────────────────────────────────────────

export function momentumLabel(
  momentumState: MomentumState,
  inheritedTrend: InheritedTrend,
): string {
  const dir = inheritedTrend === 'up'   ? 'bullish'
            : inheritedTrend === 'down' ? 'bearish'
            :                              null;
  switch (momentumState) {
    case 'accelerating':
      return dir ? `Accelerating ${dir} expansion`  : 'Accelerating';
    case 'decelerating':
      return dir ? `Decelerating ${dir} expansion`  : 'Decelerating';
    case 'exhausted':
      return dir ? `${dir.charAt(0).toUpperCase() + dir.slice(1)} exhaustion`
                 : 'Exhausted';
    case 'transitioning':
      return 'Regime transitioning';
  }
}

export function momentumColor(momentumState: MomentumState): string {
  switch (momentumState) {
    case 'accelerating': return '#4dd9e8';   // cyan
    case 'decelerating': return '#d4a028';   // amber
    case 'exhausted':    return '#c45a5a';   // muted red
    case 'transitioning':return 'var(--fg-3)';
  }
}
