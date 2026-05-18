// v14.6.1 — Phase 14.6.1: Field mood.
//
// The "coherence weather" line for the whole Radar scan — one
// atmospheric read derived from the action-state spread, the field
// dispersion level, and the dominant state. Pure derivation; no AI,
// no Engine, no recompute.

import type { DispersionLevel } from '@/lib/fieldDispersion';

export type FieldMoodSentiment =
  'opportunity' | 'defensive' | 'fragmented' | 'synchronized' | 'neutral';

export interface FieldMood {
  title:       string;
  description: string;
  sentiment:   FieldMoodSentiment;
}

export function deriveFieldMood(args: {
  ready:         number;
  watch:         number;
  blocked:       number;
  total:         number;
  dispersion:    DispersionLevel | null;
  dominantState: string | null;
}): FieldMood {
  const { ready, watch, blocked, total, dispersion } = args;

  if (total === 0) {
    return { title: 'Field idle', description: 'No scan yet.', sentiment: 'neutral' };
  }

  // A real opportunity spread dominates the read.
  if (ready >= 5) {
    return {
      title:       'Opportunity window opening',
      description: `${ready} symbols READY.`,
      sentiment:   'opportunity',
    };
  }

  // Broad blockage — defensive conditions.
  if (blocked >= 8) {
    return {
      title:       'Defensive market',
      description: 'Confirmations weak across the field.',
      sentiment:   'defensive',
    };
  }

  // Assets diverging — no shared read.
  if (dispersion === 'high' || dispersion === 'extreme') {
    return {
      title:       'Field highly fragmented',
      description: 'Assets diverging — no shared read.',
      sentiment:   'fragmented',
    };
  }

  // Unified field with readiness building.
  if ((dispersion === 'very_low' || dispersion === 'low') && (ready + watch) >= 3) {
    return {
      title:       'Field synchronized',
      description: 'Readiness expanding.',
      sentiment:   'synchronized',
    };
  }

  // Unified but quiet.
  if (dispersion === 'very_low' || dispersion === 'low') {
    return {
      title:       'Field unified',
      description: blocked >= total / 2
        ? 'Coherent — no entry edge yet.'
        : 'Coherent, low spread.',
      sentiment:   'synchronized',
    };
  }

  return {
    title:       'Mixed field',
    description: `${ready} ready · ${watch} watch · ${blocked} blocked.`,
    sentiment:   'neutral',
  };
}
