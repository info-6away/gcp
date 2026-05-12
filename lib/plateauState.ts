// v12.1: Plateau State (PS) overlay.
//
// Local-only post-processor that splits mature, saturated SS from
// active, healthy SS. The Engine never returns PS — it only returns
// SS — but GCP Pro can detect "synchronization has matured into a
// plateau" and rename the displayed state accordingly.
//
// PIPELINE PLACEMENT (in useGcpState.runCall):
//
//   Engine response
//   → anchorAiState
//   → deriveNextState         (transition ladder; may emit SS → PS hint)
//   → deriveDirectionalPressure
//   → derivePlateauStateOverlay   ← THIS MODULE
//   → setState / appendAiStateHistory
//
// Why AFTER pressure? Because the saturation read uses the pressure
// skew as one of its inputs (weak skew = plateau-y). Damping pressure
// later (when the overlay fires) is fine — we only adjust the values
// attached to the response, not the directional pressure derivation
// logic itself.
//
// NOT a state-classification rewrite. We're tagging a degenerate edge
// case of SS for clearer UI / stance / research; the Engine prompt is
// untouched.
//
// Conditions for upgrade (need ≥3 to fire):
//   1. phase = Late OR Exhausted
//   2. directional pressure skew |L−S| ≤ 20
//   3. |slope| ≤ 0.20
//   4. regime ∈ {C, D, E}
//   5. patternStory.state !== 'Alignment forming'
//   6. latest pattern ∈ {PT, SP, PD, DSE, CV} OR no clear continuation pattern
//   7. transition.nextLikelyState ∈ {CL, DS, CS} or empty
//   8. (optional) volatility contracting after prior expansion
//
// Hard blockers (any one prevents PS):
//   - nextLikelyState === 'AT'
//   - skew >= 65/35
//   - phase === 'Early'
//   - patternStory.dom === 'AL' or 'CR' with strong continuation
//   - slope > 0.35

import type { GcpStateResponse, GcpStatePayload } from '@/lib/engine-gcp';

const CONTINUATION_PATTERN_CODES = new Set(['AL', 'CR', 'AC', 'BR']);
// Patterns that LEAN plateau when seen alongside SS Late.
// PT pulse-train, SP shock-jump, PD plateau-decay, DSE discharge,
// CV coil (compression coil); seeing any of these reinforces "not
// fresh continuation, more like exhaustion".
const PLATEAU_HINT_PATTERN_CODES = new Set(['PT', 'SP', 'PD', 'DSE', 'CV']);

export interface PlateauOverlayInputs {
  aiState: GcpStateResponse;
  patternStory: GcpStatePayload['patternStory'] | null | undefined;
  metrics:      GcpStatePayload['metrics']      | null | undefined;
  directionalPressure: {
    longPressure?:  number;
    shortPressure?: number;
    pressureBand?:  'weak' | 'moderate' | 'strong';
  } | null | undefined;
  transition?: {
    nextLikelyState?: string;
  } | null | undefined;
  /** Regime letter (A/B/C/D/E) at analysis time. */
  regime?: string | null;
  /** Latest recent pattern code (e.g. 'AL', 'PT'). null when none. */
  latestPatternCode?: string | null;
}

export interface PlateauOverlayResult {
  response: GcpStateResponse;
  upgraded: boolean;
  reasons:  string[];
}

/**
 * Dampen long/short pressure toward 50/50 by 40% so PS reads as
 * "fragile" without losing all directional hint. Caps the band at
 * 'moderate' (never 'strong' under plateau).
 */
function dampenPressure(
  long:  number | undefined,
  short: number | undefined,
  band:  'weak' | 'moderate' | 'strong' | undefined,
): { long: number; short: number; band: 'weak' | 'moderate' } {
  const longRaw  = typeof long  === 'number' ? long  : 50;
  const shortRaw = typeof short === 'number' ? short : 50;
  // 40% damping: new = 50 + (old - 50) * 0.6
  const dampedLong  = Math.round(50 + (longRaw  - 50) * 0.6);
  const clampedLong = Math.max(15, Math.min(85, dampedLong));
  const clampedShort = 100 - clampedLong;
  // Suppress 'strong' to 'moderate'; keep 'weak' as-is.
  const newBand = band === 'strong' ? 'moderate'
                : band === 'moderate' ? 'moderate'
                :                       'weak';
  // Reference shortRaw so the helper signature stays symmetric — the
  // damping is anchored to long and short follows from 100-long.
  void shortRaw;
  return { long: clampedLong, short: clampedShort, band: newBand };
}

export function derivePlateauStateOverlay(
  inputs: PlateauOverlayInputs,
): PlateauOverlayResult {
  const { aiState } = inputs;

  // Only applies when the anchored / transitioned state is SS.
  if (aiState.stateCode !== 'SS') {
    return { response: aiState, upgraded: false, reasons: [] };
  }

  const story    = inputs.patternStory ?? null;
  const slope    = inputs.metrics?.slope ?? 0;
  const long     = inputs.directionalPressure?.longPressure;
  const short    = inputs.directionalPressure?.shortPressure;
  const band     = inputs.directionalPressure?.pressureBand;
  const next     = inputs.transition?.nextLikelyState ?? null;
  const phase    = aiState.phase;
  const regime   = inputs.regime ?? null;
  const pattern  = inputs.latestPatternCode ?? null;

  const skew =
    typeof long === 'number' && typeof short === 'number'
      ? Math.abs(long - short)
      : null;

  // ── Hard blockers ─────────────────────────────────────────────
  // Any one of these prevents the upgrade outright, regardless of
  // how many positive signals are present.
  if (next === 'AT') {
    return { response: aiState, upgraded: false,
      reasons: ['blocker: transition.nextLikelyState === AT'] };
  }
  if (skew != null && skew >= 30) {
    return { response: aiState, upgraded: false,
      reasons: [`blocker: pressure skew ${skew} >= 30 (i.e. >= 65/35)`] };
  }
  if (phase === 'Early') {
    return { response: aiState, upgraded: false,
      reasons: ['blocker: phase === Early'] };
  }
  if (pattern
      && CONTINUATION_PATTERN_CODES.has(pattern)
      && (story?.bias === 'bullish' || story?.bias === 'bearish')) {
    return { response: aiState, upgraded: false,
      reasons: [`blocker: continuation pattern ${pattern} + ${story?.bias} story`] };
  }
  if (Math.abs(slope) > 0.35) {
    return { response: aiState, upgraded: false,
      reasons: [`blocker: |slope| ${slope.toFixed(3)} > 0.35`] };
  }

  // ── Positive signals (need ≥3) ────────────────────────────────
  const reasons: string[] = [];
  if (phase === 'Late' || phase === 'Exhausted') {
    reasons.push(`phase ${phase}`);
  }
  if (skew != null && skew <= 20) {
    reasons.push(`pressure skew ${skew} <= 20`);
  }
  if (Math.abs(slope) <= 0.20) {
    reasons.push(`|slope| ${slope.toFixed(3)} <= 0.20`);
  }
  if (regime === 'C' || regime === 'D' || regime === 'E') {
    reasons.push(`regime ${regime} (high)`);
  }
  if (story && story.state !== 'Alignment forming') {
    reasons.push(`story "${story.state}" ≠ Alignment forming`);
  }
  // Spec: "latest pattern is PT/SP/PD/DSE/CV OR no clear continuation".
  // Fires whenever the latest pattern is plateau-hinting, missing, or
  // simply not a continuation pattern (anything outside the alignment /
  // continuation set counts).
  const isContinuationPattern = pattern != null
    && CONTINUATION_PATTERN_CODES.has(pattern);
  if (!isContinuationPattern) {
    reasons.push(pattern == null
      ? 'no recent pattern'
      : PLATEAU_HINT_PATTERN_CODES.has(pattern)
        ? `pattern ${pattern} leans plateau`
        : `pattern ${pattern} non-continuation`);
  }
  if (next === 'CL' || next === 'DS' || next === 'CS' || !next) {
    reasons.push(`transition next "${next ?? 'none'}" non-continuation`);
  }
  // Optional volatility-contracting signal — band='weak' as a coarse
  // proxy, since the pressure synthesis already collapses to 'weak'
  // when the environment is flat.
  if (band === 'weak') {
    reasons.push('pressure band weak');
  }

  if (reasons.length < 3) {
    return {
      response: aiState,
      upgraded: false,
      reasons:  reasons.length
        ? [`insufficient signals (${reasons.length} < 3): ${reasons.join('; ')}`]
        : ['no plateau signals matched'],
    };
  }

  // ── Upgrade ───────────────────────────────────────────────────
  // Apply the overlay: rename to PS, dampen confidence slightly,
  // dampen pressure toward neutral, and (importantly) preserve the
  // original Engine response on _meta — we never lie about which
  // model classified the underlying SS.
  const damp = dampenPressure(long, short, band);
  const newConfidence = Math.max(0, Math.min(1, aiState.confidence - 0.05));

  const response: GcpStateResponse = {
    ...aiState,
    stateCode:           'PS',
    state:               'Plateau State',
    confidence:          +newConfidence.toFixed(3),
    longPressure:        damp.long,
    shortPressure:       damp.short,
    pressureBand:        damp.band,
    pressureExplanation: 'Plateau saturation — directional edge fading.',
  };

  return { response, upgraded: true, reasons };
}
