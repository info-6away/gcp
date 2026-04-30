'use client';

// v11.17: deterministic action-posture mapper. Sits between the AI
// classification (environment) and the user (decision), translating
// state + direction + phase + confidence into a one-line posture
// guidance string. NOT a buy/sell signal — this is "what stance
// should I take given the environment".
//
// Mapping is intentionally simple so it stays inspectable. Pattern is
// a modifier, not the source of truth — it appends a clause to the
// base posture (e.g. "Favor continuation setups — strong GCP event
// support" when PSS >= 70 on Alignment Trend) but doesn't change the
// posture itself.
//
// v11.18: extended with three new layers — Market Mode, Execution
// Trigger, and Size guidance. The full Posture struct returned by
// derivePosture() drives the dashboard's MODE / ACTION / TRIGGER /
// SIZE rows. Logic is still deterministic; the original
// deriveAction() stays intact and is used internally.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { Pattern } from '@/types/gcp';

export type ActionTone = 'wait' | 'favor' | 'avoid' | 'risk';

export interface ActionPosture {
  text: string;
  tone: ActionTone;
}

// v11.18 types
export type MarketMode =
  | 'Trending'
  | 'Ranging'
  | 'Compression'
  | 'Breakout Watch'
  | 'Reversal Watch'
  | 'Exhaustion'
  | 'No Signal';

export type SizeGuidance = 'Full' | 'Half' | 'Small' | 'No trade';

export interface Posture {
  mode:     MarketMode;
  action:   ActionPosture;
  trigger:  string;
  size:     SizeGuidance;
  sizeTone: ActionTone;
}

const FALLBACK: ActionPosture = {
  text: 'Observe — insufficient confirmation',
  tone: 'wait',
};

function basePosture(state: GcpStateResponse): ActionPosture {
  const { stateCode, direction: dir, phase, confidence } = state;

  switch (stateCode) {
    case 'IS': // Ignition State
      if (dir === 'Mixed' || dir === 'Neutral' || confidence < 0.5) {
        return { text: 'Wait for confirmation', tone: 'wait' };
      }
      if (dir === 'Up')   return { text: 'Watch for upside continuation', tone: 'favor' };
      if (dir === 'Down') return { text: 'Watch for downside continuation', tone: 'favor' };
      return { text: 'Wait for confirmation', tone: 'wait' };

    case 'AT': // Alignment Trend
      if (phase === 'Late' || phase === 'Exhausted') {
        return { text: 'Manage risk — move may be mature', tone: 'risk' };
      }
      if (dir === 'Up')   return { text: 'Favor continuation setups', tone: 'favor' };
      if (dir === 'Down') return { text: 'Favor downside continuation setups', tone: 'favor' };
      return { text: 'Wait for direction', tone: 'wait' };

    case 'CS': // Compression
      if (phase === 'Late' || phase === 'Exhausted') {
        return { text: 'Breakout risk rising — wait for direction', tone: 'risk' };
      }
      return { text: 'Watch for breakout', tone: 'wait' };

    case 'FA': // Failed Alignment
      return { text: 'Avoid chasing — fakeout risk', tone: 'avoid' };

    case 'DS': // Discharge
      return { text: 'Avoid new positions — exhaustion risk', tone: 'avoid' };

    case 'DD': // Dead Drift
      return { text: 'No trade — low signal environment', tone: 'wait' };

    case 'SH': // Shock
      return { text: 'High volatility — reduce size / wait', tone: 'risk' };

    case 'CL': // Climax
      return { text: 'Climax — manage risk / fade exhaustion', tone: 'risk' };

    case 'SS': // Synchronization
      if (phase === 'Late' || phase === 'Exhausted') {
        return { text: 'Manage risk — sync may be peaking', tone: 'risk' };
      }
      if (dir === 'Up' || dir === 'Down') {
        return { text: 'Favor continuation — sync trend', tone: 'favor' };
      }
      return { text: 'Observe — sync direction unclear', tone: 'wait' };
  }

  return FALLBACK;
}

// Pattern is a modifier, not the source of truth. We append a short
// clause when the pattern reinforces, complicates, or contradicts the
// base posture. Keep these few — over-fitting modifiers makes the
// action line noisy.
function patternModifier(
  state: GcpStateResponse,
  latestPattern: Pattern | null,
): string {
  if (!latestPattern) return '';

  const kind = latestPattern.kind;
  const pss  = Math.round(latestPattern.strength * 100);
  const code = state.stateCode;

  // Pulse Train during ignition: pressure is building toward release.
  if (code === 'IS' && kind === 'Pulse Train') return ' — pressure is building';

  // Strong GCP event support during a trend regime.
  if ((code === 'AT' || code === 'SS') && pss >= 70) return ' — strong GCP event support';

  // Compression patterns mirror compression state.
  if (code === 'CS' && kind === 'Compression Coil')    return ' — coil tightening';
  if (code === 'CS' && kind === 'Compression Release') return ' — coil releasing';

  // Failed alignment: pattern itself may be misleading.
  if (code === 'FA') return ' — pattern may be misleading';

  // Shock event surfaced as a pattern.
  if (kind === 'Shock Jump') return ' — shock event detected';

  // Discharge breakers / waves reinforce exhaustion warning.
  if (code === 'DS' && (kind === 'Discharge Break' || kind === 'Discharge Wave')) {
    return ' — discharge underway';
  }

  return '';
}

export function deriveAction(
  state: GcpStateResponse | null,
  latestPattern: Pattern | null,
): ActionPosture | null {
  if (!state) return null;
  const base = basePosture(state);
  const modifier = patternModifier(state, latestPattern);
  return { text: base.text + modifier, tone: base.tone };
}

export function actionToneColor(tone: ActionTone): string {
  switch (tone) {
    case 'favor':  return 'var(--green)';
    case 'avoid':  return 'var(--red)';
    case 'risk':   return '#d4a028';
    case 'wait':   return 'var(--cyan)';
  }
}

// v11.18: Market Mode mapping. Mirrors the Action mapping but
// exposes the regime label the user should think in (trend / range
// / compression / etc.). Deterministic from stateCode.
function deriveMode(state: GcpStateResponse): MarketMode {
  switch (state.stateCode) {
    case 'IS':
      return state.direction === 'Mixed' || state.direction === 'Neutral'
        ? 'Breakout Watch'
        : 'Trending';
    case 'AT': return 'Trending';
    case 'SS': return 'Trending';
    case 'CS': return 'Compression';
    case 'FA': return 'Reversal Watch';
    case 'DS': return 'Exhaustion';
    case 'CL': return 'Exhaustion';
    case 'SH': return 'Exhaustion';
    case 'DD': return 'Ranging';
  }
  return 'No Signal';
}

// Execution trigger — what would have to happen before sizing up.
// Derived from the mode itself; same mode → same trigger guidance.
function triggerFor(mode: MarketMode): string {
  switch (mode) {
    case 'Trending':       return 'Pullback or continuation confirmation';
    case 'Ranging':        return 'Fade range extremes only';
    case 'Compression':    return 'Breakout required for size';
    case 'Breakout Watch': return 'Confirmation needed before size';
    case 'Reversal Watch': return 'Wait for rejection confirmation';
    case 'Exhaustion':     return 'Only scalp / fade with confirmation';
    case 'No Signal':      return '—';
  }
}

// Size guidance — how much risk to put on. Strict gates because the
// goal is capital preservation in the wrong environments and only
// allows Full when every signal lines up.
function deriveSize(
  state: GcpStateResponse,
  latestPattern: Pattern | null,
): SizeGuidance {
  const code  = state.stateCode;
  const dir   = state.direction;
  const phase = state.phase;
  const conf  = state.confidence;
  const pss   = latestPattern ? Math.round(latestPattern.strength * 100) : 0;

  // Hard "no trade" cases — protect capital.
  if (code === 'FA') return 'No trade';
  if (code === 'SH') return 'No trade';
  if ((code === 'DS' || code === 'CL') && (phase === 'Late' || phase === 'Exhausted')) {
    return 'No trade';
  }
  if (code === 'DD' && conf < 0.4) return 'No trade';

  // Full size — strong alignment trend, early/mid, high confidence,
  // strong GCP event support.
  if (code === 'AT'
      && (dir === 'Up' || dir === 'Down')
      && (phase === 'Early' || phase === 'Mid')
      && conf >= 0.7
      && pss >= 70) {
    return 'Full';
  }

  // Half size — early/mid trend, decent ignition, clean compression
  // breakout watch.
  if ((code === 'AT' || code === 'SS')
      && (dir === 'Up' || dir === 'Down')
      && (phase === 'Early' || phase === 'Mid')) {
    return 'Half';
  }
  if (code === 'IS' && (dir === 'Up' || dir === 'Down') && conf >= 0.6) {
    return 'Half';
  }
  if (code === 'CS' && (phase === 'Early' || phase === 'Mid') && conf >= 0.6) {
    return 'Half';
  }

  // Default: small. Range mean-reversion, mixed bias, low conf,
  // late-phase trends.
  return 'Small';
}

function sizeTone(size: SizeGuidance): ActionTone {
  switch (size) {
    case 'Full':     return 'favor';
    case 'Half':     return 'favor';
    case 'Small':    return 'wait';
    case 'No trade': return 'avoid';
  }
}

export function derivePosture(
  state: GcpStateResponse | null,
  latestPattern: Pattern | null,
): Posture | null {
  if (!state) return null;
  const action  = deriveAction(state, latestPattern);
  if (!action) return null;
  const mode    = deriveMode(state);
  const trigger = triggerFor(mode);
  const size    = deriveSize(state, latestPattern);
  return { mode, action, trigger, size, sizeTone: sizeTone(size) };
}
