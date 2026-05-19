// v14.10 — Phase 14.10: Opportunity distance / near-miss layer.
//
// Evidence only. BLOCKED is binary — it hides whether a symbol is
// nowhere near entry or one check away from it. This grades each of
// the eight GO checks with PARTIAL credit (a clarity of 47% is
// almost-there, not a flat fail) and rolls them into a 0-100
// closeness score, so "hard BLOCKED" and "almost READY" read
// differently.
//
// Mirrors deriveActionState's GO checks read-only. NO behavior
// change — Engine, payload, GO thresholds, classification, action
// and trade logic are untouched. This only measures distance.

import type { RadarResult } from '@/lib/radarScan';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { PriceStructureRead } from '@/lib/priceStructureConfirmation';
import type { MarketSymbol } from '@/types/gcp';

export type OpportunityStatus =
  'far' | 'building' | 'near' | 'imminent' | 'go';

export interface OpportunityDistance {
  /** 0-100 weighted closeness to a full GO. */
  score:          number;
  /** Fully-passed checks. */
  passed:         number;
  total:          number;
  /** 100 - score. */
  distance:       number;
  /** The failed check closest to passing, with a short hint. */
  nearestBlocker: string;
  status:         OpportunityStatus;
}

const TOTAL = 8;
const PER   = 100 / TOTAL;   // 12.5 points per check
const DIRECTIONAL = new Set(['IS', 'AT', 'SS']);

function contradictoryStructure(
  dom: GcpStateResponse['structureDominance'], dir: string,
): boolean {
  if (!dom || dom === 'neutral') return false;
  if (dir === 'Up'   && (dom === 'bearish' || dom === 'fragile_bearish')) return true;
  if (dir === 'Down' && (dom === 'bullish' || dom === 'fragile_bullish')) return true;
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
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

interface CheckEval { pass: boolean; credit: number; blocker: string }

export function deriveOpportunityDistance(
  result: RadarResult,
): OpportunityDistance | null {
  if (!result.ok || !result.aiState) return null;
  const ai = result.aiState;
  const ps = result.priceStructure;
  const code   = ai.stateCode;
  const phase  = ai.phase;
  const dir    = ai.direction;
  const conf   = ai.confidence ?? 0;
  const band   = ai.pressureBand;
  const dom    = ai.structureDominance;
  const moment = ai.momentumState;
  const invs   = ai.invalidators ?? [];

  const checks: CheckEval[] = [];

  // state
  checks.push(
    DIRECTIONAL.has(code) ? { pass: true,  credit: PER,       blocker: '' }
  : code === 'CS'         ? { pass: false, credit: PER * 0.5, blocker: 'needs ignition (IS/AT/SS)' }
  :                         { pass: false, credit: 0,         blocker: 'state not entry-eligible' });

  // phase
  checks.push(
    phase === 'Late'      ? { pass: false, credit: PER * 0.35, blocker: 'exit Late phase' }
  : phase === 'Exhausted' ? { pass: false, credit: 0,          blocker: 'phase exhausted' }
  :                         { pass: true,  credit: PER,        blocker: '' });

  // clarity — the one fully-numeric gap
  if (conf >= 0.50) {
    checks.push({ pass: true, credit: PER, blocker: '' });
  } else {
    const gap = Math.ceil((0.50 - conf) * 100);
    checks.push({ pass: false, credit: clamp01(conf / 0.50) * PER, blocker: `clarity needs +${gap}%` });
  }

  // edge
  checks.push(
    band === 'moderate' || band === 'strong'
      ? { pass: true,  credit: PER,        blocker: '' }
    : band === 'weak'
      ? { pass: false, credit: PER * 0.35, blocker: 'needs moderate edge' }
    :   { pass: false, credit: 0,          blocker: 'no directional edge' });

  // structure
  const contradict = contradictoryStructure(dom, dir);
  const fragile = dom === 'fragile_bullish' || dom === 'fragile_bearish';
  checks.push(
    !contradict && !fragile ? { pass: true,  credit: PER,       blocker: '' }
  : fragile                 ? { pass: false, credit: PER * 0.5, blocker: 'structure fragile' }
  :                           { pass: false, credit: 0,         blocker: 'structure contradicts' });

  // price confirmation — partial confirmation passes (mirrors GO check)
  const priceMis = priceContradicts(ps, dir);
  const pAlign   = priceAlignsWith(ps, dir);
  const pricePass = !priceMis && (ps == null
    || (pAlign && (ps.confirmation === 'confirmed' || ps.confirmation === 'partial')));
  checks.push(
    pricePass     ? { pass: true,  credit: PER,       blocker: '' }
  : priceMis      ? { pass: false, credit: 0,         blocker: 'price contradicts direction' }
  :                 { pass: false, credit: PER * 0.4, blocker: 'price not confirming' });

  // invalidators
  checks.push(
    invs.length <= 1 ? { pass: true,  credit: PER,       blocker: '' }
  : invs.length === 2 ? { pass: false, credit: PER * 0.4, blocker: '2 invalidators active' }
  :                     { pass: false, credit: 0,         blocker: `${invs.length} invalidators active` });

  // momentum — `!decayWarn` already excludes the 'exhausted' case.
  const decayWarn = code === 'DC' || moment === 'exhausted';
  checks.push(
    !decayWarn && moment !== 'decelerating' && moment !== 'transitioning'
      ? { pass: true,  credit: PER,        blocker: '' }
    : moment === 'transitioning'
      ? { pass: false, credit: PER * 0.5,  blocker: 'momentum transitioning' }
    : moment === 'decelerating'
      ? { pass: false, credit: PER * 0.35, blocker: 'momentum fading' }
    :   { pass: false, credit: 0,          blocker: 'momentum exhausted' });

  const score  = Math.round(checks.reduce((s, c) => s + c.credit, 0));
  const passed = checks.filter(c => c.pass).length;

  // Nearest blocker — the failed check carrying the most credit.
  const failed = checks.filter(c => !c.pass).sort((a, b) => b.credit - a.credit);
  const nearestBlocker = failed.length === 0
    ? 'all checks pass'
    : failed[0].blocker;

  const status: OpportunityStatus =
      score >= 100 ? 'go'
    : score >= 85  ? 'imminent'
    : score >= 65  ? 'near'
    : score >= 40  ? 'building'
    :                'far';

  return {
    score, passed, total: TOTAL,
    distance: 100 - score,
    nearestBlocker, status,
  };
}

// ── field-wide opportunity weather ──────────────────────────────────

export interface OpportunityWeather {
  counts:         Record<OpportunityStatus, number>;
  interpretation: string;
}

export function deriveOpportunityWeather(
  results: RadarResult[],
): OpportunityWeather | null {
  const ok = results.filter(r => r.ok && r.aiState);
  if (ok.length < 2) return null;

  const counts: Record<OpportunityStatus, number> = {
    far: 0, building: 0, near: 0, imminent: 0, go: 0,
  };
  const approaching: { symbol: MarketSymbol; score: number }[] = [];

  for (const r of ok) {
    const od = deriveOpportunityDistance(r);
    if (!od) continue;
    counts[od.status] += 1;
    if (od.status === 'near' || od.status === 'imminent' || od.status === 'go') {
      approaching.push({ symbol: r.symbol, score: od.score });
    }
  }

  approaching.sort((a, b) => b.score - a.score);
  const names = approaching.slice(0, 3).map(a => a.symbol).join(' and ');
  const weak = counts.far + counts.building >= ok.length - approaching.length;

  let interpretation: string;
  if (approaching.length === 0) {
    interpretation = counts.far > counts.building
      ? 'Field far from any opportunity.'
      : 'Field building — no near candidates yet.';
  } else if (weak && approaching.length <= 3) {
    interpretation = `Field weak, but ${names} approaching ignition.`;
  } else {
    interpretation = `${approaching.length} assets approaching ignition: ${names}.`;
  }

  return { counts, interpretation };
}
