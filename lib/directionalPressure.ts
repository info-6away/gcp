// v11.36: directional pressure synthesis layer.
//
// Translates the existing structural intelligence (state + phase +
// slope + curvature + dominant pattern + story bias + gold trend +
// divergence + transition) into a single number pair:
//
//   longPressure  + shortPressure = 100
//
// IMPORTANT distinction for the UI / users:
//
//   This is environment bias pressure — NOT entry certainty,
//   prediction certainty, or a buy/sell signal. It can read 64%
//   long while the active stance is WAIT — that means "structural
//   bias exists but execution structure has not confirmed yet."
//
// Pure synthesis layer. No engine call. No payload contract change.
// Reads from data already on the response / payload.

import type { GcpStateResponse, GcpStatePayload } from '@/lib/engine-gcp';

export type PressureBand = 'weak' | 'moderate' | 'strong';

export interface DirectionalPressure {
  /** 0..100 integer */
  longPressure:    number;
  /** 0..100 integer (sums to 100 with longPressure) */
  shortPressure:   number;
  confidenceBand:  PressureBand;
  explanation:     string;
}

export interface DerivePressureInputs {
  aiState:      GcpStateResponse                | null | undefined;
  patternStory: GcpStatePayload['patternStory'] | null | undefined;
  metrics:      GcpStatePayload['metrics']      | null | undefined;
  goldContext:  GcpStatePayload['goldContext']  | null | undefined;
  /** transition overlay attached to the anchored aiState */
  transition?: {
    nextLikelyState?:      string;
    transitionConfidence?: number;
  };
}

const NEUTRAL: DirectionalPressure = {
  longPressure:    50,
  shortPressure:   50,
  confidenceBand:  'weak',
  explanation:     'No active state — directional edge undefined.',
};

// Slope thresholds shared with the rest of the v11.26.x family.
const SLOPE_NUDGE  = 0.20;
const SLOPE_STRONG = 0.30;

// Per-state base. Returns:
//   longBase     — anchored long% before modifiers (clamped 15..85 later)
//   bandStrength — 0..1, how strongly the state INTRINSICALLY biases
//                  the read (used for confidence band selection)
function statePressureBase(
  code:  GcpStateResponse['stateCode'],
  dir:   GcpStateResponse['direction'],
  phase: GcpStateResponse['phase'],
  slope: number,
  storyBias: 'bullish' | 'bearish' | 'neutral' | undefined,
): { longBase: number; bandStrength: number } {
  switch (code) {
    case 'CS': {
      // Compression: small lean per slope; ~55/45 range.
      const longBase = slope >  0 ? 55 : slope <  0 ? 45 : 50;
      return { longBase, bandStrength: 0.20 };
    }
    case 'IS': {
      const longBase = dir === 'Up'   ? 65
                     : dir === 'Down' ? 35
                     :                   55;
      return { longBase, bandStrength: 0.50 };
    }
    case 'AT': {
      let longBase = dir === 'Up'   ? 78
                   : dir === 'Down' ? 22
                   :                   50;
      let strength = 0.75;
      // Late / Exhausted alignment fades the skew.
      if (phase === 'Late' || phase === 'Exhausted') {
        longBase = longBase < 50 ? longBase + 5 : longBase - 5;
        strength *= 0.6;
      }
      return { longBase, bandStrength: strength };
    }
    case 'SS': {
      const longBase = dir === 'Up'   ? 72
                     : dir === 'Down' ? 28
                     :                   50;
      return { longBase, bandStrength: 0.65 };
    }
    case 'FA': {
      // Failed Alignment leans against the failed direction. When
      // direction is 'Up' the failure was an upside attempt, so the
      // residual bias is short. patternStory.bias gives the same
      // hint when direction is unclear.
      let longBase: number;
      if (dir === 'Up')        longBase = 22;
      else if (dir === 'Down') longBase = 78;
      else if (storyBias === 'bearish') longBase = 30;
      else if (storyBias === 'bullish') longBase = 70;
      else                              longBase = 45;
      return { longBase, bandStrength: 0.65 };
    }
    case 'SH': {
      // Shock: near-neutral unless slope still expanding directionally.
      let longBase = 50;
      if (slope >  SLOPE_NUDGE) longBase = 53;
      if (slope < -SLOPE_NUDGE) longBase = 47;
      return { longBase, bandStrength: 0.10 };
    }
    case 'DS': {
      // Discharge: continuation skew but weakening.
      const longBase = dir === 'Up'   ? 68
                     : dir === 'Down' ? 32
                     :                   45;
      return { longBase, bandStrength: 0.45 };
    }
    case 'CL': {
      // Climax often precedes reversal — peak fades.
      const longBase = dir === 'Up'   ? 40
                     : dir === 'Down' ? 60
                     :                   50;
      return { longBase, bandStrength: 0.30 };
    }
    case 'DD':
    default:
      return { longBase: 50, bandStrength: 0.10 };
  }
}

export function deriveDirectionalPressure(
  inputs: DerivePressureInputs,
): DirectionalPressure {
  const { aiState, patternStory, metrics, goldContext, transition } = inputs;
  if (!aiState) return { ...NEUTRAL };

  const code      = aiState.stateCode;
  const dir       = aiState.direction;
  const phase     = aiState.phase;
  const slope     = metrics?.slope ?? 0;
  const goldTrend = goldContext?.trend;
  const storyBias = patternStory?.bias;

  // 1. State base.
  let { longBase, bandStrength } = statePressureBase(code, dir, phase, slope, storyBias);

  // 2. Divergence penalty. GCP slope strongly directional but gold
  //    diverging or sideways pulls long pressure DOWN (or up) by
  //    4-8 pts depending on severity.
  let divergenceMod = 0;
  if (slope >  SLOPE_STRONG && goldTrend === 'down')                                    divergenceMod = -8;
  else if (slope >  SLOPE_NUDGE && goldTrend !== 'up' && goldTrend !== 'unknown')       divergenceMod = -4;
  else if (slope < -SLOPE_STRONG && goldTrend === 'up')                                 divergenceMod =  8;
  else if (slope < -SLOPE_NUDGE && goldTrend !== 'down' && goldTrend !== 'unknown')     divergenceMod =  4;

  // 3. Gold confirmation bonus. Gold trend agreeing with direction
  //    reinforces the read.
  let confirmMod = 0;
  if      (dir === 'Up'   && goldTrend === 'up')   confirmMod =  4;
  else if (dir === 'Down' && goldTrend === 'down') confirmMod = -4;

  // 4. Transition modifier. FA next softens or flips current bias;
  //    AT / IS next reinforces.
  let transitionMod = 0;
  const nextState = transition?.nextLikelyState;
  const transConf = transition?.transitionConfidence ?? 0;
  if (nextState && transConf >= 0.5) {
    if (nextState === 'FA') {
      // Failure ahead — fade current bias.
      if (longBase > 50)      transitionMod = -6;
      else if (longBase < 50) transitionMod =  6;
    } else if (nextState === 'AT') {
      // Continuation ahead — reinforce.
      if (longBase > 50)      transitionMod =  5;
      else if (longBase < 50) transitionMod = -5;
    } else if (nextState === 'IS') {
      // Ignition ahead — light reinforcement.
      if (longBase > 50)      transitionMod =  3;
      else if (longBase < 50) transitionMod = -3;
    }
  }

  // 5. Pattern story bias as a small extra nudge.
  let storyMod = 0;
  if      (storyBias === 'bullish') storyMod =  3;
  else if (storyBias === 'bearish') storyMod = -3;

  // Combine + clamp + integer.
  let longPct = longBase + divergenceMod + confirmMod + transitionMod + storyMod;
  longPct = Math.round(Math.max(15, Math.min(85, longPct)));
  const shortPct = 100 - longPct;

  // Confidence band — needs both an intrinsic state strength AND a
  // material directional skew (otherwise everything reads "moderate"
  // by default, which misleads).
  const skew = Math.abs(longPct - 50);
  let band: PressureBand;
  if (bandStrength >= 0.5 && skew >= 20)         band = 'strong';
  else if (bandStrength >= 0.3 && skew >= 10)    band = 'moderate';
  else if (bandStrength >= 0.5 || skew >= 15)    band = 'moderate';
  else                                           band = 'weak';

  // Explanation copy. One line, terminal-flat.
  let explanation: string;
  if (band === 'weak') {
    explanation = 'Directional edge currently weak.';
  } else if (longPct > 55) {
    explanation = band === 'strong'
      ? 'Environment strongly favors upside continuation.'
      : 'Environment leans long; structure still developing.';
  } else if (longPct < 45) {
    explanation = band === 'strong'
      ? 'Environment strongly favors downside continuation.'
      : 'Environment leans short; structure still developing.';
  } else {
    explanation = 'Directional edge currently weak.';
  }

  return {
    longPressure:    longPct,
    shortPressure:   shortPct,
    confidenceBand:  band,
    explanation,
  };
}
