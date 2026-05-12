// v12.2: Directional Decay (DC) overlay.
//
// Local-only post-processor that catches the scenario:
//
//   coherence is weak / flat / falling, BUT price is trending
//   materially in one direction
//
// — which the existing stack of FA guards + plateau stabilization +
// weak-pressure dampening would otherwise suppress into a "stuck CS"
// or "stuck SS" classification while the user watches price drift
// away from a neutral read.
//
// DC is NOT Failed Alignment. FA is "sync attempt failed, mean-revert."
// DC is "entropy with directional persistence" — the system can't form
// a coherent ignition/alignment, but the market is moving anyway. The
// right stance is to REDUCE exposure and AVOID passively fading the
// trend — not to take a counter-trend FA fade.
//
// PIPELINE PLACEMENT (in useGcpState.runCall):
//
//   Engine response
//   → anchorAiState
//   → deriveNextState
//   → deriveDirectionalPressure
//   → derivePlateauStateOverlay
//   → deriveDirectionalDecayOverlay   ← THIS MODULE
//   → setState / appendAiStateHistory
//
// Sits AFTER plateau so PS keeps priority over DC: a mature SS that
// converges on the plateau signal stays PS. DC fires when the SS / CS
// HAS NOT met plateau conditions but does meet directional-decay ones.
//
// NAMING — the spec called this "DD". The legacy code already uses
// 'DD' for Dead Drift, so we use 'DC' here to avoid breaking history /
// switch statements / type unions. Surface label still reads
// "Directional Decay" so the user sees the spec name.
//
// REQUIRED conditions (all must hold):
//   1. Gold trend is up OR down (proxy for priceTrendStrength)
//   2. |coherence slope| <= 0.20 (slope is flat / weakening)
//   3. directional pressure is weak/moderate (skew < 30)
//   4. no active ignition/trend continuation:
//        - transition.nextLikelyState !== 'AT' && !== 'IS'
//        - patternStory.state !== 'Alignment forming'
//                              && !== 'Compression released'
//        - latest pattern not in {AL, CR, AC, BR}
//
// OPTIONAL reinforcers (any boosts confidence the overlay is right):
//   - transition.nextLikelyState empty / null
//   - transitionConfidence low (< 0.5) when present
//   - current confidence < previous-state confidence (certainty decay)
//   - gold trend label persistent (up/down vs sideways/unknown is
//     itself the persistence proxy — already covered by required #1)
//
// HARD blockers (any one prevents DC):
//   - stateCode is IS or AT (those handle directional moves correctly)
//   - transition.nextLikelyState === 'AT'
//   - pressure skew >= 35 (strong directional pressure — the system
//                          already sees the move; nothing to escalate)
//   - latest pattern is a continuation: AL, CR, AC, BR

import type { GcpStateResponse, GcpStatePayload } from '@/lib/engine-gcp';

const CONTINUATION_PATTERN_CODES = new Set(['AL', 'CR', 'AC', 'BR']);

export interface DirectionalDecayInputs {
  aiState:      GcpStateResponse;
  patternStory: GcpStatePayload['patternStory'] | null | undefined;
  metrics:      GcpStatePayload['metrics']      | null | undefined;
  goldContext:  GcpStatePayload['goldContext']  | null | undefined;
  directionalPressure: {
    longPressure?:  number;
    shortPressure?: number;
    pressureBand?:  'weak' | 'moderate' | 'strong';
  } | null | undefined;
  transition?: {
    nextLikelyState?:      string;
    transitionConfidence?: number;
  } | null | undefined;
  /** previousState carried into the payload — used as a coarse proxy
   *  for "certainty falling sequentially". null when not available. */
  previousConfidence?: number | null;
  /** Latest recent pattern code (e.g. 'AL', 'PT'). null when none. */
  latestPatternCode?:  string | null;
}

export interface DirectionalDecayResult {
  response: GcpStateResponse;
  upgraded: boolean;
  reasons:  string[];
}

export function deriveDirectionalDecayOverlay(
  inputs: DirectionalDecayInputs,
): DirectionalDecayResult {
  const { aiState } = inputs;

  // Only applies when the displayed state is CS or SS. Other codes
  // already communicate the right environment (IS/AT trend, FA fade,
  // CL/DS exhaustion, PS plateau). DD = Dead Drift is also exempt:
  // by definition it's a "no signal" environment; promoting it to DC
  // would double-classify the same idea.
  if (aiState.stateCode !== 'CS' && aiState.stateCode !== 'SS') {
    return { response: aiState, upgraded: false, reasons: [] };
  }

  const story    = inputs.patternStory ?? null;
  const slope    = inputs.metrics?.slope ?? 0;
  const trend    = inputs.goldContext?.trend;
  const long     = inputs.directionalPressure?.longPressure;
  const short    = inputs.directionalPressure?.shortPressure;
  const band     = inputs.directionalPressure?.pressureBand;
  const next     = inputs.transition?.nextLikelyState ?? null;
  const nextConf = inputs.transition?.transitionConfidence;
  const pattern  = inputs.latestPatternCode ?? null;
  const prevConf = inputs.previousConfidence ?? null;

  const skew =
    typeof long === 'number' && typeof short === 'number'
      ? Math.abs(long - short)
      : null;

  // ── Hard blockers ───────────────────────────────────────────
  if (next === 'AT') {
    return { response: aiState, upgraded: false,
      reasons: ['blocker: transition.nextLikelyState === AT'] };
  }
  if (skew != null && skew >= 35) {
    return { response: aiState, upgraded: false,
      reasons: [`blocker: pressure skew ${skew} >= 35 (strong directional)`] };
  }
  if (pattern && CONTINUATION_PATTERN_CODES.has(pattern)) {
    return { response: aiState, upgraded: false,
      reasons: [`blocker: continuation pattern ${pattern}`] };
  }

  // ── Required conditions ─────────────────────────────────────
  const reasons: string[] = [];
  let allRequiredMet = true;

  // R1: Gold trending materially (proxy for priceTrendStrength).
  const trendingDirectional = trend === 'up' || trend === 'down';
  if (trendingDirectional) {
    reasons.push(`gold trend ${trend}`);
  } else {
    allRequiredMet = false;
    reasons.push(`required-missing: gold trend "${trend ?? 'unknown'}" not directional`);
  }

  // R2: Coherence slope flat / weak.
  if (Math.abs(slope) <= 0.20) {
    reasons.push(`|slope| ${slope.toFixed(3)} <= 0.20 (coherence weak/flat)`);
  } else {
    allRequiredMet = false;
    reasons.push(`required-missing: |slope| ${slope.toFixed(3)} > 0.20`);
  }

  // R3: Pressure weak/moderate (skew < 30 i.e. tighter than 65/35).
  if (skew == null || skew < 30) {
    reasons.push(skew != null
      ? `pressure skew ${skew} < 30 (weak/moderate)`
      : 'pressure unavailable (treated as weak)');
  } else {
    allRequiredMet = false;
    reasons.push(`required-missing: pressure skew ${skew} >= 30`);
  }

  // R4: No active ignition / trend continuation.
  const noContinuation =
    next !== 'AT' && next !== 'IS'
    && story?.state !== 'Alignment forming'
    && story?.state !== 'Compression released';
  if (noContinuation) {
    reasons.push(`no continuation signal (next "${next ?? 'none'}", story "${story?.state ?? 'none'}")`);
  } else {
    allRequiredMet = false;
    reasons.push(`required-missing: continuation signal present (next="${next}", story="${story?.state ?? ''}")`);
  }

  if (!allRequiredMet) {
    return { response: aiState, upgraded: false, reasons };
  }

  // ── Optional reinforcers (logged but not gating) ────────────
  if (!next) {
    reasons.push('reinforcer: transition empty');
  } else if (typeof nextConf === 'number' && nextConf < 0.5) {
    reasons.push(`reinforcer: transition confidence ${nextConf} < 0.5`);
  }
  if (prevConf != null && aiState.confidence < prevConf - 0.05) {
    reasons.push(`reinforcer: certainty decay ${prevConf.toFixed(2)} → ${aiState.confidence.toFixed(2)}`);
  }
  if (band === 'weak') {
    reasons.push('reinforcer: pressure band weak');
  }

  // ── Upgrade ────────────────────────────────────────────────
  // Nudge pressure 5 pts WITH the gold trend so the read communicates
  // "respect this direction" rather than encouraging a fade. Then
  // confidence drops 0.05 to flag it's a local overlay.
  const baseLong  = typeof long  === 'number' ? long  : 50;
  let nudgedLong  = baseLong;
  if (trend === 'up')   nudgedLong = Math.min(70, baseLong + 5);
  if (trend === 'down') nudgedLong = Math.max(30, baseLong - 5);
  const nudgedLongClamped  = Math.max(15, Math.min(85, Math.round(nudgedLong)));
  const nudgedShortClamped = 100 - nudgedLongClamped;
  // DC keeps weak/moderate — never promotes to strong, never drops to
  // weak if the original was moderate (so the "we're paying attention"
  // signal isn't lost).
  const newBand = band === 'strong' ? 'moderate'
                : band === 'weak'   ? 'moderate'
                :                     'moderate';

  const newConfidence = Math.max(0, Math.min(1, aiState.confidence - 0.05));

  const response: GcpStateResponse = {
    ...aiState,
    stateCode:           'DC',
    state:               'Directional Decay',
    confidence:          +newConfidence.toFixed(3),
    longPressure:        nudgedLongClamped,
    shortPressure:       nudgedShortClamped,
    pressureBand:        newBand,
    pressureExplanation: 'Coherence weak; price degrading directionally — respect the move.',
  };

  return { response, upgraded: true, reasons };
}
