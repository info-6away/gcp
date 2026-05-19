// v14.6.2 — Phase 14.6.2: Radar field diagnosis.
//
// The per-card reasoning layer explains each symbol. This rolls the
// REPEATED card-level blockers/confirmations up into one field-level
// story — "what is the field doing?" answered before "what is each
// asset doing?".
//
// Pure aggregation. No Engine, no AI, no recompute — it only counts
// the cues deriveRadarReasoning already produced per card.

import type { RadarResult } from '@/lib/radarScan';
import { deriveRadarReasoning } from '@/lib/radarReasoning';

export type DiagnosisSeverity = 'calm' | 'watch' | 'warning' | 'risk';

export interface FieldDiagnosis {
  title:             string;
  summary:           string;
  dominantCondition: string;
  affectedCount:     number;
  total:             number;
  severity:          DiagnosisSeverity;
  bullets:           string[];
}

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export function deriveFieldDiagnosis(
  results: RadarResult[],
): FieldDiagnosis | null {
  const ok = results.filter(r => r.ok && r.aiState && r.action);
  if (ok.length < 2) return null;
  const total = ok.length;

  // Action-state spread.
  let ready = 0, watch = 0, blocked = 0, go = 0;
  for (const r of ok) {
    const a = r.action!.actionState;
    if      (a === 'READY')   ready++;
    else if (a === 'WATCH')   watch++;
    else if (a === 'BLOCKED') blocked++;
    else if (a === 'GO')      go++;
  }

  // Repeated blocker / confirmation phrases across every card.
  const blockerCounts: Record<string, number> = {};
  for (const r of ok) {
    const reasoning = deriveRadarReasoning(r);
    if (!reasoning) continue;
    for (const b of reasoning.blockers) {
      blockerCounts[b.text] = (blockerCounts[b.text] ?? 0) + 1;
    }
  }
  const blockerRanked = Object.entries(blockerCounts)
    .sort((a, b) => b[1] - a[1]);

  const goReady   = go + ready;
  const maxAction = Math.max(ready, watch, blocked, go);

  let title: string;
  let summary: string;
  let dominantCondition: string;
  let affectedCount: number;
  let severity: DiagnosisSeverity;

  if (goReady >= 5) {
    title = 'Opportunity window opening';
    dominantCondition = 'structure confirmation';
    affectedCount = goReady;
    severity = 'calm';
    summary = `${goReady}/${total} assets are READY${go > 0 ? '/GO' : ''} with structure confirmation.`;
  } else if (blocked >= 7) {
    title = 'Defensive field';
    const t1 = blockerRanked[0];
    const t2 = blockerRanked[1];
    dominantCondition = t1 ? t1[0] : 'weak structure';
    affectedCount = blocked;
    severity = 'risk';
    summary = `${blocked}/${total} assets blocked`
      + (t1 ? ` — mostly ${t1[0]}` : '')
      + (t2 ? ` and ${t2[0]}` : '') + '.';
  } else if (watch >= Math.ceil(total / 2)) {
    title = 'Transition field';
    dominantCondition = 'forming, unconfirmed';
    affectedCount = watch;
    severity = 'watch';
    summary = `${watch}/${total} assets are forming but not yet confirmed.`;
  } else if (maxAction / total < 0.5) {
    title = 'Fragmented field';
    dominantCondition = 'mixed reads';
    affectedCount = total;
    severity = 'warning';
    summary = 'Assets disagree — use symbol-level confirmation.';
  } else {
    title = 'Mixed field';
    dominantCondition = blockerRanked[0]?.[0] ?? 'mixed conditions';
    affectedCount = blocked;
    severity = 'warning';
    summary = `${ready} ready · ${watch} watch · ${blocked} blocked.`;
  }

  // Bullets — the repeated conditions made explicit, capped at 4.
  const bullets: string[] = [];
  for (const [text, n] of blockerRanked) {
    if (n >= 2 && bullets.length < 2) {
      bullets.push(`${cap(text)} across ${n} assets`);
    }
  }
  bullets.push(goReady > 0
    ? `${goReady} READY/GO candidate${goReady === 1 ? '' : 's'}`
    : 'No READY/GO candidates');
  if (watch > 0) {
    bullets.push(`${watch} asset${watch === 1 ? '' : 's'} in WATCH`);
  }

  return {
    title, summary, dominantCondition,
    affectedCount, total, severity,
    bullets: bullets.slice(0, 4),
  };
}
