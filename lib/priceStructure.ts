// v11.22: deterministic price-structure detector. Reads the last 30-50
// candles and decides whether the recent swing pattern is Bullish (HH +
// HL), Bearish (LH + LL), Range (oscillation between high/low without
// clear HH/LL), or Unclear (insufficient candles or mixed). Also
// surfaces approximate swing levels the trade plan can quote.
//
// Not a prediction. Not AI. Just a sliding-window read of where price
// has been moving so the trade plan can pick the right entry direction.

import type { Candle } from '@/lib/fetchCandles';

export type PriceStructure = 'Bullish' | 'Bearish' | 'Range' | 'Unclear';

export interface StructureRead {
  structure:        PriceStructure;
  recentSwingHigh:  number | null;
  recentSwingLow:   number | null;
  rangeHigh:        number | null;
  rangeLow:         number | null;
  // 0..1 — how confident the read is. 0.4 → leaning Range; 0.8 → clean
  // structure. Trade plan uses this to choose between "Pullback" and
  // "Wait for breakout".
  confidence:       number;
}

const MIN_CANDLES = 20;
const WINDOW      = 50;
// Pivot lookback — a candle is a swing-high if its high is the highest
// across +/- PIVOT_RADIUS bars; same for swing-low.
const PIVOT_RADIUS = 3;

function findPivots(candles: Candle[]): { highs: { i: number; v: number }[]; lows: { i: number; v: number }[] } {
  const highs: { i: number; v: number }[] = [];
  const lows:  { i: number; v: number }[] = [];
  for (let i = PIVOT_RADIUS; i < candles.length - PIVOT_RADIUS; i++) {
    let isHigh = true, isLow = true;
    const c = candles[i];
    for (let j = i - PIVOT_RADIUS; j <= i + PIVOT_RADIUS; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isHigh = false;
      if (candles[j].l <= c.l) isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ i, v: c.h });
    if (isLow)  lows.push({ i, v: c.l });
  }
  return { highs, lows };
}

export function readPriceStructure(candles: Candle[]): StructureRead {
  const empty: StructureRead = {
    structure: 'Unclear',
    recentSwingHigh: null,
    recentSwingLow:  null,
    rangeHigh:       null,
    rangeLow:        null,
    confidence:      0,
  };

  if (!candles || candles.length < MIN_CANDLES) return empty;
  const window = candles.slice(-WINDOW);
  const { highs, lows } = findPivots(window);

  // Window-wide range bounds — used both for the Range path and as
  // fallback swing levels when pivots are sparse.
  let rangeHigh = -Infinity, rangeLow = Infinity;
  for (const c of window) {
    if (c.h > rangeHigh) rangeHigh = c.h;
    if (c.l < rangeLow)  rangeLow  = c.l;
  }
  if (!isFinite(rangeHigh) || !isFinite(rangeLow) || rangeLow <= 0) return empty;

  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows  = lows.slice(-2);

  // Need at least two of each to call HH/HL or LH/LL.
  if (lastTwoHighs.length < 2 || lastTwoLows.length < 2) {
    // Not enough swing structure — treat as range if price is bouncing
    // inside a tight band, else unclear.
    const last = window[window.length - 1].c;
    const bandPct = (rangeHigh - rangeLow) / last * 100;
    if (bandPct < 1.5) {
      return {
        structure: 'Range',
        recentSwingHigh: rangeHigh,
        recentSwingLow:  rangeLow,
        rangeHigh, rangeLow,
        confidence: 0.4,
      };
    }
    return { ...empty, rangeHigh, rangeLow };
  }

  const [h1, h2] = lastTwoHighs;
  const [l1, l2] = lastTwoLows;
  const recentSwingHigh = h2.v;
  const recentSwingLow  = l2.v;

  const higherHighs = h2.v > h1.v;
  const higherLows  = l2.v > l1.v;
  const lowerHighs  = h2.v < h1.v;
  const lowerLows   = l2.v < l1.v;

  if (higherHighs && higherLows) {
    return {
      structure: 'Bullish',
      recentSwingHigh, recentSwingLow,
      rangeHigh, rangeLow,
      confidence: 0.8,
    };
  }
  if (lowerHighs && lowerLows) {
    return {
      structure: 'Bearish',
      recentSwingHigh, recentSwingLow,
      rangeHigh, rangeLow,
      confidence: 0.8,
    };
  }

  // Mixed (e.g. HH + LL or HL + LH) — call it Range if the band is
  // tight, otherwise Unclear.
  const last = window[window.length - 1].c;
  const bandPct = (rangeHigh - rangeLow) / last * 100;
  if (bandPct < 2) {
    return {
      structure: 'Range',
      recentSwingHigh, recentSwingLow,
      rangeHigh, rangeLow,
      confidence: 0.5,
    };
  }
  return {
    structure: 'Unclear',
    recentSwingHigh, recentSwingLow,
    rangeHigh, rangeLow,
    confidence: 0.3,
  };
}
