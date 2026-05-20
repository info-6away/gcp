// v17.2 — Phase 17.2: Field-context signature for Research.
//
// A single per-scan snapshot of the macro coherence field, captured at
// the moment a radar scan completes. Attached to every observation
// produced by that scan so Research can answer:
//
//   "CS→IS worked... during Opportunity Windows?
//    ...during Defensive markets?
//    ...when the field was synchronized?"
//
// Global averages ("CS→IS +0.08%") mask the fact that the same
// transition behaves radically differently across field contexts.
// This signature lets Research slice the same history by the
// surrounding conditions.
//
// PURE DERIVATION. The Engine, payload, prompts, thresholds, action
// ladder, GO logic, trade math and pressure/dominance calculations are
// unchanged. All inputs are values the existing field helpers already
// produce; this lib only composes them into one persistent shape.

import type { RadarResult } from '@/lib/radarScan';
import type { ActionState } from '@/lib/actionState';
import type { FieldMoodSentiment } from '@/lib/fieldMood';
import type { DispersionLevel } from '@/lib/fieldDispersion';
import { deriveFieldMood } from '@/lib/fieldMood';
import { deriveFieldDispersion } from '@/lib/fieldDispersion';
import { deriveFamilyParticipation } from '@/lib/marketFamilies';
import { deriveFieldAnchoring } from '@/lib/classificationInfluence';
import { deriveOpportunityDistance } from '@/lib/opportunityDistance';

export interface FieldSignature {
  /** Mood sentiment — the value Research filters on directly. */
  mood:              FieldMoodSentiment;
  /** Short human title — e.g. "Opportunity window opening". */
  moodTitle:         string;
  /** Dispersion level — synchronized (low) vs fragmented (high). */
  dispersionLevel:   DispersionLevel;
  /** % of symbols sharing the dominant action state. */
  agreementPct:      number;
  /** Dominant action state across the scan. */
  dominantAction:    'BLOCKED' | 'WATCH' | 'READY' | 'GO' | 'MIXED';
  /** Most-participating family at scan time. */
  topFamily:         string;
  /** Top family's mood. */
  topFamilyMood:     string;
  /** Dominant opportunity bucket across the field. */
  opportunityBucket: 'far' | 'building' | 'near' | 'imminent' | 'go';
  /** Average field-influence (0-100). High = "10 BLOCKED" was an
   *  architectural read, not market reality. */
  anchoring:         number;
  /** Number of OK symbols this signature was derived from — sanity
   *  check, lets stale / partial scans be filtered out at read time. */
  sampled:           number;
}

const ACTION_KEYS = ['BLOCKED', 'WATCH', 'READY', 'GO'] as const;

function modeOf<T extends string>(counts: Record<string, number>, fallback: T): T {
  let best = fallback as string;
  let bestN = -1;
  for (const [k, v] of Object.entries(counts)) {
    if (v > bestN) { bestN = v; best = k; }
  }
  return best as T;
}

export function deriveFieldSignature(
  results: RadarResult[],
): FieldSignature | null {
  const ok = results.filter(r => r.ok && r.aiState && r.action);
  if (ok.length < 2) return null;

  const dispersion = deriveFieldDispersion(results);
  if (!dispersion) return null;

  // Action counts feed both deriveFieldMood and the dominantAction
  // field. We re-tally here rather than reading from results twice
  // because deriveFieldDispersion uses string keys (not ActionState).
  const counts: Record<string, number> = { BLOCKED: 0, WATCH: 0, READY: 0, GO: 0 };
  for (const r of ok) {
    const a = r.action!.actionState as ActionState;
    if (a in counts) counts[a]++;
  }

  const mood = deriveFieldMood({
    ready:         counts.READY,
    watch:         counts.WATCH,
    blocked:       counts.BLOCKED,
    total:         ok.length,
    dispersion:    dispersion.level,
    dominantState: dispersion.dominantState,
  });

  // Family rotation — pick the family with the highest total
  // participation. Ties broken by READY+GO count, then alphabetically.
  const families = deriveFamilyParticipation(results);
  const topFamily = families.length > 0
    ? families.slice().sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        const aPos = a.ready + a.go;
        const bPos = b.ready + b.go;
        if (bPos !== aPos) return bPos - aPos;
        return a.family.localeCompare(b.family);
      })[0]
    : null;

  // Opportunity bucket — mode of per-symbol bucket. When the field is
  // empty of bucketed reads (older scans / partial results) fall back
  // to 'far' which is the most defensive default for a filter join.
  const oppCounts: Record<string, number> = {
    far: 0, building: 0, near: 0, imminent: 0, go: 0,
  };
  for (const r of ok) {
    const opp = deriveOpportunityDistance(r);
    if (opp) oppCounts[opp.status]++;
  }
  const opportunityBucket =
    modeOf(oppCounts, 'far') as FieldSignature['opportunityBucket'];

  const anchoring = deriveFieldAnchoring(results);

  // Dominant action — read from the dispersion summary; coerce
  // anything outside the four entry-side rungs to 'MIXED' (radar scans
  // never carry MANAGE/EXIT but defensive guard is cheap).
  const da = dispersion.dominantAction;
  const dominantAction: FieldSignature['dominantAction'] =
    ACTION_KEYS.includes(da as typeof ACTION_KEYS[number])
      ? (da as FieldSignature['dominantAction'])
      : 'MIXED';

  return {
    mood:              mood.sentiment,
    moodTitle:         mood.title,
    dispersionLevel:   dispersion.level,
    agreementPct:      dispersion.agreementPct,
    dominantAction,
    topFamily:         topFamily?.family ?? '—',
    topFamilyMood:     topFamily?.mood   ?? 'mixed',
    opportunityBucket,
    anchoring:         anchoring?.avgFieldInfluence ?? 50,
    sampled:           ok.length,
  };
}

// ────────────────────────────────────────────────────────────────────
// Research-side filter helpers
// ────────────────────────────────────────────────────────────────────

export type FieldContextFilter =
  | 'all'
  | 'opportunity'
  | 'defensive'
  | 'synchronized'
  | 'fragmented';

/** Test whether a signature matches a context filter. Records without
 *  a signature (pre-v17.2) NEVER match a specific filter — we don't
 *  know the surrounding conditions, so they must not slip into a
 *  context-specific average. */
export function signatureMatchesFilter(
  sig:    FieldSignature | undefined,
  filter: FieldContextFilter,
): boolean {
  if (filter === 'all') return true;
  if (!sig) return false;
  if (filter === 'opportunity') {
    return sig.mood === 'opportunity'
        || sig.opportunityBucket === 'near'
        || sig.opportunityBucket === 'imminent'
        || sig.opportunityBucket === 'go';
  }
  if (filter === 'defensive') {
    return sig.mood === 'defensive' || sig.dominantAction === 'BLOCKED';
  }
  if (filter === 'synchronized') return sig.mood === 'synchronized';
  if (filter === 'fragmented')   return sig.mood === 'fragmented';
  return false;
}

export const FILTER_LABEL: Record<FieldContextFilter, string> = {
  all:           'ALL',
  opportunity:   'OPPORTUNITY',
  defensive:     'DEFENSIVE',
  synchronized:  'SYNCHRONIZED',
  fragmented:    'FRAGMENTED',
};

/** Sentence fragment used in Field Insight headlines. */
export const FILTER_PHRASE: Record<FieldContextFilter, string> = {
  all:           'globally',
  opportunity:   'during opportunity windows',
  defensive:     'during defensive markets',
  synchronized:  'when the field was synchronized',
  fragmented:    'when the field was fragmented',
};
