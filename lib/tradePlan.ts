// v11.22: Trade Plan layer. Translates AI State + Price Structure into
// a deterministic execution-readiness summary.
//
// v11.22.1: language pass + price anchor.
//  - "fade" jargon replaced with explicit Buy/Sell at support /
//    resistance.
//  - Range mode now exposes BOTH a buy and a sell trigger so the user
//    sees both extremes.
//  - New fields: analysisPrice, analysisOHLC, analysisTf, currentPrice,
//    so the Trade Plan card can show "Analysis at 4567.25 (15m)" and
//    "Now: 4569.80 · +2.55 from analysis".
//  - triggers is now a string[] (was a single string). Renderers treat
//    each element as its own line.
//
// NOT a buy/sell signal. NOT AI. Frontend logic only — same inputs in,
// same plan out.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { Pattern, MarketSymbol } from '@/types/gcp';
import type { Candle } from '@/lib/fetchCandles';
import type { PriceStructure, StructureRead } from '@/lib/priceStructure';
import { derivePosture, type SizeGuidance, type ActionTone } from '@/lib/aiAction';

export type TradeDirection = 'Buy' | 'Sell' | 'Both' | 'None';
export type TradeEntryType = 'Pullback' | 'Breakout' | 'Fade' | 'No entry';

// v11.25: numeric trigger / invalidation levels. Strings in `triggers`
// remain the user-facing copy; these structured fields let the AI plan
// memory (lib/aiPlanMemory.ts) detect when price actually crosses a
// level — "Sell only after clean break below 4573.77" needs 4573.77 as
// a number for lifecycle tracking, not just embedded in prose.
export interface TriggerLevels {
  buyAbove?:   number;
  sellBelow?:  number;
  resistance?: number;
  support?:    number;
}

export interface InvalidationLevels {
  above?: number;
  below?: number;
}

export interface TradePlan {
  direction:    TradeDirection;
  entryType:    TradeEntryType;
  headline:     string;
  triggers:     string[];        // 1+ trigger lines (range has 2)
  invalidation: string;
  size:         SizeGuidance;
  reason?:      string;
  tone:         ActionTone;
  // v11.22.1 price anchor:
  analysisPrice?:   number | null;
  analysisOHLC?:    { o: number; h: number; l: number; c: number } | null;
  analysisTf?:      string;
  currentPrice?:    number | null;
  distance?:        number | null;     // currentPrice - analysisPrice
  // v11.25 numeric levels for plan-memory lifecycle tracking.
  triggerLevels?:      TriggerLevels;
  invalidationLevels?: InvalidationLevels;
}

function safeLevel(n: number | null | undefined): number | undefined {
  return (n != null && Number.isFinite(n) && n > 0) ? n : undefined;
}

function priceLabel(symbol: MarketSymbol, n: number | null | undefined): string | null {
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

export interface DerivePlanArgs {
  state:           GcpStateResponse | null;
  structure:       StructureRead;
  latestPattern:   Pattern | null;
  symbol:          MarketSymbol;
  analysisCandle?: Candle | null;
  analysisTf?:     string;
  currentPrice?:   number | null;
}

export function deriveTradePlan(args: DerivePlanArgs): TradePlan | null {
  const {
    state, structure, latestPattern, symbol,
    analysisCandle = null, analysisTf, currentPrice = null,
  } = args;
  if (!state) return null;

  const posture = derivePosture(state, latestPattern);
  const size    = posture?.size ?? 'Small';
  const tone    = posture?.action.tone ?? 'wait';

  const swingHigh = priceLabel(symbol, structure.recentSwingHigh);
  const swingLow  = priceLabel(symbol, structure.recentSwingLow);
  const rangeHi   = priceLabel(symbol, structure.rangeHigh);
  const rangeLo   = priceLabel(symbol, structure.rangeLow);

  // Price anchor metadata that every plan carries regardless of branch.
  const analysisPrice = analysisCandle?.c ?? null;
  const analysisOHLC  = analysisCandle
    ? { o: analysisCandle.o, h: analysisCandle.h, l: analysisCandle.l, c: analysisCandle.c }
    : null;
  const distance = (currentPrice != null && analysisPrice != null)
    ? +(currentPrice - analysisPrice).toFixed(symbol === 'BTC' ? 0 : symbol === 'XAGUSD' ? 3 : 2)
    : null;
  const anchor = {
    analysisPrice,
    analysisOHLC,
    analysisTf,
    currentPrice,
    distance,
  };

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
      triggers:     [],
      invalidation: '—',
      size:         'No trade',
      reason,
      tone:         'avoid',
      ...anchor,
    };
  }

  // Range market — explicit buy + sell triggers at support / resistance.
  if (structure.structure === 'Range') {
    return {
      direction:    'Both',
      entryType:    'Fade',
      headline:     'Range scalp only',
      triggers: [
        rangeHi ? `Sell rejection near ${rangeHi} resistance` : 'Sell rejection near recent resistance',
        rangeLo ? `Buy rejection near ${rangeLo} support`     : 'Buy rejection near recent support',
      ],
      invalidation: 'Clean breakout outside range',
      size:         'Small',
      tone:         'wait',
      ...anchor,
      triggerLevels: {
        resistance: safeLevel(structure.rangeHigh),
        support:    safeLevel(structure.rangeLow),
      },
      invalidationLevels: {
        above: safeLevel(structure.rangeHigh),
        below: safeLevel(structure.rangeLow),
      },
    };
  }

  // Unclear structure — wait for direction.
  if (structure.structure === 'Unclear') {
    return {
      direction:    'None',
      entryType:    'No entry',
      headline:     'No entry',
      triggers:     ['Wait for clear higher highs/lows or lower highs/lows'],
      invalidation: '—',
      size:         'No trade',
      reason:       'Unclear structure — wait for direction',
      tone:         'wait',
      ...anchor,
    };
  }

  const isBullish = structure.structure === 'Bullish';

  // Compression in a directional structure: breakout watch with
  // explicit buy AND sell conditions tied to range bounds.
  if (code === 'CS') {
    return {
      direction:    isBullish ? 'Buy' : 'Sell',
      entryType:    'Breakout',
      headline:     'Breakout watch',
      triggers: [
        rangeHi ? `Buy only after clean break above ${rangeHi}`  : 'Buy only after clean break above recent swing high',
        rangeLo ? `Sell only after clean break below ${rangeLo}` : 'Sell only after clean break below recent swing low',
      ],
      invalidation: 'Failed breakout back inside range',
      size,
      tone,
      ...anchor,
      triggerLevels: {
        buyAbove:  safeLevel(structure.rangeHigh),
        sellBelow: safeLevel(structure.rangeLow),
      },
      invalidationLevels: {},
    };
  }

  // Ignition / Alignment / Sync in a directional structure: pullback
  // continuation, single trigger + single invalidation per spec.
  if (code === 'IS' || code === 'AT' || code === 'SS') {
    if (isBullish) {
      return {
        direction:    'Buy',
        entryType:    'Pullback',
        headline:     'Buy pullback',
        triggers: [
          swingLow
            ? `Rejection above recent higher low ${swingLow}`
            : 'Rejection above recent higher low',
        ],
        invalidation: swingLow
          ? `Break below recent swing low ${swingLow}`
          : 'Break below recent swing low',
        size,
        tone,
        ...anchor,
        triggerLevels: {
          support: safeLevel(structure.recentSwingLow),
        },
        invalidationLevels: {
          below: safeLevel(structure.recentSwingLow),
        },
      };
    }
    return {
      direction:    'Sell',
      entryType:    'Pullback',
      headline:     'Sell pullback',
      triggers: [
        swingHigh
          ? `Rejection below recent lower high ${swingHigh}`
          : 'Rejection below recent lower high',
      ],
      invalidation: swingHigh
        ? `Reclaim above recent swing high ${swingHigh}`
        : 'Reclaim above recent swing high',
      size,
      tone,
      ...anchor,
      triggerLevels: {
        resistance: safeLevel(structure.recentSwingHigh),
      },
      invalidationLevels: {
        above: safeLevel(structure.recentSwingHigh),
      },
    };
  }

  // Fallback for any other code that didn't hit the no-entry gate
  // above — observe rather than guess.
  return {
    direction:    'None',
    entryType:    'No entry',
    headline:     'No entry',
    triggers:     ['Wait for confirmation'],
    invalidation: '—',
    size:         'No trade',
    reason:       'Insufficient confirmation',
    tone:         'wait',
    ...anchor,
  };
}

// v11.22.1 helper used by the Trade Plan card to render the anchor row.
export function formatPriceAnchor(plan: TradePlan, symbol: MarketSymbol): {
  anchorLabel:  string | null;
  ohlcLabel:    string | null;
  currentLabel: string | null;
} {
  const ap = priceLabel(symbol, plan.analysisPrice ?? null);
  const cp = priceLabel(symbol, plan.currentPrice  ?? null);
  const tf = plan.analysisTf ?? '';
  const anchorLabel = ap
    ? (tf ? `${ap} (${tf})` : ap)
    : null;
  let ohlcLabel: string | null = null;
  if (plan.analysisOHLC) {
    const { o, h, l, c } = plan.analysisOHLC;
    const oL = priceLabel(symbol, o);
    const hL = priceLabel(symbol, h);
    const lL = priceLabel(symbol, l);
    const cL = priceLabel(symbol, c);
    if (oL && hL && lL && cL) ohlcLabel = `O ${oL} · H ${hL} · L ${lL} · C ${cL}`;
  }
  let currentLabel: string | null = null;
  if (cp != null && plan.distance != null) {
    const sign = plan.distance >= 0 ? '+' : '−';
    const abs  = priceLabel(symbol, Math.abs(plan.distance));
    currentLabel = abs
      ? `Now: ${cp} · ${sign}${abs} from analysis`
      : `Now: ${cp}`;
  } else if (cp) {
    currentLabel = `Now: ${cp}`;
  }
  return { anchorLabel, ohlcLabel, currentLabel };
}
