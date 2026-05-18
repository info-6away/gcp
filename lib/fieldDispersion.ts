// v14.4 — Phase 14.4: Field Dispersion diagnostics.
//
// Measures whether a Radar scan shows the coherence field behaving as
// ONE thing (every symbol reading the same) or as many fragmented
// things. This is evidence-gathering, not a control: it helps tell
// three cases apart —
//
//   • genuine field synchronization  — symbols agree because the
//     global coherence field really is unified
//   • market fragmentation           — symbols diverge; assets are
//     expressing the field individually
//   • over-anchoring suspicion       — symbols agree suspiciously
//     hard (e.g. everything SH·Late·BLOCKED) which MIGHT be the
//     pipeline collapsing individuality rather than a real read
//
// deriveFieldDispersion does NOT decide which case it is — it just
// quantifies agreement so the user (and later analysis) can judge.
// No action thresholds are touched.

import type { RadarResult } from '@/lib/radarScan';

export type DispersionLevel =
  'very_low' | 'low' | 'moderate' | 'high' | 'extreme';

export interface FieldDispersion {
  level:          DispersionLevel;
  /** % of scanned symbols sharing the dominant action state. */
  agreementPct:   number;
  /** Most common "stateCode · phase" across the scan. */
  dominantState:  string;
  /** Most common action state across the scan. */
  dominantAction: string;
  /** One-line plain-English read. */
  summary:        string;
  /** Effective number of distinct expressions (1 = all identical). */
  diversity:      number;
  stateCounts:    Record<string, number>;
  actionCounts:   Record<string, number>;
  /** Symbols sharing the dominant action / total scored. */
  agreeCount:     number;
  total:          number;
}

function argmax(counts: Record<string, number>): { key: string; n: number } {
  let key = '', n = -1;
  for (const [k, v] of Object.entries(counts)) {
    if (v > n) { n = v; key = k; }
  }
  return { key, n };
}

// Perplexity (2^Shannon-entropy) — the "effective number of distinct
// categories". 1 when every reading is identical; rises as the scan
// fragments. A scale-free way to express spread.
function perplexity(counts: Record<string, number>, total: number): number {
  if (total <= 0) return 1;
  let h = 0;
  for (const v of Object.values(counts)) {
    if (v <= 0) continue;
    const p = v / total;
    h -= p * Math.log2(p);
  }
  return Math.pow(2, h);
}

export function deriveFieldDispersion(
  results: RadarResult[],
): FieldDispersion | null {
  const ok = results.filter(r => r.ok && r.aiState && r.action);
  // Dispersion is meaningless below two data points.
  if (ok.length < 2) return null;
  const total = ok.length;

  const stateCounts:  Record<string, number> = {};
  const actionCounts: Record<string, number> = {};
  const dirCounts:    Record<string, number> = {};
  for (const r of ok) {
    const st = `${r.aiState!.stateCode} · ${r.aiState!.phase}`;
    const ac = r.action!.actionState;
    const dr = r.aiState!.direction;
    stateCounts[st]  = (stateCounts[st]  ?? 0) + 1;
    actionCounts[ac] = (actionCounts[ac] ?? 0) + 1;
    dirCounts[dr]    = (dirCounts[dr]    ?? 0) + 1;
  }

  const domAction = argmax(actionCounts);
  const domState  = argmax(stateCounts);
  const agreementPct = Math.round((domAction.n / total) * 100);

  // Diversity blends state spread and direction spread — the two
  // dimensions that say "are the assets behaving individually".
  const diversity = +(
    (perplexity(stateCounts, total) + perplexity(dirCounts, total)) / 2
  ).toFixed(1);

  // Higher agreement ⇒ LOWER dispersion. Thresholds chosen so the
  // spec's anchor cases land right: ~95% → very_low, ~80% → low,
  // ~34% → high.
  const level: DispersionLevel =
      agreementPct >= 90 ? 'very_low'
    : agreementPct >= 72 ? 'low'
    : agreementPct >= 50 ? 'moderate'
    : agreementPct >= 30 ? 'high'
    :                      'extreme';

  const summary =
      level === 'very_low'
        ? `Field highly unified — ${domAction.n}/${total} symbols agree on ${domAction.key}.`
    : level === 'low'
        ? `Field unified — ${domAction.n}/${total} on ${domAction.key}, minor divergence.`
    : level === 'moderate'
        ? `Field partly split — ${domAction.n}/${total} symbols on ${domAction.key}.`
    : level === 'high'
        ? `Field fragmented — only ${domAction.n}/${total} share ${domAction.key}.`
    :     `Field highly fragmented — no common read (${agreementPct}% agreement).`;

  return {
    level, agreementPct,
    dominantState:  domState.key,
    dominantAction: domAction.key,
    summary, diversity,
    stateCounts, actionCounts,
    agreeCount: domAction.n, total,
  };
}
