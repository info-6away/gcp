'use client';

// v18.2: Trade-mode rails renamed to match the new Trade Terminal IA.
//
//   EXECUTE — active trading focus: chart + order panel + position
//             monitor. The default mode; reads the AI strip, acts.
//   PLAN    — same surfaces as EXECUTE today, but reserved for the
//             v18.3 Trigger Engine: chart + setup conditions + the
//             "activate long if X breaks, invalidate if Y loses"
//             builder.
//   JOURNAL — trade history expanded to fill the body. Used to
//             review prior decisions and outcomes.
//
// Prior to v18.2 the same toggle carried density labels (SIMPLE /
// ANALYST / RESEARCH) inherited from v13.6's progressive-disclosure
// design. v18.0 already moved the heavy intelligence to GuruView, so
// the old density rails no longer described Trade's behavior. The
// rename + new LS key intentionally drops stale values from earlier
// users — defaulting to EXECUTE is the right thing on first load.

import { useEffect, useState } from 'react';

export type ViewMode = 'EXECUTE' | 'PLAN' | 'JOURNAL';

// v18.2: new LS key. Old key ('gcpro-trade-view-mode') is intentionally
// abandoned so SIMPLE / ANALYST / RESEARCH values don't bleed through.
const VIEW_MODE_LS_KEY  = 'gcpro-trade-mode';
const VALID_MODES       = new Set<ViewMode>(['EXECUTE', 'PLAN', 'JOURNAL']);
const DEFAULT_VIEW_MODE: ViewMode = 'EXECUTE';

export function loadViewMode(): ViewMode {
  if (typeof window === 'undefined') return DEFAULT_VIEW_MODE;
  try {
    const raw = window.localStorage.getItem(VIEW_MODE_LS_KEY);
    if (raw && VALID_MODES.has(raw as ViewMode)) return raw as ViewMode;
  } catch { /* */ }
  return DEFAULT_VIEW_MODE;
}

export function saveViewMode(mode: ViewMode): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(VIEW_MODE_LS_KEY, mode); }
  catch { /* */ }
}

/**
 * useViewMode — hook for components that need the current mode + a
 * setter that also persists. Cross-tab sync via storage events.
 */
export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => loadViewMode());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== VIEW_MODE_LS_KEY) return;
      if (e.newValue && VALID_MODES.has(e.newValue as ViewMode)) {
        setMode(e.newValue as ViewMode);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const apply = (m: ViewMode) => {
    setMode(m);
    saveViewMode(m);
  };

  return [mode, apply];
}
