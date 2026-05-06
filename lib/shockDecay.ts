// v11.26.3: shock decay model v1.
//
// Shock is an EVENT, not a lingering state. The story engine
// (v11.26.2) already labels post-shock structure as "Post-shock
// recovery", but the AI State anchor sometimes still let SH / DS
// through when the Engine over-weighted the historical event. This
// module derives a quantitative decay verdict from the same payload
// the Engine sees (story + metrics + regime) so the anchor can reject
// stale shock answers cleanly.
//
// Decay vocabulary:
//   shockActive    — environment is genuinely still shock-dominated
//   decayed        — shock event happened recently but newer
//                    structure has formed; environment has moved on
//   recoveryActive — structure rebuilding after a shock; CS / IS
//                    rather than SH / DS
//
// Signals consumed:
//   patternStory.seq          — last 5 pattern codes (oldest → newest)
//   metrics.slope             — NV-per-bar regression slope
//   metrics.curvature         — second-derivative magnitude
//   current.regime            — 'A'..'F' from payload.current
//
// Thresholds:
//   SLOPE_ACTIVE_HIGH   0.40   — strong slope keeps shock active
//                                even if not the latest pattern
//   SLOPE_ACTIVE_LOW    0.20   — minimum slope for "still unstable"
//                                when shock is in last 3 with no
//                                blocker structure after
//   CURVATURE_SPIKE     0.50   — second-difference threshold for
//                                "still shocking" — matches the
//                                discharge confirmation curvature
//                                threshold in lib/energy.ts

import type { GcpStatePayload } from '@/lib/engine-gcp';

export const SHOCK_CODES: ReadonlySet<string> = new Set(['SJ', 'CV', 'DSE', 'DW']);
export const STRUCTURE_CODES: ReadonlySet<string> = new Set(['PT', 'CC', 'CR', 'AL', 'FA']);

const SLOPE_ACTIVE_HIGH = 0.40;
const SLOPE_ACTIVE_LOW  = 0.20;
const CURVATURE_SPIKE   = 0.50;

export interface ShockDecayInputs {
  story:         GcpStatePayload['patternStory'] | null | undefined;
  metrics:       GcpStatePayload['metrics']      | null | undefined;
  currentRegime: string | null | undefined;     // 'A'..'F'
}

export interface ShockDecayResult {
  shockActive:           boolean;
  decayed:               boolean;
  recoveryActive:        boolean;
  recommendedStateCode?: 'SH' | 'CS' | 'IS' | 'DS' | 'DD';
  reason:                string;
}

const NO_SHOCK: ShockDecayResult = {
  shockActive:    false,
  decayed:        false,
  recoveryActive: false,
  reason:         'No shock pattern in recent sequence',
};

export function deriveShockDecay(inputs: ShockDecayInputs): ShockDecayResult {
  const { story, metrics, currentRegime } = inputs;
  if (!story || !story.seq || story.seq.length === 0) {
    return { ...NO_SHOCK };
  }

  const seq        = story.seq;
  const latest     = seq[seq.length - 1];
  const slope      = metrics?.slope ?? 0;
  const curvAbs    = Math.abs(metrics?.curvature ?? 0);
  const regimeF    = currentRegime === 'F';

  // Most recent shock code in the sequence (and its index from the end).
  let shockIdx = -1;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (SHOCK_CODES.has(seq[i])) { shockIdx = i; break; }
  }
  if (shockIdx === -1) return { ...NO_SHOCK };

  // Codes after the most recent shock event.
  const postShock        = seq.slice(shockIdx + 1);
  const hasStructureAfter = postShock.some(c => STRUCTURE_CODES.has(c));
  const inLast3          = seq.length - shockIdx <= 3;
  const inLast5          = seq.length - shockIdx <= 5;

  // ── CV special rule ───────────────────────────────────────────
  // CV is an event spike that mean-reverts by definition. Don't let
  // it keep SH alive unless it's BOTH the latest pattern and the
  // current slope / regime confirms fresh instability.
  if (latest === 'CV' && slope <= SLOPE_ACTIVE_HIGH && !regimeF) {
    return {
      shockActive:           false,
      decayed:               true,
      recoveryActive:        true,
      recommendedStateCode:  'CS',
      reason:                'CV spike mean-reverted; structure now matters more than the event.',
    };
  }

  // ── Active rule (a): latest IS shock + active conditions ──────
  if (SHOCK_CODES.has(latest)
      && (slope > SLOPE_ACTIVE_HIGH || curvAbs > CURVATURE_SPIKE || regimeF)) {
    return {
      shockActive:           true,
      decayed:               false,
      recoveryActive:        false,
      recommendedStateCode:  'SH',
      reason: `Shock active — latest ${latest}, slope ${slope.toFixed(2)}, |curv| ${curvAbs.toFixed(2)}, regime ${currentRegime ?? '?'}`,
    };
  }

  // ── Active rule (b): shock in last 3, no blocker after, slope still elevated ─
  if (inLast3 && !hasStructureAfter && slope > SLOPE_ACTIVE_LOW) {
    return {
      shockActive:           true,
      decayed:               false,
      recoveryActive:        false,
      recommendedStateCode:  'SH',
      reason: `Shock active — recent ${seq[shockIdx]}, no blocker structure after, slope ${slope.toFixed(2)}`,
    };
  }

  // ── Decay rule: shock in last 5 + structure after + slope tame ─
  if (inLast5 && hasStructureAfter && slope <= SLOPE_ACTIVE_HIGH) {
    return {
      shockActive:           false,
      decayed:               true,
      recoveryActive:        true,
      recommendedStateCode:  'CS',
      reason:                'Shock event has decayed; newer structure is rebuilding.',
    };
  }

  // Shock in window but neither active nor cleanly decayed (edge
  // case — e.g. shock 4 patterns ago with no structure since but
  // slope below threshold). Treat as decayed → CS to err on the
  // side of post-shock framing.
  return {
    shockActive:           false,
    decayed:               true,
    recoveryActive:        true,
    recommendedStateCode:  'CS',
    reason:                'Shock no longer active; insufficient evidence of fresh instability.',
  };
}
