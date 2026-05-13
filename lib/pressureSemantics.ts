// v13.4: Semantic separation of structure vs pressure.
//
// Pure derivation helpers. Three values surfaced to the UI:
//
//   • Pressure Driver  — short copy explaining WHY pressure is what
//                        it is. Reads as "X favoring Y pressure".
//   • Alignment        — whether structure and pressure point the
//                        same way (aligned / diverging / unclear).
//   • Trend Integrity  — whether the trend skeleton itself is
//                        intact / weakening / challenged / absent.
//
// IMPORTANT: this layer does NOT modify any pressure or dominance
// values. It only reads what was already computed and produces
// human-readable explanation copy + an alignment indicator. The
// system intentionally allows pressure and structure to disagree
// (late-phase fade, ignition rebound against bearish structure,
// etc.) — these helpers exist to make the disagreement READ as
// intentional rather than as a bug.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { StructuralDominance } from '@/lib/structuralDominance';

// ──────────────────────────────────────────────────────────────────
// 1. Pressure driver
// ──────────────────────────────────────────────────────────────────

/**
 * One-line explanation for WHY the pressure values are what they
 * are. Reads downstream from state + dominance + momentum + the
 * existing pressureExplanation; the result is more specific than
 * the raw explanation copy.
 */
export function derivePressureDriver(
  aiState: GcpStateResponse | null,
): string | null {
  if (!aiState) return null;

  const code      = aiState.stateCode;
  const phase     = aiState.phase;
  const direction = aiState.direction;
  const dom       = aiState.structureDominance;
  const inherited = aiState.inheritedTrend;
  const momentum  = aiState.momentumState;
  const long      = aiState.longPressure  ?? 50;
  const short     = aiState.shortPressure ?? 50;

  // 1. State-specific drivers — these phrasings encode WHY the state
  // itself produces the pressure shape it does.
  if (code === 'PS') return 'Plateau exhaustion detected — coherence has matured into fade pressure';
  if (code === 'DC') {
    if (inherited === 'up')   return 'Coherence decay against prior bullish trend';
    if (inherited === 'down') return 'Coherence decay against prior bearish trend';
    return 'Coherence decay — directional energy weakening';
  }
  if (code === 'CL') {
    if (inherited === 'up')   return 'Climax exhaustion against bullish excess';
    if (inherited === 'down') return 'Climax exhaustion against bearish excess';
    return 'Climax exhaustion detected';
  }
  if (code === 'DS') {
    if (inherited === 'up')   return 'Discharge after bullish rally — rebound risk shifting short';
    if (inherited === 'down') return 'Discharge after bearish collapse — rebound risk shifting long';
    return 'Discharge of prior trend energy';
  }
  if (code === 'FA') {
    return 'Failed alignment chain suppressing continuation';
  }
  if (code === 'SH') {
    return 'Shock event — directional reads unreliable until volatility settles';
  }

  // 2. Phase-aware exhaustion for AT / SS.
  if ((code === 'AT' || code === 'SS')
      && (phase === 'Late' || phase === 'Exhausted')) {
    if (direction === 'Up')   return `Late bullish synchronization fading`;
    if (direction === 'Down') return `Late bearish synchronization fading`;
    return 'Late-phase synchronization fading';
  }

  // 3. Structure-vs-pressure divergence — read directly from current
  // pressure skew + dominance label.
  const pressureDir =
    long  >= 55 ? 'long'
  : short >= 55 ? 'short'
  :                'flat';
  if (dom === 'bullish' && pressureDir === 'short') {
    return 'Momentum divergence against bullish structure';
  }
  if (dom === 'bearish' && pressureDir === 'long') {
    return 'Momentum divergence against bearish structure';
  }
  if (dom === 'fragile_bullish' && pressureDir === 'short') {
    return 'Bullish structure weakening under fade pressure';
  }
  if (dom === 'fragile_bearish' && pressureDir === 'long') {
    return 'Bearish structure challenged by rebound pressure';
  }

  // 4. Momentum-class flavoring for the common aligned cases.
  if (momentum === 'accelerating') {
    if (inherited === 'up')   return 'Bullish acceleration — pressure reinforced';
    if (inherited === 'down') return 'Bearish acceleration — pressure reinforced';
  }

  // 5. Fallback to the existing pressureExplanation copy if nothing
  //    more specific applies — keeps the line meaningful on early
  //    classifications before all signals have stabilised.
  return aiState.pressureExplanation ?? null;
}

// ──────────────────────────────────────────────────────────────────
// 2. Alignment indicator
// ──────────────────────────────────────────────────────────────────

export type AlignmentStatus = 'aligned' | 'diverging' | 'unclear';

export interface AlignmentRead {
  status: AlignmentStatus;
  /** One-line summary suitable for direct render. */
  label:  string;
  /** Hex color (or var) matching the v13.4 palette: cyan/green for
   *  aligned, amber/red for diverging, grey for unclear. */
  color:  string;
}

export function deriveAlignment(
  aiState: GcpStateResponse | null,
): AlignmentRead {
  if (!aiState) {
    return { status: 'unclear', color: 'var(--fg-3)',
             label:  'Awaiting Guru read.' };
  }

  const dom   = aiState.structureDominance;
  const long  = aiState.longPressure  ?? 50;
  const short = aiState.shortPressure ?? 50;

  const structDir =
    dom === 'bullish' || dom === 'fragile_bullish' ? 'bull'
  : dom === 'bearish' || dom === 'fragile_bearish' ? 'bear'
  :                                                   'flat';
  const pressureDir =
    long  >= 55 ? 'bull'
  : short >= 55 ? 'bear'
  :                'flat';

  // Aligned — both point the same way.
  if (structDir === 'bull' && pressureDir === 'bull') {
    return { status: 'aligned', color: '#22c55e',
             label: 'Structure + pressure aligned bullish' };
  }
  if (structDir === 'bear' && pressureDir === 'bear') {
    return { status: 'aligned', color: '#22c55e',
             label: 'Structure + pressure aligned bearish' };
  }

  // Hard divergence — opposite directions. The interesting case.
  if (structDir === 'bull' && pressureDir === 'bear') {
    return { status: 'diverging', color: '#d4a028',
             label: 'Bullish structure weakening under late-state fade pressure' };
  }
  if (structDir === 'bear' && pressureDir === 'bull') {
    return { status: 'diverging', color: '#d4a028',
             label: 'Bearish structure challenged by ignition rebound pressure' };
  }

  // One side flat — soft / unclear cases.
  if (structDir === 'flat' && pressureDir !== 'flat') {
    return { status: 'unclear', color: 'var(--fg-3)',
             label: `Structure neutral; pressure leaning ${pressureDir === 'bull' ? 'long' : 'short'}` };
  }
  if (pressureDir === 'flat' && structDir !== 'flat') {
    return { status: 'unclear', color: 'var(--fg-3)',
             label: `Structure ${structDir}ish; pressure undecided` };
  }

  return { status: 'unclear', color: 'var(--fg-3)',
           label: 'Structure + pressure both neutral' };
}

// ──────────────────────────────────────────────────────────────────
// 3. Trend integrity
// ──────────────────────────────────────────────────────────────────

export type TrendIntegrity = 'intact' | 'weakening' | 'challenged' | 'absent';

export interface TrendIntegrityRead {
  status: TrendIntegrity;
  label:  string;
  color:  string;
}

export function deriveTrendIntegrity(
  aiState: GcpStateResponse | null,
): TrendIntegrityRead {
  if (!aiState) {
    return { status: 'absent', color: 'var(--fg-3)', label: 'Unread' };
  }
  const dom       = aiState.structureDominance;
  const phase     = aiState.phase;
  const direction = aiState.direction;

  // Clean directional dominance → intact, unless the state itself is
  // in a late or exhausted phase (then weakening).
  if (dom === 'bullish' || dom === 'bearish') {
    if (phase === 'Late' || phase === 'Exhausted') {
      return { status: 'weakening', color: '#d4a028', label: 'Weakening' };
    }
    return { status: 'intact', color: '#22c55e', label: 'Intact' };
  }

  // Structural dominance disagreeing with state direction → challenged
  // (e.g. SS Up state but bearish structure). Checked BEFORE the
  // generic fragile case so the more specific label wins.
  if ((dom === 'fragile_bearish' && direction === 'Up')
   || (dom === 'fragile_bullish' && direction === 'Down')) {
    return { status: 'challenged', color: '#c45a5a', label: 'Challenged' };
  }

  // Any other fragile_* → weakening.
  if (dom === 'fragile_bullish' || dom === 'fragile_bearish') {
    return { status: 'weakening', color: '#d4a028', label: 'Weakening' };
  }

  return { status: 'absent', color: 'var(--fg-3)', label: 'Absent / range' };
}

// Convenience re-export so consumers don't need to import from two files.
export type { StructuralDominance };
