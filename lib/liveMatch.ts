// v17.4.1 — Live Match Calibration.
//
// Bridges the live radar with the research ledger by asking the
// question "have I seen this read before?" instead of "what is
// happening?".
//
// Pure similarity derivation. No Engine calls, no payload changes, no
// scan or AI changes.
//
// v17.4.1 rebalances the v17.4 weights — the original scoring was
// dominated by field-level dimensions (mood + family-lead + dispersion
// + dominant-action combined for 30 of 108), which meant a BTC read
// during an opportunity window resembled a EURUSD read during an
// opportunity window almost as much as it resembled another BTC read.
// The system was remembering the WEATHER, not the person standing in
// the weather.
//
// Changes in v17.4.1:
//   1. Field-context dimensions de-emphasized (mood 10→4, family-lead
//      8→4, dispersion 6→3, dominant-action 6→3).
//   2. Per-symbol dimensions emphasized — clarity 8→14, pressure
//      direction 8→12, NEW pressure magnitude (10).
//   3. NEW symbol-family match: +12 when the two symbols belong to
//      the same family (metals↔metals, crypto↔crypto), -8 PENALTY
//      when they don't. Cross-family resemblance now requires real
//      evidence to clear the bar.
//   4. Hard caps: state differs → max 70, family differs → max 80,
//      clarity delta > 15% → max 85.
//   5. Dropped opportunity-score proximity and pressure-band exact
//      match — both folded into the other dimensions.
//   6. Per-match breakdown returned + dev-logged so calibration is
//      auditable in the console.
//
// Final weight table:
//   stateCode             18   (exact)
//   opportunity status    14   (exact)
//   clarity (proximity)   14   (0 at |Δconf| ≥ 0.5)
//   pressure direction    12   (sign of long-short skew)
//   symbol family         12   (+12 same / -8 different)
//   pressure magnitude    10   (proximity, 0 at |Δskew| ≥ 50)
//   phase                  8   (exact)
//   field mood             4   (exact, when both signatures present)
//   family leadership      4   (exact, when both signatures present)
//   dispersion             3   (exact, when both signatures present)
//   dominant action        3   (exact, when both signatures present)
//   ────────────────────────────────
//   max raw              102 → normalized to 0-100, then capped

import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';
import type { MarketSymbol } from '@/types/gcp';
import { familyOf } from '@/lib/marketFamilies';

/** Subset of AiStateHistoryRecord the scorer needs. */
export type LiveMatchAnchor = Pick<AiStateHistoryRecord,
  | 'symbol' | 'stateCode' | 'phase' | 'direction' | 'confidence'
  | 'longPressure' | 'shortPressure' | 'pressureBand'
  | 'opportunityScore' | 'opportunityStatus'
  | 'fieldSignature' | 'timestamp'>;

export interface LiveMatchBreakdown {
  /** Pre-cap normalized score (0-100). */
  base:        number;
  /** Symbol-family adjustment that landed in raw — +12, -8, or 0. */
  familyDelta: number;
  /** Caps that bound the final score, in order — e.g.
   *  ['family cap 80', 'clarity cap 85']. */
  capsApplied: string[];
  /** Final score after caps. */
  final:       number;
}

export interface LiveMatch {
  /** The historical record this match refers to. */
  record:      AiStateHistoryRecord;
  /** 0-100 similarity score (after caps). */
  similarity:  number;
  /** Which dimensions matched — drives the diagnostic line. */
  matchedOn:   string[];
  /** Index in the source history array — lets callers cross-reference
   *  outcome arrays without re-walking history. */
  historyIdx:  number;
  /** Auditable scoring breakdown. */
  breakdown:   LiveMatchBreakdown;
}

const W = {
  state:         18,
  opportunity:   14,
  clarity:       14,
  pressureDir:   12,
  symbolFamily:  12,   // +12 match / -8 mismatch
  pressureMag:   10,
  phase:          8,
  mood:           4,
  familyLead:     4,
  dispersion:     3,
  dominantAction: 3,
} as const;

const FAMILY_MISMATCH_PENALTY = 8;

// Max positive raw with every dimension at full credit.
const TOTAL_RAW =
    W.state + W.opportunity + W.clarity + W.pressureDir + W.symbolFamily
  + W.pressureMag + W.phase + W.mood + W.familyLead + W.dispersion
  + W.dominantAction;   // = 102

// Caps applied AFTER normalization. Take MIN of all triggered caps.
const CAP_STATE_DIFFERS:   number = 70;
const CAP_FAMILY_DIFFERS:  number = 80;
const CAP_CLARITY_DRIFT:   number = 85;
/** Clarity delta in absolute percentage points (confidence × 100). */
const CLARITY_DRIFT_THRESHOLD = 15;

function pressureDirection(long?: number, short?: number): 1 | -1 | 0 {
  if (long == null || short == null) return 0;
  if (long === short) return 0;
  return long > short ? 1 : -1;
}

function pressureSkew(long?: number, short?: number): number | null {
  if (long == null || short == null) return null;
  return Math.abs(long - short);
}

interface ScorePairResult {
  similarity: number;       // post-cap (0-100)
  matchedOn:  string[];
  breakdown:  LiveMatchBreakdown;
}

function scorePair(
  anchor: LiveMatchAnchor,
  rec:    AiStateHistoryRecord,
): ScorePairResult {
  let raw = 0;
  const matched: string[] = [];

  // ── State + opportunity (still the heaviest exact dimensions) ──
  const stateMatch = anchor.stateCode === rec.stateCode;
  if (stateMatch) { raw += W.state; matched.push('state'); }

  if (anchor.opportunityStatus && rec.opportunityStatus
      && anchor.opportunityStatus === rec.opportunityStatus) {
    raw += W.opportunity; matched.push('opportunity');
  }

  // ── Per-symbol fingerprint dimensions (boosted in v17.4.1) ──
  // Clarity: linear decay, 0 credit at |Δconf| ≥ 0.5.
  const diffConf = Math.abs(anchor.confidence - rec.confidence);
  raw += Math.max(0, W.clarity - diffConf * (W.clarity / 0.5));

  // Pressure direction — sign agreement on the long/short skew.
  const aDir = pressureDirection(anchor.longPressure, anchor.shortPressure);
  const rDir = pressureDirection(rec.longPressure,    rec.shortPressure);
  if (aDir !== 0 && rDir !== 0 && aDir === rDir) {
    raw += W.pressureDir; matched.push('pressure-dir');
  }

  // Pressure magnitude — linear proximity on the long/short skew
  // magnitude. 0 credit at |Δskew| ≥ 50.
  const aSkew = pressureSkew(anchor.longPressure, anchor.shortPressure);
  const rSkew = pressureSkew(rec.longPressure,    rec.shortPressure);
  if (aSkew != null && rSkew != null) {
    const diff = Math.abs(aSkew - rSkew);
    const credit = Math.max(0, W.pressureMag - diff * (W.pressureMag / 50));
    raw += credit;
    if (credit >= W.pressureMag * 0.6) matched.push('pressure-mag');
  }

  // Symbol family: same family → +12; different → -8 penalty.
  // Unknown symbol (defensive) → 0 either way.
  const aFam = familyOf(anchor.symbol as MarketSymbol);
  const rFam = familyOf(rec.symbol    as MarketSymbol);
  let familyDelta = 0;
  let symbolFamilyMatch = false;
  if (aFam && rFam) {
    if (aFam === rFam) {
      familyDelta = W.symbolFamily;
      raw += W.symbolFamily;
      matched.push(`${aFam}↔${rFam}`);
      symbolFamilyMatch = true;
    } else {
      familyDelta = -FAMILY_MISMATCH_PENALTY;
      raw -= FAMILY_MISMATCH_PENALTY;
    }
  }

  // ── Phase ──
  if (anchor.phase === rec.phase) { raw += W.phase; matched.push('phase'); }

  // ── Field context (de-emphasized) ──
  const aSig = anchor.fieldSignature;
  const rSig = rec.fieldSignature;
  if (aSig && rSig) {
    if (aSig.mood === rSig.mood) {
      raw += W.mood; matched.push(`mood:${aSig.mood}`);
    }
    if (aSig.topFamily === rSig.topFamily) {
      raw += W.familyLead; matched.push(`${aSig.topFamily}-lead`);
    }
    if (aSig.dispersionLevel === rSig.dispersionLevel) {
      raw += W.dispersion; matched.push('dispersion');
    }
    if (aSig.dominantAction === rSig.dominantAction) {
      raw += W.dominantAction; matched.push('field-action');
    }
  }

  // Normalize to 0-100. Raw can go negative if family mismatches and
  // little else matches; floor at 0.
  const base = Math.max(0, Math.round((raw / TOTAL_RAW) * 100));

  // Apply hard caps. Take MIN of every cap that triggers.
  let final = base;
  const capsApplied: string[] = [];

  if (!stateMatch) {
    final = Math.min(final, CAP_STATE_DIFFERS);
    capsApplied.push(`state cap ${CAP_STATE_DIFFERS}`);
  }
  if (aFam && rFam && !symbolFamilyMatch) {
    final = Math.min(final, CAP_FAMILY_DIFFERS);
    capsApplied.push(`family cap ${CAP_FAMILY_DIFFERS}`);
  }
  if (diffConf * 100 > CLARITY_DRIFT_THRESHOLD) {
    final = Math.min(final, CAP_CLARITY_DRIFT);
    capsApplied.push(`clarity cap ${CAP_CLARITY_DRIFT}`);
  }

  return {
    similarity: final,
    matchedOn:  matched,
    breakdown:  { base, familyDelta, capsApplied, final },
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
   *  scored. */
  symbol?:          string;
  /** Emit one dev-only console line per call describing the top
   *  match's score breakdown. Default true in dev, false in prod. */
  debug?:           boolean;
}

const isDev = () =>
  typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';

export function findLiveMatches(
  anchor:  LiveMatchAnchor,
  history: AiStateHistoryRecord[],
  options: LiveMatchOptions = {},
): LiveMatch[] {
  const limit           = options.limit           ?? 3;
  const minScore        = options.minScore        ?? 50;
  const excludeWithinMs = options.excludeWithinMs ?? 60_000;
  const symbolFilter    = options.symbol;
  const debug           = options.debug ?? isDev();

  const ranked: LiveMatch[] = [];
  for (let i = 0; i < history.length; i++) {
    const rec = history[i];
    if (symbolFilter && rec.symbol !== symbolFilter) continue;
    if (Math.abs(rec.timestamp - anchor.timestamp) < excludeWithinMs) continue;

    const { similarity, matchedOn, breakdown } = scorePair(anchor, rec);
    if (similarity < minScore) continue;
    ranked.push({
      record: rec, similarity, matchedOn, historyIdx: i, breakdown,
    });
  }

  ranked.sort((a, b) =>
    b.similarity - a.similarity || b.record.timestamp - a.record.timestamp);
  const top = ranked.slice(0, limit);

  if (debug && top.length > 0) {
    const t = top[0];
    const parts: string[] = [
      `base=${t.breakdown.base}`,
    ];
    if (t.breakdown.familyDelta !== 0) {
      parts.push(`family=${t.breakdown.familyDelta > 0 ? '+' : ''}${t.breakdown.familyDelta}`);
    }
    if (t.breakdown.capsApplied.length > 0) {
      parts.push(`caps=[${t.breakdown.capsApplied.join(', ')}]`);
    }
    parts.push(`final=${t.breakdown.final}`);
    console.log(
      '[LIVE MATCH]',
      `${anchor.symbol} → ${t.record.symbol}`,
      ...parts,
    );
  }

  return top;
}
