// v14.9 — Phase 14.9: Action ladder calibration audit.
//
// Evidence only. The Radar keeps returning BLOCKED — but WHICH check
// is doing the blocking? This re-evaluates the GO-cascade checks
// (read-only, same predicates deriveActionState uses) for every
// scanned symbol, records the failures, and rolls them up field-wide.
//
// The point: distinguish "every rule is slightly too strict" from
// "one blocker dominates everything". If 10/10 fail the SAME check,
// that check is the calibration target — not the whole ladder.
//
// NO behavior change. deriveActionState, GO thresholds, classification
// and trade logic are untouched — this only inspects.

import type { RadarResult } from '@/lib/radarScan';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { PriceStructureRead } from '@/lib/priceStructureConfirmation';

// The audited GO checks, in ladder order.
export type LadderCheckName =
  | 'state' | 'phase' | 'clarity' | 'edge'
  | 'structure' | 'priceConfirmation' | 'invalidator' | 'momentum';

const CHECK_LABEL: Record<LadderCheckName, string> = {
  state:             'Non-directional state',
  phase:             'Late / exhausted phase',
  clarity:           'Clarity < 50%',
  edge:              'Weak directional edge',
  structure:         'Weak / contradicting structure',
  priceConfirmation: 'Price not confirming',
  invalidator:       'Invalidators active',
  momentum:          'Momentum unhealthy',
};

const CHECK_ORDER: LadderCheckName[] = [
  'state', 'phase', 'clarity', 'edge',
  'structure', 'priceConfirmation', 'invalidator', 'momentum',
];

const DIRECTIONAL = new Set(['IS', 'AT', 'SS']);

export interface LadderAuditRecord {
  symbol:       string;
  actionState:  string;
  failedChecks: LadderCheckName[];
}

export interface LadderBlocker {
  name:  LadderCheckName;
  label: string;
  count: number;
  pct:   number;   // 0-100
}

export interface ActionLadderAudit {
  records:        LadderAuditRecord[];
  topBlockers:    LadderBlocker[];
  interpretation: string;
  total:          number;
}

// ── GO-check predicates — mirror deriveActionState (read-only) ───────

function contradictoryStructure(
  dom: GcpStateResponse['structureDominance'], direction: string,
): boolean {
  if (!dom || dom === 'neutral') return false;
  if (direction === 'Up'   && (dom === 'bearish' || dom === 'fragile_bearish')) return true;
  if (direction === 'Down' && (dom === 'bullish' || dom === 'fragile_bullish')) return true;
  return false;
}
function priceContradicts(ps: PriceStructureRead | null | undefined, dir: string): boolean {
  if (!ps) return false;
  if (dir === 'Up'   && ps.structure === 'bearish') return true;
  if (dir === 'Down' && ps.structure === 'bullish') return true;
  return false;
}
function priceAlignsWith(ps: PriceStructureRead | null | undefined, dir: string): boolean {
  if (!ps) return false;
  if (dir === 'Up'   && ps.structure === 'bullish') return true;
  if (dir === 'Down' && ps.structure === 'bearish') return true;
  return false;
}

function failedChecksFor(result: RadarResult): LadderCheckName[] {
  const ai = result.aiState!;
  const ps = result.priceStructure;
  const code   = ai.stateCode;
  const phase  = ai.phase;
  const dir    = ai.direction;
  const conf   = ai.confidence ?? 0;
  const band   = ai.pressureBand;
  const dom    = ai.structureDominance;
  const moment = ai.momentumState;
  const invs   = ai.invalidators ?? [];

  const isLate    = phase === 'Late' || phase === 'Exhausted';
  const decayWarn = code === 'DC' || moment === 'exhausted';
  const priceMis  = priceContradicts(ps, dir);
  const pAlign    = priceAlignsWith(ps, dir);

  const failed: LadderCheckName[] = [];
  if (!DIRECTIONAL.has(code)) failed.push('state');
  if (isLate) failed.push('phase');
  if (conf < 0.50) failed.push('clarity');
  if (!(band === 'moderate' || band === 'strong')) failed.push('edge');
  if (contradictoryStructure(dom, dir)
      || dom === 'fragile_bullish' || dom === 'fragile_bearish') {
    failed.push('structure');
  }
  if (priceMis ||
      (ps != null && !(pAlign &&
        (ps.confirmation === 'confirmed' || ps.confirmation === 'partial')))) {
    failed.push('priceConfirmation');
  }
  if (invs.length > 1) failed.push('invalidator');
  if (moment === 'decelerating' || moment === 'exhausted'
      || moment === 'transitioning' || decayWarn) {
    failed.push('momentum');
  }
  return failed;
}

export function deriveActionLadderAudit(
  results: RadarResult[],
): ActionLadderAudit | null {
  const ok = results.filter(r => r.ok && r.aiState && r.action);
  if (ok.length < 2) return null;
  const total = ok.length;

  const records: LadderAuditRecord[] = ok.map(r => ({
    symbol:       r.symbol,
    actionState:  r.action!.actionState,
    failedChecks: failedChecksFor(r),
  }));

  const counts: Record<LadderCheckName, number> = {
    state: 0, phase: 0, clarity: 0, edge: 0,
    structure: 0, priceConfirmation: 0, invalidator: 0, momentum: 0,
  };
  for (const rec of records) {
    for (const c of rec.failedChecks) counts[c] += 1;
  }

  const topBlockers: LadderBlocker[] = CHECK_ORDER
    .map(name => ({
      name,
      label: CHECK_LABEL[name],
      count: counts[name],
      pct:   Math.round((counts[name] / total) * 100),
    }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.count - a.count);

  // Interpretation — does one check dominate, or do they cluster?
  let interpretation: string;
  if (topBlockers.length === 0) {
    interpretation = 'No GO check is failing — the field is entry-eligible.';
  } else {
    const top = topBlockers[0];
    const second = topBlockers[1];
    const dominant = top.pct >= 80 && (!second || top.count - second.count >= total * 0.3);
    const clustered = topBlockers.filter(b => b.pct >= 70).length >= 3;
    interpretation = dominant
      ? `Most assets fail at the same stage — ${top.label.toLowerCase()}.`
      : clustered
        ? 'Most assets fail several checks together — broad, not a single gate.'
        : 'Assets fail at varied stages — no single dominant blocker.';
  }

  return { records, topBlockers, interpretation, total };
}
