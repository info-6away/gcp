// v14.5 — Phase 14.5: Symbol Individuality Audit.
//
// Diagnostics only. The Radar has been returning the SAME read
// (e.g. CS·Late·BLOCKED) across all 10 symbols at 100% agreement.
// That could be genuine field synchronization — or the shared
// coherence inputs (GCP series, metrics, regime, pattern story are
// identical for every symbol in a scan) overwhelming each asset's
// own price individuality.
//
// deriveSymbolIndividuality quantifies, per symbol, how much of the
// read is FIELD-driven (shared coherence) vs SYMBOL-driven (that
// asset's own price structure). It changes NO behavior — no Engine,
// no GO criteria, no thresholds. It only measures, so the over-
// anchoring question can be answered with evidence.
//
// Conservative heuristic: a flat points table, normalised to 100.

import type { RadarResult } from '@/lib/radarScan';

export type IndividualityVerdict =
  'field_dominant' | 'balanced' | 'symbol_dominant';

export interface SymbolIndividuality {
  /** 0-100 — share of the read attributable to shared coherence. */
  fieldWeight:   number;
  /** 0-100 — share attributable to the symbol's own price. = 100-field. */
  symbolWeight:  number;
  fieldDrivers:  string[];
  symbolDrivers: string[];
  /** Alias of symbolWeight — higher = more individual. */
  individuality: number;
  verdict:       IndividualityVerdict;
}

export function deriveSymbolIndividuality(
  result: RadarResult,
): SymbolIndividuality | null {
  if (!result.ok || !result.aiState) return null;
  const ai = result.aiState;
  const ps = result.priceStructure;

  let fieldScore = 0;
  let symbolScore = 0;
  const fieldDrivers:  string[] = [];
  const symbolDrivers: string[] = [];

  // ── FIELD — coherence-rooted signals ──────────────────────────────
  // Every classification is a coherence read at its root.
  fieldScore += 12; fieldDrivers.push('coherence classification');

  if (ai.inheritedTrend && ai.inheritedTrend !== 'neutral') {
    fieldScore += 20; fieldDrivers.push('state inheritance');
  }
  // Late / Exhausted phase ⇒ the state has been holding — persistence.
  if (ai.phase === 'Late' || ai.phase === 'Exhausted') {
    fieldScore += 15; fieldDrivers.push('state persistence');
  }
  if ((ai.transitionConfidence ?? 0) >= 0.40) {
    fieldScore += 10; fieldDrivers.push('transition pressure');
  }
  if (ai.momentumState === 'transitioning' || ai.momentumState === 'exhausted') {
    fieldScore += 10; fieldDrivers.push('coherence momentum');
  }

  // ── SYMBOL — price-rooted signals (from that asset's own candles) ──
  if (ps) {
    if (ps.structure === 'bullish') {
      symbolScore += 20; symbolDrivers.push('bullish price structure');
    } else if (ps.structure === 'bearish') {
      symbolScore += 20; symbolDrivers.push('bearish price structure');
    }
    if (ps.confirmation === 'confirmed') {
      symbolScore += 12; symbolDrivers.push('price structure confirmed');
    } else if (ps.confirmation === 'partial') {
      symbolScore += 6;  symbolDrivers.push('partial structure confirmation');
    }
    if (ps.trend === 'up' || ps.trend === 'down') {
      symbolScore += 10; symbolDrivers.push(`${ps.trend}trend in price`);
    }
  }
  const dom = ai.structureDominance;
  if (dom && dom !== 'neutral') {
    symbolScore += 15;
    symbolDrivers.push(
      dom.includes('bull') ? 'bullish structural dominance'
                           : 'bearish structural dominance',
    );
  }
  if (ai.momentumState === 'accelerating') {
    symbolScore += 10; symbolDrivers.push('price momentum');
  }
  // Engine direction confirmed by the symbol's own structure.
  if (ps && (
      (ai.direction === 'Up'   && ps.structure === 'bullish') ||
      (ai.direction === 'Down' && ps.structure === 'bearish'))) {
    symbolScore += 10; symbolDrivers.push('trend agreement');
  }

  // ── normalise to 100 ──────────────────────────────────────────────
  const total = fieldScore + symbolScore;
  const fieldWeight  = total <= 0 ? 50 : Math.round((fieldScore / total) * 100);
  const symbolWeight = 100 - fieldWeight;

  const verdict: IndividualityVerdict =
      fieldWeight >= 62 ? 'field_dominant'
    : fieldWeight <= 42 ? 'symbol_dominant'
    :                     'balanced';

  return {
    fieldWeight, symbolWeight,
    fieldDrivers, symbolDrivers,
    individuality: symbolWeight,
    verdict,
  };
}
