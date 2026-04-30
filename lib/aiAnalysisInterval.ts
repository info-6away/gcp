'use client';

// v11.16.4: user-controlled AI analysis interval. Replaces the hard-
// coded 120 s heartbeat with a per-client setting persisted in
// localStorage so credit burn can be capped at a level the user
// chooses. The 'manual' option turns the auto-loop off entirely;
// only the "Run AI Analysis Now" button triggers a call in that mode.
//
// useGcpState reads this on mount and on cross-tab/storage events;
// SettingsPanel writes via setAiAnalysisInterval, which also fires a
// same-tab storage event so the running hook picks the change up
// without a reload.

export const AI_INTERVAL_LS_KEY = 'gcpro-ai-analysis-interval';

export type AiAnalysisInterval = 60 | 120 | 200 | 300 | 600 | 'manual';

export const AI_INTERVAL_OPTIONS: AiAnalysisInterval[] = [60, 120, 200, 300, 600, 'manual'];

export const AI_INTERVAL_DEFAULT: AiAnalysisInterval = 120;

export function loadAiAnalysisInterval(): AiAnalysisInterval {
  if (typeof window === 'undefined') return AI_INTERVAL_DEFAULT;
  try {
    const raw = window.localStorage.getItem(AI_INTERVAL_LS_KEY);
    if (!raw) return AI_INTERVAL_DEFAULT;
    if (raw === 'manual') return 'manual';
    const n = Number(raw);
    return AI_INTERVAL_OPTIONS.includes(n as AiAnalysisInterval)
      ? (n as AiAnalysisInterval)
      : AI_INTERVAL_DEFAULT;
  } catch {
    return AI_INTERVAL_DEFAULT;
  }
}

export function saveAiAnalysisInterval(value: AiAnalysisInterval): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AI_INTERVAL_LS_KEY, String(value));
    // Same-tab storage events don't fire by default. Dispatch manually
    // so useGcpState picks up the change immediately on the same tab.
    window.dispatchEvent(new StorageEvent('storage', { key: AI_INTERVAL_LS_KEY }));
  } catch {
    /* ignore quota / serialization failures */
  }
}

export function formatAiInterval(v: AiAnalysisInterval): string {
  if (v === 'manual') return 'Manual only';
  if (v >= 60 && v < 600) return `${v} sec`;
  if (v === 600) return '600 sec (10 min)';
  return `${v} sec`;
}
