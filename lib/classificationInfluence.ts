// v16.0 — Phase 16: Classification source audit.
//
// The Radar keeps returning near-identical reads across 10 symbols.
// Phase 14.5 measured field vs symbol weight; this asks the sharper
// architectural question: of the classification itself, how much is
// driven by the SHARED coherence field (state inheritance, regime,
// pattern story, GCP slope, momentum — all identical across symbols
// in a scan) versus the symbol's OWN price (structure, trend,
// confirmation, momentum, volatility)?
//
// If field influence is high with high confidence, "10 BLOCKED" is
// partly classification ARCHITECTURE, not pure market reality.
//
// Pure diagnostic. No Engine, prompt, threshold, or trade change.

import type { RadarResult } from '@/lib/radarScan';

export interface ClassificationInfluence {
  /** 0-100 — share of the read attributable to the shared field. */
  fieldInfluence:  number;
  /** 0-100 — share attributable to the symbol's own price. */
  symbolInfluence: number;
  /** 0-100 — how reliable this estimate is (low when the symbol has
   *  little price-structure signal to weigh). */
  confidence:      number;
  fieldSignals:    string[];
  symbolSignals:   string[];
}

export function deriveClassificationInfluence(
  result: RadarResult,
): ClassificationInfluence | null {
  if (!result.ok || !result.aiState) return null;
  const ai = result.aiState;
  const ps = result.priceStructure;

  let fieldScore  = 0;
  let symbolScore = 0;
  const fieldSignals:  string[] = [];
  const symbolSignals: string[] = [];

  // ── FIELD — shared-coherence inputs (identical for every symbol
  //    in a scan: GCP series, energy metrics, regime, pattern story) ─
  fieldScore += 24; fieldSignals.push('shared coherence field');
  fieldScore += 10; fieldSignals.push('regime-driven state');
  if (ai.inheritedTrend && ai.inheritedTrend !== 'neutral') {
    fieldScore += 18; fieldSignals.push('state inheritance');
  }
  if (ai.momentumState === 'transitioning' || ai.momentumState === 'exhausted') {
    fieldScore += 12; fieldSignals.push('shared momentum read');
  }
  if ((ai.transitionConfidence ?? 0) >= 0.40) {
    fieldScore += 8;  fieldSignals.push('transition pressure');
  }

  // ── SYMBOL — price-rooted inputs (this asset's own candles) ───────
  if (ps && ps.structure !== 'neutral') {
    symbolScore += 20; symbolSignals.push(`${ps.structure} price structure`);
  }
  if (ps?.confirmation === 'confirmed') {
    symbolScore += 12; symbolSignals.push('structure confirmed');
  } else if (ps?.confirmation === 'partial') {
    symbolScore += 6;  symbolSignals.push('partial confirmation');
  }
  if (ps && (ps.trend === 'up' || ps.trend === 'down')) {
    symbolScore += 10; symbolSignals.push(`${ps.trend}trend in price`);
  }
  const dom = ai.structureDominance;
  if (dom && dom !== 'neutral') {
    symbolScore += 14; symbolSignals.push('structural dominance');
  }
  if (ai.momentumState === 'accelerating') {
    symbolScore += 10; symbolSignals.push('symbol momentum');
  }

  const total = fieldScore + symbolScore;
  const fieldInfluence  = total <= 0 ? 50 : Math.round((fieldScore / total) * 100);
  const symbolInfluence = 100 - fieldInfluence;

  // Confidence — the split is only trustworthy when there's real
  // price-structure signal to weigh on the symbol side.
  let confidence = 45;
  if (ps && ps.structure !== 'neutral') confidence += 25;
  if (ps?.confirmation === 'confirmed' || ps?.confirmation === 'partial') confidence += 15;
  if (dom && dom !== 'neutral') confidence += 15;
  confidence = Math.min(100, confidence);

  return { fieldInfluence, symbolInfluence, confidence, fieldSignals, symbolSignals };
}

// ── field-wide anchoring roll-up ────────────────────────────────────

export interface FieldAnchoring {
  avgFieldInfluence: number;
  avgConfidence:     number;
  interpretation:    string;
  sampled:           number;
}

export function deriveFieldAnchoring(
  results: RadarResult[],
): FieldAnchoring | null {
  const infs = results
    .map(r => deriveClassificationInfluence(r))
    .filter((x): x is ClassificationInfluence => x != null);
  if (infs.length === 0) return null;

  const avgField = Math.round(
    infs.reduce((s, i) => s + i.fieldInfluence, 0) / infs.length);
  const avgConf = Math.round(
    infs.reduce((s, i) => s + i.confidence, 0) / infs.length);

  const interpretation =
      avgField >= 75 ? 'Engine heavily driven by shared field — symbol individuality minimal.'
    : avgField >= 58 ? 'Engine moderately field-driven; limited symbol individuality.'
    : avgField >= 42 ? 'Balanced — field and symbol both contribute.'
    :                  'Symbol price leads — classification is asset-specific.';

  return {
    avgFieldInfluence: avgField,
    avgConfidence:     avgConf,
    interpretation,
    sampled:           infs.length,
  };
}
