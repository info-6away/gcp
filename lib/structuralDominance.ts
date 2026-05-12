// v13.1: structural dominance layer.
//
// Local-only correction layer that prevents directional pressure from
// drifting unrealistically bullish (or bearish) when price structure
// clearly disagrees with the coherence read. Engine + payload + SDK
// stay untouched.
//
// Core philosophy:
//
//   Directional Pressure  ≠ market structure
//
//   Pressure is the LATENT coherence tendency: "what the GCP layer
//   thinks the environment is leaning toward."
//
//   Structure is the ACTUAL price control: HH+HL, LH+LL, range,
//   reclaims, FA chains, slope sign.
//
// Pre-v13.1 the additive bullish signals could pin LONG 78% while the
// chart was in a clean LH+LL bleed with an FA chain in history. This
// module reads structure independently, scores it, and applies typed
// contradiction penalties + a final sanity guard so the displayed
// pressure can't lie about what the price tape is doing.
//
// PIPELINE PLACEMENT (in useGcpState.runCall):
//
//   Engine response
//   → anchorAiState
//   → deriveNextState
//   → deriveDirectionalPressure
//   → derivePlateauStateOverlay
//   → deriveDirectionalDecayOverlay
//   → deriveStructuralDominance     ← THIS MODULE
//   → setState / appendAiStateHistory

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { StructureRead } from '@/lib/priceStructure';
import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';

export type StructuralDominance =
  | 'bullish'
  | 'bearish'
  | 'neutral'
  | 'fragile_bullish'
  | 'fragile_bearish';

export interface StructuralDominanceArgs {
  aiState:        GcpStateResponse | null;
  priceStructure: StructureRead   | null | undefined;
  metrics:        { slope: number; curvature?: number } | null | undefined;
  goldTrend:      'up' | 'down' | 'sideways' | 'unknown';
  /** Recent aiStateHistory rows for THIS symbol, newest first. Used
   *  for FA-chain detection. Pass an empty array if unavailable. */
  recentHistory:  AiStateHistoryRecord[];
  latestPatternCode: string | null;
  /** The post-pressure / post-plateau pressure values from the
   *  prior step. These are the numbers we may adjust. */
  currentPressure: { long: number; short: number };
}

export interface StructuralDominanceResult {
  dominance:    StructuralDominance;
  score:        number;       // -100..+100, negative = bearish
  reasons:      string[];
  adjustedLong:  number;       // post-penalties + sanity guard
  adjustedShort: number;
  /** Pressures from BEFORE the structural dominance layer ran.
   *  Surfaced for the dev log so the user can see exactly what the
   *  correction changed. */
  preLong:       number;
  preShort:      number;
}

// ──────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────

const SLOPE_NUDGE  = 0.10;
const SLOPE_STRONG = 0.25;

/** True when 3+ of the last 5 anchored history rows are FA. */
function hasRepeatedFAChain(history: AiStateHistoryRecord[]): boolean {
  const last = history.slice(0, 5);
  const faCount = last.filter(r => r.stateCode === 'FA').length;
  return faCount >= 3;
}

/**
 * Reclaim-after-FA detection. True when the MOST RECENT record was
 * FA and one of the next ≤2 rows after it (going forward in time,
 * which is going BACK in the history array since it's newest-first)
 * is CS / IS / AT. Reads as "FA failed but the system has reclaimed."
 */
function reclaimedAfterFA(history: AiStateHistoryRecord[]): boolean {
  // history is newest-first. A "reclaim" means a recent FA followed by
  // a more recent CS/IS/AT.
  if (history.length < 2) return false;
  const newer = history[0];
  const older = history[1];
  return older?.stateCode === 'FA'
      && (newer.stateCode === 'CS' || newer.stateCode === 'IS' || newer.stateCode === 'AT');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function labelFromScore(score: number): StructuralDominance {
  if (score >=  40) return 'bullish';
  if (score >=  20) return 'fragile_bullish';
  if (score <= -40) return 'bearish';
  if (score <= -20) return 'fragile_bearish';
  return 'neutral';
}

// ──────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────

export function deriveStructuralDominance(
  args: StructuralDominanceArgs,
): StructuralDominanceResult {
  const {
    aiState, priceStructure, metrics, goldTrend,
    recentHistory, latestPatternCode, currentPressure,
  } = args;

  const preLong  = currentPressure.long;
  const preShort = currentPressure.short;
  const reasons: string[] = [];
  let score = 0;

  // ── 1. Price structure (from priceStructure.ts) ────────────────
  if (priceStructure?.structure === 'Bullish') {
    score += 30;
    reasons.push('higher highs + higher lows');
  } else if (priceStructure?.structure === 'Bearish') {
    score -= 30;
    reasons.push('lower highs + lower lows');
  } else if (priceStructure?.structure === 'Range') {
    reasons.push('range structure (neutral)');
  }

  // ── 2. Coherence slope sign + magnitude ────────────────────────
  const slope = metrics?.slope ?? 0;
  if (slope >  SLOPE_STRONG)  { score += 20; reasons.push(`strong positive slope ${slope.toFixed(2)}`); }
  else if (slope >  SLOPE_NUDGE)  { score += 12; reasons.push(`positive slope ${slope.toFixed(2)}`); }
  else if (slope < -SLOPE_STRONG) { score -= 20; reasons.push(`strong negative slope ${slope.toFixed(2)}`); }
  else if (slope < -SLOPE_NUDGE)  { score -= 12; reasons.push(`negative slope ${slope.toFixed(2)}`); }

  // ── 3. Continuation pattern + bias of that pattern ─────────────
  // Pattern codes that are inherently directional/continuation:
  //   AL alignment, CR compression-release, AC accumulation,
  //   BR breakout (subset that the codebase uses).
  // We use the AI state's direction as the "intended" side of the
  // pattern — if direction is Up + we see a continuation pattern,
  // that's a bullish reinforcement.
  const continuationCodes = new Set(['AL', 'CR', 'AC', 'BR']);
  if (latestPatternCode && continuationCodes.has(latestPatternCode)) {
    const dir = aiState?.direction;
    if (dir === 'Up') {
      score += 15;
      reasons.push(`continuation pattern ${latestPatternCode} + Up direction`);
    } else if (dir === 'Down') {
      score -= 15;
      reasons.push(`continuation pattern ${latestPatternCode} + Down direction`);
    } else {
      score +=  5;
      reasons.push(`continuation pattern ${latestPatternCode} (direction ${dir ?? 'unknown'})`);
    }
  }

  // ── 4. Reclaim after FA — bullish recovery signal ──────────────
  if (reclaimedAfterFA(recentHistory)) {
    score += 12;
    reasons.push('reclaim after recent FA');
  }

  // ── 5. Repeated FA chain — bearish exhaustion signal ───────────
  const faChain = hasRepeatedFAChain(recentHistory);
  if (faChain) {
    score -= 25;
    reasons.push('repeated FA chain (≥3 of last 5)');
  }

  // ── 6. Gold trend confirmation / divergence ────────────────────
  if (goldTrend === 'up')   { score += 10; reasons.push('gold trend up'); }
  if (goldTrend === 'down') { score -= 10; reasons.push('gold trend down'); }

  // Clamp before label.
  score = clamp(score, -100, 100);
  const dominance = labelFromScore(score);

  // ── 7. Hard contradiction penalties ────────────────────────────
  // Apply BEFORE the sanity guard so we never over-clamp a soft
  // contradiction that would have been handled by penalties alone.
  let long  = preLong;
  let short = preShort;

  // 7a. FA state + bearish structure: hard bearish.
  if (aiState?.stateCode === 'FA' && dominance.endsWith('bearish')) {
    long  -= 18;
    short += 18;
    reasons.push('penalty: FA state + bearish structure (-18 long)');
  }

  // 7b. Repeated FA chain + LH+LL: chronic bearish exhaustion.
  if (faChain && priceStructure?.structure === 'Bearish') {
    long  -= 12;
    short += 12;
    reasons.push('penalty: repeated FA chain + LH/LL (-12 long)');
  }

  // 7c. Negative slope + no continuation pattern + Bearish structure:
  //     classic late-session breakdown.
  const noContinuation = !latestPatternCode
    || !continuationCodes.has(latestPatternCode);
  if (slope < -SLOPE_NUDGE
      && noContinuation
      && priceStructure?.structure === 'Bearish') {
    long  -= 10;
    short += 10;
    reasons.push('penalty: negative slope + no continuation + bearish structure (-10 long)');
  }

  // 7d. Symmetric upside penalty — bullish slope + no continuation +
  //     bullish structure with mismatch... actually this case is
  //     usually correct, so no penalty. We're guarding AGAINST
  //     unwarranted bullish drift, not vice versa. But if pressure is
  //     long-heavy while gold is trending down, dampen:
  if (goldTrend === 'down' && long > 65) {
    const overshoot = long - 65;
    long  -= overshoot * 0.5;     // pull halfway back toward 65
    short = 100 - long;
    reasons.push(`penalty: gold-down contradiction dampener (long → ${Math.round(long)})`);
  }
  // Symmetric: gold up + short > 65 → dampen short.
  if (goldTrend === 'up' && short > 65) {
    const overshoot = short - 65;
    short -= overshoot * 0.5;
    long  = 100 - short;
    reasons.push(`penalty: gold-up contradiction dampener (short → ${Math.round(short)})`);
  }

  // ── 8. Sanity guard — contradiction resolution, not clipping ────
  // When structural dominance and pressure point in opposite directions
  // by a wide margin, the displayed pressure must capitulate. This is
  // the loudest correction; reserved for cases where the gap would
  // otherwise show "LONG 78%" on a clean bearish bleed.
  if (dominance === 'bearish' && long > 70) {
    long  = 58;
    short = 42;
    reasons.push('sanity: bearish dominance vs long>70 → reset 58/42');
  }
  if (dominance === 'bullish' && short > 70) {
    short = 58;
    long  = 42;
    reasons.push('sanity: bullish dominance vs short>70 → reset 42/58');
  }
  // Softer guard for fragile_*: still resolve obvious contradictions
  // but with a smaller correction so the band stays "fragile".
  if (dominance === 'fragile_bearish' && long > 70) {
    long  = 62;
    short = 38;
    reasons.push('sanity: fragile_bearish vs long>70 → 62/38');
  }
  if (dominance === 'fragile_bullish' && short > 70) {
    short = 62;
    long  = 38;
    reasons.push('sanity: fragile_bullish vs short>70 → 62/38');
  }

  // Final clamp + integerise.
  const adjustedLong  = clamp(Math.round(long),  15, 85);
  const adjustedShort = 100 - adjustedLong;

  return {
    dominance,
    score,
    reasons,
    adjustedLong,
    adjustedShort,
    preLong,
    preShort,
  };
}

// ──────────────────────────────────────────────────────────────────
// Display helpers
// ──────────────────────────────────────────────────────────────────

export function dominanceColor(d: StructuralDominance): string {
  switch (d) {
    case 'bullish':         return '#22c55e';   // clean bull green
    case 'fragile_bullish': return '#7fc59e';   // muted bull
    case 'bearish':         return '#c45a5a';   // clean bear red
    case 'fragile_bearish': return '#c08585';   // muted bear
    case 'neutral':         return 'var(--fg-3)';
  }
}

export function dominanceLabel(d: StructuralDominance): string {
  switch (d) {
    case 'bullish':         return 'Bullish control';
    case 'fragile_bullish': return 'Fragile bullish recovery';
    case 'bearish':         return 'Bearish control';
    case 'fragile_bearish': return 'Fragile bearish bleed';
    case 'neutral':         return 'Neutral range';
  }
}
