// v17.4 — Phase 17.4: Live Match Engine.
//
// Bridges the live radar with the research ledger by asking the
// question "have I seen this read before?" instead of "what is
// happening?".
//
// Pure similarity derivation. No Engine calls, no payload changes, no
// scan or AI changes. Given an anchor (a current read for a symbol)
// and the history of past observations, this returns the top-N
// historically closest records, each tagged with which dimensions
// matched. Callers downstream attach outcomes (forward returns) where
// they have candle access — Research does; Radar does not yet, so the
// radar surface shows the resemblance without the outcome.
//
// Weighting (state + opportunity = highest, per spec):
//   stateCode               20   (exact)
//   opportunity status      18   (exact)
//   field mood              10   (exact)
//   phase                   10   (exact)
//   opportunity score        8   (proximity)
//   clarity (confidence)     8   (proximity)
//   pressure direction       8   (sign match on long-short skew)
//   family leadership        8   (exact, when both signatures present)
//   pressure band            6   (exact)
//   dispersion level         6   (exact, when both signatures present)
//   dominant action          6   (exact, when both signatures present)
//   ────────────────────────────────
//   total raw                108  → normalized to 0-100

import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';

/** Subset of AiStateHistoryRecord the scorer needs. Live radar reads
 *  build this synthetically from a RadarResult + scan-time
 *  fieldSignature; Research uses the most recent history record for
 *  the active symbol verbatim. */
export type LiveMatchAnchor = Pick<AiStateHistoryRecord,
  | 'symbol' | 'stateCode' | 'phase' | 'direction' | 'confidence'
  | 'longPressure' | 'shortPressure' | 'pressureBand'
  | 'opportunityScore' | 'opportunityStatus'
  | 'fieldSignature' | 'timestamp'>;

export interface LiveMatch {
  /** The historical record this match refers to. */
  record:      AiStateHistoryRecord;
  /** 0-100 similarity score (higher = more similar). */
  similarity:  number;
  /** Which dimensions actually matched — drives the diagnostic line. */
  matchedOn:   string[];
  /** Index in the source history array — lets callers cross-reference
   *  outcome arrays (e.g. ResearchView's aiStatePoints) without
   *  re-walking history. */
  historyIdx:  number;
}

const W = {
  state:           20,
  opportunity:     18,
  mood:            10,
  phase:           10,
  oppScore:         8,
  clarity:          8,
  pressureDir:      8,
  familyLead:       8,
  pressureBand:     6,
  dispersion:       6,
  dominantAction:   6,
} as const;

const TOTAL_RAW = Object.values(W).reduce((a, b) => a + b, 0);  // 108

function pressureDirection(long?: number, short?: number): 1 | -1 | 0 {
  if (long == null || short == null) return 0;
  if (long === short) return 0;
  return long > short ? 1 : -1;
}

function scorePair(
  anchor: LiveMatchAnchor,
  rec:    AiStateHistoryRecord,
): { score: number; matchedOn: string[] } {
  let raw = 0;
  const matched: string[] = [];

  // ── state + opportunity (heaviest weight) ──
  if (anchor.stateCode === rec.stateCode) {
    raw += W.state; matched.push('state');
  }
  if (anchor.opportunityStatus && rec.opportunityStatus
      && anchor.opportunityStatus === rec.opportunityStatus) {
    raw += W.opportunity; matched.push('opportunity');
  }

  // ── exact matches on phase + field context ──
  if (anchor.phase === rec.phase) { raw += W.phase; matched.push('phase'); }

  const aSig = anchor.fieldSignature;
  const rSig = rec.fieldSignature;
  if (aSig && rSig) {
    if (aSig.mood === rSig.mood) {
      raw += W.mood; matched.push(`mood:${aSig.mood}`);
    }
    if (aSig.dispersionLevel === rSig.dispersionLevel) {
      raw += W.dispersion; matched.push('dispersion');
    }
    if (aSig.dominantAction === rSig.dominantAction) {
      raw += W.dominantAction; matched.push('field-action');
    }
    if (aSig.topFamily === rSig.topFamily) {
      raw += W.familyLead; matched.push(`${aSig.topFamily}-lead`);
    }
  }

  // ── continuous fields scored by proximity ──
  // Opportunity score (0-100). Linear decay; ≥50 points apart → 0 credit.
  if (anchor.opportunityScore != null && rec.opportunityScore != null) {
    const diff = Math.abs(anchor.opportunityScore - rec.opportunityScore);
    raw += Math.max(0, W.oppScore - diff * (W.oppScore / 50));
  }

  // Clarity (0-1). ≥0.5 apart → 0 credit.
  const diffConf = Math.abs(anchor.confidence - rec.confidence);
  raw += Math.max(0, W.clarity - diffConf * (W.clarity / 0.5));

  // Pressure direction — must agree to credit.
  const aDir = pressureDirection(anchor.longPressure, anchor.shortPressure);
  const rDir = pressureDirection(rec.longPressure, rec.shortPressure);
  if (aDir !== 0 && rDir !== 0 && aDir === rDir) {
    raw += W.pressureDir; matched.push('pressure-dir');
  }

  // Pressure band (weak / moderate / strong).
  if (anchor.pressureBand && rec.pressureBand
      && anchor.pressureBand === rec.pressureBand) {
    raw += W.pressureBand; matched.push('pressure-band');
  }

  return {
    score:     Math.round((raw / TOTAL_RAW) * 100),
    matchedOn: matched,
  };
}

export interface LiveMatchOptions {
  /** Max matches returned (default 3). */
  limit?:           number;
  /** Below this similarity (0-100) drop the match (default 50). */
  minScore?:        number;
  /** Anchor's own scan and any other observation within this many ms
   *  are excluded (prevents matching against same-scan siblings).
   *  Default 60_000 — one minute. */
  excludeWithinMs?: number;
  /** Symbol filter — when set, only records matching this symbol are
   *  scored. Leave undefined to consider every symbol (the radar's
   *  default, which is the whole point of cross-symbol resemblance). */
  symbol?:          string;
}

export function findLiveMatches(
  anchor:  LiveMatchAnchor,
  history: AiStateHistoryRecord[],
  options: LiveMatchOptions = {},
): LiveMatch[] {
  const limit           = options.limit           ?? 3;
  const minScore        = options.minScore        ?? 50;
  const excludeWithinMs = options.excludeWithinMs ?? 60_000;
  const symbolFilter    = options.symbol;

  const ranked: LiveMatch[] = [];
  for (let i = 0; i < history.length; i++) {
    const rec = history[i];
    if (symbolFilter && rec.symbol !== symbolFilter) continue;
    // Exclude the anchor itself + same-scan siblings. The anchor will
    // usually be the most-recent record for the active symbol; with
    // excludeWithinMs=60s any other record from the same radar pass
    // is dropped so we don't match a symbol against its own scan twins.
    if (Math.abs(rec.timestamp - anchor.timestamp) < excludeWithinMs) continue;

    const { score, matchedOn } = scorePair(anchor, rec);
    if (score < minScore) continue;
    ranked.push({ record: rec, similarity: score, matchedOn, historyIdx: i });
  }

  ranked.sort((a, b) =>
    b.similarity - a.similarity || b.record.timestamp - a.record.timestamp);
  return ranked.slice(0, limit);
}
