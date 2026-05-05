// v11.25.6: pattern story engine v1.
// v11.25.7: pattern story engine v2 — sequence-aware reasoning.
//
// Deterministic interpreter that turns the recent resolved-pattern
// stream into a structured 5-row read:
//   STATE      — the dominant phase (Failed alignment / Discharge / …)
//   STRUCTURE  — sequence-aware narration of how we got here
//   RISK       — what failure looks like from this point
//   BIAS       — bullish / bearish / neutral
//   POSTURE    — concrete action stance
// Plus activeCycle (for the lifecycle-map highlight) and
// dominantPattern (the pattern that defines STATE — used to drive the
// DOMINANT badge in the active grid).
//
// NOT an AI call. Pure rule mapping over the (already resolved,
// already visible) pattern stream so the story is reproducible and
// auditable.
//
// Priority order (highest-impact first):
//   shock      — SJ / CV / DSE / DW present in last 5,
//                AND (it's the latest OR no newer CC/CR/AL/FA followed)
//   post-shock — same shock window, BUT a newer CC/CR/AL/FA arrived
//                after it → state becomes "Post-shock recovery" with
//                the structure narrating what came next
//   alignment  — FA present in last 5  (overrides CR / AL)
//   plateau    — DB or DD in last 5 > PD > SP
//   alignment  — AL latest with no later FA
//   compression — CR latest > CC + PT > PT-only > CC
//
// "FA in last 5 overrides CR / AL" is the key sequence-aware rule:
// in `CR → FA → PT → CR → PT` the FA defines what just happened to
// the user even though it sits 4 patterns back, while CR / PT alone
// would mis-read the moment.
//
// v11.25.7-fix: similar adjustment for shock. A DW that happened 4
// patterns ago and was followed by CR / PT is no longer the user's
// current reality — they're in a recovery attempt. We carve that out
// as its own STATE so the narrative tracks the most recent
// structural pattern rather than freezing on the loudest historical
// event.

import type { Pattern, PatternKind } from '@/types/gcp';
import { PATTERN_CODE } from '@/lib/patterns-meta';

export type PatternCycle = 'compression' | 'plateau' | 'shock' | 'alignment' | 'none';
export type StoryBias    = 'bullish' | 'bearish' | 'neutral';

export interface PatternStory {
  /** patternCode chain for the last 5 patterns (oldest → newest) */
  sequence:        string[];
  state:           string;
  structure:       string;
  risk:            string;
  bias:            StoryBias;
  posture:         string;
  activeCycle:     PatternCycle;
  /**
   * The pattern that defines STATE — used by UI to place the
   * DOMINANT badge. Per spec:
   *   FA / DB / DD / SJ / CV / DSE / DW → always dominant when
   *     they fire STATE.
   *   CR → only dominant when no FA followed it.
   *   PT → only dominant when state is Pressure building (i.e.
   *     it is essentially alone in the sequence).
   */
  dominantPattern: PatternKind | null;
}

export interface DeriveStoryArgs {
  patterns: Pattern[];
  aiState?: { stateCode?: string; phase?: string; direction?: string } | null;
  regime?:  string | null;
  pss?:     number | null;
}

const SEQ_DEPTH = 5;

const FALLBACK: PatternStory = {
  sequence:        [],
  state:           'No dominant story',
  structure:       'Current patterns are mixed or weak.',
  risk:            'No clear edge from the pattern layer alone.',
  bias:            'neutral',
  posture:         'Use AI State and price structure for context.',
  activeCycle:     'none',
  dominantPattern: null,
};

// ---------- Helpers ----------

function codeOf(p: Pattern): string {
  return PATTERN_CODE[p.kind] ?? p.kind;
}

function biasFromDirection(dir: string | undefined | null): StoryBias {
  if (dir === 'Up')   return 'bullish';
  if (dir === 'Down') return 'bearish';
  return 'neutral';
}

// Search the sorted-ascending pattern list backwards and return the
// most recent pattern whose code is in `codes`. Used to pick the
// pattern that *defines* STATE.
function recentByCode(sorted: Pattern[], codes: string[]): Pattern | null {
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (codes.includes(codeOf(sorted[i]))) return sorted[i];
  }
  return null;
}

// Detect whether `target` ever occurs after `anchor` in the sorted
// list. Used to enforce "CR is dominant only when no FA followed it".
function occursAfter(sorted: Pattern[], anchorCode: string, targetCode: string): boolean {
  let pastAnchor = false;
  for (const p of sorted) {
    const c = codeOf(p);
    if (!pastAnchor) {
      if (c === anchorCode) pastAnchor = true;
      continue;
    }
    if (c === targetCode) return true;
  }
  return false;
}

// ---------- STRUCTURE narration ----------
//
// Sequence-aware text per state. Reads from the last 5 codes, with
// last 3 as the "current" window. Order matters — most-specific
// branches come first so the spec example outputs are produced
// verbatim.

// v11.25.7-fix: post-shock structure narration. Reads only the codes
// AFTER the most recent shock so the sentence reflects what's
// actually happening now, not the shock itself. `postShock` is the
// list of codes that occurred strictly after the shock event.
function postShockStructure(postShock: string[]): string {
  if (!postShock.length)                                     return 'Shock event followed by mixed structure';
  if (postShock.includes('FA'))                              return 'Shock event followed by failed alignment attempt';
  if (postShock.includes('CR') && postShock.includes('AL'))  return 'Shock event followed by compression release and alignment attempt';
  if (postShock.includes('AL'))                              return 'Shock event followed by alignment attempt';
  if (postShock.includes('CR') && postShock.includes('PT'))  return 'Shock event followed by compression release; recovery attempt forming';
  if (postShock.includes('CR'))                              return 'Shock event followed by compression release';
  if (postShock.includes('CC') && postShock.includes('PT'))  return 'Shock event followed by re-compression with pulse pressure';
  if (postShock.includes('CC'))                              return 'Shock event followed by re-compression';
  // v11.26.2: PT-only post-shock counts as structure rebuilding now.
  if (postShock.includes('PT'))                              return 'Shock event followed by pulse-train; pressure rebuilding';
  return 'Shock event followed by structural rebuild';
}

function structureFor(state: string, last5: string[], last3: string[]): string {
  const has5 = (c: string) => last5.includes(c);
  const has3 = (c: string) => last3.includes(c);
  const eq3  = (...codes: string[]) => last3.length === 3 && last3.every((c, i) => c === codes[i]);

  switch (state) {
    case 'Shock / exhaustion':
      return 'Abrupt spike followed by instability or reversal';

    case 'Post-shock recovery':
      // Sequence-aware narration is built by postShockStructure() at
      // the call site (it needs the post-shock slice, not last3/last5)
      // — fall through to a safe default if reached without that.
      return 'Shock event followed by structural rebuild';

    case 'Failed alignment':
      if (eq3('AL', 'FA') || (last3.at(-1) === 'FA' && last3.at(-2) === 'AL')) {
        return 'Trend attempt collapsed after initial acceptance';
      }
      if (has5('CR') && has5('PT') && has5('FA')) {
        return 'Release attempt failed, followed by weak pulse structure and reattempt forming';
      }
      if (has3('PT') && has5('FA')) {
        return 'Sync attempt failed; pulse pressure rebuilding';
      }
      return 'Recent sync attempt failed';

    case 'Discharge phase':
      if (has5('SP') && has5('PD') && has5('DB')) {
        return 'Plateau weakened and broke; energy releasing from elevated levels';
      }
      if (has3('PD') && has3('DB')) {
        return 'Plateau decay confirmed; discharge in progress';
      }
      if (has3('DB')) return 'Coherence broke down decisively';
      return 'Energy draining gradually through lower highs';

    case 'Plateau decaying':
      return 'Coherence plateau weakening without confirmed release';

    case 'Plateau forming':
      return 'High coherence holding; release direction undefined';

    case 'Alignment forming':
      if (eq3('CC', 'CR', 'AL')) {
        return 'Compression released and transitioning into structured trend';
      }
      if (has3('CR') && has3('AL')) {
        return 'Coil released and beginning to organise into trend';
      }
      return 'Coherence organising into trend structure';

    case 'Compression released':
      return 'Coil released; awaiting continuation confirmation versus failed breakout';

    case 'Pressure building': {
      const ptCount = last3.filter(c => c === 'PT').length;
      if (ptCount >= 3) return 'Repeated low/mid pulses without alignment acceptance';
      if (has3('CC') && has3('PT')) {
        return 'Repeated pulses inside compression; energy building without acceptance';
      }
      return 'Indicates unresolved pressure building without alignment acceptance';
    }

    case 'Compression building':
      return 'Energy accumulating without release';

    default:
      return 'Mixed signals — no dominant structure';
  }
}

// ---------- RISK + POSTURE per state ----------

const RISK_BY_STATE: Record<string, string> = {
  'Shock / exhaustion':   'High volatility; unpredictable follow-through',
  'Post-shock recovery':  'Recovery may not hold; volatility from prior shock still elevated',
  'Failed alignment':     'Continuation quality weak; repeated failure possible',
  'Discharge phase':      'Late continuation risk; exhaustion likely',
  'Plateau decaying':     'Discharge break building; conviction should fade',
  'Plateau forming':      'Direction undecided; either side possible',
  'Alignment forming':    'If alignment fails, reversal risk increases',
  'Compression released': 'Failed breakout possible if continuation does not confirm',
  'Pressure building':    'Breakout possible but direction unclear',
  'Compression building': 'Direction unresolved; breakout pending',
};

const POSTURE_BY_STATE: Record<string, string> = {
  'Shock / exhaustion':   'Reduce size; wait for stabilization',
  'Post-shock recovery':  'Treat as recovery; size cautiously until structure confirms',
  'Failed alignment':     'Avoid chasing; wait for confirmed breakout',
  'Discharge phase':      'Avoid chasing; manage exposure',
  'Plateau decaying':     'Reduce conviction; watch for discharge break',
  'Plateau forming':      'Wait for decay or breakout',
  'Alignment forming':    'Follow continuation only after confirmation',
  'Compression released': 'Follow confirmation only',
  'Pressure building':    'Prepare for breakout; do not pre-empt',
  'Compression building': 'Wait for clean break; avoid guessing direction',
};

// ---------- BIAS per state ----------
//
// Direction-based for alignment-forming and (modestly) for failed
// alignment + compression released. Discharge defaults to bearish.
// Everything else stays neutral until we add price-trend context.

function biasFor(state: string, dir: string | null | undefined): StoryBias {
  switch (state) {
    case 'Alignment forming':
    case 'Compression released':
      return biasFromDirection(dir);
    case 'Failed alignment':
      // Neutral by default; if the prior direction was Down, the
      // failed alignment leans bearish (failure downward).
      return dir === 'Down' ? 'bearish' : 'neutral';
    case 'Discharge phase':
      return 'bearish';
    case 'Shock / exhaustion':
    case 'Plateau decaying':
    case 'Plateau forming':
    case 'Pressure building':
    case 'Compression building':
    default:
      return 'neutral';
  }
}

// ---------- Cycle ↔ chain mapping (re-export for the UI) ----------

export const CYCLE_TO_CHAIN: Record<PatternCycle, string | null> = {
  compression: 'Compression cycle',
  alignment:   'Compression cycle',
  plateau:     'Plateau cycle',
  shock:       'Shock / exhaustion events',
  none:        null,
};

// ---------- Main entry point ----------

export function derivePatternStory(args: DeriveStoryArgs): PatternStory {
  const { patterns } = args;
  if (!patterns || patterns.length === 0) {
    return { ...FALLBACK, sequence: [] };
  }

  const sorted = [...patterns].sort((a, b) => a.tStart - b.tStart);
  const tail   = sorted.slice(-SEQ_DEPTH);
  const sequence = tail.map(codeOf);
  const last5 = sequence;
  const last3 = sequence.slice(-3);
  const dir   = args.aiState?.direction ?? null;

  // Pick the active cycle + state in spec priority order.

  // 1. Shock / exhaustion — recency-tightened in v11.26.2.
  //    Shock is an EVENT, not a lingering state. Allowed only when:
  //      (a) the shock pattern IS the latest visible pattern, OR
  //      (b) the shock is in the last 3 patterns AND no
  //          CC / CR / AL / FA / PT has occurred since.
  //    PT joins CC/CR/AL/FA as a "structure-formed" blocker because a
  //    pulse train after a shock means coherence is rebuilding —
  //    classifying that environment as still-shock contradicts what
  //    the user sees.
  const shockPat = recentByCode(sorted, ['SJ', 'CV', 'DSE', 'DW']);
  if (shockPat && last5.includes(codeOf(shockPat))) {
    const shockIdx     = sorted.lastIndexOf(shockPat);
    const postShockArr = sorted.slice(shockIdx + 1);
    const postCodes    = postShockArr.map(codeOf);
    const isShockLatest    = shockIdx === sorted.length - 1;
    const shockRecency     = sorted.length - shockIdx;        // 1 = latest, 2 = prev, …
    const isRecentShock    = shockRecency <= 3;
    const STRUCTURE_BLOCKERS = ['CC', 'CR', 'AL', 'FA', 'PT'] as const;
    const hasBlockerAfter  = postCodes.some(c =>
      (STRUCTURE_BLOCKERS as readonly string[]).includes(c));

    // Pure shock — only when latest, or recent + no blocker since.
    if (isShockLatest || (isRecentShock && !hasBlockerAfter)) {
      const state = 'Shock / exhaustion';
      return {
        sequence, state,
        structure: structureFor(state, last5, last3),
        risk:      RISK_BY_STATE[state],
        bias:      biasFor(state, dir),
        posture:   POSTURE_BY_STATE[state],
        activeCycle: 'shock',
        dominantPattern: shockPat.kind,
      };
    }

    // Post-shock recovery — recovery-flavoured blocker exists, no FA
    // afterwards (FA gets its own sharper branch). PT is now treated
    // as recovery-flavoured because a pulse-train after a shock is
    // exactly the "structure rebuilding" case this state is meant to
    // capture.
    const RECOVERY_FLAVOURED = ['CC', 'CR', 'AL', 'PT'] as const;
    const recoveryFlavoured = postCodes.some(c =>
      (RECOVERY_FLAVOURED as readonly string[]).includes(c));
    if (recoveryFlavoured && !postCodes.includes('FA')) {
      const state = 'Post-shock recovery';
      // Dominant pattern = the active recovery driver (latest
      // CC/CR/AL/PT after shock), not the historical event.
      const driverPat = recentByCode(postShockArr, ['AL', 'CR', 'CC', 'PT']);
      return {
        sequence, state,
        structure: postShockStructure(postCodes),
        risk:      RISK_BY_STATE[state],
        bias:      biasFor(state, dir),
        posture:   POSTURE_BY_STATE[state],
        activeCycle: 'compression',
        dominantPattern: driverPat?.kind ?? shockPat.kind,
      };
    }
    // Otherwise fall through — FA / DB / DD branches below will
    // produce a sharper read.
  }

  // 2. Failed alignment — FA anywhere in last 5 takes precedence over
  //    CR / AL because the failure event is what the user just lived
  //    through. Spec example A: CR → FA → PT → CR → PT reads as
  //    "Failed alignment", not "Compression released".
  const faPat = recentByCode(sorted, ['FA']);
  if (faPat && last5.includes('FA')) {
    const state = 'Failed alignment';
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'alignment',
      dominantPattern: faPat.kind,
    };
  }

  // 3. Plateau / discharge cycle.
  const dischargePat = recentByCode(sorted, ['DB', 'DD']);
  if (dischargePat && last5.includes(codeOf(dischargePat))) {
    const state = 'Discharge phase';
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'plateau',
      dominantPattern: dischargePat.kind,
    };
  }
  const pdPat = recentByCode(sorted, ['PD']);
  if (pdPat && last5.includes('PD')) {
    const state = 'Plateau decaying';
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'plateau',
      dominantPattern: pdPat.kind,
    };
  }
  const spPat = recentByCode(sorted, ['SP']);
  if (spPat && last5.includes('SP')) {
    const state = 'Plateau forming';
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'plateau',
      dominantPattern: spPat.kind,
    };
  }

  // 4. Alignment forming — AL latest, no FA after.
  if (last3.at(-1) === 'AL') {
    const state = 'Alignment forming';
    const alPat = recentByCode(sorted, ['AL']);
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'alignment',
      dominantPattern: alPat?.kind ?? null,
    };
  }

  // 5. Compression released — CR somewhere in last 5, no AL or FA
  //    after it (AL after CR was handled by the alignment branch
  //    above; FA after CR would have been caught at step 2).
  const crPat = recentByCode(sorted, ['CR']);
  if (crPat && last5.includes('CR') && !occursAfter(sorted, 'CR', 'AL')) {
    const state = 'Compression released';
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'compression',
      dominantPattern: crPat.kind,
    };
  }

  // 6. Pressure building — CC + PT, or PT-dominated tail.
  const ptCount3 = last3.filter(c => c === 'PT').length;
  if ((last3.includes('CC') && last3.includes('PT')) || ptCount3 >= 2) {
    const state = 'Pressure building';
    const ptPat = recentByCode(sorted, ['PT']);
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'compression',
      dominantPattern: ptPat?.kind ?? null,
    };
  }

  // 7. Compression building — CC alone.
  if (last5.includes('CC')) {
    const state = 'Compression building';
    const ccPat = recentByCode(sorted, ['CC']);
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'compression',
      dominantPattern: ccPat?.kind ?? null,
    };
  }

  // 8. Lone PT.
  if (last5.includes('PT')) {
    const state = 'Pressure building';
    const ptPat = recentByCode(sorted, ['PT']);
    return {
      sequence, state,
      structure: structureFor(state, last5, last3),
      risk:      RISK_BY_STATE[state],
      bias:      biasFor(state, dir),
      posture:   POSTURE_BY_STATE[state],
      activeCycle: 'compression',
      dominantPattern: ptPat?.kind ?? null,
    };
  }

  return { ...FALLBACK, sequence };
}

// --------------------------- Per-pattern "WHEN IT MATTERS" ---------------------------
//
// One short sentence per kind, displayed under the card meaning. Tells
// the user the *use case* — when this pattern should pull their
// attention vs. just being a tag on the chart.
//
// v11.25.7 PT update: replaces the old "Repeated low/mid pulses" copy
// with a clearer "unresolved pressure building" framing that matches
// the new STATE narration.

export const PATTERN_WHEN_IT_MATTERS: Record<PatternKind, string> = {
  'Compression Coil':         'Before a breakout; direction still unresolved.',
  'Compression Release':      'When stored energy starts moving into alignment.',
  'Alignment Ladder':         'When sync builds step-by-step with price confirmation.',
  'Failed Alignment':         'When a breakout/continuation attempt fails.',
  'Pulse Train':              'Indicates unresolved pressure building without alignment acceptance.',
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

// v11.25.6 -> v11.25.7: pickDominantKind kept for back-compat, but
// callers should prefer story.dominantPattern (the STATE-defining
// pattern). This helper now just delegates to the story so existing
// imports keep working.
export function pickDominantKind(patterns: Pattern[]): PatternKind | null {
  if (!patterns || patterns.length === 0) return null;
  return derivePatternStory({ patterns }).dominantPattern;
}
