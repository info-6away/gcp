// v14.8 — Phase 14.8: Field memory + recurrence.
//
// Every completed Radar scan leaves a compact field signature in
// localStorage. deriveFieldRecurrence then answers a new question:
// has today's field state happened before, and what did it resolve
// into last time?
//
// This shifts the Radar from "why is the field blocked?" to "what
// happened the last 17 times it looked like this?" — a market-memory
// layer. Local only. No Engine, no payload, no classification, no
// thresholds — pure client-side recording + comparison.

import type { DispersionLevel } from '@/lib/fieldDispersion';
import type { FieldMoodSentiment } from '@/lib/fieldMood';
import type { LiquidityLevel } from '@/lib/sessionContext';

const LS_KEY = 'gcpro-field-memory';
const MAX    = 200;

export interface FieldMemoryRecord {
  id:             string;
  timestamp:      number;
  dispersion:     DispersionLevel;
  mood:           FieldMoodSentiment;
  dominantState:  string;
  dominantAction: string;
  blockedCount:   number;
  watchCount:     number;
  readyCount:     number;
  total:          number;
  avgClarity:     number;   // 0-100
  regime:         string;
  nv:             number;
  participation:  LiquidityLevel;
}

export type FieldSignature = Omit<FieldMemoryRecord, 'id'>;

export function loadFieldMemory(): FieldMemoryRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as FieldMemoryRecord[] : [];
  } catch {
    return [];
  }
}

/** Append a completed scan. Keeps the last 200, oldest dropped. */
export function recordFieldScan(sig: FieldSignature): FieldMemoryRecord[] {
  if (typeof window === 'undefined') return [];
  const history = loadFieldMemory();
  const record: FieldMemoryRecord = {
    id: `${sig.timestamp}-${sig.dominantAction}`,
    ...sig,
  };
  history.push(record);
  while (history.length > MAX) history.shift();
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(history));
  } catch {
    /* quota / serialization — drop silently */
  }
  return history;
}

// ── recurrence ──────────────────────────────────────────────────────

export interface FieldRecurrence {
  /** Prior scans similar enough to count as a precedent. */
  matches:          number;
  /** Closest match similarity, 0-100. */
  similarity:       number;
  closestMatch:     FieldMemoryRecord | null;
  /** Short summaries of what the field resolved into after matches. */
  priorOutcomes:    string[];
  /** Mean hours from a matched scan to its first action change. */
  averageDuration:  number | null;
  /** Most common state chain following a match, e.g. "FA → CS → IS". */
  commonTransition: string | null;
  /** Size of the whole memory. */
  totalScans:       number;
}

const MATCH_THRESHOLD = 0.62;

// State code out of a "CS · Late" style label.
function stateCode(label: string): string {
  return label.split('·')[0].trim().split(' ')[0] || label;
}

// 0-1 weighted similarity between the current signature and a record.
function similarity(a: FieldSignature, b: FieldMemoryRecord): number {
  let s = 0;
  if (a.dominantAction === b.dominantAction) s += 0.25;
  if (a.dominantState  === b.dominantState)  s += 0.20;
  if (a.dispersion     === b.dispersion)     s += 0.15;
  if (a.regime         === b.regime)         s += 0.15;
  if (Math.abs(a.blockedCount - b.blockedCount) <= 2) s += 0.10;
  if (a.participation  === b.participation)  s += 0.08;
  if (Math.abs(a.nv - b.nv) <= 15)           s += 0.07;
  return s;
}

export function deriveFieldRecurrence(
  current: FieldSignature,
  history: FieldMemoryRecord[],
): FieldRecurrence {
  const empty: FieldRecurrence = {
    matches: 0, similarity: 0, closestMatch: null,
    priorOutcomes: [], averageDuration: null,
    commonTransition: null, totalScans: history.length,
  };
  if (history.length === 0) return empty;

  const sorted = history.slice().sort((a, b) => a.timestamp - b.timestamp);
  const scored = sorted.map((r, i) => ({ r, i, sim: similarity(current, r) }));
  const matched = scored.filter(x => x.sim >= MATCH_THRESHOLD);
  const closest = scored.reduce((best, x) => (x.sim > best.sim ? x : best), scored[0]);

  // What followed each match: the next-scan action, the time to the
  // first action change, and the forward state chain.
  const outcomeCounts: Record<string, number> = {};
  const durations:     number[] = [];
  const transitions:   Record<string, number> = {};

  for (const m of matched) {
    const next = sorted[m.i + 1];
    if (!next) continue;
    outcomeCounts[next.dominantAction] = (outcomeCounts[next.dominantAction] ?? 0) + 1;

    for (let j = m.i + 1; j < sorted.length; j++) {
      if (sorted[j].dominantAction !== m.r.dominantAction) {
        durations.push((sorted[j].timestamp - m.r.timestamp) / 3_600_000);
        break;
      }
    }

    const chain = [stateCode(m.r.dominantState)];
    for (let j = m.i + 1; j < sorted.length && chain.length < 3; j++) {
      const c = stateCode(sorted[j].dominantState);
      if (c !== chain[chain.length - 1]) chain.push(c);
    }
    if (chain.length >= 2) {
      const key = chain.join(' → ');
      transitions[key] = (transitions[key] ?? 0) + 1;
    }
  }

  const priorOutcomes = Object.entries(outcomeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([action, n]) => `→ ${action} ×${n}`);

  const averageDuration = durations.length
    ? +(durations.reduce((s, d) => s + d, 0) / durations.length).toFixed(1)
    : null;

  const commonTransition = Object.entries(transitions)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    matches:      matched.length,
    similarity:   Math.round(closest.sim * 100),
    closestMatch: closest.r,
    priorOutcomes,
    averageDuration,
    commonTransition,
    totalScans:   history.length,
  };
}
