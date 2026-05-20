// v15.2 — Phase 15.2: Separate WAIT from BLOCKED (presentation only).
//
// The action ladder collapses three very different environments into
// one BLOCKED bucket on the radar:
//
//   • setup BUILDING — state CS, opportunity score climbing, no hard
//     invalidator. The field is PREPARING for an entry.
//   • setup INVALID — late decay, fragile structure, weakening clarity.
//     Still salvageable, but not building.
//   • setup BLOCKED — failed alignment, shock, discharge, contradictory
//     structure, multiple invalidators. Genuinely dead.
//
// Showing all three as "10 BLOCKED" creates a false impression that the
// field is dead when it is in fact compressing. WAIT is the display
// label for the BUILDING case. The action ladder, Engine, payload,
// prompts, thresholds, GO logic and trade logic are unchanged — this
// only relabels BLOCKED → WAIT in the radar UI.

import type { RadarResult } from '@/lib/radarScan';
import type { ActionState } from '@/lib/actionState';
import { deriveOpportunityDistance } from '@/lib/opportunityDistance';

/** Display-only superset of ActionState. WAIT is a relabel of certain
 *  BLOCKED reads; every other rung passes through unchanged. */
export type RadarOpportunityState = ActionState | 'WAIT';

const CATASTROPHIC_CODES = new Set(['FA', 'SH', 'DS']);

export function deriveRadarOpportunityState(
  result: RadarResult,
): RadarOpportunityState {
  // Defensive: failed scans / missing reads fall back to whatever the
  // ladder produced (typically BLOCKED via awaitingClassification).
  if (!result.ok || !result.action || !result.aiState) {
    return result.action?.actionState ?? 'BLOCKED';
  }

  const action = result.action.actionState;
  // Only re-skin BLOCKED. Everything else stays as the ladder ruled it.
  if (action !== 'BLOCKED') return action;

  const ai     = result.aiState;
  const code   = ai.stateCode;
  const phase  = ai.phase;
  const invs   = ai.invalidators ?? [];

  // WAIT criteria — all four must hold:
  //   1. state is compression (CS)
  //   2. phase is still forming (not Late / Exhausted)
  //   3. invalidator profile not catastrophic (no FA/SH/DS, ≤1 invs)
  //   4. opportunity status reads "building" — score climbing, not flat
  if (code !== 'CS') return 'BLOCKED';
  if (phase === 'Late' || phase === 'Exhausted') return 'BLOCKED';
  if (CATASTROPHIC_CODES.has(code)) return 'BLOCKED';
  if (invs.length >= 2) return 'BLOCKED';

  const opp = deriveOpportunityDistance(result);
  if (!opp || opp.status !== 'building') return 'BLOCKED';

  return 'WAIT';
}

/** Soft cyan — distinct from READY's vivid cyan and WATCH's amber.
 *  Reads as "preparing", not "active". */
export const WAIT_COLOR    = '#7fb8c2';
export const WAIT_SUBTITLE = 'building compression';
