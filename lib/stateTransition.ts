// State Transition Ladder v1.
//
// Pure deterministic post-processor that asks: where is the system
// going next? AI State tells us the snapshot; this module overlays a
// directional read so Guru can show "NEXT → IS (64%)" instead of just
// "CS now".
//
// Runs AFTER anchorAiState() and shockDecay() so it operates on the
// already-corrected classification. Never overrides state — only
// attaches three optional fields to the response:
//
//   nextLikelyState       — 'CS' | 'IS' | 'AT' | 'FA'
//   transitionConfidence  — 0.25..0.90
//   transitionReason      — short human-readable hint
//
// Ladder model:
//
//   CS → IS → AT → FA          (forward progression)
//   AT → CS                    (recompression / range tightening)
//   FA → CS                    (failure resolved, new base forming)
//   SH/DS → CS                 (already covered by shockDecay; this
//                               module skips when state isn't laddered)
//
// Priority when multiple transitions could fire:
//   1. FA transitions (risk first)
//   2. IS / AT continuation
//   3. CS fallback (recompression / reset)

import type { GcpStateResponse, GcpStatePayload } from '@/lib/engine-gcp';

// v12.1: ladder widened to include PS / SS / CL / DS so the new
// Plateau State overlay has somewhere to point next. The original four
// stay first because the helpers below still treat them as the
// canonical laddered states.
export type LadderState = 'CS' | 'IS' | 'AT' | 'FA' | 'SS' | 'PS' | 'CL' | 'DS';

export interface TransitionResult {
  nextLikelyState?:      LadderState;
  transitionConfidence?: number;
  transitionReason?:     string;
}

export interface TransitionInputs {
  aiState:      GcpStateResponse                | null;
  patternStory: GcpStatePayload['patternStory'] | null | undefined;
  metrics:      GcpStatePayload['metrics']      | null | undefined;
  goldContext:  GcpStatePayload['goldContext']  | null | undefined;
}

// Slope is in NV-per-bar units over the engine window. The thresholds
// match the v11.26.x decay model so the same slope reads as
// "still moving" / "flat" everywhere in the codebase.
const SLOPE_RISING = 0.15;   // >|0.15| ⇒ meaningful directional move
const SLOPE_TREND  = 0.25;   // >|0.25| ⇒ strong/sustained slope
const SLOPE_FLAT   = 0.10;   // <|0.10| ⇒ effectively flat
const CURV_FLAT    = 0.20;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function deriveNextState(inputs: TransitionInputs): TransitionResult {
  const { aiState, patternStory, metrics, goldContext } = inputs;
  if (!aiState) return {};
  const state = aiState.stateCode;

  // v12.1: SS + PS now have laddered targets too. SH / DS / CL / DD
  // still fall through to "no overlay" — they're terminal states from
  // this ladder's perspective.
  if (state !== 'CS' && state !== 'IS' && state !== 'AT' && state !== 'FA'
      && state !== 'SS' && state !== 'PS') {
    return {};
  }

  const slope      = metrics?.slope     ?? 0;
  const curv       = metrics?.curvature ?? 0;
  const dir        = aiState.direction;
  const trend      = goldContext?.trend;
  const storyDom   = patternStory?.dom;
  const storyState = patternStory?.state;
  const storySeq   = patternStory?.seq ?? [];

  // Shared confidence modifiers.
  const strongSlope = Math.abs(slope) > SLOPE_TREND;
  const lowVol      = Math.abs(slope) < SLOPE_FLAT && Math.abs(curv) < CURV_FLAT;
  // Gold divergence — GCP moving directionally but gold not agreeing.
  // 'unknown' / 'sideways' counts as disagreement when GCP is rising
  // OR falling at meaningful slope.
  const goldDivergence =
    (slope >  SLOPE_RISING && trend && trend !== 'up')   ||
    (slope < -SLOPE_RISING && trend && trend !== 'down');

  // Apply the spec's confidence modifiers + clamp.
  function applyMods(base: number, opts: { storyAligned?: boolean } = {}): number {
    let c = base;
    if (strongSlope)        c += 0.10;
    if (opts.storyAligned)  c += 0.10;
    if (goldDivergence)     c -= 0.15;
    if (lowVol)             c -= 0.10;
    return +clamp(c, 0.25, 0.90).toFixed(2);
  }

  // ── Priority 1: FA transitions (risk first) ─────────────────

  // AT → FA: trend losing coherence.
  if (state === 'AT') {
    const dominantFA      = storyDom === 'FA';
    const slopeFlattening = Math.abs(slope) < SLOPE_FLAT;
    if (dominantFA || goldDivergence || slopeFlattening) {
      const base = dominantFA ? 0.70 : goldDivergence ? 0.60 : 0.50;
      return {
        nextLikelyState:      'FA',
        transitionConfidence: applyMods(base, { storyAligned: dominantFA }),
        transitionReason:     'Trend losing coherence → risk of failure',
      };
    }
  }

  // ── Priority 2: IS / AT continuation ────────────────────────

  // IS → AT: breakout holding.
  if (state === 'IS') {
    const sustainedSlope = Math.abs(slope) > SLOPE_TREND;
    const goldAgrees     =
      (dir === 'Up'   && trend === 'up')   ||
      (dir === 'Down' && trend === 'down');
    const noFA           = !storySeq.includes('FA') && storyDom !== 'FA';
    if (sustainedSlope && goldAgrees && noFA) {
      return {
        nextLikelyState:      'AT',
        transitionConfidence: applyMods(0.70, {
          storyAligned: storyState === 'Alignment forming'
                     || storyState === 'Compression released',
        }),
        transitionReason:     'Breakout holding → trend formation',
      };
    }
  }

  // CS → IS: energy building, breakout likely.
  if (state === 'CS') {
    const energyBuilding = slope > SLOPE_RISING && (curv > 0 || strongSlope);
    const storyMatches   =
      storyState === 'Compression building' ||
      storyState === 'Pressure building'    ||
      storyState === 'Compression released';
    if (energyBuilding || (storyMatches && slope > SLOPE_FLAT)) {
      return {
        nextLikelyState:      'IS',
        transitionConfidence: applyMods(0.60, { storyAligned: storyMatches }),
        transitionReason:     'Energy building → breakout likely',
      };
    }
  }

  // ── Priority 3: CS fallback / reset ─────────────────────────

  // AT → CS: recompression.
  if (state === 'AT') {
    const slopeWeakening  = Math.abs(slope) < SLOPE_RISING;
    const rangeTightening = lowVol;
    if (slopeWeakening && rangeTightening) {
      return {
        nextLikelyState:      'CS',
        transitionConfidence: applyMods(0.50),
        transitionReason:     'Trend weakening → recompression forming',
      };
    }
  }

  // FA → CS: failure resolved, new base forming.
  if (state === 'FA') {
    const ptOrCcAppearing = storySeq.includes('PT') || storySeq.includes('CC');
    if (lowVol || ptOrCcAppearing) {
      return {
        nextLikelyState:      'CS',
        transitionConfidence: applyMods(0.65, { storyAligned: ptOrCcAppearing }),
        transitionReason:     'Failure resolved → new base forming',
      };
    }
  }

  // ── v12.1: SS / PS branches ────────────────────────────────

  // SS → PS: synchronization maturing into plateau. Hint only —
  // derivePlateauStateOverlay() runs AFTER this and may actually
  // promote the displayed state, in which case the ladder shows
  // PS → ... below on the next classification.
  if (state === 'SS') {
    const lateMature = aiState.phase === 'Late' || aiState.phase === 'Exhausted';
    if (lateMature && Math.abs(slope) < SLOPE_RISING) {
      return {
        nextLikelyState:      'PS',
        transitionConfidence: applyMods(0.55, {
          storyAligned: storyState === 'Plateau forming'
                     || storyState === 'Plateau decaying',
        }),
        transitionReason:     'Synchronization maturing into plateau',
      };
    }
  }

  // PS branches — climax / discharge / compression / re-acceleration.
  if (state === 'PS') {
    // PS → CL: volatility expansion or curvature spike from plateau.
    if (Math.abs(curv) > 0.30) {
      return {
        nextLikelyState:      'CL',
        transitionConfidence: applyMods(0.55),
        transitionReason:     'Curvature spiking from plateau → climax risk',
      };
    }
    // PS → DS: slope turning sharply negative-of-direction.
    const dischargeDown =
      (dir === 'Up'   && slope < -SLOPE_RISING) ||
      (dir === 'Down' && slope >  SLOPE_RISING);
    if (dischargeDown) {
      return {
        nextLikelyState:      'DS',
        transitionConfidence: applyMods(0.60),
        transitionReason:     'Direction reversing from plateau → discharge',
      };
    }
    // PS → AT: rare re-acceleration. Slope re-strengthens in the
    // SAME direction the SS was pointing.
    const reAccel =
      (dir === 'Up'   && slope >  SLOPE_TREND) ||
      (dir === 'Down' && slope < -SLOPE_TREND);
    if (reAccel) {
      return {
        nextLikelyState:      'AT',
        transitionConfidence: applyMods(0.45),
        transitionReason:     'Trend re-accelerating from plateau',
      };
    }
    // PS → CS: energy fades back toward base.
    if (lowVol) {
      return {
        nextLikelyState:      'CS',
        transitionConfidence: applyMods(0.55),
        transitionReason:     'Plateau energy fading → recompression',
      };
    }
  }

  // No clear transition — leave the overlay empty so the UI can
  // render nothing instead of a stale arrow.
  return {};
}

// Color + label helpers used by GuruView (and any future renderer)
// so the ladder palette stays consistent.
export function ladderColor(code: LadderState): string {
  switch (code) {
    case 'IS': return '#4dd9e8';   // cyan
    case 'AT': return '#22c55e';   // green
    case 'FA': return '#ef4444';   // red
    case 'CS': return '#7F98A3';   // grey
    // v12.1
    case 'SS': return '#4dd9e8';   // cyan (sync = ignition family)
    case 'PS': return '#8a8fb8';   // muted violet (matches stateAccent)
    case 'CL': return '#d46428';   // climax orange
    case 'DS': return '#d4a028';   // discharge amber
  }
}

export function ladderLabel(code: LadderState): string {
  switch (code) {
    case 'IS': return 'Ignition';
    case 'AT': return 'Alignment Trend';
    case 'FA': return 'Failed Alignment';
    case 'CS': return 'Compression';
    // v12.1
    case 'SS': return 'Synchronization';
    case 'PS': return 'Plateau';
    case 'CL': return 'Climax';
    case 'DS': return 'Discharge';
  }
}
