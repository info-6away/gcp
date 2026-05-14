// v13.8.2: Read Evolution layer.
//
// Diagnostic for the Guru history list. When Guru sits in the same
// state code for many consecutive reads (a long CS stretch, say),
// the list looks dead — "CS / CS / CS / CS" — even though the
// underlying signals are moving every read: confidence drifts,
// pressure shifts, transition probability climbs, dominance score
// changes. This helper surfaces WHAT actually moved between two
// consecutive reads as a single primary status + a short data tail.
//
// CRITICAL: pure derivation. No new Engine calls. No prompt changes.
// Reads only fields already on AiStateHistoryRecord (writes added
// progressively across v11.36 → v13.8). Older entries missing some
// fields are handled gracefully — the helper falls back to whatever
// it has and tags the status conservatively (STABLE).
//
// What we DO have on a history record:
//   - confidence            (always)
//   - longPressure          (v11.36+)
//   - shortPressure         (v11.36+)
//   - structureScore        (v13.1+)
//   - nextLikelyState       (v13.3+)
//   - transitionConfidence  (v13.3+)
//   - phase / direction     (always)
//   - patternCode / pss     (when a pattern landed at analysis time)
//   - invalidatorsSnap      (v13.8+)
//
// What we DON'T have stored (acknowledged in the spec's "many
// internal things changed" list — slope / curvature / PSS-metric
// live on payload.metrics but are never persisted to history):
//   - metrics.slope
//   - metrics.curvature
//   - metrics.ced
//   - metrics.pss (the coherence-pressure-score metric, distinct
//     from a pattern's PSS)
//
// Slope deltas would require persisting them on the snapshot —
// that's a separate change.

import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';

export type ReadEvolutionStatus =
  | 'CURRENT'
  | 'NEW STATE'
  | 'STRENGTHENING'
  | 'WEAKENING'
  | 'PRESSURE BUILDING'
  | 'EDGE LOST'
  | 'TRANSITION RISK'
  | 'IGNITION BUILDING'
  | 'LATE DECAY'
  | 'AGING'
  | 'STABLE'
  | 'STALE';

export interface ReadEvolution {
  status: ReadEvolutionStatus;
  /** Hex color for the badge accent. */
  color:  string;
  /** Optional one-line tail with the data backing the status, e.g.
   *  "↑ clarity +14%" or "held 7 reads". Empty string when no
   *  meaningful tail is computable. */
  tail:   string;
}

const COLOR: Record<ReadEvolutionStatus, string> = {
  CURRENT:            '#4dd9e8',
  'NEW STATE':        '#4dd9e8',
  STRENGTHENING:      '#22c55e',
  WEAKENING:          '#d4a028',
  'PRESSURE BUILDING':'#4dd9e8',
  'EDGE LOST':        '#7F98A3',
  'TRANSITION RISK':  '#d4a028',
  'IGNITION BUILDING':'#22c55e',
  'LATE DECAY':       '#b87838',
  AGING:              '#7F98A3',
  STABLE:             'var(--fg-3)' as string,
  STALE:              '#d4a028',
};

// Walk the history (newest-first) and count how many CONSECUTIVE
// records — starting from index — share the given stateCode.
function countStateAge(
  records: AiStateHistoryRecord[],
  startIndex: number,
  stateCode: string,
): number {
  let age = 0;
  for (let i = startIndex; i < records.length; i++) {
    if (records[i].stateCode !== stateCode) break;
    age++;
  }
  return age;
}

// Pull a comparable previous record. Walks BACKWARDS through history
// (older direction) looking for the first row that has at least a
// confidence value so deltas can be computed. Returns null if none.
function findPriorComparable(
  records: AiStateHistoryRecord[],
  fromIndex: number,
): AiStateHistoryRecord | null {
  for (let i = fromIndex + 1; i < records.length; i++) {
    const r = records[i];
    if (typeof r.confidence === 'number') return r;
  }
  return null;
}

export interface ReadEvolutionArgs {
  /** History list, newest-first (the order the UI receives). */
  records:    AiStateHistoryRecord[];
  /** Index of the current row in records. */
  index:      number;
  /** True when this is the most-recent row (index === 0). The badge
   *  becomes "CURRENT" by default; if a transition just happened it
   *  becomes "NEW STATE". Set by the caller because the caller
   *  already tracks isCurrent for highlight styling. */
  isCurrent:  boolean;
  /** True when this record's stateCode differs from the one before
   *  it (already tracked by the GuruHistory annotation pass). */
  isTransition: boolean;
  /** Optional — current live aiState. Lets us detect the "STALE"
   *  badge for the newest row when the response was served from
   *  the proxy cache. */
  liveStale?: boolean;
}

export function deriveReadEvolution(args: ReadEvolutionArgs): ReadEvolution {
  const { records, index, isCurrent, isTransition, liveStale } = args;
  const r = records[index];
  if (!r) return { status: 'STABLE', color: COLOR.STABLE, tail: '' };

  // ── Top-priority badges that take over regardless of deltas. ──

  if (isCurrent && liveStale) {
    return { status: 'STALE', color: COLOR.STALE, tail: 'served from cache' };
  }
  if (isCurrent) {
    // Don't return early — fall through so we can still compute a
    // meaningful tail (e.g. "held 7 reads") for the current row.
    // We'll re-tag the status to CURRENT at the end if nothing more
    // specific applies. Mark it for the final selection.
  }
  if (isTransition) {
    return { status: 'NEW STATE', color: COLOR['NEW STATE'], tail: 'state shifted' };
  }

  // ── Comparison against the prior comparable read. ──
  const prev = findPriorComparable(records, index);
  if (!prev) {
    // First record we've seen for this row's lineage. Nothing to
    // compare against — fall back to a state-age computation.
    const age = countStateAge(records, index, r.stateCode);
    if (age >= 4) {
      return { status: 'AGING', color: COLOR.AGING, tail: `held ${age} reads` };
    }
    if (isCurrent) {
      return { status: 'CURRENT', color: COLOR.CURRENT, tail: '' };
    }
    return { status: 'STABLE', color: COLOR.STABLE, tail: '' };
  }

  // Deltas computed in PRESENTATION units (× 100 for confidences,
  // signed for pressure skew + dominance score).
  const confDelta  = Math.round(((r.confidence ?? 0) - (prev.confidence ?? 0)) * 100);
  const longA      = r.longPressure  ?? 50;
  const shortA     = r.shortPressure ?? 50;
  const longB      = prev.longPressure  ?? 50;
  const shortB     = prev.shortPressure ?? 50;
  const skewCur    = longA - shortA;
  const skewPrev   = longB - shortB;
  const skewDelta  = skewCur - skewPrev;
  const absSkewCur = Math.abs(skewCur);
  const absSkewPrev= Math.abs(skewPrev);
  const transA     = r.transitionConfidence ?? 0;
  const transB     = prev.transitionConfidence ?? 0;
  const transDelta = Math.round((transA - transB) * 100);
  const domA       = r.structureScore ?? 0;
  const domB       = prev.structureScore ?? 0;
  const domDelta   = domA - domB;

  // ── Status decision tree. Order = priority. ──
  // Phase-aware late decay sits high so AT-Late / SS-Late reads as
  // such even when nothing measurable moved.
  const code  = r.stateCode;
  const phase = r.phase;

  // 1. Strong confidence movement (either direction).
  if (confDelta >= 8) {
    return { status: 'STRENGTHENING', color: COLOR.STRENGTHENING,
             tail: `↑ clarity +${confDelta}%` };
  }
  if (confDelta <= -8) {
    return { status: 'WEAKENING', color: COLOR.WEAKENING,
             tail: `↓ clarity ${confDelta}%` };
  }

  // 2. Ignition building — CS state with next-likely IS rising.
  if (code === 'CS'
      && r.nextLikelyState === 'IS'
      && (transDelta >= 5 || (transA >= 0.55 && transB < transA))) {
    return { status: 'IGNITION BUILDING', color: COLOR['IGNITION BUILDING'],
             tail: `IS prob ${Math.round(transA * 100)}%${transDelta > 0 ? ` (+${transDelta}%)` : ''}` };
  }

  // 3. Transition risk — non-trivial next-state probability rising
  //    against the current state.
  if (transA >= 0.55 && r.nextLikelyState && r.nextLikelyState !== code) {
    return { status: 'TRANSITION RISK', color: COLOR['TRANSITION RISK'],
             tail: `${r.nextLikelyState} ${Math.round(transA * 100)}%` };
  }

  // 4. Late-phase decay on directional states.
  if ((code === 'AT' || code === 'SS')
      && (phase === 'Late' || phase === 'Exhausted')) {
    return { status: 'LATE DECAY', color: COLOR['LATE DECAY'],
             tail: `${phase.toLowerCase()} ${code}` };
  }

  // 5. Pressure building — directional skew widening.
  if (absSkewCur - absSkewPrev >= 5) {
    return { status: 'PRESSURE BUILDING', color: COLOR['PRESSURE BUILDING'],
             tail: `skew ${skewCur > 0 ? '+' : ''}${skewCur}` };
  }

  // 6. Edge lost — directional skew collapsing toward neutral.
  if (absSkewPrev - absSkewCur >= 5 && absSkewCur < 15) {
    return { status: 'EDGE LOST', color: COLOR['EDGE LOST'],
             tail: `skew now ${skewCur > 0 ? '+' : ''}${skewCur}` };
  }

  // 7. Dominance score swing (structural read changed materially).
  if (Math.abs(domDelta) >= 15) {
    return { status: domDelta > 0 ? 'STRENGTHENING' : 'WEAKENING',
             color:  domDelta > 0 ? COLOR.STRENGTHENING : COLOR.WEAKENING,
             tail:   `dominance ${domDelta > 0 ? '+' : ''}${domDelta}` };
  }

  // 8. Aging — same state for many consecutive reads.
  const age = countStateAge(records, index, code);
  if (age >= 4) {
    return { status: 'AGING', color: COLOR.AGING,
             tail: `held ${age} reads` };
  }

  // 9. Fallback. CURRENT for the newest row; STABLE for everything
  //    else when nothing material moved.
  if (isCurrent) {
    return { status: 'CURRENT', color: COLOR.CURRENT, tail: '' };
  }
  return { status: 'STABLE', color: COLOR.STABLE, tail: '' };

  void skewDelta;     // reserved for future "direction reversed" detection
}

// ──────────────────────────────────────────────────────────────────
// Persistence summary — used by the StateStoryBanner + the Current
// Read hero when the current state has held for several reads.
// Walks the segment (consecutive same-state runs from index 0) and
// returns first → last deltas for clarity, pressure, transition.
// ──────────────────────────────────────────────────────────────────

export interface PersistenceSummary {
  /** Number of consecutive same-state records at the head of history. */
  segmentLength: number;
  stateCode:     string;
  state:         string;
  phase:         string | null;
  /** First clarity (oldest record in segment) and current clarity. */
  clarityFirst:  number | null;
  clarityNow:    number | null;
  /** Pressure long/short at segment start and now. */
  pressureFirst: { long: number; short: number } | null;
  pressureNow:   { long: number; short: number } | null;
  /** Transition probability at segment start and now (0..100). */
  transFirst:    number | null;
  transNow:      number | null;
  transTarget:   string | null;   // e.g. 'IS' — the most-recent next-likely state
  /** Coarse environment temperament. */
  temperament:   'stabilizing' | 'stable' | 'unresolved' | 'drifting';
}

export function derivePersistenceSummary(
  records: AiStateHistoryRecord[],
): PersistenceSummary | null {
  if (records.length === 0) return null;
  const head = records[0];
  // Count current segment (newest stretch of same stateCode).
  let len = 1;
  for (let i = 1; i < records.length; i++) {
    if (records[i].stateCode !== head.stateCode) break;
    len++;
  }
  if (len < 2) return null;          // not yet a persistence story

  const segment = records.slice(0, len);
  // Segment is newest-first; "first" of the run is the OLDEST record
  // in the segment (last index), "now" is the newest (index 0).
  const first = segment[segment.length - 1];
  const now   = segment[0];

  const clarityFirst = typeof first.confidence === 'number'
    ? Math.round(first.confidence * 100)
    : null;
  const clarityNow = typeof now.confidence === 'number'
    ? Math.round(now.confidence * 100)
    : null;

  const pressureFirst = (typeof first.longPressure === 'number'
                     && typeof first.shortPressure === 'number')
    ? { long: first.longPressure, short: first.shortPressure }
    : null;
  const pressureNow = (typeof now.longPressure === 'number'
                    && typeof now.shortPressure === 'number')
    ? { long: now.longPressure, short: now.shortPressure }
    : null;

  const transFirst = typeof first.transitionConfidence === 'number'
    ? Math.round(first.transitionConfidence * 100)
    : null;
  const transNow = typeof now.transitionConfidence === 'number'
    ? Math.round(now.transitionConfidence * 100)
    : null;

  // Temperament heuristic.
  const clarityDelta = (clarityNow ?? 0) - (clarityFirst ?? 0);
  const transDelta   = (transNow   ?? 0) - (transFirst   ?? 0);
  let temperament: PersistenceSummary['temperament'] = 'stable';
  if (clarityDelta >= 12 && transDelta >= 8) temperament = 'stabilizing';
  else if (transDelta >= 12)                  temperament = 'unresolved';
  else if (Math.abs(clarityDelta) >= 10 && transDelta < 0) temperament = 'drifting';
  else if (clarityDelta >= 8)                 temperament = 'stabilizing';

  return {
    segmentLength: len,
    stateCode:     now.stateCode,
    state:         now.state,
    phase:         now.phase ?? null,
    clarityFirst,
    clarityNow,
    pressureFirst,
    pressureNow,
    transFirst,
    transNow,
    transTarget:   now.nextLikelyState ?? null,
    temperament,
  };
}
