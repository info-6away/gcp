// v16.1 — Phase 16.1: Temporal Drift Intelligence.
//
// Pure derivation. Compares the CURRENT read for a symbol against the
// PRIOR read (last scan / last classification / last history row) and
// projects how the environment, the action ladder, and an open
// position's thesis are moving over time.
//
// The Engine, payload, prompts, thresholds, GO logic, action ladder,
// trade math and pressure/dominance calculations are unchanged. This
// only labels the gradient between two reads so the UI can show:
//
//   • Radar — a "trend" line per card ("↑ improving from BLOCKED")
//   • Trade — separation of ENVIRONMENT READ vs POSITION THESIS, with
//             a conflict banner when the field is building while the
//             open position thesis is broken
//   • Guru timeline — a per-row drift tag (improving / weakening /
//             stable / rotating)

import type { ActionState } from '@/lib/actionState';
import type { RadarResult } from '@/lib/radarScan';
import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';
import { deriveOpportunityDistance } from '@/lib/opportunityDistance';

export type FieldDrift  = 'improving' | 'weakening' | 'stable' | 'rotating';
export type ActionDrift = 'upgrading' | 'downgrading' | 'unchanged';
/** Presentation vocabulary for the position thesis. INTACT/DRIFT/
 *  INVALIDATED/EXIT are mapped from the underlying MANAGE/EXIT action
 *  state combined with field drift — the action ladder itself is
 *  unchanged. */
export type ThesisState = 'INTACT' | 'DRIFT' | 'INVALIDATED' | 'EXIT';

/** Normalized two-frame input. The same shape comes out of a
 *  RadarResult and out of an AiStateHistoryRecord (+ action context),
 *  so the comparison logic doesn't fan out per call site. */
export interface DriftFrame {
  /** 0-100 — Engine confidence × 100, rounded. */
  clarity:           number;
  /** 0-100. */
  longPressure:      number;
  /** 0-100. */
  shortPressure:     number;
  actionState:       ActionState;
  /** 0-100 closeness-to-GO. Optional — history rows don't carry it
   *  unless the radar fed them. */
  opportunityScore?: number;
  /** Count of active invalidators at read time. */
  invalidators:      number;
  /** Engine state code (CS / IS / AT / SS / CL / DC / DS / DD / FA / SH). */
  stateCode?:        string;
}

export interface TemporalDrift {
  fieldDrift:       FieldDrift;
  actionDrift:      ActionDrift;
  /** Signed deltas — positive = current is higher than prior. */
  clarityDelta:     number;
  /** Signed long/short skew delta (curSkew − priorSkew). */
  pressureDelta:    number;
  opportunityDelta: number | null;
  /** Invalidator count delta. Positive = MORE invalidators now. */
  blockerDelta:     number;
  summary:          string;
  /** Compact tag — same as fieldDrift, exposed for badge consumers. */
  tag:              FieldDrift;
  arrow:            '↑' | '↓' | '→' | '↻';
  /** Hex / CSS color for the badge. */
  color:            string;
}

// Higher = better rung on the ladder. EXIT sits at zero so a
// degradation into EXIT registers as a sharp negative actDelta.
const ACTION_RANK: Record<ActionState, number> = {
  EXIT: 0, BLOCKED: 1, MANAGE: 2, WATCH: 3, READY: 4, GO: 5,
};

const DRIFT_COLOR: Record<FieldDrift, string> = {
  improving: '#22c55e',
  weakening: '#d4a028',
  stable:    'var(--fg-3)',
  rotating:  '#4dd9e8',
};

const DRIFT_ARROW: Record<FieldDrift, '↑' | '↓' | '→' | '↻'> = {
  improving: '↑',
  weakening: '↓',
  stable:    '→',
  rotating:  '↻',
};

// ────────────────────────────────────────────────────────────────────
// Core derivation
// ────────────────────────────────────────────────────────────────────

export function deriveTemporalDrift(
  current: DriftFrame,
  prior:   DriftFrame | null,
): TemporalDrift | null {
  if (!prior) return null;

  const clarityDelta = current.clarity - prior.clarity;
  const opportunityDelta =
    current.opportunityScore != null && prior.opportunityScore != null
      ? current.opportunityScore - prior.opportunityScore
      : null;
  const blockerDelta = current.invalidators - prior.invalidators;

  const curSkew   = current.longPressure - current.shortPressure;
  const priorSkew = prior.longPressure   - prior.shortPressure;
  const pressureDelta = curSkew - priorSkew;

  // Rotating — long/short skew flipped sign AND was non-trivial on
  // both sides. A flip from −2 to +4 isn't a rotation; −18 → +14 is.
  const flipped =
       Math.sign(curSkew) !== Math.sign(priorSkew)
    && Math.abs(curSkew)   > 8
    && Math.abs(priorSkew) > 8;

  const actDelta =
    ACTION_RANK[current.actionState] - ACTION_RANK[prior.actionState];
  const actionDrift: ActionDrift =
       actDelta > 0 ? 'upgrading'
    :  actDelta < 0 ? 'downgrading'
    :                 'unchanged';

  // Composite improvement signal — heavier weights on ladder rung
  // and invalidator changes because those carry more trade-side
  // meaning than small clarity wiggles.
  const improvement =
       clarityDelta
     + (opportunityDelta ?? 0)
     + actDelta * 15
     - blockerDelta * 10;

  const fieldDrift: FieldDrift =
       flipped              ? 'rotating'
    :  improvement >  10    ? 'improving'
    :  improvement < -10    ? 'weakening'
    :                         'stable';

  return {
    fieldDrift,
    actionDrift,
    clarityDelta,
    pressureDelta,
    opportunityDelta,
    blockerDelta,
    summary: summarize({
      fieldDrift, actionDrift,
      priorAction:   prior.actionState,
      currentAction: current.actionState,
      clarityDelta, opportunityDelta, blockerDelta,
    }),
    tag:   fieldDrift,
    arrow: DRIFT_ARROW[fieldDrift],
    color: DRIFT_COLOR[fieldDrift],
  };
}

function summarize(args: {
  fieldDrift:     FieldDrift;
  actionDrift:    ActionDrift;
  priorAction:    ActionState;
  currentAction:  ActionState;
  clarityDelta:   number;
  opportunityDelta: number | null;
  blockerDelta:   number;
}): string {
  const {
    fieldDrift, actionDrift,
    priorAction, currentAction,
    clarityDelta, opportunityDelta, blockerDelta,
  } = args;

  // Action transitions carry the strongest narrative — lead with them.
  if (actionDrift !== 'unchanged') {
    const dir = actionDrift === 'upgrading' ? 'improving' : 'degrading';
    return `Radar ${dir} from ${priorAction} → ${currentAction}.`;
  }
  // Opportunity score is the next-strongest signal.
  if (opportunityDelta != null && Math.abs(opportunityDelta) >= 10) {
    return opportunityDelta > 0
      ? `Opportunity climbing — ${opportunityDelta}% closer to entry.`
      : `Opportunity slipping — ${Math.abs(opportunityDelta)}% further from entry.`;
  }
  if (clarityDelta >=  5) return `Action unchanged; clarity improving (+${clarityDelta}%).`;
  if (clarityDelta <= -5) return `Action unchanged; clarity weakening (${clarityDelta}%).`;
  if (blockerDelta > 0)   return `${blockerDelta} new invalidator${blockerDelta > 1 ? 's' : ''} active.`;
  if (blockerDelta < 0)   return `${Math.abs(blockerDelta)} invalidator${blockerDelta < -1 ? 's' : ''} cleared.`;
  return fieldDrift === 'rotating' ? 'Pressure rotating — long/short flipped.'
                                   : 'Read holding stable.';
}

// ────────────────────────────────────────────────────────────────────
// Frame builders — keep call sites tidy
// ────────────────────────────────────────────────────────────────────

export function driftFrameFromRadarResult(
  result: RadarResult,
): DriftFrame | null {
  if (!result.ok || !result.aiState || !result.action) return null;
  const ai = result.aiState;
  const opp = deriveOpportunityDistance(result);
  return {
    clarity:           Math.round((ai.confidence ?? 0) * 100),
    longPressure:      ai.longPressure  ?? 50,
    shortPressure:     ai.shortPressure ?? 50,
    actionState:       result.action.actionState,
    opportunityScore:  opp?.score,
    invalidators:      (ai.invalidators ?? []).length,
    stateCode:         ai.stateCode,
  };
}

export function driftFrameFromHistoryRecord(
  r: AiStateHistoryRecord,
): DriftFrame {
  return {
    clarity:       Math.round((r.confidence ?? 0) * 100),
    longPressure:  r.longPressure  ?? 50,
    shortPressure: r.shortPressure ?? 50,
    // Older history rows (pre-v13.9) may not carry actionState — fall
    // back to BLOCKED so a missing rung doesn't masquerade as GO.
    actionState:   (r.actionState as ActionState | undefined) ?? 'BLOCKED',
    invalidators:  (r.invalidatorsSnap ?? []).length,
    stateCode:     r.stateCode,
  };
}

// ────────────────────────────────────────────────────────────────────
// Position thesis vocabulary (presentation only)
// ────────────────────────────────────────────────────────────────────

export function derivePositionThesis(args: {
  actionState:     ActionState;
  hasOpenPosition: boolean;
  fieldDrift?:     FieldDrift;
}): ThesisState | null {
  if (!args.hasOpenPosition) return null;
  if (args.actionState === 'EXIT') {
    // EXIT triggered by invalidators / failed alignment reads as
    // INVALIDATED; momentum-driven exit stays as EXIT. The action
    // ladder collapses both into actionState=EXIT — without invalid-
    // ator detail at this layer we surface INVALIDATED, which is the
    // more common case.
    return 'INVALIDATED';
  }
  if (args.actionState === 'MANAGE') {
    return args.fieldDrift === 'weakening' ? 'DRIFT' : 'INTACT';
  }
  // No open position OR action is on the entry-side ladder
  // (BLOCKED/WATCH/READY/GO) — there's no thesis yet to label.
  return null;
}

export const THESIS_COLOR: Record<ThesisState, string> = {
  INTACT:      '#22c55e',
  DRIFT:       '#d4a028',
  INVALIDATED: '#c45a5a',
  EXIT:        '#c45a5a',
};

// ────────────────────────────────────────────────────────────────────
// Environment-vs-thesis conflict — Trade banner driver
// ────────────────────────────────────────────────────────────────────

export interface EnvVsThesis {
  envState:    ActionState;
  thesisState: ThesisState | null;
  conflict:    boolean;
  /** One-liner shown in the banner when conflict is true. */
  banner:      string | null;
}

export function deriveEnvVsThesis(args: {
  /** Action ladder run with hasOpenPosition=false — the pure
   *  environment read. */
  envAction:        ActionState;
  /** Action ladder run with the user's actual position state. */
  positionAction:   ActionState;
  hasOpenPosition:  boolean;
  fieldDrift?:      FieldDrift;
}): EnvVsThesis {
  const thesis = derivePositionThesis({
    actionState:     args.positionAction,
    hasOpenPosition: args.hasOpenPosition,
    fieldDrift:      args.fieldDrift,
  });

  // No open position — nothing to reconcile.
  if (!args.hasOpenPosition || !thesis) {
    return {
      envState: args.envAction, thesisState: thesis,
      conflict: false, banner: null,
    };
  }

  const envImproving =
       args.envAction === 'WATCH'
    || args.envAction === 'READY'
    || args.envAction === 'GO';
  const thesisBroken = thesis === 'INVALIDATED' || thesis === 'EXIT';

  if (envImproving && thesisBroken) {
    return {
      envState: args.envAction, thesisState: thesis,
      conflict: true,
      banner: 'Field is building; existing trade remains invalidated.',
    };
  }
  if (args.fieldDrift === 'weakening' && thesis === 'INTACT') {
    return {
      envState: args.envAction, thesisState: 'DRIFT',
      conflict: true,
      banner: 'Position thesis intact, but environment is deteriorating.',
    };
  }

  return {
    envState: args.envAction, thesisState: thesis,
    conflict: false, banner: null,
  };
}
