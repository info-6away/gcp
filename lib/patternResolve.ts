// v11.24.6: post-detection conflict resolver.
//
// Each pattern detector in gcp-data.ts works in isolation, which means
// the same local window can light up with several patterns from
// different phases of the same lifecycle — e.g. a Synchronization
// Plateau and a Discharge Break landing on the same peak. The chart
// then shows them stacked, the feed reads as indicator soup, and the
// user can't tell which signal "won".
//
// This module is a thin post-processor: take the raw detector output,
// keep the highest-priority pattern inside each conflict window, and
// drop the rest. No detector logic is changed — every individual
// pattern is still fired the same way; we just compress overlapping
// signals into a single coherent narrative line.
//
// Priority order (lowest number = highest priority):
//
//   1  SJ, CV, DSE, DW       shock / exhaustion events
//   2  DB                    confirmed discharge break
//   3  DD                    drift after break  (Dead Drift, post-vacuum)
//   4  PD                    plateau decay
//   5  CR                    compression release
//   6  CC                    compression coil
//   7  SP                    synchronization plateau
//   8  AL                    alignment ladder
//   9  ES                    echo spike
//  10  IR / SA / ID          ignition rise / staircase / ignition drift
//  11  FA                    failed alignment
//  12  PT                    pulse train
//
// Within `PATTERN_CONFLICT_WINDOW = timeframeMs * 3`:
//   - Two `narrative` patterns conflict (only one is kept).
//   - A `narrative` pattern suppresses any `support` pattern within
//     the same window (chart should show the lifecycle/shock signal,
//     not a coexisting support marker stacked on top).
//   - Two `support` patterns of DIFFERENT kinds may coexist.
//   - Same-kind duplicates inside the window collapse (older wins).

import type { Pattern, PatternKind } from '@/types/gcp';

export const PATTERN_CONFLICT_WINDOW_MULT = 3;

const PRIORITY: Record<PatternKind, number> = {
  // Event / shock — top priority
  'Shock Jump':                1,
  'Coherence Volcano':         1,
  'Double Spike Exhaustion':   1,
  'Discharge Wave':            1,

  // Lifecycle: discharge phase
  'Discharge Break':           2,

  // Lifecycle: drift / decay
  'Dead Drift':                3,
  'Plateau Decay':             4,

  // Lifecycle: compression -> release
  'Compression Release':       5,
  'Compression Coil':          6,

  // Lifecycle: trend
  'Synchronization Plateau':   7,
  'Alignment Ladder':          8,

  // Context / supporting
  'Echo Spike':                9,
  'Ignition Rise':            10,
  'Staircase Alignment':      10,
  'Ignition Drift':           10,
  'Failed Alignment':         11,
  'Pulse Train':              12,
};

// Narrative = lifecycle + event/shock. Only one wins per conflict
// window. Support = secondary context; coexists with other support of
// different kind, suppressed by any narrative inside its window.
const NARRATIVE: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Shock Jump', 'Coherence Volcano', 'Double Spike Exhaustion', 'Discharge Wave',
  'Discharge Break',
  'Dead Drift', 'Plateau Decay',
  'Compression Release', 'Compression Coil',
  'Synchronization Plateau',
]);

const SUPPORT: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Alignment Ladder', 'Echo Spike',
  'Ignition Rise', 'Staircase Alignment', 'Ignition Drift',
  'Failed Alignment', 'Pulse Train',
]);

export interface SuppressedPattern {
  pattern:    Pattern;
  /** kind of the pattern that ousted this one */
  keptKind:   PatternKind;
  /** |tStart| difference between the two, in ms */
  deltaMs:    number;
  reason:     string;
}

export interface ResolveResult {
  kept:       Pattern[];
  suppressed: SuppressedPattern[];
}

function priorityOf(k: PatternKind): number {
  return PRIORITY[k] ?? 99;
}

function conflictsWith(a: PatternKind, b: PatternKind): boolean {
  if (a === b) return true;                          // dedupe same-kind
  if (NARRATIVE.has(a) && NARRATIVE.has(b)) return true;
  if (NARRATIVE.has(a) && SUPPORT.has(b))   return true;  // narrative > support
  if (SUPPORT.has(a) && NARRATIVE.has(b))   return true;
  return false;                                      // two distinct supports coexist
}

function reasonFor(kept: PatternKind, dropped: PatternKind): string {
  const k = NARRATIVE.has(kept);
  const d = NARRATIVE.has(dropped);
  if (kept === dropped)        return 'duplicate within window';
  if (k && d)                  return 'lower-priority narrative within window';
  if (k && !d)                 return 'support suppressed by narrative';
  return 'lower-priority within window';
}

const DEV = (): boolean =>
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

// Infer the bar interval from a sequence of timestamps. Falls back to
// 60_000 ms (1m) when the series is too short or non-monotonic.
export function inferTimeframeMs(series: { t: number }[]): number {
  if (!series || series.length < 3) return 60_000;
  const diffs: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const d = series[i].t - series[i - 1].t;
    if (d > 0 && d < 24 * 3_600_000) diffs.push(d);
  }
  if (!diffs.length) return 60_000;
  diffs.sort((a, b) => a - b);
  // Median diff resists the historical→live boundary gap.
  const mid = Math.floor(diffs.length / 2);
  return diffs[mid] || 60_000;
}

// Resolve detector output to the highest-priority pattern in each
// local window. Returns both the kept list (used for chart markers,
// pattern feed, research) and a suppressed list (dev-only debug).
export function resolvePatternConflicts(
  patterns: Pattern[],
  timeframeMs: number = 60_000,
): ResolveResult {
  if (patterns.length < 2) return { kept: patterns.slice(), suppressed: [] };

  const window = Math.max(1, timeframeMs) * PATTERN_CONFLICT_WINDOW_MULT;
  // Sort by start timestamp so the inner backward-scan can break early
  // once `dt > window`. Tie-break by priority so that for two patterns
  // sharing the same tStart, the higher-priority one is processed
  // FIRST and the later same-window candidate gets suppressed.
  const sorted = [...patterns].sort((a, b) => {
    if (a.tStart !== b.tStart) return a.tStart - b.tStart;
    return priorityOf(a.kind) - priorityOf(b.kind);
  });

  const kept: Pattern[] = [];
  const suppressed: SuppressedPattern[] = [];

  for (const p of sorted) {
    let dropped = false;

    // Walk kept[] backward; entries are time-monotonic so once dt
    // exceeds the conflict window we can stop.
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i];
      const dt = p.tStart - k.tStart;     // sorted ⇒ p.tStart >= k.tStart
      if (dt > window) break;
      if (!conflictsWith(p.kind, k.kind)) continue;

      const kPri = priorityOf(k.kind);
      const pPri = priorityOf(p.kind);

      if (pPri < kPri) {
        // p outranks k — evict k. Continue scanning for more conflicts
        // since p might dominate multiple older entries within window.
        const reason = reasonFor(p.kind, k.kind);
        suppressed.push({ pattern: k, keptKind: p.kind, deltaMs: dt, reason });
        if (DEV()) {
          console.log(
            `[PATTERN RESOLVE] kept ${p.patternCode ?? p.kind} over `
            + `${k.patternCode ?? k.kind}  (Δ${(dt / 1000).toFixed(0)}s · ${reason})`,
          );
        }
        kept.splice(i, 1);
      } else {
        // p ranks at or below k — drop p, stop checking.
        const reason = reasonFor(k.kind, p.kind);
        suppressed.push({ pattern: p, keptKind: k.kind, deltaMs: dt, reason });
        if (DEV()) {
          console.log(
            `[PATTERN RESOLVE] suppressed ${p.patternCode ?? p.kind} near `
            + `${k.patternCode ?? k.kind}  (Δ${(dt / 1000).toFixed(0)}s · ${reason})`,
          );
        }
        dropped = true;
        break;
      }
    }

    if (!dropped) kept.push(p);
  }

  if (DEV() && suppressed.length) {
    console.log(
      `[PATTERN RESOLVE] resolved ${patterns.length} → ${kept.length} `
      + `(suppressed ${suppressed.length} · window ${(window / 1000).toFixed(0)}s)`,
    );
  }

  return { kept, suppressed };
}
