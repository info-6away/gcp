// v14.6.1 — Phase 14.6.1: Radar thesis summary.
//
// A single ≤60-char sentence per Radar card — the "personality
// layer" that lets the eye scan ten symbols without parsing each
// diagnostic. Pure derivation from fields already on the result;
// no AI, no Engine, no recompute of the verdict.

import type { RadarResult } from '@/lib/radarScan';

const MAX = 60;

export function deriveRadarThesisSummary(result: RadarResult): string | null {
  if (!result.ok || !result.aiState || !result.action) return null;
  const ai  = result.aiState;
  const ps  = result.priceStructure;
  const act = result.action.actionState;
  const code = ai.stateCode;
  const dir  = ai.direction;
  const invs = ai.invalidators ?? [];
  const transC = ai.transitionConfidence ?? 0;

  const structContra = !!ps &&
    ((dir === 'Up'   && ps.structure === 'bearish') ||
     (dir === 'Down' && ps.structure === 'bullish'));
  const structWeak = !ps || ps.structure === 'neutral';

  let s: string;
  switch (act) {
    case 'GO':
      s = 'All conditions aligned. Entry permitted.';
      break;
    case 'READY':
      s = code === 'IS' ? 'Ignition aligned. Awaiting trigger.'
        : code === 'AT' ? 'Trend intact. Awaiting continuation.'
        : code === 'SS' ? 'Synchronized. Awaiting extension.'
        :                 'Build-up complete. Awaiting continuation.';
      break;
    case 'WATCH':
      s = code === 'CS' ? 'Compression unresolved. Confirmation pending.'
        : code === 'IS' ? 'Ignition forming. Confirmation pending.'
        :                 'Pressure building. Confirmation pending.';
      break;
    case 'MANAGE':
      s = 'Position valid. Manage exposure.';
      break;
    case 'EXIT':
      s = 'Thesis broken. Exit setup.';
      break;
    default: // BLOCKED
      s = invs.length >= 1
            ? 'Invalidators active. No entry edge.'
        : structContra
            ? 'Structure fighting state.'
        : code === 'CS'
            ? 'Compression without ignition.'
        : (dir !== 'Neutral' && dir !== 'Mixed' && structWeak)
            ? `Field ${dir === 'Up' ? 'bullish' : 'bearish'}, asset reaction weak.`
        : (ai.nextLikelyState && transC > 0 && transC < 0.4)
            ? 'Transition incomplete.'
        :     'No directional edge.';
  }

  return s.length > MAX ? s.slice(0, MAX - 1) + '…' : s;
}
