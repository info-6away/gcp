// v11.25.6: pattern story engine v1.
//
// Deterministic interpreter that turns the last few resolved patterns
// into a one-paragraph narrative + a posture suggestion + an
// activeCycle tag. NOT an AI call — pure rule mapping over the
// (already-resolved, already-visible) pattern stream.
//
// Why deterministic: the Patterns tab is now the *explainability*
// surface. The story must be reproducible and inspectable; an LLM
// would add latency, cost, and surface area to debug. The trade is
// that the story has a small fixed vocabulary; new branches need a
// code change. That's fine — the rules below cover every documented
// lifecycle.
//
// Priority order (most specific / highest-impact first):
//   shock      — SJ / CV / DSE / DW present
//   plateau    — DB or DD (active discharge) > PD > SP
//   alignment  — FA latest or present > AL
//   compression — CR > CC+PT > CC
//   none       — fallback when nothing dominant fires

import type { Pattern, PatternKind } from '@/types/gcp';
import { PATTERN_CODE } from '@/lib/patterns-meta';

export type PatternCycle = 'compression' | 'plateau' | 'shock' | 'alignment' | 'none';

export interface PatternStory {
  /** patternCode chain for the last N patterns (oldest → newest) */
  sequence:        string[];
  title:           string;
  interpretation:  string;
  posture:         string;
  activeCycle:     PatternCycle;
}

export interface DeriveStoryArgs {
  patterns: Pattern[];
  /** kept for future heuristics; reads from this in v2 */
  aiState?: { stateCode?: string; phase?: string; direction?: string } | null;
  regime?:  string | null;
  pss?:     number | null;
}

const SEQ_DEPTH = 5;

const FALLBACK: PatternStory = {
  sequence:       [],
  title:          'No dominant story',
  interpretation: 'Current patterns are mixed or weak.',
  posture:        'Use AI State and price structure for context.',
  activeCycle:    'none',
};

export function derivePatternStory(args: DeriveStoryArgs): PatternStory {
  const { patterns } = args;
  if (!patterns || patterns.length === 0) {
    return { ...FALLBACK, sequence: [] };
  }

  const sorted = [...patterns].sort((a, b) => a.tStart - b.tStart);
  const tail   = sorted.slice(-SEQ_DEPTH);
  const codes  = tail.map(p => PATTERN_CODE[p.kind] ?? p.kind);
  const latest = tail[tail.length - 1];
  const set    = new Set(codes);

  // Shock / exhaustion — overrides all other cycles.
  if (set.has('SJ') || set.has('CV') || set.has('DSE') || set.has('DW')) {
    return {
      sequence:       codes,
      title:          'Shock / exhaustion',
      interpretation: 'Abrupt coherence event detected. Volatility and reversal risk elevated.',
      posture:        'Reduce size; wait for stabilization.',
      activeCycle:    'shock',
    };
  }

  // Plateau cycle. Most-progressed phase wins (discharge active >
  // decaying > forming) so the title reflects where we are in the chain.
  if (set.has('DB') || set.has('DD')) {
    return {
      sequence:       codes,
      title:          'Discharge active',
      interpretation: 'Stored coherence is releasing or drifting out. Late continuation risk rises.',
      posture:        'Manage risk; avoid late chase.',
      activeCycle:    'plateau',
    };
  }
  if (set.has('PD')) {
    return {
      sequence:       codes,
      title:          'Plateau decaying',
      interpretation: 'Coherence plateau is weakening without confirmed release.',
      posture:        'Reduce conviction; watch for discharge break.',
      activeCycle:    'plateau',
    };
  }
  if (set.has('SP')) {
    return {
      sequence:       codes,
      title:          'Plateau forming',
      interpretation: 'High coherence is holding, but release direction is not confirmed.',
      posture:        'Wait for decay or breakout.',
      activeCycle:    'plateau',
    };
  }

  // Alignment cycle. FA latest beats FA-anywhere because a recent
  // failure is more material than a historical one.
  if (latest && latest.kind === 'Failed Alignment') {
    return {
      sequence:       codes,
      title:          'Failed alignment',
      interpretation: 'Sync attempt failed. Continuation quality weakened; reversal/fade risk rising.',
      posture:        'Avoid chasing.',
      activeCycle:    'alignment',
    };
  }
  if (set.has('FA')) {
    return {
      sequence:       codes,
      title:          'Failed alignment',
      interpretation: 'Recent sync attempt failed. Continuation quality weakened.',
      posture:        'Avoid chasing.',
      activeCycle:    'alignment',
    };
  }
  if (set.has('AL')) {
    return {
      sequence:       codes,
      title:          'Alignment attempt',
      interpretation: 'Coherence is trying to organize into trend structure.',
      posture:        'Watch for price confirmation.',
      activeCycle:    'alignment',
    };
  }

  // Compression cycle.
  if (set.has('CR')) {
    return {
      sequence:       codes,
      title:          'Compression released',
      interpretation: 'Coil released. Watch for continuation confirmation versus failed breakout.',
      posture:        'Follow confirmation only.',
      activeCycle:    'compression',
    };
  }
  if (set.has('CC') && set.has('PT')) {
    return {
      sequence:       codes,
      title:          'Pressure building',
      interpretation: 'Repeated pulses inside compression. Energy is building but not yet accepted by alignment.',
      posture:        'Prepare; wait for trigger.',
      activeCycle:    'compression',
    };
  }
  if (set.has('CC')) {
    return {
      sequence:       codes,
      title:          'Compression building',
      interpretation: 'Energy accumulating without release. Breakout risk rising, but direction unresolved.',
      posture:        'Wait for clean break; avoid guessing direction.',
      activeCycle:    'compression',
    };
  }

  return { ...FALLBACK, sequence: codes };
}

// --------------------------- Per-pattern "WHEN IT MATTERS" ---------------------------
//
// One short sentence per kind, displayed under the card meaning. Tells
// the user the *use case* — when this pattern should pull their
// attention vs. just being a tag on the chart.

export const PATTERN_WHEN_IT_MATTERS: Record<PatternKind, string> = {
  'Compression Coil':         'Before a breakout; direction still unresolved.',
  'Compression Release':      'When stored energy starts moving into alignment.',
  'Alignment Ladder':         'When sync builds step-by-step with price confirmation.',
  'Failed Alignment':         'When a breakout/continuation attempt fails.',
  'Pulse Train':              'When repeated low/mid pulses show pressure building.',
  'Coherence Volcano':        'When a sharp spike mean-reverts quickly.',
  'Shock Jump':               'When a sudden shock spike rapidly retraces.',
  'Plateau Decay':            'When high coherence starts weakening before release.',
  'Discharge Break':          'When elevated coherence breaks down decisively.',
  'Dead Drift':               'When energy drains gradually through lower highs.',
  'Synchronization Plateau':  'When high coherence holds in the trend zone.',
  'Discharge Wave':           'When a climax burst quickly collapses.',
  'Double Spike Exhaustion':  'When two equal spikes mark the end of a move.',
  'Ignition Drift':           'When ignition energy oscillates without committing.',
  'Ignition Rise':            'When a coil starts releasing upward toward alignment.',
  'Staircase Alignment':      'When sync builds quietly through stepwise rises.',
  'Echo Spike':               'When a smaller follow-up spike confirms exhaustion of the first.',
};

// --------------------------- Cycle ↔ lifecycle-map row mapping ---------------------------
//
// LifecycleMap renders three chains; this mapping ties activeCycle to
// the matching chain title so the renderer can highlight one row.
// Alignment patterns (AL / FA) live in the compression chain since
// they sit at the tail of CC → CR → AL → FA.
export const CYCLE_TO_CHAIN: Record<PatternCycle, string | null> = {
  compression: 'Compression cycle',
  alignment:   'Compression cycle',
  plateau:     'Plateau cycle',
  shock:       'Shock / exhaustion events',
  none:        null,
};

// --------------------------- Dominant pattern picker ---------------------------
//
// "Dominant" = the pattern the user's eye should land on in the active
// grid. Latest primary-visibility wins; fallback is highest strength.
// Returns null when there's nothing dominant (empty active list).
export function pickDominantKind(patterns: Pattern[]): PatternKind | null {
  if (!patterns || patterns.length === 0) return null;

  const primary = patterns.filter(p => p.visibility === 'primary');
  const pool    = primary.length > 0 ? primary : patterns;

  // Sort by recency (newest first); within same tStart, highest strength.
  const ranked = [...pool].sort((a, b) => {
    if (b.tStart !== a.tStart) return b.tStart - a.tStart;
    return (b.strength ?? 0) - (a.strength ?? 0);
  });
  return ranked[0]?.kind ?? null;
}
