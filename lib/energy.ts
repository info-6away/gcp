// Energy metrics for the GCP Pro pattern detector.
// v11.2: split out from gcp-data.ts so the v11.3+ pattern logic can call
// these directly without re-deriving slope / curvature / etc. inline.
//
// All inputs are NV values (raw GCP Net Variance) ordered oldest -> newest.
// Pattern detection itself is untouched in this commit; the only consumer
// today is energyAt() in gcp-data.ts, which now delegates here.

// Linear regression slope of `values` against their index. Positive means
// rising coherence over the window, negative means fading.
export function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let k = 0; k < n; k++) {
    sx  += k;
    sy  += values[k];
    sxy += k * values[k];
    sxx += k * k;
  }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

// Average second difference of `values`. Positive curvature = slope is
// accelerating (alignment is taking hold); negative = slope is fading.
export function curvature(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  let c = 0;
  for (let k = 2; k < n; k++) {
    c += values[k] - 2 * values[k - 1] + values[k - 2];
  }
  return c / (n - 2);
}

// Coherence Energy Density: sum of |v[i] - v[i-1]| across the window.
// High CED inside a compression range = charged coil; low CED inside the
// same range = dead drift.
export function ced(values: number[]): number {
  let sum = 0;
  for (let k = 1; k < values.length; k++) {
    sum += Math.abs(values[k] - values[k - 1]);
  }
  return sum;
}

// Trailing run of bars whose value is <= maxV (default 60, the A/B
// regime ceiling). Counts how long the series has been "compressed"
// at the right edge of the window.
export function compressionDuration(values: number[], maxV: number = 60): number {
  let count = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] <= maxV) count++;
    else break;
  }
  return count;
}

// Width of the value range during the trailing compression run. Returns
// 0 if there is no current compression. Tighter range = stronger coil.
export function oscillationTightness(values: number[], maxV: number = 60): number {
  const dur = compressionDuration(values, maxV);
  if (dur < 2) return 0;
  const start = values.length - dur;
  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < values.length; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  return hi - lo;
}

export interface WindowMetrics {
  slope:                number;  // raw signed slope (NV per bar)
  curvature:            number;  // raw signed second difference
  ced:                  number;  // raw cumulative |Δ|
  compressionDuration:  number;  // bars (count) in trailing compression
  oscillationTightness: number;  // range width inside that compression
  pss:                  number;  // 0..1 composite Pattern Strength Score
}

// Pattern Strength Score, per spec §6.
//
// PSS = 0.35 * CompressionDurationScore
//     + 0.25 * OscillationTightnessScore
//     + 0.25 * EnergyDensityScore
//     + 0.15 * CurvatureScore
//
// Each subscore normalized to [0, 1] before weighting:
// - CompressionDuration: bars / 60 (1.0 once we have an hour of A/B)
// - OscillationTightness: 1 - range/60 (tighter range = higher score)
// - EnergyDensity: ced / 400 (clamps for 1 m bars; coarser TFs stay <1)
// - Curvature: |curv| / 0.5 (clamps; spec is silent on scale, this is
//   the value the previous inline calc used and keeps PSS comparable
//   to v11.1 numbers).
export function computePSS(m: Omit<WindowMetrics, 'pss'>): number {
  const compScore  = Math.min(1, m.compressionDuration / 60);
  const tightScore = m.compressionDuration >= 2
    ? Math.max(0, 1 - m.oscillationTightness / 60)
    : 0;
  const cedScore   = Math.min(1, m.ced / 400);
  const curvScore  = Math.min(1, Math.abs(m.curvature) / 0.5);
  const pss = 0.35 * compScore
            + 0.25 * tightScore
            + 0.25 * cedScore
            + 0.15 * curvScore;
  return Math.max(0, Math.min(1, pss));
}

// v11.24.2: thresholds + helper for the Discharge confirmation layer.
//
// The Discharge Break detector previously fired on regime-only logic
// ("D/E run ends with ≥60% A/B in the next few bars"), which produced
// a false positive every time a Synchronization Plateau (sustained D)
// flattened down through C → B without a real release. The
// confirmation layer requires at least 2 of 4 quantitative conditions
// to actually call it Discharge; otherwise the detector emits a
// softer "Plateau Decay" so the user sees that the plateau is fading
// without the misleading "discharge in progress" framing.
//
// Thresholds are tuned against the NV scale (0..~300) at 1m bars.
//   SLOPE_STRONG     = -1.5 NV/bar over the drop window
//                      (≈ -12 NV over 8 bars: a meaningful regime
//                      transition rather than a slow drift).
//   CURVATURE_SPIKE  = 0.50 (matches the |curv|/0.5 normalisation
//                      used by computePSS; values above this register
//                      as a real second-derivative event).
//   VOL_EXPANSION    = 1.30 (rolling std of the drop window must
//                      expand 30% versus the comparable pre-window).
//   STRUCTURE_LOOKBK = 20 bars (current value must break below the
//                      local min over this window).
export const DISCHARGE_SLOPE_STRONG    = 1.5;   // |slope| threshold
export const DISCHARGE_CURVATURE_SPIKE = 0.50;
export const DISCHARGE_VOL_EXPANSION   = 1.30;
export const DISCHARGE_STRUCTURE_LOOKBACK = 20;

function stdev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let sum = 0;
  for (const v of values) sum += (v - mean) * (v - mean);
  return Math.sqrt(sum / n);
}

export interface DischargeConfirmation {
  /** drop window's regression slope in NV/bar (signed) */
  slope:           number;
  /** drop window's average second diff (signed) */
  curvature:       number;
  /** drop window's rolling std */
  rollingStd:      number;
  /** comparison-window std the rolling std is measured against */
  previousStd:     number;
  /** local min over `DISCHARGE_STRUCTURE_LOOKBACK` pre-drop bars */
  localMin:        number;
  /** last value in the drop window (current NV) */
  currentValue:    number;
  /** which of the 4 conditions are true */
  slopeOk:         boolean;
  curvatureOk:     boolean;
  volatilityOk:    boolean;
  structureOk:     boolean;
  /** count of conditions met; used for the SP→PD→DB gate */
  conditionsMet:   number;
}

// Evaluate the 4 discharge confirmation conditions against the drop
// window (`drop`) and the comparison window (`prior`). Returns the
// raw values + which conditions fired so the caller can both gate
// the pattern AND surface the breakdown to dev logs.
export function dischargeConfirmation(
  drop:  number[],
  prior: number[],
): DischargeConfirmation {
  const slp  = slope(drop);
  const curv = curvature(drop);
  const rs   = stdev(drop);
  const ps   = stdev(prior);
  const localMin = prior.length
    ? prior.slice(-DISCHARGE_STRUCTURE_LOOKBACK).reduce((m, v) => Math.min(m, v), Infinity)
    : Infinity;
  const currentValue = drop.length ? drop[drop.length - 1] : NaN;

  const slopeOk      = slp < -DISCHARGE_SLOPE_STRONG;
  const curvatureOk  = Math.abs(curv) > DISCHARGE_CURVATURE_SPIKE;
  const volatilityOk = ps > 0 && rs > ps * DISCHARGE_VOL_EXPANSION;
  const structureOk  = Number.isFinite(localMin) && currentValue < localMin;

  const conditionsMet =
    (slopeOk      ? 1 : 0) +
    (curvatureOk  ? 1 : 0) +
    (volatilityOk ? 1 : 0) +
    (structureOk  ? 1 : 0);

  return {
    slope: slp, curvature: curv, rollingStd: rs, previousStd: ps,
    localMin, currentValue,
    slopeOk, curvatureOk, volatilityOk, structureOk,
    conditionsMet,
  };
}

// Build the full per-window metrics struct in one call.
export function windowMetrics(values: number[]): WindowMetrics {
  const slp  = slope(values);
  const curv = curvature(values);
  const e    = ced(values);
  const dur  = compressionDuration(values);
  const tght = oscillationTightness(values);
  const pss  = computePSS({
    slope: slp, curvature: curv, ced: e,
    compressionDuration: dur, oscillationTightness: tght,
  });
  return {
    slope:                slp,
    curvature:            curv,
    ced:                  e,
    compressionDuration:  dur,
    oscillationTightness: tght,
    pss,
  };
}
