// Sensitivity setting for the pattern detector.
// v11.1: pure wiring -- thresholds are passed through detectPatterns but
// the detection logic doesn't read them yet. v11.2+ will plug in.

export type Sensitivity = 'low' | 'medium' | 'high';

export interface SensitivityThresholds {
  minPatternConfidence: number; // 0-1
  minCompressionDuration: number; // minutes
  minCOrDHold: number;            // minutes
}

export const SENSITIVITY_THRESHOLDS: Record<Sensitivity, SensitivityThresholds> = {
  low:    { minPatternConfidence: 0.75, minCompressionDuration: 60, minCOrDHold: 20 },
  medium: { minPatternConfidence: 0.60, minCompressionDuration: 30, minCOrDHold: 10 },
  high:   { minPatternConfidence: 0.45, minCompressionDuration: 15, minCOrDHold: 5  },
};

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  low:    'Low',
  medium: 'Medium',
  high:   'High',
};

const PREFS_LS_KEY = 'gcpro-settings';
const DEFAULT: Sensitivity = 'medium';

export function loadSensitivity(): Sensitivity {
  if (typeof window === 'undefined') return DEFAULT;
  try {
    const raw = window.localStorage.getItem(PREFS_LS_KEY);
    if (!raw) return DEFAULT;
    const obj = JSON.parse(raw);
    const v = obj?.sensitivity;
    if (v === 'low' || v === 'medium' || v === 'high') return v;
    return DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function saveSensitivity(s: Sensitivity): void {
  if (typeof window === 'undefined') return;
  try {
    const raw  = window.localStorage.getItem(PREFS_LS_KEY);
    const obj  = raw ? JSON.parse(raw) : {};
    obj.sensitivity = s;
    window.localStorage.setItem(PREFS_LS_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}
