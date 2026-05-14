// v13.8: deterministic state-evolution narrative.
//
// Reads the recent aiStateHistory and produces a one-line plain-English
// summary like:
//
//   "CS persisted for 4 reads → SH event → recovery into CS → SS attempt
//    failed."
//
// Pure derivation. No LLM, no Engine call. Used by the new Guru
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

function describeSegment(seg: Segment): string {
  const label = SHORT_LABEL[seg.code] ?? seg.code;
  const flavor = FLAVOR[seg.code];
  if (seg.count >= 3) {
    return `${label} persisted for ${seg.count} reads`;
  }
  if (seg.count === 2) {
    return `${label}${flavor ? ` (${flavor})` : ''} held twice`;
  }
  if (flavor) return `${label} (${flavor})`;
  return label;
}

export interface StateStory {
  /** Full narrative string, e.g. "CS persisted for 4 reads → SH event …". */
  text:     string;
  /** Number of source records the narrative summarised. */
  samples:  number;
  /** Distinct state codes covered by the narrative — useful for the
   *  UI's "states seen" badge if it ever wants one. */
  codes:    string[];
}

const DEFAULT_WINDOW = 8;

export function deriveStateStory(
  records: AiStateHistoryRecord[],
  options: { window?: number } = {},
): StateStory | null {
  const window = options.window ?? DEFAULT_WINDOW;
  const slice = records.slice(0, window);
  if (slice.length === 0) {
    return null;
  }
  const segs = buildSegments(slice);
  if (segs.length === 0) return null;

  // Edge case — entire window is the same state. Read as "CS held
  // steady for N reads." (no arrow).
  if (segs.length === 1) {
    const only = segs[0];
    const label = SHORT_LABEL[only.code] ?? only.code;
    return {
      text:    `${label} held steady for ${only.count} read${only.count === 1 ? '' : 's'}.`,
      samples: slice.length,
      codes:   [only.code],
    };
  }

  const parts = segs.map(describeSegment);
  const text = `${parts.join(' → ')}.`;
  return {
    text,
    samples: slice.length,
    codes:   Array.from(new Set(segs.map(s => s.code))),
  };
}
