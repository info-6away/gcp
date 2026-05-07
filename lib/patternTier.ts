// v11.34: pattern visual hierarchy tiers (state-intelligence pass).
//
// Visual hierarchy ONLY — no filtering / no detector change.
// The chart shows every detected pattern; tiers govern HOW LOUDLY
// each one renders. Goal: state-driving patterns (FA / SJ / CR /
// DSE / AL / dominant story driver) read as headline events;
// structural support (PT / CC / SP / PD / DB) reads as context;
// repeated low-PSS support and decayed shocks fade to background.
//
// Inputs: a Pattern, the dominant pattern kind from the current
// patternStory (when available), and a few timeline flags so we can
// fade older shocks once newer structure has formed.

import type { Pattern, PatternKind } from '@/types/gcp';

export type PatternTier = 1 | 2 | 3;

// Tier 1 — state-driving patterns. Always loud unless explicitly
// downgraded by the dominant-pattern override below.
const TIER1_KINDS: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Failed Alignment',
  'Shock Jump',
  'Coherence Volcano',
  'Discharge Wave',
  'Double Spike Exhaustion',
  'Compression Release',
  'Alignment Ladder',
  'Discharge Break',
]);

// Tier 2 — structural support. Useful context, but should read
// dimmer than Tier 1.
const TIER2_KINDS: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Pulse Train',
  'Compression Coil',
  'Synchronization Plateau',
  'Plateau Decay',
  'Ignition Rise',
  'Staircase Alignment',
]);

const SHOCK_KINDS: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Shock Jump',
  'Coherence Volcano',
  'Double Spike Exhaustion',
  'Discharge Wave',
]);

// Structure-formed kinds that signal "market moved on after the
// shock" — used to demote older shocks from Tier 1 to Tier 2.
const STRUCTURE_AFTER_SHOCK: ReadonlySet<PatternKind> = new Set<PatternKind>([
  'Compression Coil', 'Compression Release', 'Pulse Train',
  'Alignment Ladder', 'Failed Alignment', 'Synchronization Plateau',
]);

export function isShockKind(k: PatternKind): boolean {
  return SHOCK_KINDS.has(k);
}

export interface PatternTimelineContext {
  /** chronologically latest shock pattern in the visible window, if any */
  latestShockTs:    number | null;
  /** newer non-shock structure pattern exists after the latest shock */
  hasNewerStructure: boolean;
}

// Walk the visible patterns once to derive shock timeline context so
// the per-marker tier function can stay O(1).
export function buildTimelineContext(patterns: Pattern[]): PatternTimelineContext {
  let latestShockTs: number | null = null;
  for (const p of patterns) {
    if (SHOCK_KINDS.has(p.kind) && (latestShockTs == null || p.tStart > latestShockTs)) {
      latestShockTs = p.tStart;
    }
  }
  if (latestShockTs == null) return { latestShockTs, hasNewerStructure: false };
  const hasNewerStructure = patterns.some(p =>
    p.tStart > (latestShockTs as number) && STRUCTURE_AFTER_SHOCK.has(p.kind),
  );
  return { latestShockTs, hasNewerStructure };
}

export interface TierInputs {
  pattern:       Pattern;
  /** dominantPattern from derivePatternStory(...) (null if no story) */
  dominantKind?: PatternKind | null;
  timeline?:     PatternTimelineContext;
}

// v11.34: tier resolver. Order:
//
//   1. Hidden visibility   → tier 3 (caller should usually skip
//                                    these entirely; included so
//                                    debug renderers can show them
//                                    as background dots).
//   2. Dominant pattern     → tier 1 (always loud — this is the
//                                    pattern that defines the
//                                    current state).
//   3. Decayed shock        → tier 2 (older shock with newer
//                                    structure formed since).
//   4. Tier1/Tier2 kind set → static class.
//   5. Catch-all            → tier 3.
export function getPatternVisualTier(input: TierInputs): PatternTier {
  const { pattern, dominantKind, timeline } = input;

  if (pattern.visibility === 'hidden') return 3;

  if (dominantKind && pattern.kind === dominantKind) return 1;

  if (timeline && SHOCK_KINDS.has(pattern.kind) && timeline.latestShockTs != null) {
    const isThisLatest = pattern.tStart >= timeline.latestShockTs;
    if (!isThisLatest && timeline.hasNewerStructure) return 2;
  }

  // Repeated low-PSS support → tier 3 (background dot).
  if (TIER2_KINDS.has(pattern.kind) && (pattern.strength ?? pattern.pss ?? 0) < 0.50) {
    return 3;
  }

  if (TIER1_KINDS.has(pattern.kind)) return 1;
  if (TIER2_KINDS.has(pattern.kind)) return 2;
  return 3;
}

// Marker visuals derived from tier, returned in LW Charts-friendly
// shape so ChartView can plug them straight into a SeriesMarker.
export interface TierVisuals {
  /** alpha hex suffix (`ff` / `99` / `52`) appended to base hex */
  alphaHex:    string;
  /** numeric alpha 0..1 — for fill / overlay maths */
  alpha:       number;
  /** marker size to pass to LW Charts SeriesMarker.size */
  size:        number;
  /** whether to render the abbreviation text (tier 3 = dot only) */
  showLabel:   boolean;
}

export function tierVisuals(tier: PatternTier): TierVisuals {
  switch (tier) {
    case 1: return { alphaHex: 'ff', alpha: 1.0,  size: 1,    showLabel: true  };
    case 2: return { alphaHex: '99', alpha: 0.6,  size: 0.7,  showLabel: true  };
    case 3: return { alphaHex: '52', alpha: 0.32, size: 0.45, showLabel: false };
  }
}
