// v13.9.1: PRICE STRUCTURE CONFIRMATION
//
// Simple, indicator-free price-structure read. Decides whether the
// last N candles paint a bullish / bearish / neutral structure, and
// whether the current price action CONFIRMS, PARTIALLY supports, or
// REJECTS that structure.
//
// Used by deriveActionState as the GO gate's directional-confirmation
// check. The point is to keep GCP Pro's edge (coherence + environment
// + structure) and add a thin price-layer reality-check without
// importing RSI / MACD / moving-average dependence.
//
// Rules (deliberately plain):
//   Bullish  — HH / HL pivots, closes above midpoint, reclaim above
//              recent pivot, or breakout above range high.
//   Bearish  — LH / LL pivots, closes below midpoint, rejection below
//              pivot, or breakdown below range low.
//   Neutral  — mixed pivots / range chop.
//
// Pure function. No network. No state. Returns null when there
// aren't enough candles to read structure honestly.

import type { Candle } from '@/lib/fetchCandles';

export type PriceStructureTrend       = 'up' | 'down' | 'range';
export type PriceStructure            = 'bullish' | 'bearish' | 'neutral';
export type PriceStructureConfirmation = 'confirmed' | 'partial' | 'rejected';

export interface PriceStructureRead {
  trend:         PriceStructureTrend;
  structure:     PriceStructure;
  confirmation:  PriceStructureConfirmation;
  reason:        string;
  levels: {
    rangeHigh?: number;
    rangeLow?:  number;
    reclaim?:   number;
    breakdown?: number;
  };
}

const MIN_CANDLES   = 8;
const WINDOW_BARS   = 30;
const BREAKOUT_PROX = 0.005;  // within 0.5% of range high → "near top"
const BREAKDOWN_PROX = 0.005; // within 0.5% of range low  → "near floor"

export function derivePriceStructureConfirmation(
  candles: Candle[] | null | undefined,
): PriceStructureRead | null {
  if (!candles || candles.length < MIN_CANDLES) return null;

  // Strip any synthetic gap-fill bars before reading structure — they
  // would otherwise produce spurious HH/HL by flat-projecting prior
  // closes across weekend / overnight gaps.
  const realBars = candles.filter(c => !c.synthetic);
  if (realBars.length < MIN_CANDLES) return null;

  const window  = realBars.slice(-WINDOW_BARS);
  const highs   = window.map(c => c.h);
  const lows    = window.map(c => c.l);
  const closes  = window.map(c => c.c);
  const rangeHigh = Math.max(...highs);
  const rangeLow  = Math.min(...lows);
  const midpoint  = (rangeHigh + rangeLow) / 2;
  const lastClose = closes[closes.length - 1];
  const closesAboveMid = closes.slice(-5).filter(c => c > midpoint).length;
  const closesBelowMid = closes.slice(-5).filter(c => c < midpoint).length;

  // Simple 3-bar pivots — bar i is a swing high if its high exceeds
  // both neighbors. Symmetric definition for swing lows.
  const swingHighs: number[] = [];
  const swingLows:  number[] = [];
  for (let i = 1; i < window.length - 1; i++) {
    if (window[i].h > window[i - 1].h && window[i].h > window[i + 1].h) {
      swingHighs.push(window[i].h);
    }
    if (window[i].l < window[i - 1].l && window[i].l < window[i + 1].l) {
      swingLows.push(window[i].l);
    }
  }
  const lastSH  = swingHighs[swingHighs.length - 1];
  const prevSH  = swingHighs[swingHighs.length - 2];
  const lastSL  = swingLows[swingLows.length - 1];
  const prevSL  = swingLows[swingLows.length - 2];

  const hh = lastSH != null && prevSH != null && lastSH > prevSH;
  const lh = lastSH != null && prevSH != null && lastSH < prevSH;
  const hl = lastSL != null && prevSL != null && lastSL > prevSL;
  const ll = lastSL != null && prevSL != null && lastSL < prevSL;

  // "Reclaim" / "breakdown" levels surface the actionable price the
  // banner can quote — they're the most recent pivot in each
  // direction. A close above `reclaim` flips bullish; a close below
  // `breakdown` flips bearish.
  const reclaim   = lastSH;
  const breakdown = lastSL;

  // Score the bullish / bearish case independently. The score-3
  // / score-4 thresholds keep both "partial" and "confirmed"
  // categories accessible without overweighting any single signal.
  const breakoutNear  = lastClose >= rangeHigh * (1 - BREAKOUT_PROX);
  const breakdownNear = lastClose <= rangeLow  * (1 + BREAKDOWN_PROX);

  let bullScore = 0;
  if (hh)              bullScore += 1;
  if (hl)              bullScore += 1;
  if (closesAboveMid >= 3) bullScore += 1;
  if (breakoutNear)    bullScore += 1;
  if (reclaim != null && lastClose > reclaim) bullScore += 1;

  let bearScore = 0;
  if (lh)              bearScore += 1;
  if (ll)              bearScore += 1;
  if (closesBelowMid >= 3) bearScore += 1;
  if (breakdownNear)   bearScore += 1;
  if (breakdown != null && lastClose < breakdown) bearScore += 1;

  const levels = { rangeHigh, rangeLow, reclaim, breakdown };

  if (bullScore >= 3 && bullScore > bearScore) {
    const confirmation: PriceStructureConfirmation =
      bullScore >= 4 ? 'confirmed' : 'partial';
    const why: string[] = [];
    if (hh && hl) why.push('higher highs + higher lows');
    else if (hh)  why.push('higher highs');
    else if (hl)  why.push('higher lows');
    if (reclaim != null && lastClose > reclaim) why.push(`reclaim of ${reclaim.toFixed(2)}`);
    if (breakoutNear) why.push(`near range high ${rangeHigh.toFixed(2)}`);
    if (closesAboveMid >= 3) why.push('closes above midpoint');
    return {
      trend:        'up',
      structure:    'bullish',
      confirmation,
      reason:       why.join(' · ') || 'Bullish structure intact',
      levels,
    };
  }

  if (bearScore >= 3 && bearScore > bullScore) {
    const confirmation: PriceStructureConfirmation =
      bearScore >= 4 ? 'confirmed' : 'partial';
    const why: string[] = [];
    if (lh && ll) why.push('lower highs + lower lows');
    else if (lh)  why.push('lower highs');
    else if (ll)  why.push('lower lows');
    if (breakdown != null && lastClose < breakdown) why.push(`breakdown of ${breakdown.toFixed(2)}`);
    if (breakdownNear) why.push(`near range low ${rangeLow.toFixed(2)}`);
    if (closesBelowMid >= 3) why.push('closes below midpoint');
    return {
      trend:        'down',
      structure:    'bearish',
      confirmation,
      reason:       why.join(' · ') || 'Bearish structure intact',
      levels,
    };
  }

  return {
    trend:        'range',
    structure:    'neutral',
    confirmation: 'rejected',
    reason:       'Mixed highs / lows — price chopping inside the range.',
    levels,
  };
}
