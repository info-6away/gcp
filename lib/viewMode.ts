'use client';

// v13.6: Trade view-mode state + persistence.
//
// SIMPLE   — Hero + Stance + 4-meter strip + Position/Action only.
//            "What environment is this and should I act?" in <3s.
//
// ANALYST  — Everything in SIMPLE, plus the existing intelligence
//            row (Env Risk · State Flow · Historical Analog) +
//            Pressure gauge with full LONG/SHORT detail + Market
//            Context (structure / momentum / trend integrity).
//
// RESEARCH — Everything in ANALYST, plus a raw-metrics card with
//            the underlying coherence-field numbers (PSS, slope,
//            curvature, CED, oscillation, regime).
//
// v13.7: default flipped from ANALYST → SIMPLE. New users see a
// 3-second decision surface first; ANALYST / RESEARCH stay one
// click away. Existing users who explicitly picked a mode get
// their choice respected (localStorage value wins).

import { useEffect, useState } from 'react';

export type ViewMode = 'SIMPLE' | 'ANALYST' | 'RESEARCH';

const VIEW_MODE_LS_KEY  = 'gcpro-trade-view-mode';
const VALID_MODES       = new Set<ViewMode>(['SIMPLE', 'ANALYST', 'RESEARCH']);
const DEFAULT_VIEW_MODE: ViewMode = 'SIMPLE';

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
 * setter that also persists. Mirrors the chartTF pattern.
 */
export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => loadViewMode());

  // Cross-tab sync — if the user flips the mode in one tab, others
  // pick it up via the storage event.
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
