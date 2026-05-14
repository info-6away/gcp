// v13.8: deterministic state-evolution narrative.
// v13.8.1: richer phrasing — adds clarity-trend tracking + a
// stable / unresolved / drifting environment classification, and
// uses full state names ("Compression") instead of short codes
// ("CS") when reading as prose.
//
// Reads the recent aiStateHistory and produces a 1-3 sentence
// plain-English summary like:
//
//   "Failed alignment resolved into a long Compression plateau.
//    Guru has held CS for 6 reads, with read clarity strengthening
//    from 31% to 54%. The environment is stable but unresolved."
//
// Pure derivation. No LLM, no Engine call. Used by the Guru
// timeline page as the "STATE STORY" banner above the history list.

import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';

// Friendly short labels for state codes that appear in the narrative.
const SHORT_LABEL: Record<string, string> = {
  CS: 'CS',
  IS: 'IS',
  AT: 'AT',
  SS: 'SS',
  FA: 'FA',
  CL: 'climax',
  SH: 'shock',
  DS: 'discharge',
  DD: 'flat',
  PS: 'plateau',
  DC: 'decay',
};

// Optional flavor phrases keyed off the state — used when the state
// appears as a SEGMENT in the narrative. e.g. an FA segment reads as
// "FA failure", a CL segment as "climax", etc.
const FLAVOR: Record<string, string> = {
  FA: 'failed alignment',
  SH: 'shock event',
  CL: 'climax exhaustion',
  DS: 'discharge',
  PS: 'plateau saturation',
  DC: 'directional decay',
};

interface Segment {
  code:  string;
  count: number;     // how many consecutive records collapsed into this segment
}

/**
 * Collapse consecutive same-state records into segments, walking
 * OLDEST-first. Caller passes records newest-first as stored on
 * localStorage; we reverse internally so the narrative reads in time
 * order ("X → Y → Z" matches user mental model).
 */
function buildSegments(recordsNewestFirst: AiStateHistoryRecord[]): Segment[] {
  if (recordsNewestFirst.length === 0) return [];
  const ordered = recordsNewestFirst.slice().reverse();
  const out: Segment[] = [];
  for (const r of ordered) {
    const code = r.stateCode;
    const last = out[out.length - 1];
    if (last && last.code === code) {
      last.count += 1;
    } else {
      out.push({ code, count: 1 });
    }
  }
  return out;
}

// describeSegment was used by the v13.8 single-line arrow rendering;
// v13.8.1's narrative builder no longer needs it. Helper preserved
// for potential future callers — referenced via `void` to silence
// noUnusedLocals.
function describeSegment(seg: Segment): string {
  const label = SHORT_LABEL[seg.code] ?? seg.code;
  const flavor = FLAVOR[seg.code];
  if (seg.count >= 3) return `${label} persisted for ${seg.count} reads`;
  if (seg.count === 2) return `${label}${flavor ? ` (${flavor})` : ''} held twice`;
  if (flavor) return `${label} (${flavor})`;
  return label;
}
void describeSegment;

// Full prose names for state codes, used in narrative sentences
// where SHORT_LABEL would read as jargon.
const PROSE_NAME: Record<string, string> = {
  CS: 'Compression',
  IS: 'Ignition',
  AT: 'Alignment Trend',
  SS: 'Synchronization',
  FA: 'Failed Alignment',
  CL: 'Climax',
  SH: 'Shock',
  DS: 'Discharge',
  DD: 'Dead Drift',
  PS: 'Plateau',
  DC: 'Directional Decay',
};

// State codes whose appearance reads as an event worth narrating.
const EVENT_CODES = new Set(['FA', 'SH', 'CL', 'DC']);

export interface StateStory {
  /** Full 1-3 sentence narrative string. */
  text:     string;
  /** Number of source records the narrative summarised. */
  samples:  number;
  /** Distinct state codes covered by the narrative — useful for the
   *  UI's "states seen" badge if it ever wants one. */
  codes:    string[];
  /** Environment temperament — "stable" / "unresolved" / "drifting". */
  temperament?: 'stable' | 'unresolved' | 'drifting';
}

const DEFAULT_WINDOW = 8;

/**
 * Pick the most recent segment as the "current" segment and produce
 * a sentence about how Guru has held that state, including a clarity
 * trend over the segment's records if available.
 */
function describePersistenceTrend(
  current: Segment,
  recentRecords: AiStateHistoryRecord[],
): string {
  const prose = PROSE_NAME[current.code] ?? current.code;
  const short = SHORT_LABEL[current.code] ?? current.code;
  if (current.count <= 1) {
    return `Guru is currently in ${prose}.`;
  }
  // Pull clarity for the current segment's records (most-recent first).
  // We treat the first `current.count` records as belonging to the
  // segment since they're consecutive same-state.
  const inSegment = recentRecords.slice(0, current.count);
  // Records are stored newest-first; reverse so we read oldest → newest.
  const conf = inSegment.slice().reverse().map(r => r.confidence ?? 0);
  if (conf.length < 2) {
    return `Guru has held ${short} for ${current.count} reads.`;
  }
  const first = Math.round(conf[0] * 100);
  const last  = Math.round(conf[conf.length - 1] * 100);
  const delta = last - first;
  let trend: string;
  if (Math.abs(delta) < 5) {
    trend = `read clarity flat near ${last}%`;
  } else if (delta > 0) {
    trend = `read clarity strengthening from ${first}% to ${last}%`;
  } else {
    trend = `read clarity slipping from ${first}% to ${last}%`;
  }
  return `Guru has held ${short} for ${current.count} reads, with ${trend}.`;
}

/**
 * Classify the overall environment temperament from the segment chain.
 *   stable      — single long segment, no event states
 *   unresolved  — mixed segments with at least one event state but
 *                 current segment is a passive one (CS / DD / PS)
 *   drifting    — current segment is short (≤2) and surrounded by
 *                 churn (3+ segments in window)
 */
function classifyTemperament(
  segs: Segment[],
): 'stable' | 'unresolved' | 'drifting' {
  if (segs.length === 0) return 'unresolved';
  const current = segs[segs.length - 1];
  const hasEvent = segs.some(s => EVENT_CODES.has(s.code));
  // Single-segment window — fully stable.
  if (segs.length === 1) return 'stable';
  // Many segments + short current → drifting.
  if (segs.length >= 4 && current.count <= 2) return 'drifting';
  // Event in the chain but current passive → unresolved.
  if (hasEvent && (current.code === 'CS' || current.code === 'DD' || current.code === 'PS')) {
    return 'unresolved';
  }
  // Long current segment (≥4) → stable.
  if (current.count >= 4) return 'stable';
  return 'drifting';
}

const TEMPERAMENT_SUFFIX: Record<'stable' | 'unresolved' | 'drifting', string> = {
  stable:     'The environment is stable.',
  unresolved: 'The environment is stable but unresolved.',
  drifting:   'The environment is drifting.',
};

/**
 * Build the opening "what happened" sentence from the segment chain.
 * For ≤1 distinct code: skipped (the persistence sentence carries it).
 * For ≥2 codes: "<oldest event> resolved into <current>" style copy
 * with friendly transitions for common patterns.
 */
function describeArc(segs: Segment[]): string | null {
  if (segs.length < 2) return null;
  const current = segs[segs.length - 1];
  const prev    = segs[segs.length - 2];

  const cur = PROSE_NAME[current.code] ?? current.code;
  const pr  = PROSE_NAME[prev.code]    ?? prev.code;

  // FA / SH / CL events resolving into something quieter — preferred
  // narrative pattern.
  if (EVENT_CODES.has(prev.code) && !EVENT_CODES.has(current.code)) {
    const intro =
      prev.code === 'FA' ? 'Failed alignment resolved'
    : prev.code === 'SH' ? 'Shock event resolved'
    : prev.code === 'CL' ? 'Climax exhaustion resolved'
    : prev.code === 'DC' ? 'Directional decay resolved'
    :                       `${pr} resolved`;
    const tail =
      current.count >= 4 ? `into a long ${cur} plateau`
    : current.count >= 2 ? `into ${cur}`
    :                       `into a fresh ${cur} read`;
    return `${intro} ${tail}.`;
  }

  // Same-direction continuation (CS → IS, IS → AT, etc.) → "advanced".
  const continuationChains: Record<string, string> = {
    'CS|IS': 'compression broke into ignition',
    'IS|AT': 'ignition resolved into alignment',
    'AT|SS': 'alignment matured into synchronization',
    'SS|PS': 'synchronization saturated into plateau',
  };
  const key = `${prev.code}|${current.code}`;
  if (continuationChains[key]) {
    return continuationChains[key].charAt(0).toUpperCase()
      + continuationChains[key].slice(1) + '.';
  }

  // Failure entering — e.g., IS → FA.
  if (EVENT_CODES.has(current.code) && !EVENT_CODES.has(prev.code)) {
    return `${pr} attempt ended in ${cur}.`;
  }

  // Generic fallback.
  return `${pr} transitioned into ${cur}.`;
}

export function deriveStateStory(
  records: AiStateHistoryRecord[],
  options: { window?: number } = {},
): StateStory | null {
  const window = options.window ?? DEFAULT_WINDOW;
  const slice = records.slice(0, window);
  if (slice.length === 0) return null;
  const segs = buildSegments(slice);
  if (segs.length === 0) return null;

  // Single-segment edge case — entire window is the same state.
  if (segs.length === 1) {
    const only = segs[0];
    const short = SHORT_LABEL[only.code] ?? only.code;
    const persistence = describePersistenceTrend(only, slice);
    return {
      text:    persistence
             + (only.count >= 4
                ? ` ${TEMPERAMENT_SUFFIX.stable}`
                : ''),
      samples: slice.length,
      codes:   [only.code],
      temperament: 'stable',
    };
  }

  const current = segs[segs.length - 1];
  const arc = describeArc(segs);
  const persistence = describePersistenceTrend(current, slice);
  const temperament = classifyTemperament(segs);
  const tail = TEMPERAMENT_SUFFIX[temperament];

  const parts: string[] = [];
  if (arc) parts.push(arc);
  parts.push(persistence);
  // Only append a temperament tail if it adds something beyond the
  // arc + persistence sentences already conveyed.
  if (temperament !== 'stable' || segs.length > 1) {
    parts.push(tail);
  }
  const text = parts.join(' ');
  return {
    text,
    samples: slice.length,
    codes:   Array.from(new Set(segs.map(s => s.code))),
    temperament,
  };
}
