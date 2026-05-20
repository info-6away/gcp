// v17.0 — Phase 17: Research sample-confidence badge.
//
// Small reliability cue used across every Research card. "AT: +1.2%
// n=1" is dangerous — one observation is noise, not evidence. The
// badge gives the user a single-glance signal of how much to trust
// the row's average return.

export type SampleConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

const THRESHOLDS = {
  /** Up to this count → LOW. */
  low:    10,
  /** Up to this count → MEDIUM (≥ this is HIGH). */
  medium: 30,
};

export const SAMPLE_COLOR: Record<SampleConfidence, string> = {
  LOW:    '#c45a5a',   // red — treat the average as noise
  MEDIUM: '#d4a028',   // amber — directional but small
  HIGH:   '#22c55e',   // green — statistically meaningful for trading
};

export function sampleConfidence(n: number): SampleConfidence {
  if (n < THRESHOLDS.low)    return 'LOW';
  if (n < THRESHOLDS.medium) return 'MEDIUM';
  return 'HIGH';
}
