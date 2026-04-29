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

// ── v11.13.2 OHLC candle integrity ────────────────────────────────────────
//
// Structural type so sanity.ts doesn't need to import the Candle type from
// fetchCandles (which would create a cycle when fetchCandles imports here).
interface CandleShape {
  t: number; o: number; h: number; l: number; c: number;
}

// Reject any candle that violates the OHLC contract: timestamp finite,
// every OHLC field finite + > 0, high >= max(o, c, l), low <= min(o, c, h),
// AND intra-bar spread h/l <= MAX_SPREAD_RATIO. The spread check catches
// the v11.13.2 outage symptom -- Twelve Data was returning XAU 5m bars
// with l=0.00022 while o/h/c were ~4534. Both v11.13.2 checks passed
// (0.00022 > 0, 0.00022 <= min(...)) so the bar survived sanitize and
// painted a vertical spike to ~0.
const MAX_SPREAD_RATIO = 2;

export function isValidCandle(c: CandleShape | null | undefined): boolean {
  if (!c) return false;
  if (!Number.isFinite(c.t)) return false;
  if (!Number.isFinite(c.o) || !Number.isFinite(c.h) ||
      !Number.isFinite(c.l) || !Number.isFinite(c.c)) return false;
  if (c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0) return false;
  if (c.h < Math.max(c.o, c.c, c.l)) return false;
  if (c.l > Math.min(c.o, c.c, c.h)) return false;
  // v11.13.3 intra-bar spread guard. Real XAU / XAG / BTC bars at any
  // TF rarely exceed h/l = 1.05; 2.0 leaves enormous margin so this
  // only catches true glitches where one field is wildly off.
  if (c.h / c.l > MAX_SPREAD_RATIO) return false;
  return true;
}

// Compare consecutive candle closes; > maxPct in a single bar is almost
// always a feed glitch on the symbols we trade. Real overnight gaps fall
// well under 10% on XAU/XAG/BTC.
export function isReasonableCandleJump(
  prev: CandleShape | null | undefined,
  next: CandleShape,
  maxPct = 0.10,
): boolean {
  if (!prev) return true;
  if (!Number.isFinite(prev.c) || !Number.isFinite(next.c) || prev.c <= 0) return true;
  return Math.abs(next.c - prev.c) / prev.c <= maxPct;
}

// Per-symbol "this is impossible" floor for the debug locator. Logs a
// warning if any OHLC field falls below the floor so we can identify
// the source of a near-zero spike without spamming healthy feeds.
// Pass 0 / undefined to disable the check.
const NEAR_ZERO_FLOOR: Record<string, number> = {
  XAUUSD:    100,    // gold spot has not been below $100 historically
  'XAU/USD': 100,
  BTC:       1000,   // BTC has not been below $1000 since 2017
  'BTC/USD': 1000,
  XAGUSD:    1,      // silver spot floor (rough)
  'XAG/USD': 1,
};

export function nearZeroFloorFor(symbol: string | undefined): number {
  if (!symbol) return 0;
  return NEAR_ZERO_FLOOR[symbol] ?? 0;
}

// Filter a candle array through the OHLC + jump gates and emit a
// single warning per call summarising rejections. Returns the clean
// array. Use at every boundary where candles enter the chart pipeline
// (initial fetch, lazy backfill, live append, setData / update calls).
export function sanitizeCandles<T extends CandleShape>(
  candles: T[],
  source: string,
  opts: {
    filterJumps?:   boolean;
    jumpMaxPct?:    number;
    nearZeroFloor?: number;
  } = {},
): T[] {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  let invalid    = 0;
  let jumpReject = 0;
  let nearZero   = 0;
  const out: T[]    = [];
  let prev: T | null = null;
  for (const c of candles) {
    if (!isValidCandle(c)) { invalid++; continue; }
    if (opts.filterJumps && !isReasonableCandleJump(prev, c, opts.jumpMaxPct ?? 0.10)) {
      jumpReject++;
      continue;
    }
    out.push(c);
    prev = c;
    if (opts.nearZeroFloor && opts.nearZeroFloor > 0) {
      const floor = opts.nearZeroFloor;
      if (c.o < floor || c.h < floor || c.l < floor || c.c < floor) {
        nearZero++;
        // First few logs only -- enough to identify a glitch source
        // without flooding the console if the feed is genuinely off.
        if (nearZero <= 3) {
          console.warn(
            `[CHART] suspicious near-zero OHLC at ${source}`,
            'time:', new Date(c.t).toISOString(),
            'OHLC:', { o: c.o, h: c.h, l: c.l, c: c.c },
          );
        }
      }
    }
  }
  if (invalid > 0)    console.warn(`[CHART] filtered ${invalid} invalid candles before ${source}`);
  if (jumpReject > 0) console.warn(`[CHART] unreasonable candle jump rejected (${jumpReject}) at ${source}`);
  return out;
}
