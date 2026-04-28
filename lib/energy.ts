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
