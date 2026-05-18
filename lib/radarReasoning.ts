// v14.6 — Phase 14.6: Radar reasoning layer.
//
// Turns a Radar result from a verdict ("READY") into an explanation
// ("READY because structure aligned, ignition present, bullish
// dominance"). It does NOT recompute or change the verdict — the
// action state, classification, pressure, dominance and GO criteria
// are all upstream and untouched. This only REVEALS the signals the
// pipeline already weighed, as short chip-friendly phrases.
//
// Pure derivation. No Engine, no network, no AI, no thresholds.

import type { RadarResult } from '@/lib/radarScan';

export interface RadarReasoning {
  /** Aligned signals — max 3, priority-ordered, short phrases. */
  confirmations:    string[];
  /** Missing / contradicting signals — max 3, priority-ordered. */
  blockers:         string[];
  /** One-line plain-English read tying the verdict together. */
  summary:          string;
  /** Why clarity is where it is. */
  confidenceReason: string;
}

interface Cue { text: string; pri: number }

const DIRECTIONAL = new Set(['IS', 'AT', 'SS']);
const EVENT_LABEL: Record<string, string> = {
  FA: 'failed alignment',
  SH: 'shock event',
  CL: 'climax exhaustion',
  DC: 'directional decay',
  DS: 'discharge unwinding',
  DD: 'dead drift — no edge',
};

function top3(cues: Cue[]): string[] {
  return cues
    .sort((a, b) => b.pri - a.pri)
    .slice(0, 3)
    .map(c => c.text);
}

export function deriveRadarReasoning(result: RadarResult): RadarReasoning | null {
  if (!result.ok || !result.aiState || !result.action) return null;
  const ai  = result.aiState;
  const ps  = result.priceStructure;
  const act = result.action.actionState;

  const code   = ai.stateCode;
  const phase  = ai.phase;
  const dir    = ai.direction;
  const conf   = ai.confidence ?? 0;
  const band   = ai.pressureBand;
  const dom    = ai.structureDominance;
  const moment = ai.momentumState;
  const invs   = ai.invalidators ?? [];
  const transC = ai.transitionConfidence ?? 0;
  const next   = ai.nextLikelyState;
  const isLate = phase === 'Late' || phase === 'Exhausted';

  const structAligned =
    !!ps && ((dir === 'Up'   && ps.structure === 'bullish') ||
             (dir === 'Down' && ps.structure === 'bearish'));
  const structContra =
    !!ps && ((dir === 'Up'   && ps.structure === 'bearish') ||
             (dir === 'Down' && ps.structure === 'bullish'));
  const domAligned = !!dom && dom !== 'neutral'
    && !dom.includes('fragile');

  const confirmations: Cue[] = [];
  const blockers:      Cue[] = [];

  // ── state ─────────────────────────────────────────────────────────
  if (code === 'IS')      confirmations.push({ text: 'ignition present',    pri: 9 });
  else if (code === 'AT') confirmations.push({ text: 'trend active',        pri: 9 });
  else if (code === 'SS') confirmations.push({ text: 'synchronization',     pri: 9 });
  else if (code === 'CS') blockers.push({ text: 'compression, no ignition', pri: 7 });
  else if (EVENT_LABEL[code]) blockers.push({ text: EVENT_LABEL[code],      pri: 9 });

  // ── price structure ───────────────────────────────────────────────
  if (structAligned)      confirmations.push({ text: 'structure aligned',   pri: 8 });
  else if (structContra)  blockers.push({ text: 'structure contradicts',    pri: 8 });
  else                    blockers.push({ text: 'weak structure',           pri: 6 });

  if (ps?.confirmation === 'confirmed') {
    confirmations.push({ text: 'price confirmed', pri: 6 });
  } else if (ps?.confirmation === 'rejected') {
    blockers.push({ text: 'confirmation missing', pri: 5 });
  } else if (ps?.confirmation === 'partial') {
    blockers.push({ text: 'confirmation partial', pri: 3 });
  }

  // ── structural dominance ──────────────────────────────────────────
  if (domAligned) {
    confirmations.push({
      text: dom!.includes('bull') ? 'bullish dominance' : 'bearish dominance',
      pri: 7,
    });
  } else if (dom && dom.includes('fragile')) {
    blockers.push({ text: 'fragile dominance', pri: 5 });
  }

  // ── momentum ──────────────────────────────────────────────────────
  if (moment === 'accelerating')        confirmations.push({ text: 'momentum healthy', pri: 6 });
  else if (moment === 'exhausted')      blockers.push({ text: 'momentum exhausted',    pri: 6 });
  else if (moment === 'decelerating')   blockers.push({ text: 'momentum fading',       pri: 4 });

  // ── directional edge ──────────────────────────────────────────────
  if (band === 'strong')        confirmations.push({ text: 'strong edge',   pri: 7 });
  else if (band === 'moderate') confirmations.push({ text: 'directional edge', pri: 6 });
  else if (band === 'weak')     blockers.push({ text: 'weak directional edge', pri: 6 });

  // ── transition ladder ─────────────────────────────────────────────
  if (next && transC >= 0.5)        confirmations.push({ text: 'transition forming',   pri: 5 });
  else if (next && transC > 0 && transC < 0.4) blockers.push({ text: 'transition incomplete', pri: 6 });

  // ── phase + clarity ───────────────────────────────────────────────
  if (DIRECTIONAL.has(code) && !isLate) confirmations.push({ text: 'phase fresh', pri: 4 });
  else if (isLate)                      blockers.push({ text: 'late phase',       pri: 5 });

  if (conf >= 0.60)      confirmations.push({ text: 'clarity strong',   pri: 5 });
  else if (conf >= 0.50) confirmations.push({ text: 'clarity moderate', pri: 3 });
  else if (conf < 0.40)  blockers.push({ text: 'low clarity',           pri: 6 });

  // ── invalidators ──────────────────────────────────────────────────
  if (invs.length === 0)      confirmations.push({ text: 'invalidation clean', pri: 3 });
  else                        blockers.push({ text: 'invalidator active',      pri: 9 });

  const confs = top3(confirmations);
  const blks  = top3(blockers);

  // ── summary ───────────────────────────────────────────────────────
  const sp = `${code} ${phase}`;
  const lead = blks[0];
  const summary =
      act === 'GO'
        ? `${sp} — structure, edge and clarity all aligned; entry permitted.`
    : act === 'READY'
        ? `${sp} is structurally aligned${lead ? ` but ${lead}` : ''} — awaiting the confirmation trigger.`
    : act === 'WATCH'
        ? `${sp} is still forming${lead ? ` — ${lead}` : ''}; confirmation incomplete.`
    : act === 'MANAGE'
        ? `${sp} — open position still valid; manage exposure.`
    : act === 'EXIT'
        ? `${sp} — thesis broken${lead ? ` (${lead})` : ''}; exit setup.`
    :     `${lead ?? 'No directional edge'} — ${sp} offers no entry.`;

  // ── confidence reason ─────────────────────────────────────────────
  const clarityPct = Math.round(conf * 100);
  const clarityWord = conf >= 0.60 ? 'strong' : conf >= 0.50 ? 'moderate' : 'thin';
  const edgeWord = band ?? 'unclassified';
  const confidenceReason =
    `Read clarity ${clarityPct}% (${clarityWord}) on a ${edgeWord} directional edge.`;

  return { confirmations: confs, blockers: blks, summary, confidenceReason };
}
