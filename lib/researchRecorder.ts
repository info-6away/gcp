// v17.0 — Phase 17: Research persistence layer.
//
// Unified observation recorder for Research. The Research view used to
// see ONLY manual "Ask Guru" reads — radar scan results never landed
// in localStorage, so the validation surface was blind to most of the
// system's actual output. This module is the single place that writes
// an observation, regardless of which surface produced it:
//
//   • manual Guru classification (single-symbol Ask Guru flow)
//   • radar scan (one observation per symbol per scan)
//
// Both paths funnel into the existing aiStateHistory ledger — no
// parallel store, no migration. v17.0 added three optional fields to
// AiStateHistoryRecord (opportunityScore, opportunityStatus, source),
// so older records degrade gracefully.
//
// CRITICAL: this module does NOT modify Engine output, payloads,
// prompts, thresholds, or classification logic. It only persists the
// already-derived radar result + opportunity distance into research
// memory. Forward-return outcomes are computed lazily by ResearchView
// from candles (same as before v17.0); no candle-fetching here.

import {
  appendAiStateHistory, type AiStateHistoryInput,
} from '@/lib/aiStateHistory';
import { deriveOpportunityDistance } from '@/lib/opportunityDistance';
import type { RadarResult } from '@/lib/radarScan';
import type { FieldSignature } from '@/lib/fieldSignature';

const isDev = () =>
  typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';

/** Common shape — every observation source normalizes into this
 *  before delegating to appendAiStateHistory. */
export interface ResearchObservationInput
  extends Omit<AiStateHistoryInput, 'source'> {
  /** Provenance — defaults to 'manual_guru' on the single-symbol path. */
  source?: 'manual_guru' | 'radar_scan';
  opportunityScore?:  number;
  opportunityStatus?: 'far' | 'building' | 'near' | 'imminent' | 'go';
}

/** Generic write — manual flows can call this directly when they have
 *  the full input pre-built. Mostly an explicit contract; the manual
 *  Ask Guru path still calls appendAiStateHistory itself, and gets
 *  source/opportunity fields filled in at v17.0+. */
export function recordResearchObservation(
  input: ResearchObservationInput,
): void {
  appendAiStateHistory({
    ...input,
    source: input.source ?? 'manual_guru',
  });
}

/** Radar-scan adapter — converts one RadarResult into a research
 *  observation and persists it. Idempotent at the ledger level
 *  (appendAiStateHistory dedupes within 60s on same state/phase/dir),
 *  so re-scanning a stable symbol won't spam the history.
 *
 *  Skips failed scans, missing aiState, and missing action — the
 *  research ledger only records actionable classifications.  */
export function recordRadarScanObservation(args: {
  result:    RadarResult;
  timeframe: string;
  regime:    string;
  /** Bar net-variance at scan time — same field the manual path stores.
   *  Optional; falls through as 0 when the radar surface doesn't have
   *  it readily. */
  netVariance?: number;
  /** v17.2: field context snapshot for this scan. Computed once per
   *  scan and attached to every observation it produces so Research
   *  can slice history by surrounding conditions. */
  fieldSignature?: FieldSignature;
}): void {
  const { result, timeframe, regime, fieldSignature } = args;
  if (!result.ok || !result.aiState || !result.action) return;

  const ai = result.aiState;
  const opp = deriveOpportunityDistance(result);
  // Position-aware action states (MANAGE/EXIT) never enter the history
  // ledger — Research is interested in the environment read, not
  // whether a position happens to be open. Radar always scans with no
  // position context, so this guard is belt-and-suspenders.
  const env = result.action.actionState;
  const actionForLedger: 'BLOCKED' | 'WATCH' | 'READY' | 'GO' | undefined =
    env === 'BLOCKED' || env === 'WATCH' || env === 'READY' || env === 'GO'
      ? env
      : undefined;

  appendAiStateHistory({
    timestamp:       result.scannedAt,
    symbol:          result.symbol,
    timeframe,
    state:           ai.state,
    stateCode:       ai.stateCode,
    phase:           ai.phase,
    direction:       ai.direction,
    confidence:      ai.confidence,
    marketBias:      ai.marketBias,
    regime,
    netVariance:     args.netVariance ?? 0,
    priceAtAnalysis: result.priceAtAnalysis ?? null,

    longPressure:    ai.longPressure,
    shortPressure:   ai.shortPressure,
    pressureBand:    ai.pressureBand,

    structureDominance: ai.structureDominance,
    structureScore:     ai.structureScore,
    structureReasons:   ai.structureReasons,
    inheritedTrend:     ai.inheritedTrend,
    momentumState:      ai.momentumState,

    nextLikelyState:      ai.nextLikelyState,
    transitionConfidence: ai.transitionConfidence,

    stale:        result.aiState.stale,
    staleReason:  result.aiState.staleReason,

    actionState:       actionForLedger,
    opportunityScore:  opp?.score,
    opportunityStatus: opp?.status,
    source:            'radar_scan',
    fieldSignature,
  });

  if (isDev()) {
    console.log('[RESEARCH RECORDER] radar scan persisted', {
      symbol:    result.symbol,
      stateCode: ai.stateCode,
      action:    env,
      opp:       opp ? `${opp.status}/${opp.score}%` : null,
    });
  }
}
