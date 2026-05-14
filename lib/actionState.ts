// v13.9.0: ACTION STATE ladder — escalation hierarchy for the
// terminal's decision banner. Replaces lib/entryStatus.ts.
//
// The prior EntryStatus collapsed every signal to BLOCKED unless a
// rare stance verb fired, which made the terminal feel permanently
// passive. The new ladder lets favorable environments visibly
// escalate while keeping discipline:
//
//   BLOCKED  — no directional edge, contradictory structure, late
//              compression decay, exhausted state, insufficient
//              ignition, low clarity
//   WATCH    — environment evolving, directional pressure forming,
//              transition probability rising, trigger incomplete
//   READY    — directional edge aligned, structure intact, clarity
//              moderate/high, ignition near, awaiting confirmation
//   GO       — high conviction: state ∈ {IS,AT,SS}, NOT Late/Exh,
//              clarity ≥ threshold, edge ≥ MOD, structure aligned,
//              dominance not contradictory, invalidators ≤ 1,
//              confidence stable/rising, no decay warning
//   MANAGE   — open position still valid, manage exposure
//   EXIT     — open position with broken thesis / invalidator hit
//
// GO is intentionally rare. The rarity is the value: when GO appears,
// the environment genuinely changed.
//
// Pure derivation. No Engine call. No payload change. The function
// returns a stable shape so the banner can read .state + .headline +
// .description + .bullets without conditional checks.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';

export type ActionState = 'BLOCKED' | 'WATCH' | 'READY' | 'GO' | 'MANAGE' | 'EXIT';

export interface ActionStateRead {
  state:       ActionState;
  /** Hex color matching the v13.4+ palette. */
  color:       string;
  /** One-line "what it is". Shown big under the state label. */
  headline:    string;
  /** Optional longer secondary line. Quietest. */
  description?: string;
  /** Optional bullet list shown only when GO fires — the four checks
   *  that passed, so the user sees WHY GO appeared this read. */
  bullets?:    string[];
}

export interface ActionStateOptions {
  /** Minimum read clarity for GO. Defaults to 0.62. */
  goClarity?:    number;
  /** Minimum read clarity for READY. Defaults to 0.50. */
  readyClarity?: number;
}

const COLOR: Record<ActionState, string> = {
  BLOCKED: '#c45a5a',
  WATCH:   '#d4a028',
  READY:   '#4dd9e8',
  GO:      '#22c55e',
  MANAGE:  '#d4a028',
  EXIT:    '#c45a5a',
};

// State codes that categorically refuse new entries.
const BLOCKED_STATE_CODES = new Set(['CL', 'DC', 'DS', 'DD', 'FA', 'SH']);
// Codes that ENABLE the GO / READY ladder when other conditions hold.
const DIRECTIONAL_STATE_CODES = new Set(['IS', 'AT', 'SS']);
// Codes that force EXIT when there's an open position.
const EXIT_TRIGGER_CODES = new Set(['FA', 'SH', 'DS']);

function contradictoryStructure(
  dom:       GcpStateResponse['structureDominance'],
  direction: string,
): boolean {
  if (!dom || dom === 'neutral') return false;
  if (direction === 'Up'
      && (dom === 'bearish' || dom === 'fragile_bearish')) return true;
  if (direction === 'Down'
      && (dom === 'bullish' || dom === 'fragile_bullish')) return true;
  return false;
}

function awaitingClassification(): ActionStateRead {
  return {
    state:       'BLOCKED',
    color:       '#7F98A3',
    headline:    'Awaiting Guru classification',
    description: 'Click Ask Guru to capture a read.',
  };
}

// ────────────────────────────────────────────────────────────────────
// Public: deriveActionState
//
// `hasOpenPosition` defaults to false, which gives the
// environment-only view used by the history snapshot. The Trade page
// passes true when a position is live, which can promote the read to
// MANAGE / EXIT.
// ────────────────────────────────────────────────────────────────────

export function deriveActionState(
  args: {
    aiState:          GcpStateResponse | null;
    hasOpenPosition?: boolean;
    history?:         AiStateHistoryRecord[];
  },
  options: ActionStateOptions = {},
): ActionStateRead {
  const { aiState, hasOpenPosition = false, history = [] } = args;
  const goClarity    = options.goClarity    ?? 0.62;
  const readyClarity = options.readyClarity ?? 0.50;

  if (!aiState) return awaitingClassification();

  const code     = aiState.stateCode;
  const phase    = aiState.phase;
  const dir      = aiState.direction;
  const conf     = aiState.confidence;
  const band     = aiState.pressureBand;
  const dom      = aiState.structureDominance;
  const momentum = aiState.momentumState;
  const invs     = aiState.invalidators ?? [];
  const transC   = aiState.transitionConfidence ?? 0;
  const next     = aiState.nextLikelyState;
  const long     = aiState.longPressure  ?? 50;
  const short    = aiState.shortPressure ?? 50;
  const skew     = Math.abs(long - short);

  const prior        = history[1] ?? null;          // newest-first; [0] is current
  const priorConf    = prior?.confidence ?? null;
  const confDelta    = priorConf != null ? conf - priorConf : 0;
  const isContradict = contradictoryStructure(dom, dir);
  const isLate       = phase === 'Late' || phase === 'Exhausted';
  const lateDecay    = code === 'CS' && (phase === 'Late' || phase === 'Exhausted');
  const decayWarn    = code === 'DC' || momentum === 'exhausted';

  // 1. With an open position the ladder skips to MANAGE / EXIT.
  if (hasOpenPosition) {
    if (EXIT_TRIGGER_CODES.has(code)
        || momentum === 'exhausted'
        || invs.length >= 2) {
      const reason =
          code === 'FA' ? 'Thesis broken — failed alignment'
        : code === 'SH' ? 'Shock event — exit setup'
        : code === 'DS' ? 'Discharge — unwind exposure'
        : invs.length >= 2 ? 'Multiple invalidators triggered'
        : 'Momentum exhausted — exit setup';
      return {
        state:       'EXIT',
        color:       COLOR.EXIT,
        headline:    reason,
        description: 'Close or tighten the active position.',
      };
    }
    return {
      state:       'MANAGE',
      color:       COLOR.MANAGE,
      headline:    'Position active — manage existing exposure',
      description: 'Tighten stops / scale per plan; no new entries.',
    };
  }

  // 2. GO — strict cascade. Every requirement must hold.
  const goChecks = {
    directionalState: DIRECTIONAL_STATE_CODES.has(code),
    notLate:          !isLate,
    clarityHigh:      conf >= goClarity,
    edgeAtLeastMod:   band === 'moderate' || band === 'strong',
    structureAligned: !isContradict
                       && dom !== 'fragile_bullish'
                       && dom !== 'fragile_bearish',
    invalidatorsLow:  invs.length <= 1,
    confidenceStable: confDelta >= -0.02,
    momentumOk:       momentum !== 'decelerating'
                       && momentum !== 'exhausted'
                       && momentum !== 'transitioning',
    noDecay:          !decayWarn,
  };
  const goAllPass = Object.values(goChecks).every(v => v);
  if (goAllPass) {
    return {
      state:    'GO',
      color:    COLOR.GO,
      headline: 'Environment aligned for continuation',
      bullets: [
        'Alignment confirmed',
        'Momentum building',
        'Invalidation clean',
        'Clarity above threshold',
      ],
    };
  }

  // 3. BLOCKED — categorical refusals: contradictory structure, late
  //    decay, exhausted / failure / shock states, low clarity.
  const blockedReasons: string[] = [];
  if (BLOCKED_STATE_CODES.has(code)) {
    const stateReason =
        code === 'CL' ? 'Climax exhaustion'
      : code === 'DC' ? 'Directional decay'
      : code === 'DS' ? 'Discharge — unwinding'
      : code === 'DD' ? 'Dead drift — no edge'
      : code === 'FA' ? 'Failed alignment'
      :                 'Shock event';
    blockedReasons.push(stateReason);
  }
  if (lateDecay) blockedReasons.push('Late compression decay');
  if (conf < 0.40) blockedReasons.push('Low clarity');
  if (isContradict) blockedReasons.push('Contradictory structure');
  if (decayWarn && !blockedReasons.length) blockedReasons.push('Momentum exhausted');

  if (blockedReasons.length > 0) {
    return {
      state:       'BLOCKED',
      color:       COLOR.BLOCKED,
      headline:    blockedReasons[0],
      description: blockedReasons.length > 1
        ? blockedReasons.slice(1).join(' · ')
        : 'No directional edge — wait for a cleaner read.',
    };
  }

  // 4. READY — directional state, mid-clarity, edge ≥ moderate, no
  //    contradictions. The "one rung below GO" — typically what fires
  //    when clarity is good but momentum hasn't progressed yet.
  const readyChecks =
       DIRECTIONAL_STATE_CODES.has(code)
    && !isLate
    && conf >= readyClarity
    && (band === 'moderate' || band === 'strong')
    && !isContradict;
  if (readyChecks) {
    const detail =
        code === 'IS' ? 'Awaiting ignition confirmation'
      : code === 'AT' ? 'Trend in progress — confirm continuation'
      :                 'Synchronization holding — confirm extension';
    return {
      state:       'READY',
      color:       COLOR.READY,
      headline:    detail,
      description: 'Directional edge present; trigger pending.',
    };
  }

  // 5. WATCH — environment is forming. Triggers when transition
  //    pressure is building OR directional skew is non-trivial OR a
  //    compression / ignition stretch is underway.
  const watchAllowed =
       (band === 'moderate' || band === 'strong')
    || transC >= 0.35
    || skew >= 12
    || code === 'CS'
    || code === 'IS';
  if (watchAllowed) {
    const detail =
        transC >= 0.35 && next ? `Transition pressure rising toward ${next}`
      : code === 'CS'         ? 'Compression — pressure forming'
      : code === 'IS'         ? 'Ignition forming — confirmation pending'
      : skew >= 12            ? 'Directional pressure building'
      :                          'Setup forming — confirmation required';
    return {
      state:       'WATCH',
      color:       COLOR.WATCH,
      headline:    detail,
      description: 'Environment evolving — no entry yet.',
    };
  }

  // 6. Default — flat / no signal.
  return {
    state:       'BLOCKED',
    color:       COLOR.BLOCKED,
    headline:    'No directional edge',
    description: 'Environment flat — wait for a cleaner read.',
  };
}
