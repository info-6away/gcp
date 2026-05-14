// v13.7: Entry Status — explicit permission gate for new positions.
//
// Closes the "LONG 57% but stance WAIT" semantic gap. Directional
// pressure communicates which way the environment leans; Entry Status
// communicates whether Guru permits new entries right now. Reading
// the latter answers "can I act?" directly without inferring from
// the stance verb.
//
// Pure derivation — reads existing GcpStateResponse + GuruStance + an
// open-position boolean. No new Engine calls, no payload changes.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { GuruStance } from '@/lib/guruStance';

export type EntryStatus = 'BLOCKED' | 'WATCH' | 'READY' | 'MANAGE';

export interface EntryStatusRead {
  status: EntryStatus;
  /** Hex color matching the v13.4+ palette. */
  color:  string;
  /** One-line "why" for the badge. */
  reason: string;
  /** Optional secondary line — usually the stance verb itself, so
   *  the user can see WAIT / Lean long etc. alongside the gate. */
  stance: string | null;
}

export function deriveEntryStatus(args: {
  aiState:         GcpStateResponse | null;
  stance:          GuruStance       | null;
  hasOpenPosition: boolean;
}): EntryStatusRead {
  const { aiState, stance, hasOpenPosition } = args;

  // 1. Open position dominates — management posture supersedes new
  //    entry signaling. The position monitor handles thesis integrity
  //    + alignment; entry status reflects "you have exposure already".
  if (hasOpenPosition) {
    return {
      status: 'MANAGE',
      color:  '#d4a028',
      reason: 'Open position active — manage existing exposure',
      stance: stance?.stance ?? null,
    };
  }

  // 2. No state yet — block by default until Guru has a read.
  if (!aiState || !stance) {
    return {
      status: 'BLOCKED',
      color:  '#7F98A3',
      reason: 'Awaiting Guru classification',
      stance: stance?.stance ?? null,
    };
  }

  // Stance verb classification — string-match the verbs deriveStance
  // emits today. The set is small and stable; keep it explicit so a
  // future stance copy edit can't silently reclassify entries.
  const verb = stance.stance.toLowerCase();
  const isHoldType   = /\bhold\b|\breduce\b|\bmanage\b|\bwait\b|\bavoid\b|\bstay flat\b/.test(verb);
  const isActionType = /\blean\b|\bfavor\b|\binitiate\b|\benter\b|\btrail\b/.test(verb);

  // 3. WAIT/HOLD/REDUCE/AVOID → BLOCKED. The stance itself is the
  //    primary signal; pressure direction is irrelevant to permission.
  if (isHoldType) {
    return {
      status: 'BLOCKED',
      color:  '#c45a5a',
      reason: stance.execution || 'Stance disallows new entries',
      stance: stance.stance,
    };
  }

  // 4. Action-type stance: branch on state quality.
  //    - Clean directional states (AT / IS / SS with non-Late phase)
  //      → READY: ignition / continuation conditions in place.
  //    - Plateau / decay / FA / SH / CL or Late/Exhausted phases of
  //      directional states → WATCH: setup forming but confirmation
  //      required.
  if (isActionType) {
    const code  = aiState.stateCode;
    const phase = aiState.phase;
    const cleanContinuation =
      (code === 'AT' || code === 'IS' || code === 'SS')
      && phase !== 'Late' && phase !== 'Exhausted';
    if (cleanContinuation) {
      return {
        status: 'READY',
        color:  '#22c55e',
        reason: stance.execution || 'Continuation conditions in place',
        stance: stance.stance,
      };
    }
    return {
      status: 'WATCH',
      color:  '#d4a028',
      reason: stance.execution || 'Setup forming — confirmation required',
      stance: stance.stance,
    };
  }

  // 5. Unrecognized verb — default conservative (WATCH).
  return {
    status: 'WATCH',
    color:  '#d4a028',
    reason: stance.execution || 'Setup forming',
    stance: stance.stance,
  };
}
