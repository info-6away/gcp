// v11.30: Guru stance — execution-layer overlay.
//
// Pure mapping from AI state → action stance. Tells the user in <2s:
//   STANCE     — what to do  ("Wait", "Prepare entry", "No entry")
//   MODE       — what kind of phase we're in
//   EXECUTION  — how to act if you act
//
// No engine change, no payload change. Stance is a derived view —
// runs alongside aiState in the UI.

import type { GcpStateResponse } from '@/lib/engine-gcp';

export interface GuruStance {
  stance:    string;
  mode:      string;
  execution: string;
}

export function deriveStance(aiState: GcpStateResponse | null): GuruStance | null {
  if (!aiState) return null;
  const code  = aiState.stateCode;
  const phase = aiState.phase;

  switch (code) {
    case 'SH':
      return {
        stance:    'No entry',
        mode:      'Defensive / Observation',
        execution: 'Only scalp or fade with confirmation',
      };

    case 'CS':
      return {
        stance:    'Wait',
        mode:      'Build-up phase',
        execution: 'No entry until ignition trigger',
      };

    case 'IS':
      return {
        stance:    'Prepare entry',
        mode:      'Breakout forming',
        execution: 'Enter on confirmation breakout',
      };

    case 'AT':
      // Late / Exhausted alignment shouldn't read as "add" — soften to
      // "hold" so the user doesn't size into a fading trend.
      if (phase === 'Late' || phase === 'Exhausted') {
        return {
          stance:    'Hold',
          mode:      'Trend mature',
          execution: 'Manage exposure; avoid late additions',
        };
      }
      return {
        stance:    'Hold / add',
        mode:      'Trend continuation',
        execution: 'Follow trend, avoid fading',
      };

    case 'FA':
      return {
        stance:    'Short bias / fade',
        mode:      'Breakdown',
        execution: 'Look for continuation or retrace entries',
      };

    case 'DS':
      return {
        stance:    'Exit / avoid',
        mode:      'Unwinding',
        execution: 'No new entries, manage exits',
      };

    // Spec didn't cover the other engine codes; pick sensible defaults
    // so the block never reads blank.
    case 'DD':
      return {
        stance:    'Wait',
        mode:      'Low signal',
        execution: 'No GCP edge — defer to price-only setups',
      };
    case 'SS':
      if (phase === 'Late' || phase === 'Exhausted') {
        return {
          stance:    'Hold',
          mode:      'Sync mature',
          execution: 'Manage exposure; sync may be peaking',
        };
      }
      return {
        stance:    'Hold / add',
        mode:      'Synchronization',
        execution: 'Trend continuation; manage size',
      };
    case 'CL':
      return {
        stance:    'Manage exits',
        mode:      'Climax / exhaustion risk',
        execution: 'No new entries; trim into strength',
      };
  }

  return null;
}
