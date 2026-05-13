// v13.1: structural dominance layer.
// v13.1.1: penalty + sanity-guard pass softened ~50%; new
//          amplification path added so confirming structure can push
//          pressure further (not just dampen it).
//
// Local-only correction layer that prevents directional pressure from
// drifting unrealistically bullish (or bearish) when price structure
// clearly disagrees with the coherence read. Engine + payload + SDK
// stay untouched.
//
// EXPRESSIVE RANGES — what the displayed pressure should hit:
//   weak environments        45-55
//   moderate environments    60-40
//   strong environments      70-30
//   extreme environments     80-20
// Pre-v13.1.1 the cascade collapsed everything to ~49/51 by stacking
// hard penalties + an aggressive sanity guard. v13.1.1 reduces every
// penalty magnitude by ~50% and adds a structural-amplification block
// so confirming evidence reinforces pressure instead of being neutral.
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
  /** v13.2: skip the sanity-guard step so the temporal-pressure layer
   *  can run between penalties+amp and sanity. Defaults to true for
   *  back-compat with v13.1 callers. */
  runSanityGuard?: boolean;
}

export interface StructuralDominanceResult {
  dominance:    StructuralDominance;
  score:        number;       // -100..+100, negative = bearish
  reasons:      string[];
  adjustedLong:  number;       // post-penalties + amplification (+ sanity if runSanityGuard)
  adjustedShort: number;
  /** Pressures from BEFORE the structural dominance layer ran.
   *  Surfaced for the dev log so the user can see exactly what the
   *  correction changed. */
  preLong:       number;
  preShort:      number;
  /** v13.2: detectors needed by the separate sanity-guard pass so the
   *  caller can interpose temporal pressure between dominance and
   *  sanity without recomputing structure semantics. */
  faChain:        boolean;
  reclaim:        boolean;
  structureClean: boolean;
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

  // ── 7. Contradiction penalties — softened in v13.1.1 ────────────
  //
  // The pre-v13.1.1 penalties were correct in direction but too eager
  // in magnitude, and they collapsed everything to ~49/51 by stacking
  // with the sanity guard. v13.1.1 cuts every penalty by ~50% and
  // requires the trigger to ACTUALLY conflict with the prior pressure
  // direction (no point dampening long when long is already at 45).
  let long  = preLong;
  let short = preShort;

  const noContinuation = !latestPatternCode
    || !continuationCodes.has(latestPatternCode);

  // 7a. FA state + bearish structure: was -18, now -10. And only when
  // pressure actually leans long against the bearish read.
  if (aiState?.stateCode === 'FA'
      && dominance.endsWith('bearish')
      && preLong > 55) {
    long  -= 10;
    short += 10;
    reasons.push('penalty: FA state + bearish structure (-10 long)');
  }

  // 7b. Repeated FA chain + LH+LL: was -12, now -6.
  if (faChain && priceStructure?.structure === 'Bearish' && preLong > 55) {
    long  -= 6;
    short += 6;
    reasons.push('penalty: repeated FA chain + LH/LL (-6 long)');
  }

  // 7c. Negative slope + no continuation + bearish structure: was
  // -10, now -5.
  if (slope < -SLOPE_NUDGE
      && noContinuation
      && priceStructure?.structure === 'Bearish'
      && preLong > 55) {
    long  -= 5;
    short += 5;
    reasons.push('penalty: negative slope + no continuation + bearish structure (-5 long)');
  }

  // 7d. Gold-trend dampeners — raised threshold from 65 to 70 so they
  // only kick in when pressure is materially against gold. Halfway
  // pullback toward 70 (not 65), so the cap effect is much milder.
  if (goldTrend === 'down' && long > 70) {
    const overshoot = long - 70;
    long  -= overshoot * 0.5;
    short = 100 - long;
    reasons.push(`penalty: gold-down dampener (long → ${Math.round(long)})`);
  }
  if (goldTrend === 'up' && short > 70) {
    const overshoot = short - 70;
    short -= overshoot * 0.5;
    long  = 100 - short;
    reasons.push(`penalty: gold-up dampener (short → ${Math.round(short)})`);
  }

  // ── 8. NEW v13.1.1: structural amplification ───────────────────
  //
  // When dominance AGREES with the existing pressure lean, push the
  // pressure further toward that side. The pre-v13.1.1 system only
  // suppressed contradictions — it never rewarded confirmation, so a
  // 60/40 lean stayed 60/40 no matter how much structural evidence
  // piled on. v13.1.1 amplifies up to the natural expressive ranges:
  //   weak     45-55    no amplification
  //   moderate 60-40    +5 boost
  //   strong   70-30    +10 boost (score |≥| 60)
  //   extreme  80-20    +15 boost (score |≥| 80 + faChain reclaim /
  //                                strong structure agreement)

  // 8a. Bullish dominance + long already leans: boost.
  if ((dominance === 'bullish' || dominance === 'fragile_bullish')
      && preLong >= 50) {
    let boost = 0;
    if (score >= 80) boost = 15;
    else if (score >= 60) boost = 10;
    else if (score >= 40) boost =  5;
    else if (score >= 20) boost =  3;
    if (boost > 0) {
      long  += boost;
      short -= boost;
      reasons.push(`amplify: bullish dominance (+${boost} long)`);
    }
  }
  // 8b. Bearish dominance + short already leans: boost.
  if ((dominance === 'bearish' || dominance === 'fragile_bearish')
      && preShort >= 50) {
    let boost = 0;
    if (score <= -80) boost = 15;
    else if (score <= -60) boost = 10;
    else if (score <= -40) boost =  5;
    else if (score <= -20) boost =  3;
    if (boost > 0) {
      short += boost;
      long  -= boost;
      reasons.push(`amplify: bearish dominance (+${boost} short)`);
    }
  }

  // ── 9. Sanity guard — tiered, much softer in v13.1.1 ───────────
  //
  // Pre-v13.1.1 the guard fired on dominance + skew alone and reset
  // to 58/42 — a 12-pt forced move that crushed expressiveness.
  // v13.1.1 only fires when MULTIPLE converging signals point the
  // same way:
  //
  //   sev = count({
  //     score |>=| 60                 — extreme dominance
  //     faChain                       — repeated FA evidence
  //     clean structure agreeing      — confidence ≥ 0.6 + matching
  //     extreme skew against          — pressure > 75 vs dominance
  //   })
  //
  //   sev >= 3 → hard cap  65/35  (still less harsh than the old 58/42)
  //   sev == 2 → soft cap  70/30
  //   sev <= 1 → no cap (penalties + amplification do the work)

  const cleanStruct =
    !!(priceStructure
      && priceStructure.confidence >= 0.6
      && priceStructure.structure !== 'Unclear');
  const reclaim = reclaimedAfterFA(recentHistory);

  if (args.runSanityGuard !== false) {
    const guard = applyStructuralSanityGuard({
      dominance, score,
      currentPressure: { long, short },
      faChain, reclaim,
      structureClean: cleanStruct,
      priceStructure,
    });
    long  = guard.long;
    short = guard.short;
    reasons.push(...guard.reasons);
  }

  // Final clamp + integerise. Range is 15..85 — the natural expressive
  // band the v13.1 spec calls for; the dominance pass can no longer
  // drag everything into the 48-52 dead zone.
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
    faChain,
    reclaim,
    structureClean: cleanStruct,
  };
}

// ──────────────────────────────────────────────────────────────────
// v13.2: standalone sanity-guard step.
//
// Extracted out of deriveStructuralDominance so the new
// lib/temporalPressure layer can run BETWEEN the structural pass and
// the final sanity guard, exactly per the v13.2 pipeline spec:
//
//   dominance (penalties + amp, NO sanity)
//   → temporalPressure
//   → applyStructuralSanityGuard
//   → setState
//
// Logic identical to the v13.1.1 in-line block: tiered severity
// counter, hard cap at 65/35 on sev>=3, soft cap at 70/30 on sev==2
// only when skew > 75 against dominance, NO cap on sev<=1.
// ──────────────────────────────────────────────────────────────────

export interface SanityGuardArgs {
  dominance:      StructuralDominance;
  score:          number;
  currentPressure: { long: number; short: number };
  faChain:        boolean;
  reclaim:        boolean;
  structureClean: boolean;
  priceStructure: StructureRead | null | undefined;
}

export interface SanityGuardResult {
  long:    number;
  short:   number;
  reasons: string[];
}

export function applyStructuralSanityGuard(
  args: SanityGuardArgs,
): SanityGuardResult {
  let { long, short } = args.currentPressure;
  const reasons: string[] = [];
  const { dominance, score, faChain, reclaim, structureClean, priceStructure } = args;

  const structAgreesBearish = structureClean
    && priceStructure!.structure === 'Bearish';
  const structAgreesBullish = structureClean
    && priceStructure!.structure === 'Bullish';

  if (dominance === 'bearish' || dominance === 'fragile_bearish') {
    let sev = 0;
    if (score <= -60)        sev++;
    if (faChain)             sev++;
    if (structAgreesBearish) sev++;
    if (long > 75)           sev++;
    if (sev >= 3) {
      long = 65; short = 35;
      reasons.push(`sanity: bearish triple-trigger (sev=${sev}) → 65/35`);
    } else if (sev === 2 && long > 75) {
      long = 70; short = 30;
      reasons.push(`sanity: bearish double-trigger (sev=2) → 70/30`);
    }
  }
  if (dominance === 'bullish' || dominance === 'fragile_bullish') {
    let sev = 0;
    if (score >=  60)        sev++;
    if (reclaim)             sev++;
    if (structAgreesBullish) sev++;
    if (short > 75)          sev++;
    if (sev >= 3) {
      short = 65; long = 35;
      reasons.push(`sanity: bullish triple-trigger (sev=${sev}) → 35/65`);
    } else if (sev === 2 && short > 75) {
      short = 70; long = 30;
      reasons.push(`sanity: bullish double-trigger (sev=2) → 30/70`);
    }
  }

  return { long, short, reasons };
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
