// v14.2 — Phase 14.2: News analysis.
//
// Two distinct, deliberately separate concerns:
//
//   classifyNews()           — EDITORIAL signal. Category + importance
//                              derived from the headline text. "How
//                              significant is this news as news?"
//
//   deriveNewsReactionScore() — COHERENCE signal. Did the GCP field
//                              actually move around the event? Reads
//                              NV deviation / slope / curvature /
//                              regime / pattern emergence across
//                              pre / event / post windows.
//
// These are NOT the same thing — a major headline can land with no
// coherence reaction, and a minor one can coincide with a strong
// reaction. The News tab shows both, separately.
//
// Pure derivation. No Engine, no network, no AI.

import type { DataPoint, Pattern } from '@/types/gcp';
import { windowMetrics } from '@/lib/energy';

// ════════════════════════════════════════════════════════════════════
// EDITORIAL — category + importance
// ════════════════════════════════════════════════════════════════════

export type NewsCategory =
  'macro' | 'geopolitics' | 'markets' | 'crypto' | 'gold' | 'fx' | 'general';

export type NewsImportance = 'high' | 'medium' | 'low';

// Specific categories are tested before broad ones so e.g. a gold
// headline isn't swallowed by "markets". First match wins.
const CATEGORY_KEYWORDS: { cat: NewsCategory; words: string[] }[] = [
  { cat: 'gold',   words: ['gold', 'xau', 'bullion', 'precious metal', 'silver'] },
  { cat: 'crypto', words: ['bitcoin', 'btc', 'ethereum', 'crypto', 'blockchain', 'stablecoin'] },
  { cat: 'fx',     words: ['forex', 'currency', 'exchange rate', 'sterling', 'the dollar', 'the euro', 'the yen', 'us dollar'] },
  { cat: 'macro',  words: ['federal reserve', 'the fed', 'rate cut', 'rate hike', 'rate decision', 'interest rate', 'inflation', 'cpi', 'gdp', 'ecb', 'central bank', 'jobs report', 'payroll', 'unemployment', 'recession', 'powell', 'monetary'] },
  { cat: 'markets', words: ['stocks', 'shares', 's&p', 'nasdaq', 'dow ', 'equities', 'bond', 'yields', 'wall street', 'earnings', 'ipo'] },
  { cat: 'geopolitics', words: ['war', 'sanction', 'election', 'military', 'conflict', 'treaty', 'troops', 'missile', 'invasion', 'ceasefire', 'border', 'nuclear', 'coup', 'strike on', 'airstrike'] },
];

const HIGH_IMPACT_WORDS = [
  'rate decision', 'rate hike', 'rate cut', 'the fed', 'federal reserve',
  'powell', 'cpi', 'jobs report', 'war', 'crisis', 'crash', 'emergency',
  'invasion', 'collapse', 'default', 'recession', 'ceasefire', 'nuclear',
];
const MED_IMPACT_WORDS = [
  'inflation', 'gdp', 'central bank', 'sanction', 'earnings', 'yields',
  'ecb', 'tariff', 'stimulus', 'election', 'unemployment', 'payroll',
];

export interface NewsClassification {
  category:   NewsCategory;
  importance: NewsImportance;
}

export function classifyNews(title: string): NewsClassification {
  const t = title.toLowerCase();

  let category: NewsCategory = 'general';
  for (const { cat, words } of CATEGORY_KEYWORDS) {
    if (words.some(w => t.includes(w))) { category = cat; break; }
  }

  let importance: NewsImportance = 'low';
  if (HIGH_IMPACT_WORDS.some(w => t.includes(w))) {
    importance = 'high';
  } else if (
    MED_IMPACT_WORDS.some(w => t.includes(w)) ||
    category === 'macro' || category === 'geopolitics' || category === 'markets'
  ) {
    importance = 'medium';
  }

  return { category, importance };
}

// ════════════════════════════════════════════════════════════════════
// COHERENCE — reaction score
// ════════════════════════════════════════════════════════════════════

export type ReactionLabel  = 'none' | 'low' | 'moderate' | 'high' | 'extreme';
export type ReactionTiming = 'pre' | 'during' | 'post' | 'delayed' | 'none';

export interface NewsReaction {
  /** 0-100 coherence-reaction score. */
  score:          number;
  label:          ReactionLabel;
  /** Where the strongest deviation sat relative to the event. */
  timing:         ReactionTiming;
  /** The single largest-contributing signal. */
  dominantSignal: string;
  explanation:    string;
  /** Baseline (pre-event quiet) NV — reference for the timeline. */
  baselineNV:     number | null;
  /** Peak NV across the analysis window. */
  peakNV:         number | null;
  /** Minutes from event to the NV peak (negative = before). */
  peakOffsetMin:  number | null;
  /** Regime transition across the event, if any. */
  regimeShift:    { from: string; to: string } | null;
  /** Downsampled NV for the expanded mini timeline, ~T-60..T+60. */
  spark:          { nv: number[]; eventIdx: number } | null;
}

const MIN = 60_000;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function std(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function sliceWindow(series: DataPoint[], from: number, to: number): DataPoint[] {
  return series.filter(p => p.t >= from && p.t <= to);
}
function dominantRegime(pts: DataPoint[]): string | null {
  if (!pts.length) return null;
  const counts: Record<string, number> = {};
  for (const p of pts) counts[p.r] = (counts[p.r] ?? 0) + 1;
  let best: string | null = null, bestN = -1;
  for (const [r, n] of Object.entries(counts)) {
    if (n > bestN) { bestN = n; best = r; }
  }
  return best;
}

const EMPTY_REACTION: NewsReaction = {
  score: 0, label: 'none', timing: 'none',
  dominantSignal: 'no coverage',
  explanation: 'Event falls outside the recorded coherence window.',
  baselineNV: null, peakNV: null, peakOffsetMin: null,
  regimeShift: null, spark: null,
};

/**
 * Score how strongly the GCP coherence field reacted around a news
 * event. Looks at a baseline (quiet) window, a pre window, the event
 * window (±10m) and a post window — so a reaction that lands early,
 * on time, or with a delay is all captured.
 */
export function deriveNewsReactionScore(args: {
  newsTimestamp: number;
  gcpSeries:     DataPoint[];
  patterns:      Pattern[];
}): NewsReaction {
  const { newsTimestamp: T, gcpSeries, patterns } = args;
  if (!gcpSeries.length) return EMPTY_REACTION;

  // Window boundaries (ms).
  const baseline = sliceWindow(gcpSeries, T - 60 * MIN, T - 20 * MIN);
  const pre      = sliceWindow(gcpSeries, T - 30 * MIN, T - 2  * MIN);
  const event    = sliceWindow(gcpSeries, T - 10 * MIN, T + 10 * MIN);
  const post     = sliceWindow(gcpSeries, T + 10 * MIN, T + 60 * MIN);

  // Need a real baseline + at least a partial event window to score.
  if (baseline.length < 5 || event.length < 3) return EMPTY_REACTION;

  const baseNVs  = baseline.map(p => p.v);
  const bMean    = mean(baseNVs);
  // Floor the std so a dead-flat baseline can't make every wiggle look
  // like a 10σ spike.
  const bStd     = Math.max(std(baseNVs, bMean), bMean * 0.06 + 1);
  const baseSlope = baseline.length >= 3
    ? windowMetrics(baseNVs).slope : 0;

  // Peak NV + its offset across pre+event+post.
  const scanned = [...pre, ...event, ...post];
  let peakNV = -Infinity, peakT = T;
  for (const p of scanned) {
    if (p.v > peakNV) { peakNV = p.v; peakT = p.t; }
  }
  if (!isFinite(peakNV)) return EMPTY_REACTION;
  const peakOffsetMin = Math.round((peakT - T) / MIN);

  // ── Component 1: NV deviation (0-40). Peak event/post NV vs
  //    baseline mean, in baseline-std units.
  const reactNVs    = [...event, ...post].map(p => p.v);
  const reactPeak   = reactNVs.length ? Math.max(...reactNVs) : bMean;
  const deviationSd = (reactPeak - bMean) / bStd;
  const nvComponent = clamp01(deviationSd / 4) * 40;

  // ── Component 2: slope acceleration (0-20). Event-window slope vs
  //    baseline slope.
  const eventSlope  = event.length >= 3 ? windowMetrics(event.map(p => p.v)).slope : 0;
  const slopeDelta  = Math.abs(eventSlope - baseSlope);
  const slopeComponent = clamp01(slopeDelta / 4) * 20;

  // ── Component 3: curvature spike (0-10).
  const eventCurv   = event.length >= 3 ? Math.abs(windowMetrics(event.map(p => p.v)).curvature) : 0;
  const baseCurv    = baseline.length >= 3 ? Math.abs(windowMetrics(baseNVs).curvature) : 0;
  const curvComponent = clamp01((eventCurv - baseCurv) / 1.5) * 10;

  // ── Component 4: regime transition (0-20).
  const baseRegime  = dominantRegime(baseline);
  const postRegime  = dominantRegime(post.length ? post : event);
  const regimeShifted = !!baseRegime && !!postRegime && baseRegime !== postRegime;
  const regimeComponent = regimeShifted ? 20 : 0;

  // ── Component 5: pattern emergence in the reaction window (0-10).
  const patternInWindow = patterns.some(
    p => p.tStart >= T - 30 * MIN && p.tStart <= T + 60 * MIN,
  );
  const patternComponent = patternInWindow ? 10 : 0;

  let score = Math.round(
    nvComponent + slopeComponent + curvComponent
    + regimeComponent + patternComponent,
  );

  // Persistence bonus — reaction that stays elevated post-event is a
  // truer signal than a single-bar blip.
  const postMean = mean(post.map(p => p.v));
  const persisted = post.length >= 5 && postMean > bMean + 0.6 * bStd;
  if (persisted) score = Math.min(100, score + 6);

  score = Math.max(0, Math.min(100, score));

  // Dominant signal — largest contributor.
  const contributions: { signal: string; weight: number }[] = [
    { signal: 'NV spike',           weight: nvComponent },
    { signal: 'slope acceleration', weight: slopeComponent },
    { signal: 'curvature spike',    weight: curvComponent },
    { signal: 'regime shift',       weight: regimeComponent },
    { signal: 'pattern emergence',  weight: patternComponent },
  ];
  contributions.sort((a, b) => b.weight - a.weight);
  const dominantSignal = score < 12 ? 'no clear reaction'
    : persisted && contributions[0].weight < 12 ? 'sustained elevation'
    : contributions[0].signal;

  // Timing — which window held the peak.
  const timing: ReactionTiming =
      score < 12               ? 'none'
    : peakOffsetMin < -2        ? 'pre'
    : peakOffsetMin <= 10       ? 'during'
    : peakOffsetMin <= 30       ? 'post'
    :                             'delayed';

  // Label.
  const label: ReactionLabel =
      score < 12 ? 'none'
    : score < 32 ? 'low'
    : score < 58 ? 'moderate'
    : score < 80 ? 'high'
    :              'extreme';

  // Explanation.
  const timingWord =
      timing === 'pre'     ? 'ahead of the event'
    : timing === 'during'  ? 'at the event'
    : timing === 'post'    ? 'shortly after the event'
    : timing === 'delayed' ? `${peakOffsetMin}m after the event`
    :                        'around the event';
  const explanation = score < 12
    ? 'No meaningful coherence movement around this event.'
    : `Coherence ${label === 'extreme' || label === 'high' ? 'reacted strongly' : 'shifted'} `
      + `${timingWord} — ${dominantSignal}`
      + (regimeShifted ? `, regime ${baseRegime} → ${postRegime}.` : '.');

  // Mini-timeline spark — downsample T-60..T+60 NV into ~48 buckets.
  const sparkPts = sliceWindow(gcpSeries, T - 60 * MIN, T + 60 * MIN);
  let spark: { nv: number[]; eventIdx: number } | null = null;
  if (sparkPts.length >= 6) {
    const BUCKETS = 48;
    const spanMs  = 120 * MIN;
    const nv: number[] = new Array(BUCKETS).fill(0);
    const cnt: number[] = new Array(BUCKETS).fill(0);
    for (const p of sparkPts) {
      let b = Math.floor(((p.t - (T - 60 * MIN)) / spanMs) * BUCKETS);
      b = Math.max(0, Math.min(BUCKETS - 1, b));
      nv[b] += p.v; cnt[b] += 1;
    }
    // Fill empty buckets by carrying the last value forward.
    let last = bMean;
    for (let i = 0; i < BUCKETS; i++) {
      if (cnt[i] > 0) { nv[i] = nv[i] / cnt[i]; last = nv[i]; }
      else nv[i] = last;
    }
    spark = { nv, eventIdx: BUCKETS / 2 };
  }

  return {
    score, label, timing, dominantSignal, explanation,
    baselineNV: +bMean.toFixed(1),
    peakNV:     +peakNV.toFixed(1),
    peakOffsetMin,
    regimeShift: regimeShifted ? { from: baseRegime!, to: postRegime! } : null,
    spark,
  };
}
