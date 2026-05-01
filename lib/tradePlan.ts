// v11.22: Trade Plan layer. Translates AI State + Price Structure into
// a deterministic execution-readiness summary:
//
//   Direction    Buy / Sell / Both / None
//   Entry type   Pullback / Breakout / Fade / No entry
//   Trigger      one-line condition the user is waiting for
//   Invalidation one-line condition that kills the idea
//   Size         Full / Half / Small / No trade
//   Reason       (only when "No entry") why we're standing aside
//
// NOT a buy/sell signal. NOT AI. Frontend logic only — same inputs in,
// same plan out. Builds on priceStructure (HH/HL detection from
// candles), the AI state's stateCode + phase + direction, and the
// existing posture sizing from aiAction.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { Pattern, MarketSymbol } from '@/types/gcp';
import type { PriceStructure, StructureRead } from '@/lib/priceStructure';
import { derivePosture, type SizeGuidance, type ActionTone } from '@/lib/aiAction';

export type TradeDirection = 'Buy' | 'Sell' | 'Both' | 'None';
export type TradeEntryType = 'Pullback' | 'Breakout' | 'Fade' | 'No entry';

export interface TradePlan {
  direction:    TradeDirection;
  entryType:    TradeEntryType;
  headline:     string;          // "Sell pullback", "Range scalp only", "No entry"
  trigger:      string;          // human-readable wait condition
  invalidation: string;          // human-readable kill condition
  size:         SizeGuidance;
  reason?:      string;          // only set when entryType === 'No entry'
  tone:         ActionTone;      // colour mapping for the row
}

function priceLabel(symbol: MarketSymbol, n: number | null): string | null {
  if (n == null || !isFinite(n) || n <= 0) return null;
  if (symbol === 'BTC')    return Math.round(n).toLocaleString();
  if (symbol === 'XAGUSD') return n.toFixed(3);
  return n.toFixed(2);
}

function directionFromStructure(s: PriceStructure): TradeDirection {
  if (s === 'Bullish') return 'Buy';
  if (s === 'Bearish') return 'Sell';
  if (s === 'Range')   return 'Both';
  return 'None';
}

export function deriveTradePlan(
  state:         GcpStateResponse | null,
  structure:     StructureRead,
  latestPattern: Pattern | null,
  symbol:        MarketSymbol,
): TradePlan | null {
  if (!state) return null;

  const posture = derivePosture(state, latestPattern);
  const size    = posture?.size ?? 'Small';
  const tone    = posture?.action.tone ?? 'wait';

  const dir = directionFromStructure(structure.structure);
  const swingHigh = priceLabel(symbol, structure.recentSwingHigh);
  const swingLow  = priceLabel(symbol, structure.recentSwingLow);

  const code  = state.stateCode;
  const phase = state.phase;

  // Hard "no entry" gates — match the size = No trade branches in
  // aiAction. These take priority over structure direction so the
  // plan never says "Buy" when posture said "No trade".
  if (size === 'No trade'
      || code === 'FA'
      || code === 'SH'
      || code === 'DD'
      || ((code === 'DS' || code === 'CL') && (phase === 'Late' || phase === 'Exhausted'))) {
    let reason = '';
    if (code === 'FA')         reason = 'Failed alignment — fakeout risk, only reversal confirmation';
    else if (code === 'SH')    reason = 'Shock — extreme volatility, reduce / wait';
    else if (code === 'DD')    reason = 'Dead drift — low signal environment';
    else if (code === 'DS')    reason = 'Discharge — exhaustion risk, no new positions';
    else if (code === 'CL')    reason = 'Climax — exhaustion risk, no new positions';
    else                       reason = 'Conditions do not warrant new entries';
    return {
      direction:    'None',
      entryType:    'No entry',
      headline:     'No entry',
      trigger:      '—',
      invalidation: '—',
      size:         'No trade',
      reason,
      tone:         'avoid',
    };
  }

  // Range market — fade extremes with small size regardless of state.
  if (structure.structure === 'Range') {
    return {
      direction:    'Both',
      entryType:    'Fade',
      headline:     'Range scalp only',
      trigger:      swingHigh && swingLow
                      ? `fade rejection near ${swingHigh} / ${swingLow}`
                      : 'fade range extremes only',
      invalidation: swingHigh && swingLow
                      ? `clean breakout above ${swingHigh} or below ${swingLow}`
                      : 'clean breakout from the range',
      size:         'Small',
      tone:         'wait',
    };
  }

  // Unclear structure — wait for direction even if AI state suggests
  // a posture; we don't want to commit a trade direction without
  // visible structure on the chart.
  if (structure.structure === 'Unclear') {
    return {
      direction:    'None',
      entryType:    'No entry',
      headline:     'No entry',
      trigger:      'wait for clear higher highs/lows or lower highs/lows',
      invalidation: '—',
      size:         'No trade',
      reason:       'Unclear structure — wait for direction',
      tone:         'wait',
    };
  }

  // Bullish or Bearish — derive entry type from AI state code.
  const isBullish = structure.structure === 'Bullish';
  const verb = isBullish ? 'Buy' : 'Sell';

  // Compression in a directional structure: breakout in the structure
  // direction is the high-confidence trade; pullback is the secondary.
  if (code === 'CS') {
    return {
      direction:    isBullish ? 'Buy' : 'Sell',
      entryType:    'Breakout',
      headline:     `${verb} breakout`,
      trigger:      isBullish
        ? (swingHigh ? `clean break above ${swingHigh}` : 'clean break above recent swing high')
        : (swingLow  ? `clean break below ${swingLow}`  : 'clean break below recent swing low'),
      invalidation: isBullish
        ? (swingLow  ? `loss of ${swingLow}` : 'loss of recent swing low')
        : (swingHigh ? `reclaim of ${swingHigh}` : 'reclaim of recent swing high'),
      size,
      tone,
    };
  }

  // Ignition early/mid in a directional structure: pullback continuation.
  // Late / exhausted: still pullback but smaller, posture sizing handles it.
  if (code === 'IS' || code === 'AT' || code === 'SS') {
    return {
      direction:    isBullish ? 'Buy' : 'Sell',
      entryType:    'Pullback',
      headline:     `${verb} pullback`,
      trigger:      isBullish
        ? (swingLow  ? `bounce / higher low above ${swingLow}` : 'bounce off recent higher low')
        : (swingHigh ? `rejection below ${swingHigh}`          : 'rejection below recent lower high'),
      invalidation: isBullish
        ? (swingLow  ? `close below ${swingLow}` : 'close below recent swing low')
        : (swingHigh ? `close above ${swingHigh}` : 'close above recent swing high'),
      size,
      tone,
    };
  }

  // Fallback for any other code that didn't hit the no-entry gate
  // above — observe rather than guess.
  return {
    direction:    'None',
    entryType:    'No entry',
    headline:     'No entry',
    trigger:      'wait for confirmation',
    invalidation: '—',
    size:         'No trade',
    reason:       'Insufficient confirmation',
    tone:         'wait',
  };
}
