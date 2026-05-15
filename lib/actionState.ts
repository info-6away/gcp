// v13.9.1: ACTION STATE ladder with PRICE STRUCTURE CONFIRMATION.
//
// Pure derivation. No Engine call. No payload change. The ladder lets
// favorable environments visibly escalate while keeping discipline
// (GO is intentionally rare):
//
//   BLOCKED  weak / unclear environment, low clarity, contradictory
//            structure, late compression decay, exhaustion, active
//            invalidators
//   WATCH    environment building, transition pressure forming,
//            directional edge incipient, trigger incomplete
//   READY    state ∈ {IS,AT,SS}, structure aligned, clarity moderate+,
//            edge ≥ moderate, awaiting confirmation candle / reclaim
//            / breakout
//   GO       rare — every check passes (state non-Late, clarity ≥
//            threshold, edge ≥ MOD, structural dominance agrees,
//            price structure confirms direction, invalidators ≤ 1,
//            confidence stable/rising or ladder progressed, no decay /
//            shock / exhaustion overlay)
//   MANAGE   open position still valid
//   EXIT     open position with broken thesis / invalidator hit
//
// Return shape (v13.9.1):
//   { actionState, label, reason, blockers, confirmations, color, ... }

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';
import type { PriceStructureRead } from '@/lib/priceStructureConfirmation';

export type ActionState =
  'BLOCKED' | 'WATCH' | 'READY' | 'GO' | 'MANAGE' | 'EXIT';

export interface ActionStateRead {
  actionState:   ActionState;
  /** Short human-form label — e.g. "Wait", "Watching", "Awaiting trigger",
   *  "Entry permitted", "Managing position", "Exit setup". */
  label:         string;
  /** Primary one-line reason shown under the state. */
  reason:        string;
  /** Failed checks (mostly populated when not GO). Lets the UI
   *  surface "what's missing for the next rung". */
  blockers:      string[];
  /** Passing checks — surfaced as ✓ chips when GO fires, optionally
   *  shown for READY too. */
  confirmations: string[];
  /** Hex color matching the v13.4+ palette — convenience for UI. */
  color:         string;
}

export interface ActionStateOptions {
  goClarity?:    number;    // default 0.50 — spec says ≥ 50
  readyClarity?: number;    // default 0.50
}

const COLOR: Record<ActionState, string> = {
  BLOCKED: '#c45a5a',
  WATCH:   '#d4a028',
  READY:   '#4dd9e8',
  GO:      '#22c55e',
  MANAGE:  '#d4a028',
  EXIT:    '#c45a5a',
};

const BLOCKED_STATE_CODES     = new Set(['CL', 'DC', 'DS', 'DD', 'FA', 'SH']);
const DIRECTIONAL_STATE_CODES = new Set(['IS', 'AT', 'SS']);
const EXIT_TRIGGER_CODES      = new Set(['FA', 'SH', 'DS']);

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

function priceContradicts(
  priceStructure: PriceStructureRead | null | undefined,
  direction:      string,
): boolean {
  if (!priceStructure) return false;
  if (direction === 'Up'   && priceStructure.structure === 'bearish') return true;
  if (direction === 'Down' && priceStructure.structure === 'bullish') return true;
  return false;
}

function priceAlignsWith(
  priceStructure: PriceStructureRead | null | undefined,
  direction:      string,
): boolean {
  if (!priceStructure) return false;
  if (direction === 'Up'   && priceStructure.structure === 'bullish') return true;
  if (direction === 'Down' && priceStructure.structure === 'bearish') return true;
  return false;
}

function ladderProgressed(
  current: GcpStateResponse,
  prior:   AiStateHistoryRecord | null,
): boolean {
  if (!prior) return false;
  const progression: Record<string, string[]> = {
    CS: ['IS'],
    IS: ['AT', 'SS'],
    AT: ['SS'],
  };
  const advances = progression[prior.stateCode];
  return !!advances && advances.includes(current.stateCode);
}

function awaitingClassification(): ActionStateRead {
  return {
    actionState:   'BLOCKED',
    label:         'Wait',
    reason:        'Awaiting Guru classification.',
    blockers:      ['No read yet — click Ask Guru.'],
    confirmations: [],
    color:         '#7F98A3',
  };
}

// ────────────────────────────────────────────────────────────────────
// Public: deriveActionState
// ────────────────────────────────────────────────────────────────────

export function deriveActionState(
  args: {
    aiState:          GcpStateResponse | null;
    /** Optional pre-derived inputs. All accepted for forward
     *  compatibility; most are also read from aiState directly. */
    directionalEdge?:     GcpStateResponse['pressureBand'];
    structuralDominance?: GcpStateResponse['structureDominance'];
    temporalPressure?:    GcpStateResponse['momentumState'];
    patternStory?:        unknown;
    metrics?:             unknown;
    priceStructure?:      PriceStructureRead | null;
    invalidators?:        string[];
    history?:             AiStateHistoryRecord[];
    /** Aliased as openPosition or hasOpenPosition — either works. */
    openPosition?:        boolean;
    hasOpenPosition?:     boolean;
  },
  options: ActionStateOptions = {},
): ActionStateRead {
  const aiState         = args.aiState;
  const priceStructure  = args.priceStructure ?? null;
  const history         = args.history ?? [];
  const openPosition    = args.openPosition ?? args.hasOpenPosition ?? false;
  const goClarity       = options.goClarity    ?? 0.50;
  const readyClarity    = options.readyClarity ?? 0.50;

  if (!aiState) return awaitingClassification();

  const code     = aiState.stateCode;
  const phase    = aiState.phase;
  const dir      = aiState.direction;
  const conf     = aiState.confidence;
  const band     = args.directionalEdge     ?? aiState.pressureBand;
  const dom      = args.structuralDominance ?? aiState.structureDominance;
  const momentum = args.temporalPressure    ?? aiState.momentumState;
  const invs     = args.invalidators        ?? aiState.invalidators ?? [];
  const transC   = aiState.transitionConfidence ?? 0;
  const long     = aiState.longPressure  ?? 50;
  const short    = aiState.shortPressure ?? 50;
  const skew     = Math.abs(long - short);

  const prior        = history[1] ?? null;
  const priorConf    = prior?.confidence ?? null;
  const confDelta    = priorConf != null ? conf - priorConf : 0;
  const isContradict = contradictoryStructure(dom, dir);
  const priceMisaligns = priceContradicts(priceStructure, dir);
  const priceAligns    = priceAlignsWith(priceStructure, dir);
  const isLate         = phase === 'Late' || phase === 'Exhausted';
  const lateDecay      = code === 'CS' && (phase === 'Late' || phase === 'Exhausted');
  const decayWarn      = code === 'DC' || momentum === 'exhausted';
  const progressed     = ladderProgressed(aiState, prior);

  // 1. Position-aware branch: MANAGE / EXIT.
  if (openPosition) {
    if (EXIT_TRIGGER_CODES.has(code)
        || momentum === 'exhausted'
        || invs.length >= 2
        || priceMisaligns) {
      const reason =
          code === 'FA' ? 'Thesis broken — failed alignment.'
        : code === 'SH' ? 'Shock event — thesis invalidated.'
        : code === 'DS' ? 'Discharge — thesis unwinding.'
        : invs.length >= 2 ? 'Multiple invalidators triggered.'
        : priceMisaligns ? 'Price structure now contradicts the position.'
        : 'Momentum exhausted — exit setup.';
      return {
        actionState:   'EXIT',
        label:         'Exit setup',
        reason,
        blockers:      [reason],
        confirmations: [],
        color:         COLOR.EXIT,
      };
    }
    return {
      actionState:   'MANAGE',
      label:         'Managing position',
      reason:        'Position active; thesis intact.',
      blockers:      [],
      confirmations: ['Thesis intact', 'No invalidator triggered'],
      color:         COLOR.MANAGE,
    };
  }

  // 2. GO — strict cascade. Every check must pass.
  const checks: { key: string; pass: boolean; label: string; blocker: string }[] = [
    { key: 'state',
      pass:    DIRECTIONAL_STATE_CODES.has(code),
      label:   `State ${code} aligned for entry`,
      blocker: `State ${code} not entry-eligible` },
    { key: 'phase',
      pass:    !isLate,
      label:   `Phase ${phase}`,
      blocker: `Phase ${phase} — too late in the move` },
    { key: 'clarity',
      pass:    conf >= goClarity,
      label:   `Clarity ${(conf * 100).toFixed(0)}%`,
      blocker: `Clarity ${(conf * 100).toFixed(0)}% below ${(goClarity * 100).toFixed(0)}%` },
    { key: 'edge',
      pass:    band === 'moderate' || band === 'strong',
      label:   `Directional edge ${band ?? 'unknown'}`,
      blocker: `Directional edge ${band ?? 'unknown'} — need MOD+` },
    { key: 'structure',
      pass:    !isContradict && dom !== 'fragile_bullish' && dom !== 'fragile_bearish',
      label:   'Structural dominance aligned',
      blocker: isContradict
                 ? 'Structural dominance contradicts direction'
                 : 'Structural dominance fragile' },
    { key: 'price',
      // When priceStructure is provided, it must confirm. When it's
      // absent (candles not loaded yet, helper short on bars), the
      // check is treated as a SOFT pass on the live path — GO can
      // still fire on the strength of the other 8 checks.
      pass:    !priceMisaligns
                && (priceStructure == null
                    || (priceAligns
                        && (priceStructure.confirmation === 'confirmed'
                            || priceStructure.confirmation === 'partial'))),
      label:   priceStructure
                 ? `Price structure ${priceStructure.confirmation}`
                 : 'Price structure not contradicted',
      blocker: priceMisaligns
                 ? 'Price structure contradicts direction'
                 : 'Price structure not confirming yet' },
    { key: 'invalidators',
      pass:    invs.length <= 1,
      label:   `Invalidation profile clean (${invs.length})`,
      blocker: `${invs.length} invalidators active` },
    { key: 'momentum',
      pass:    momentum !== 'decelerating'
                && momentum !== 'exhausted'
                && momentum !== 'transitioning'
                && !decayWarn,
      label:   `Momentum ${momentum ?? 'steady'}`,
      blocker: decayWarn
                 ? 'Decay / exhaustion warning active'
                 : `Momentum ${momentum} — not entry-quality` },
    { key: 'strengthening',
      pass:    confDelta >= -0.02 || progressed,
      label:   progressed
                 ? `Ladder progressed (${prior?.stateCode} → ${code})`
                 : 'Clarity stable or strengthening',
      blocker: 'Recent read weakening' },
  ];

  const failed = checks.filter(c => !c.pass);
  const passed = checks.filter(c =>  c.pass);

  if (failed.length === 0) {
    return {
      actionState:   'GO',
      label:         'Entry permitted',
      reason:        'Environment aligned; entry permitted by Guru conditions. Respect invalidation.',
      blockers:      [],
      confirmations: passed.map(c => c.label),
      color:         COLOR.GO,
    };
  }

  // 3. BLOCKED — categorical refusals (state, clarity, contradictions).
  const blockerReasons: string[] = [];
  if (BLOCKED_STATE_CODES.has(code)) {
    blockerReasons.push(
        code === 'CL' ? 'Climax exhaustion.'
      : code === 'DC' ? 'Directional decay.'
      : code === 'DS' ? 'Discharge — unwinding.'
      : code === 'DD' ? 'Dead drift — no edge.'
      : code === 'FA' ? 'Failed alignment.'
      :                 'Shock event.');
  }
  if (lateDecay)       blockerReasons.push('Late compression decay.');
  if (conf < 0.40)     blockerReasons.push('Read clarity too low.');
  if (isContradict)    blockerReasons.push('Structural dominance contradicts direction.');
  if (priceMisaligns)  blockerReasons.push('Price structure contradicts direction.');
  if (decayWarn && !blockerReasons.length) blockerReasons.push('Momentum exhausted.');

  if (blockerReasons.length > 0) {
    return {
      actionState:   'BLOCKED',
      label:         'Wait',
      reason:        blockerReasons[0],
      blockers:      blockerReasons,
      confirmations: [],
      color:         COLOR.BLOCKED,
    };
  }

  // 4. READY — directional state, mid-clarity, edge moderate, no
  //    contradictions, but missing one or more GO checks.
  const readyOk =
       DIRECTIONAL_STATE_CODES.has(code)
    && !isLate
    && conf >= readyClarity
    && (band === 'moderate' || band === 'strong')
    && !isContradict
    && !priceMisaligns;

  if (readyOk) {
    const readyReason =
        priceStructure && priceAligns
          ? 'Structure aligned; awaiting breakout confirmation.'
      : code === 'IS' ? 'Ignition forming; awaiting confirmation candle.'
      : code === 'AT' ? 'Trend in progress; awaiting continuation confirmation.'
      :                 'Synchronization holding; awaiting extension confirmation.';
    return {
      actionState:   'READY',
      label:         'Awaiting trigger',
      reason:        readyReason,
      blockers:      failed.map(c => c.blocker),
      confirmations: passed.map(c => c.label),
      color:         COLOR.READY,
    };
  }

  // 5. WATCH — environment evolving.
  const watchOk =
       (band === 'moderate' || band === 'strong')
    || transC >= 0.35
    || skew >= 12
    || code === 'CS'
    || code === 'IS';
  if (watchOk) {
    const next = aiState.nextLikelyState;
    const watchReason =
        transC >= 0.35 && next ? `Transition pressure rising toward ${next}.`
      : code === 'CS'          ? 'Compression — pressure forming, no ignition.'
      : code === 'IS'          ? 'Ignition forming; confirmation incomplete.'
      : skew >= 12             ? 'Directional pressure building.'
      :                          'Setup forming — confirmation required.';
    return {
      actionState:   'WATCH',
      label:         'Watching',
      reason:        watchReason,
      blockers:      failed.map(c => c.blocker),
      confirmations: passed.map(c => c.label),
      color:         COLOR.WATCH,
    };
  }

  // 6. Default fallback — flat / no signal.
  return {
    actionState:   'BLOCKED',
    label:         'Wait',
    reason:        'No directional edge.',
    blockers:      ['Environment flat — wait for a cleaner read.'],
    confirmations: [],
    color:         COLOR.BLOCKED,
  };
}
