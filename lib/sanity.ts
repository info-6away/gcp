// Data sanity helpers for the v11.13.1 integrity layer.
//
// One bad upstream tick (NaN, null, 0, infinity, or a 50% spike) used to
// propagate from the GCP / gold feeds straight through to the chart,
// energy metrics, and pattern detector. These predicates gate every
// boundary where external data enters the system so corrupt values get
// rejected at the source instead of corrupting downstream state.

// Accepts a real, finite, non-NaN number. Reject anything else --
// strings, booleans, null, undefined, NaN, +/- Infinity.
export function isValidNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// GCP Net Variance must be a valid number > 0. Zero is invalid here:
// the GCP2 network never produces a 0 NV under normal operation, and
// 0 sneaking through would bias compression-coil detection toward
// false positives.
export function isValidNV(v: unknown): v is number {
  return isValidNumber(v) && v > 0;
}

// Spot price must be valid and positive. Same check as isValidNV
// today, but kept separate so future per-feed thresholds (e.g. min
// price for BTC vs XAGUSD) can land here without changing call sites.
export function isValidPrice(v: unknown): v is number {
  return isValidNumber(v) && v > 0;
}

// Reject anomalous price ticks. 10% in a single 2-second poll is a
// feed glitch, not a real market move, even on BTC. Returning false
// means "treat this tick as bad, keep prior price".
//
// prev <= 0 means there's no baseline yet -- accept the new value
// unconditionally so the very first tick can land.
export function isReasonableJump(prev: number | null, next: number, maxPct = 0.10): boolean {
  if (!isValidPrice(next)) return false;
  if (prev == null || !isValidPrice(prev)) return true;
  const jump = Math.abs(next - prev) / prev;
  return jump <= maxPct;
}
