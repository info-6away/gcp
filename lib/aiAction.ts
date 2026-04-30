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

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { Pattern } from '@/types/gcp';

export type ActionTone = 'wait' | 'favor' | 'avoid' | 'risk';

export interface ActionPosture {
  text: string;
  tone: ActionTone;
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
