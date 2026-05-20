// v14.0 — Phase 14A: Guru Radar scan engine.
//
// Sequential, manual-only multi-asset coherence scan. For each radar
// symbol it builds the SAME engine payload the single-symbol console
// uses, calls the Engine once, then runs the identical local
// post-processing chain (anchor → transition → pressure → plateau →
// decay → dominance → temporal → sanity guard) and finally the
// v13.9 action-state + price-structure layers.
//
// Architecture note: GCP is the GLOBAL coherence field — the series,
// energy metrics, regime, recent patterns and pattern story are
// shared across every symbol in a scan. What differs per symbol is
// the PRICE: each symbol's own candles drive priceStructure +
// goldContext, and the Engine knows which symbol it is classifying.
// So the scan reuses one shared `GcpStateInputs` template and only
// overrides the per-symbol price fields.
//
// NO background loops. NO auto-polling. NO Engine payload changes.
// NO new AI prompt. The scan only fires when the user clicks
// SCAN MARKETS. Each symbol costs exactly one Engine call — the same
// cost as one manual Ask Guru.

import type { MarketSymbol } from '@/types/gcp';
import type { GcpStateInputs } from '@/lib/gcp-state-payload';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import { buildGcpStatePayload } from '@/lib/gcp-state-payload';
import { classifyGcpState, isClassifyError } from '@/lib/engine-gcp';
import { anchorAiState } from '@/lib/aiStateAnchor';
import { deriveNextState } from '@/lib/stateTransition';
import { deriveDirectionalPressure } from '@/lib/directionalPressure';
import { derivePlateauStateOverlay } from '@/lib/plateauState';
import { deriveDirectionalDecayOverlay } from '@/lib/directionalDecay';
import {
  deriveStructuralDominance, applyStructuralSanityGuard,
} from '@/lib/structuralDominance';
import { deriveTemporalPressureBias } from '@/lib/temporalPressure';
import { tdTimeSeries, type Candle } from '@/lib/fetchCandles';
import { readPriceStructure } from '@/lib/priceStructure';
import {
  derivePriceStructureConfirmation, type PriceStructureRead,
} from '@/lib/priceStructureConfirmation';
import { deriveActionState, type ActionStateRead } from '@/lib/actionState';
import { AI_ANALYSIS_TF } from '@/lib/aiTimeframe';
import { RADAR_SYMBOLS } from '@/lib/radarSymbols';

// Twelve Data ticker mapping — same values the other candle fetch
// sites use. Kept local so radarScan has no cross-import on a UI file.
const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
  EURUSD: 'EUR/USD',
  USDJPY: 'USD/JPY',
  ETH:    'ETH/USD',
  GBPUSD: 'GBP/USD',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF',
};

const isDev = () =>
  typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';

export interface RadarResult {
  symbol:    MarketSymbol;
  scannedAt: number;
  ok:        boolean;
  error?:    string;
  /** Final post-processed classification (only when ok). */
  aiState?:        GcpStateResponse;
  /** Action-state read (only when ok). */
  action?:         ActionStateRead;
  /** Price-structure confirmation read (only when ok). */
  priceStructure?: PriceStructureRead | null;
  /** v17.0: last close at scan time. Exposed so the research recorder
   *  can persist priceAtAnalysis into the unified history. */
  priceAtAnalysis?: number;
}

export interface RadarScanProgress {
  index:  number;   // 0-based position in RADAR_SYMBOLS
  total:  number;
  symbol: MarketSymbol;
  step:   'fetching' | 'classifying' | 'processing' | 'done';
}

export interface RadarScanSummary {
  durationMs:     number;
  symbolsScanned: number;
  goCount:        number;
}

// Run the full classify + post-process chain for ONE symbol. Mirrors
// the sequence in useGcpState exactly, with the per-symbol price
// fields overridden and no symbol-specific history inheritance.
async function scanSymbol(
  symbol:       MarketSymbol,
  sharedInputs: GcpStateInputs,
): Promise<RadarResult> {
  const scannedAt = Date.now();

  // 1. Per-symbol candles → price structure + coarse trend.
  let candles: Candle[];
  try {
    candles = await tdTimeSeries({
      symbol:     TD_SYMBOLS[symbol],
      tf:         AI_ANALYSIS_TF,
      outputsize: 60,
    });
  } catch (e) {
    return {
      symbol, scannedAt, ok: false,
      error: e instanceof Error ? e.message : 'candle fetch failed',
    };
  }
  const realBars = candles.filter(c => !c.synthetic);
  if (realBars.length < 10) {
    return { symbol, scannedAt, ok: false, error: 'insufficient candles' };
  }
  const structureRead = readPriceStructure(candles);
  const lastClose     = realBars[realBars.length - 1].c;
  const firstClose    = realBars[0].c;
  const changePct     = firstClose > 0
    ? ((lastClose - firstClose) / firstClose) * 100
    : 0;
  const trend: 'up' | 'down' | 'sideways' | 'unknown' =
    changePct >  0.10 ? 'up'
  : changePct < -0.10 ? 'down'
  :                     'sideways';

  // 2. Build the payload — shared coherence field + per-symbol price.
  //    priorPlan is dropped: a scan must not carry one symbol's saved
  //    plan into another symbol's classification.
  const inputs: GcpStateInputs = {
    ...sharedInputs,
    symbol,
    goldContext:     { trend },
    priceAtAnalysis: lastClose,
    priceStructure:  structureRead,
    priorPlan:       undefined,
  };
  const payload = buildGcpStatePayload(inputs);
  if (!payload) {
    return { symbol, scannedAt, ok: false, error: 'payload unbuildable' };
  }

  // 3. Engine classify — exactly one call, manual source 'guru_radar'.
  let rawResult;
  try {
    rawResult = await classifyGcpState(payload, {
      manual: true, source: 'guru_radar',
    });
  } catch (e) {
    return {
      symbol, scannedAt, ok: false,
      error: e instanceof Error ? e.message : 'engine call failed',
    };
  }
  if (isClassifyError(rawResult)) {
    return { symbol, scannedAt, ok: false, error: rawResult.error.message };
  }
  if (!rawResult) {
    return { symbol, scannedAt, ok: false, error: 'no classification' };
  }
  const result = rawResult;

  // 4. Local post-processing — mirrors useGcpState's runCall chain.
  const anchor   = anchorAiState(result, payload);
  const anchored = anchor.response;

  const transition = deriveNextState({
    aiState:      anchored,
    patternStory: payload.patternStory,
    metrics:      payload.metrics,
    goldContext:  payload.goldContext,
  });
  const withTransition = transition.nextLikelyState
    ? { ...anchored, ...transition }
    : anchored;

  const pressure = deriveDirectionalPressure({
    aiState:      withTransition,
    patternStory: payload.patternStory,
    metrics:      payload.metrics,
    goldContext:  payload.goldContext,
    transition,
  });
  const respWithPressure: GcpStateResponse = {
    ...withTransition,
    longPressure:        pressure.longPressure,
    shortPressure:       pressure.shortPressure,
    pressureBand:        pressure.confidenceBand,
    pressureExplanation: pressure.explanation,
    _meta:               result._meta,
    stale:               result.stale,
    staleReason:         result.staleReason,
    staleAgeMs:          result.staleAgeMs,
  };

  const latestPatternCode =
    sharedInputs.recentPatterns[sharedInputs.recentPatterns.length - 1]?.patternCode ?? null;

  const plateau = derivePlateauStateOverlay({
    aiState:      respWithPressure,
    patternStory: payload.patternStory,
    metrics:      payload.metrics,
    directionalPressure: {
      longPressure:  respWithPressure.longPressure,
      shortPressure: respWithPressure.shortPressure,
      pressureBand:  respWithPressure.pressureBand,
    },
    transition: { nextLikelyState: respWithPressure.nextLikelyState },
    regime:            sharedInputs.regime.code,
    latestPatternCode,
  });
  const respAfterPlateau = plateau.response;

  const decay = deriveDirectionalDecayOverlay({
    aiState:      respAfterPlateau,
    patternStory: payload.patternStory,
    metrics:      payload.metrics,
    goldContext:  payload.goldContext,
    directionalPressure: {
      longPressure:  respAfterPlateau.longPressure,
      shortPressure: respAfterPlateau.shortPressure,
      pressureBand:  respAfterPlateau.pressureBand,
    },
    transition: {
      nextLikelyState:      respAfterPlateau.nextLikelyState,
      transitionConfidence: respAfterPlateau.transitionConfidence,
    },
    previousConfidence: null,
    latestPatternCode,
  });
  const respAfterDecay = decay.response;

  // Radar scans have no per-symbol history to inherit — pass empty.
  const dominance = deriveStructuralDominance({
    aiState:        respAfterDecay,
    priceStructure: structureRead,
    metrics:        payload.metrics,
    goldTrend:      payload.goldContext?.trend ?? 'unknown',
    recentHistory:  [],
    latestPatternCode,
    currentPressure: {
      long:  respAfterDecay.longPressure  ?? 50,
      short: respAfterDecay.shortPressure ?? 50,
    },
    runSanityGuard: false,
  });

  const temporal = deriveTemporalPressureBias({
    aiState:         respAfterDecay,
    recentHistory:   [],
    currentPressure: {
      long:  dominance.adjustedLong,
      short: dominance.adjustedShort,
    },
    metrics:        payload.metrics,
    priceStructure: structureRead,
    latestPatternCode,
  });
  const longAfterTemporal  = dominance.adjustedLong  + temporal.longAdjust;
  const shortAfterTemporal = dominance.adjustedShort + temporal.shortAdjust;

  const sanity = applyStructuralSanityGuard({
    dominance:       dominance.dominance,
    score:           dominance.score,
    currentPressure: { long: longAfterTemporal, short: shortAfterTemporal },
    faChain:         dominance.faChain,
    reclaim:         dominance.reclaim,
    structureClean:  dominance.structureClean,
    priceStructure:  structureRead,
  });
  const finalLong  = Math.max(15, Math.min(85, Math.round(sanity.long)));
  const finalShort = 100 - finalLong;

  const finalResp: GcpStateResponse = {
    ...respAfterDecay,
    longPressure:       finalLong,
    shortPressure:      finalShort,
    structureDominance: dominance.dominance,
    structureScore:     dominance.score,
    structureReasons:   [
      ...dominance.reasons,
      ...(temporal.longAdjust !== 0 ? temporal.reasons : []),
      ...sanity.reasons,
    ],
    inheritedTrend:     temporal.inheritedTrend,
    momentumState:      temporal.momentumState,
  };

  // 5. v13.9 layers — price-structure confirmation + action state.
  const priceStructure = derivePriceStructureConfirmation(candles);
  const action = deriveActionState({
    aiState:         finalResp,
    hasOpenPosition: false,
    history:         [],
    priceStructure,
  });

  if (isDev()) {
    console.log('[RADAR SCAN]', {
      symbol,
      step:    'done',
      state:   finalResp.stateCode,
      action:  action.actionState,
      clarity: Math.round((finalResp.confidence ?? 0) * 100),
    });
  }

  return {
    symbol, scannedAt, ok: true,
    aiState: finalResp,
    action,
    priceStructure,
    priceAtAnalysis: lastClose,
  };
}

// Public: sequential scan of every radar symbol. Awaits each symbol
// fully before starting the next — never parallel — so the user sees
// honest progress and the Engine is hit one call at a time.
export async function scanRadar(
  sharedInputs: GcpStateInputs,
  onProgress:   (p: RadarScanProgress) => void,
  onResult:     (r: RadarResult) => void,
): Promise<RadarScanSummary> {
  const started = Date.now();
  const total   = RADAR_SYMBOLS.length;
  let goCount   = 0;

  for (let i = 0; i < total; i++) {
    const symbol = RADAR_SYMBOLS[i];
    onProgress({ index: i, total, symbol, step: 'fetching' });
    if (isDev()) {
      console.log('[RADAR SCAN]', { symbol, step: 'fetching' });
    }
    const result = await scanSymbol(symbol, sharedInputs);
    if (result.ok && result.action?.actionState === 'GO') goCount += 1;
    onProgress({ index: i, total, symbol, step: 'done' });
    onResult(result);
  }

  const summary: RadarScanSummary = {
    durationMs:     Date.now() - started,
    symbolsScanned: total,
    goCount,
  };
  if (isDev()) console.log('[RADAR COMPLETE]', summary);
  return summary;
}
