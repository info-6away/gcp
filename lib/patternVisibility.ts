// v11.24.7: pattern visibility tiers.
// v11.24.8: tightened — kill weak ALs, demote decorative PTs, hard
// cap to ONE visible support per window.
//
// Sits AFTER lib/patternResolve.ts. The resolver compresses
// narrative-vs-narrative conflicts (only one SP/PD/DB per window).
// This module then tags each surviving pattern as 'primary' /
// 'secondary' / 'hidden' so the chart can render fewer markers and
// the pattern feed can group supporting context separately.
//
// Pipeline (order matters — later steps read earlier-step decisions):
//
//   1. Default tier per kind.
//   2. AL gate     — confidence < 0.70 OR pss < 0.55  → hidden.
//   3. FA gate     — confidence < 0.65                → secondary.
//   4. PT gate     — primary nearby                   → hidden;
//                    confidence ≥ 0.75                → primary;
//                    else                             → secondary.
//   5. Hard support cap — at most ONE visible support per window
//                         (CR + PT + AL collapses to CR + best-of).
//
// Hidden patterns are filtered out before reaching consumers (chart,
// pattern feed, research). Secondary patterns reach consumers tagged
// so renderers can dim them.

import type { Pattern, PatternKind } from '@/types/gcp';
import { PATTERN_CONFLICT_WINDOW_MULT } from '@/lib/patternResolve';

export type PatternVisibility = 'primary' | 'secondary' | 'hidden';

// Patterns that anchor a "story" — lifecycle states + shock/exhaustion
// events. These are primary by default and trigger the support cap on
// adjacent secondary patterns.
const PRIMARY_KINDS: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Compression Coil',
  'Compression Release',
  'Synchronization Plateau',
  'Plateau Decay',
  'Discharge Break',
  'Discharge Wave',
  'Double Spike Exhaustion',
  'Coherence Volcano',
  'Shock Jump',
  'Dead Drift',
]);

// All seven kinds that fall under the v11.24.8 hard support cap. AL /
// FA always count as support kinds for the cap regardless of their
// current tier — once their per-kind gate has run, they still
// participate in the "max one visible support per window" rule.
const SUPPORT_KINDS: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Pulse Train',
  'Alignment Ladder',
  'Failed Alignment',
  'Ignition Rise',
  'Ignition Drift',
  'Staircase Alignment',
  'Echo Spike',
]);

// v11.24.8 thresholds.
const AL_MIN_CONFIDENCE = 0.70;
const AL_MIN_PSS        = 0.55;   // proxy for the spec's "rising steps" check —
                                   // PSS captures structural quality (compression
                                   // duration, energy density, curvature) when no
                                   // explicit risingSteps field is tracked.
const FA_PRIMARY_CONFIDENCE = 0.65;
const PT_PRIMARY_CONFIDENCE = 0.75;

const DEV = (): boolean =>
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

function confidenceOf(p: Pattern): number {
  return p.confidence ?? p.strength ?? 0;
}
function pssOf(p: Pattern): number {
  return p.pss ?? p.strength ?? 0;
}

// Higher value = stronger candidate when the support cap has to
// choose. Confidence is the primary axis, strength the tiebreaker,
// then most recent timestamp wins. Mirrors the spec's sort key.
function supportRank(p: Pattern): number {
  const c = confidenceOf(p);
  const s = p.strength ?? 0;
  return c * 1_000_000 + s * 1_000 + (p.tStart > 0 ? p.tStart / 1e15 : 0);
}

function defaultTier(p: Pattern): PatternVisibility {
  if (PRIMARY_KINDS.has(p.kind)) return 'primary';
  // AL and FA start as primary if they're going to survive their
  // per-kind gate, otherwise the gates downgrade them. PT and the rest
  // of the support class start as secondary; their gates may then
  // demote/promote/hide them further.
  if (p.kind === 'Alignment Ladder') return 'primary';
  if (p.kind === 'Failed Alignment') return 'primary';
  if (SUPPORT_KINDS.has(p.kind))     return 'secondary';
  return 'secondary';
}

export interface VisibilityResult {
  visible:    Pattern[];   // primary + secondary, in original order
  hidden:     Pattern[];   // filtered out
}

export function assignPatternVisibility(
  patterns: Pattern[],
  timeframeMs: number = 60_000,
): VisibilityResult {
  if (!patterns.length) return { visible: [], hidden: [] };

  const window = Math.max(1, timeframeMs) * PATTERN_CONFLICT_WINDOW_MULT;
  const sorted = [...patterns].sort((a, b) => a.tStart - b.tStart);

  // Step 1: default tier.
  for (const p of sorted) {
    p.visibility = defaultTier(p);
  }

  // Step 2: AL gate. Kill weak alignment ladders so the chart only
  // shows ladders with both sufficient confidence AND structural
  // quality (PSS proxy for risingSteps when that field isn't tracked).
  for (const p of sorted) {
    if (p.kind !== 'Alignment Ladder') continue;
    const conf = confidenceOf(p);
    const pss  = pssOf(p);
    if (conf < AL_MIN_CONFIDENCE || pss < AL_MIN_PSS) {
      p.visibility = 'hidden';
      if (DEV()) {
        console.log(
          `[PATTERN TIGHTEN] AL hidden — insufficient structure `
          + `(confidence ${conf.toFixed(2)}, pss ${pss.toFixed(2)})`,
        );
      }
    } else {
      p.visibility = 'primary';
    }
  }

  // Step 3: FA gate. Weak Failed Alignment drops to secondary so the
  // chart doesn't surface every minor sync attempt as a headline event.
  for (const p of sorted) {
    if (p.kind !== 'Failed Alignment') continue;
    const conf = confidenceOf(p);
    if (conf < FA_PRIMARY_CONFIDENCE) {
      p.visibility = 'secondary';
      if (DEV()) {
        console.log(
          `[PATTERN TIGHTEN] FA downgraded to secondary — confidence ${conf.toFixed(2)}`,
        );
      }
    }
  }

  // Step 4: PT gate. Pulse Train must earn its marker. If a primary
  // anchor exists in the window, PT is suppressed entirely — the
  // headline already tells the story. Otherwise PT promotes only if
  // confidence ≥ 0.75; weaker pulses stay secondary.
  for (const p of sorted) {
    if (p.kind !== 'Pulse Train') continue;

    let hasNearbyPrimary = false;
    for (const q of sorted) {
      if (q === p) continue;
      if (q.visibility !== 'primary') continue;
      if (Math.abs(q.tStart - p.tStart) > window) continue;
      hasNearbyPrimary = true;
      break;
    }

    if (hasNearbyPrimary) {
      p.visibility = 'hidden';
      if (DEV()) console.log(`[PATTERN TIGHTEN] PT hidden — primary exists in window`);
      continue;
    }

    const conf = confidenceOf(p);
    p.visibility = conf >= PT_PRIMARY_CONFIDENCE ? 'primary' : 'secondary';
    if (DEV()) {
      console.log(
        `[PATTERN TIGHTEN] PT → ${p.visibility} — `
        + `no nearby primary, confidence ${conf.toFixed(2)}`,
      );
    }
  }

  // Step 5: hard support cap. Walk every support-class pattern that's
  // still visible; if any other visible support of the same window
  // ranks higher, hide this one. Result: at most ONE visible support
  // per window (CR + PT + AL → CR + best-of-PT/AL, never all three).
  for (const p of sorted) {
    if (p.visibility === 'hidden') continue;
    if (!SUPPORT_KINDS.has(p.kind)) continue;

    const myRank = supportRank(p);
    let outranked: Pattern | null = null;
    for (const q of sorted) {
      if (q === p) continue;
      if (q.visibility === 'hidden')   continue;
      if (!SUPPORT_KINDS.has(q.kind))  continue;
      if (Math.abs(q.tStart - p.tStart) > window) continue;
      if (supportRank(q) > myRank) { outranked = q; break; }
    }
    if (outranked) {
      p.visibility = 'hidden';
      if (DEV()) {
        const code = p.patternCode ?? p.kind;
        const win  = outranked.patternCode ?? outranked.kind;
        const dt   = Math.abs(outranked.tStart - p.tStart);
        console.log(
          `[PATTERN TIGHTEN] support cap applied — kept ${win}, removed ${code} `
          + `(Δ${(dt / 1000).toFixed(0)}s)`,
        );
      }
    }
  }

  // Bucket and return. Preserve original input order for the visible
  // bucket (so consumers that rely on the resolver's ordering keep
  // working) — sorted[] was a sort copy, but visibility tags are on
  // the same Pattern references, so we filter the original input.
  const visible: Pattern[] = [];
  const hidden:  Pattern[] = [];
  for (const p of patterns) {
    if (p.visibility === 'hidden') hidden.push(p);
    else                            visible.push(p);
  }

  if (DEV() && hidden.length) {
    const primaryCount   = visible.filter(p => p.visibility === 'primary').length;
    const secondaryCount = visible.filter(p => p.visibility === 'secondary').length;
    console.log(
      `[PATTERN TIGHTEN] resolved ${patterns.length} → visible ${visible.length} `
      + `(primary ${primaryCount}, secondary ${secondaryCount}) · hidden ${hidden.length}`,
    );
  }

  return { visible, hidden };
}
