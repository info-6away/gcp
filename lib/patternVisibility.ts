// v11.24.7: pattern visibility tiers.
//
// Sits AFTER lib/patternResolve.ts. The resolver compresses
// narrative-vs-narrative conflicts (only one SP/PD/DB per window).
// This module then tags each surviving pattern as 'primary' /
// 'secondary' / 'hidden' so the chart can render fewer markers and
// the pattern feed can group supporting context separately.
//
// Three rules in priority order:
//
//   1. Default tier per kind. Lifecycle / event patterns are primary;
//      AL and FA depend on confidence; PT / IR / SA / ID / ES default
//      to secondary.
//
//   2. PT upgrade. Pulse Train can be elevated to primary IF the
//      conflict window contains no primary anchor AND its confidence
//      clears 0.7 (sustained pulses with no stronger story).
//
//   3. Support cap. Inside each conflict window, allow at most ONE
//      visible support. When a primary anchor exists in the window,
//      keep the strongest support (highest confidence, then strength,
//      then newest) and hide the rest. Without a primary anchor the
//      strongest support stays visible too.
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

// Context / supporting patterns. Default to secondary; can be hidden
// when more than one shows up inside a single conflict window.
const SUPPORT_KINDS: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Pulse Train',
  'Ignition Rise',
  'Ignition Drift',
  'Staircase Alignment',
  'Echo Spike',
]);

// AL and FA are conditional — strong instances are primary, weak ones
// secondary. The threshold is shared so both kinds use the same gate.
const AL_FA_PRIMARY_CONFIDENCE = 0.65;
const PT_PRIMARY_CONFIDENCE    = 0.70;

const DEV = (): boolean =>
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

function confidenceOf(p: Pattern): number {
  return p.confidence ?? p.strength ?? 0;
}

// Higher value = stronger candidate when the support cap has to
// choose. Confidence is the primary axis, strength the tiebreaker,
// then most recent timestamp wins.
function supportRank(p: Pattern): number {
  const c = confidenceOf(p);
  const s = p.strength ?? 0;
  return c * 1_000_000 + s * 1_000 + (p.tStart > 0 ? p.tStart / 1e15 : 0);
}

function defaultTier(p: Pattern): PatternVisibility {
  if (PRIMARY_KINDS.has(p.kind)) return 'primary';
  if (p.kind === 'Alignment Ladder' || p.kind === 'Failed Alignment') {
    return confidenceOf(p) >= AL_FA_PRIMARY_CONFIDENCE ? 'primary' : 'secondary';
  }
  if (SUPPORT_KINDS.has(p.kind)) return 'secondary';
  return 'secondary';
}

function isSupport(p: Pattern): boolean {
  if (SUPPORT_KINDS.has(p.kind)) return true;
  // AL / FA count as support when they're below the primary threshold.
  if (p.kind === 'Alignment Ladder' || p.kind === 'Failed Alignment') {
    return confidenceOf(p) < AL_FA_PRIMARY_CONFIDENCE;
  }
  return false;
}

function isPrimaryAnchor(p: Pattern): boolean {
  if (PRIMARY_KINDS.has(p.kind)) return true;
  if (p.kind === 'Alignment Ladder' || p.kind === 'Failed Alignment') {
    return confidenceOf(p) >= AL_FA_PRIMARY_CONFIDENCE;
  }
  return false;
}

// Mutates each pattern's `visibility` field in place. Returns the same
// array (with a separate hidden bucket dropped) so the caller can use
// the result as the canonical "patterns the user sees".
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
    if (DEV() && p.kind === 'Alignment Ladder' && p.visibility === 'secondary') {
      console.log(
        `[PATTERN VISIBILITY] AL downgraded to secondary — confidence ${confidenceOf(p).toFixed(2)}`,
      );
    }
    if (DEV() && p.kind === 'Failed Alignment' && p.visibility === 'secondary') {
      console.log(
        `[PATTERN VISIBILITY] FA downgraded to secondary — confidence ${confidenceOf(p).toFixed(2)}`,
      );
    }
  }

  // Step 2: PT upgrade. Pulse Train can become primary if the local
  // window has no other primary anchor and its confidence clears the PT
  // threshold. Sustained pulses with no stronger story deserve to read
  // as the headline pattern in that window.
  for (const p of sorted) {
    if (p.kind !== 'Pulse Train') continue;
    if (confidenceOf(p) < PT_PRIMARY_CONFIDENCE) continue;
    let hasPrimaryNearby = false;
    for (const q of sorted) {
      if (q === p) continue;
      if (Math.abs(q.tStart - p.tStart) > window) continue;
      if (isPrimaryAnchor(q)) { hasPrimaryNearby = true; break; }
    }
    if (!hasPrimaryNearby) {
      p.visibility = 'primary';
      if (DEV()) {
        console.log(
          `[PATTERN VISIBILITY] PT upgraded to primary — no anchor in window, confidence ${confidenceOf(p).toFixed(2)}`,
        );
      }
    }
  }

  // Step 3: support cap. Walk every support-class pattern; if a
  // stronger support sits within its conflict window, hide it. Effect:
  // at most one visible support per window. The check fires whether or
  // not a primary anchor is present — an AL + PT combo inside a tiny
  // window without any narrative still collapses to one visible
  // support, which keeps the chart selective.
  for (const p of sorted) {
    if (p.visibility !== 'secondary') continue;
    if (!isSupport(p))                 continue;

    const myRank = supportRank(p);
    let outranked: Pattern | null = null;
    for (const q of sorted) {
      if (q === p) continue;
      if (Math.abs(q.tStart - p.tStart) > window) continue;
      if (q.visibility === 'hidden')   continue;
      if (!isSupport(q))                continue;
      if (supportRank(q) > myRank) { outranked = q; break; }
    }
    if (outranked) {
      p.visibility = 'hidden';
      if (DEV()) {
        const dt   = Math.abs(outranked.tStart - p.tStart);
        const code = p.patternCode ?? p.kind;
        const win  = outranked.patternCode ?? outranked.kind;
        console.log(
          `[PATTERN VISIBILITY] ${code} hidden near ${win} — support cap exceeded `
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
      `[PATTERN VISIBILITY] resolved ${patterns.length} → visible ${visible.length} `
      + `(primary ${primaryCount}, secondary ${secondaryCount}) · hidden ${hidden.length}`,
    );
  }

  return { visible, hidden };
}
