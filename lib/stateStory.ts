// v13.8.3: human-summary rewrite. The previous "arc" framing read as
// an event log — "Failed alignment resolved into Compression …".
// The new copy frames consequences instead — "After failed alignment,
// conviction reset." — and follows it with short pressure / clarity
// trend lines pulled directly from the current-segment record fields.
//
// Pure derivation. No LLM, no Engine call. Used by:
//   • StateStoryBanner — narrative under the hero
//   • StateEvolution — a one-line interpretation tag under the rail
//                      ("Recovery sequence", "Shock fading", …)

import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';

// Full prose names for state codes, used in narrative sentences.
const PROSE_NAME: Record<string, string> = {
  CS: 'Compression',
  IS: 'Ignition',
  AT: 'Alignment',
  SS: 'Synchronization',
  FA: 'Failed alignment',
  CL: 'Climax',
  SH: 'Shock',
  DS: 'Discharge',
  DD: 'Dead drift',
  PS: 'Plateau',
  DC: 'Directional decay',
};

// Event-class codes — these are the "things that happened" that the
// arc-of-consequence framing reads off of.
const EVENT_CODES = new Set(['FA', 'SH', 'CL', 'DC']);

interface Segment {
  code:  string;
  count: number;
}

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

export interface StateStory {
  text:        string;
  samples:     number;
  codes:       string[];
  temperament?: 'stable' | 'unresolved' | 'drifting' | 'stabilizing';
}

const DEFAULT_WINDOW = 8;

// ────────────────────────────────────────────────────────────────────
// Consequence-framing arc sentence.
// Where the v13.8.1 builder read "FA resolved into CS", this reads
// "After failed alignment, conviction reset." — past-tense, human,
// no event-log fingerprint.
// ────────────────────────────────────────────────────────────────────

function describeArc(segs: Segment[]): string | null {
  if (segs.length < 2) return null;
  const current = segs[segs.length - 1];
  const prev    = segs[segs.length - 2];

  // Event → passive: the EVENT just happened, the environment is
  // settling. Read as "After X, …".
  if (EVENT_CODES.has(prev.code) && !EVENT_CODES.has(current.code)) {
    switch (prev.code) {
      case 'SH': return 'After shock, environment cooled.';
      case 'FA': return 'After failed alignment, conviction reset.';
      case 'CL': return 'After climax, momentum eased.';
      case 'DC': return 'Directional decay subsided.';
    }
  }

  // Constructive continuations — read as a single verb.
  const continuation: Record<string, string> = {
    'CS|IS': 'Compression released into ignition.',
    'IS|AT': 'Ignition matured into trend.',
    'AT|SS': 'Trend tightened into synchronization.',
    'SS|PS': 'Synchronization saturated into plateau.',
    'PS|DC': 'Plateau gave way to decay.',
    'AT|FA': 'Trend attempt failed.',
    'IS|FA': 'Ignition failed.',
    'AT|CS': 'Trend lost coherence, back to compression.',
    'SS|CS': 'Synchronization unwound back to compression.',
    'AT|DC': 'Trend coherence broke down.',
    'SS|DC': 'Synchronization coherence broke down.',
  };
  const key = `${prev.code}|${current.code}`;
  if (continuation[key]) return continuation[key];

  // Generic fallback — still consequence-flavored, not event-log.
  const pr = PROSE_NAME[prev.code] ?? prev.code;
  const cu = PROSE_NAME[current.code]?.toLowerCase() ?? current.code;
  return `${pr} gave way to ${cu}.`;
}

// ────────────────────────────────────────────────────────────────────
// Pressure trend across the current segment.
// Reads "Pressure built." / "Pressure weakened." / "Pressure tilted long."
// based on the change in directional skew between segment-start and
// segment-end. Skips if change is small or fields are missing.
// ────────────────────────────────────────────────────────────────────

function describePressureChange(
  oldest: AiStateHistoryRecord | undefined,
  newest: AiStateHistoryRecord | undefined,
): string | null {
  if (!oldest || !newest) return null;
  const oL = oldest.longPressure;
  const oS = oldest.shortPressure;
  const nL = newest.longPressure;
  const nS = newest.shortPressure;
  if (oL == null || oS == null || nL == null || nS == null) return null;

  const oSkew = oL - oS;
  const nSkew = nL - nS;
  const oMag  = Math.abs(oSkew);
  const nMag  = Math.abs(nSkew);

  // Direction flip — pressure rotated.
  if (Math.sign(oSkew) !== Math.sign(nSkew) && oMag > 6 && nMag > 6) {
    return nSkew > 0 ? 'Pressure rotated long.' : 'Pressure rotated short.';
  }
  // Magnitude change.
  const delta = nMag - oMag;
  if (Math.abs(delta) < 8) return null;
  if (delta > 0) {
    return nSkew > 0 ? 'Long pressure built.'
        : nSkew < 0 ? 'Short pressure built.'
        :              'Pressure built.';
  }
  return 'Pressure weakened.';
}

// ────────────────────────────────────────────────────────────────────
// Clarity trend across the current segment.
// Reads "Clarity firmed: 18% → 31%." or "Clarity slipped: 27% → 18%.".
// ────────────────────────────────────────────────────────────────────

function describeClarityChange(
  oldest: AiStateHistoryRecord | undefined,
  newest: AiStateHistoryRecord | undefined,
): string | null {
  if (!oldest || !newest) return null;
  const o = Math.round((oldest.confidence ?? 0) * 100);
  const n = Math.round((newest.confidence ?? 0) * 100);
  if (Math.abs(n - o) < 5) return null;
  const verb = n > o ? 'firmed' : 'slipped';
  return `Clarity ${verb}: ${o}% → ${n}%.`;
}

// ────────────────────────────────────────────────────────────────────
// Temperament — same 4-way classification, but the copy is shorter.
// ────────────────────────────────────────────────────────────────────

function classifyTemperament(
  segs: Segment[],
  current: Segment,
): 'stable' | 'unresolved' | 'drifting' | 'stabilizing' {
  if (segs.length === 0) return 'unresolved';
  const hasEvent = segs.some(s => EVENT_CODES.has(s.code));
  if (segs.length === 1) return 'stable';
  // Long current passive segment after an event → stabilizing.
  if (hasEvent && current.count >= 3
      && !EVENT_CODES.has(current.code)) {
    return 'stabilizing';
  }
  if (segs.length >= 4 && current.count <= 2) return 'drifting';
  if (hasEvent && (current.code === 'CS' || current.code === 'DD' || current.code === 'PS')) {
    return 'unresolved';
  }
  if (current.count >= 4) return 'stable';
  return 'drifting';
}

const TEMPERAMENT_PROSE: Record<NonNullable<StateStory['temperament']>, string> = {
  stable:       'Environment stable.',
  unresolved:   'Environment unresolved.',
  drifting:     'Environment drifting.',
  stabilizing:  'Environment stabilizing.',
};

// ────────────────────────────────────────────────────────────────────
// Public: deriveStateStory.
// Returns a 1-4 sentence human summary of recent state activity.
// ────────────────────────────────────────────────────────────────────

export function deriveStateStory(
  records: AiStateHistoryRecord[],
  options: { window?: number } = {},
): StateStory | null {
  const window = options.window ?? DEFAULT_WINDOW;
  const slice = records.slice(0, window);
  if (slice.length === 0) return null;
  const segs = buildSegments(slice);
  if (segs.length === 0) return null;

  const current = segs[segs.length - 1];

  // Current segment occupies the first `current.count` records (newest
  // first). Segment endpoints used for trend sentences.
  const segmentRecords = slice.slice(0, current.count);
  const segOldest = segmentRecords[segmentRecords.length - 1];
  const segNewest = segmentRecords[0];

  const sentences: string[] = [];

  // 1. Arc — only if a prior segment exists (multi-segment chain).
  const arc = describeArc(segs);
  if (arc) sentences.push(arc);

  // 2. Pressure verb across the current segment.
  const pressure = describePressureChange(segOldest, segNewest);
  if (pressure) sentences.push(pressure);

  // 3. Clarity verb across the current segment.
  const clarity = describeClarityChange(segOldest, segNewest);
  if (clarity) sentences.push(clarity);

  // Single-segment window with no movement — fall back to a soft
  // observation so the banner isn't empty.
  if (sentences.length === 0) {
    const prose = PROSE_NAME[current.code] ?? current.code;
    if (current.count >= 2) {
      sentences.push(`${prose} holding across ${current.count} reads.`);
    } else {
      sentences.push(`${prose} just read.`);
    }
  }

  // 4. Temperament tail.
  const temperament = classifyTemperament(segs, current);
  sentences.push(TEMPERAMENT_PROSE[temperament]);

  return {
    text:    sentences.join(' '),
    samples: slice.length,
    codes:   Array.from(new Set(segs.map(s => s.code))),
    temperament,
  };
}

// ────────────────────────────────────────────────────────────────────
// Public: deriveEvolutionTag.
// Short interpretation tag (≤3 words) shown under the State Evolution
// rail — e.g. "Recovery sequence", "Shock fading", "Compression
// stabilizing", "Failed progression", "Momentum deteriorating".
//
// Pure derivation from the segment chain — no AI call.
// ────────────────────────────────────────────────────────────────────

export function deriveEvolutionTag(
  records: AiStateHistoryRecord[],
  options: { window?: number } = {},
): string | null {
  const window = options.window ?? DEFAULT_WINDOW;
  const slice = records.slice(0, window);
  if (slice.length === 0) return null;
  const segs = buildSegments(slice);
  if (segs.length === 0) return null;

  const current = segs[segs.length - 1];
  const prev    = segs.length >= 2 ? segs[segs.length - 2] : null;

  // Failed progression — IS or AT collapsed into FA.
  if (prev && (prev.code === 'IS' || prev.code === 'AT') && current.code === 'FA') {
    return 'Failed progression';
  }

  // Recovery sequence — event state immediately followed by a passive.
  if (prev && EVENT_CODES.has(prev.code) && !EVENT_CODES.has(current.code)) {
    return 'Recovery sequence';
  }

  // Shock fading — shock appeared in the recent chain but current
  // segment is past it for at least 2 reads.
  const sawShock = segs.some(s => s.code === 'SH');
  if (sawShock && current.code !== 'SH' && current.count >= 2) {
    return 'Shock fading';
  }

  // Momentum deteriorating — trend/sync rolled into compression/dead
  // drift/decay.
  if (prev
      && (prev.code === 'AT' || prev.code === 'SS')
      && (current.code === 'CS' || current.code === 'DD' || current.code === 'DC')) {
    return 'Momentum deteriorating';
  }

  // Ignition building — CS just released into IS, or a long CS with
  // strengthening clarity (caller can also surface this).
  if (prev && prev.code === 'CS' && current.code === 'IS') {
    return 'Ignition building';
  }

  // Compression stabilizing — long-held CS run.
  if (current.code === 'CS' && current.count >= 4) {
    return 'Compression stabilizing';
  }

  // Saturation hold — PS persisted.
  if (current.code === 'PS' && current.count >= 2) {
    return 'Saturation hold';
  }

  // Trend in progress — AT or SS holding.
  if ((current.code === 'AT' || current.code === 'SS') && current.count >= 2) {
    return current.code === 'SS' ? 'Synchronizing' : 'Trend in progress';
  }

  return null;
}
