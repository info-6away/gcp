// v17.4.2 — Live Match diversity / novelty filter.
//
// The v17.4.1 scorer fixed weight balance — fingerprint dimensions
// now beat field-context dimensions, so XAUUSD doesn't masquerade as
// EURUSD just because the macro field happens to agree. But there
// was a second failure mode the scorer can't address by itself: when
// a radar scan persists ten observations in one moment, each of
// those ten observations is a future candidate for matching the
// NEXT scan — and they tend to cluster so tightly that the top
// three matches end up as three near-duplicates from the same hour.
// That's not memory. That's looking into a mirror.
//
// This module collapses temporal near-duplicates and prefers older
// analogues over recent siblings:
//
//   1. Hard reject — observations within 4h of the anchor are dropped
//      (defaults are applied in liveMatch.ts; this lib only defines
//      the helpers).
//   2. Soft penalty — same calendar day = -15; within 24h = -8.
//      Recent reads pay a price; older analogues bubble up.
//   3. Cluster collapse — group candidates by (calendar day, field
//      signature, state, opportunity, phase). Keep only the strongest
//      member per cluster.
//   4. Tiebreaker — when two candidates land on the same final score,
//      the OLDER one ranks higher.
//
// Pure derivation. No Engine, payload, or scoring changes.

import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';

export type MatchDepth = 'today' | 'this-week' | 'older';

const DAY_MS  = 24 * 3600 * 1000;
const WEEK_MS =  7 * DAY_MS;

function sameCalendarDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function depthOf(recordTs: number, anchorTs: number): MatchDepth {
  if (sameCalendarDay(recordTs, anchorTs)) return 'today';
  const age = Math.abs(anchorTs - recordTs);
  if (age <= WEEK_MS) return 'this-week';
  return 'older';
}

export const DEPTH_LABEL: Record<MatchDepth, string> = {
  today:       'today',
  'this-week': 'this week',
  older:       'older analogue',
};

export interface NoveltyAdjust {
  /** Signed delta to add to the similarity score (≤ 0 here). */
  delta:   number;
  /** Human-readable reasons — surfaced in the breakdown and dev log. */
  reasons: string[];
  /** Depth bucket — drives UI tags and the older-first preference. */
  depth:   MatchDepth;
}

export function noveltyAdjustment(
  recordTs: number,
  anchorTs: number,
): NoveltyAdjust {
  const reasons: string[] = [];
  let delta = 0;
  const ageMs = Math.abs(anchorTs - recordTs);

  if (sameCalendarDay(anchorTs, recordTs)) {
    delta -= 15; reasons.push('same-day -15');
  } else if (ageMs <= DAY_MS) {
    delta -= 8;  reasons.push('within-24h -8');
  }

  return { delta, reasons, depth: depthOf(recordTs, anchorTs) };
}

/** Cluster key — records sharing the same calendar day, field
 *  signature, state code, opportunity status and phase belong to one
 *  cluster regardless of how many of them were persisted. The caller
 *  keeps the strongest member and discards the rest. */
export function clusterKey(rec: Pick<AiStateHistoryRecord,
  'timestamp' | 'stateCode' | 'phase'
  | 'opportunityStatus' | 'fieldSignature'>): string {
  const day = new Date(rec.timestamp).toDateString();
  const sig = rec.fieldSignature;
  // Signature key: mood + dominant action + top family + dispersion.
  // Two scans on the same day with the same micro-state but different
  // moods are NOT the same cluster — that distinction matters.
  const sigKey = sig
    ? `${sig.mood}|${sig.dominantAction}|${sig.topFamily}|${sig.dispersionLevel}`
    : 'no-sig';
  return [
    day,
    sigKey,
    rec.stateCode,
    rec.opportunityStatus ?? 'no-opp',
    rec.phase,
  ].join('::');
}

/** Hard-reject window default — 4 hours. Anything within this band
 *  of the anchor is dropped before scoring even happens. */
export const HARD_REJECT_MS = 4 * 3600 * 1000;
