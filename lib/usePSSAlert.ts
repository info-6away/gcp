'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { Pattern, DataPoint } from '@/types/gcp';

export const PSS_THRESHOLD = 70;
const COOLDOWN_MS          = 300_000;

const SEEN_LS_KEY = 'gcpro-alerts-seen';
const SEEN_MAX    = 500;

interface AlertState {
  lastAlertTime: Record<string, number>;
}

// Pattern.id encodes the array index from the detector pass, which shifts
// as the windowedSeries slides forward; "cc-200" yesterday is "cc-195"
// today for the same pattern. Use kind + tStart as the dedup key instead
// -- absolute timestamp + kind is stable across reloads and windowing.
function stableKey(p: Pattern): string {
  return `${p.kind}|${p.tStart}`;
}

function loadSeenIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(SEEN_LS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(x => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function saveSeenIds(s: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    // Cap to most recent SEEN_MAX so localStorage doesn't grow unbounded.
    // JS Set preserves insertion order; slice keeps the newest entries.
    const arr = [...s].slice(-SEEN_MAX);
    window.localStorage.setItem(SEEN_LS_KEY, JSON.stringify(arr));
  } catch {
    /* ignore quota / serialization failures */
  }
}

function pssOf(p: Pattern): number {
  return Math.round(p.strength * 100);
}

function barsOf(p: Pattern): number {
  return p.end - p.start;
}

function regimeOf(p: Pattern, series: DataPoint[]): string {
  return series[p.start]?.r ?? '?';
}

export function usePSSAlert(
  patterns: Pattern[],
  series:   DataPoint[],
  enabled:  boolean = true,
  onAlert?: (pattern: Pattern) => void,
  recentWindowMs: number = 10 * 60_000,
) {
  const stateRef       = useRef<AlertState>({ lastAlertTime: {} });
  const seenIdsRef     = useRef<Set<string>>(new Set());
  const initializedRef = useRef<boolean>(false);

  // Load persisted seen IDs once on mount so a reload doesn't replay
  // alerts the user already received.
  useEffect(() => {
    seenIdsRef.current = loadSeenIds();
  }, []);

  const requestPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied')  return false;

    const result = await Notification.requestPermission();
    return result === 'granted';
  }, []);

  const fireNotification = useCallback((pattern: Pattern, pss: number, regime: string, bars: number) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const title = `GCP PRO — ${pattern.kind}`;
    const body  = `PSS ${pss} · ${regime} regime · ${bars} bars\nHigh-probability setup forming.`;

    try {
      const n = new Notification(title, {
        body,
        tag:    `gcppro-pss-${pattern.kind}`,
        silent: false,
      });

      setTimeout(() => n.close(), 8_000);
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) {
      console.warn('[PSS Alert] notification error:', e);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !patterns.length) return;

    const now   = Date.now();
    const state = stateRef.current;
    const seen  = seenIdsRef.current;

    // First detection pass after mount: mark every currently-visible
    // pattern as already seen and bail without firing. Without this, the
    // initial render presents ~24h of historical patterns to the hook
    // and every PSS >= 70 one would fire a notification on reload.
    if (!initializedRef.current) {
      for (const p of patterns) seen.add(stableKey(p));
      saveSeenIds(seen);
      initializedRef.current = true;
      console.debug('[PSS] initialized: seeded', patterns.length, 'patterns as already seen');
      return;
    }

    for (const pattern of patterns) {
      const pss = pssOf(pattern);
      if (pss < PSS_THRESHOLD) continue;

      const key = stableKey(pattern);

      // Dedup against persisted history first -- cheaper than the freshness
      // check and catches reload-replays.
      if (seen.has(key)) {
        console.debug('[PSS] alert skipped: duplicate', key);
        continue;
      }

      // Freshness gate: only alert for patterns whose tStart sits inside
      // the recent window. Older patterns get marked as seen so we don't
      // re-evaluate them every cycle.
      if (now - pattern.tStart > recentWindowMs) {
        seen.add(key);
        console.debug(
          '[PSS] alert skipped: historical', key,
          'age:', Math.round((now - pattern.tStart) / 60_000), 'min',
        );
        continue;
      }

      // Per-kind cooldown: prevents rapid-fire bursts of the same pattern
      // type. 5 minutes between same-kind alerts.
      const lastAlert = state.lastAlertTime[pattern.kind] ?? 0;
      if (now - lastAlert < COOLDOWN_MS) continue;

      const regime = regimeOf(pattern, series);
      const bars   = barsOf(pattern);

      (async () => {
        const granted = await requestPermission();
        if (!granted) return;
        fireNotification(pattern, pss, regime, bars);
        state.lastAlertTime[pattern.kind] = now;
        seen.add(key);
        saveSeenIds(seen);
        console.log('[PSS] alert fired: live', key, 'pss:', pss);
        onAlert?.(pattern);
      })();
    }
  }, [patterns, series, enabled, requestPermission, fireNotification, onAlert, recentWindowMs]);

  const testAlert = useCallback(async (): Promise<'sent' | 'blocked' | 'focused'> => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      console.warn('[PSS] Notifications not supported in this environment');
      return 'blocked';
    }

    // Permission must be requested directly from the user gesture; doing
    // any extra `await` work before this call can drop the gesture context
    // in some browsers (notably Safari) and silently no-op the prompt.
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      console.warn('[PSS] Notification permission not granted:', permission);
      return 'blocked';
    }

    // Chrome (and most browsers) silently drop notifications for the
    // currently focused tab. Detect that so the UI can prompt the user
    // to switch tabs to actually see it.
    const isFocused = document.hasFocus();

    try {
      const n = new Notification('GCP PRO — Test Alert', {
        body: 'PSS 82 · D regime · Alignment Ladder · 18 bars\nAlerts are working correctly.',
        tag:  'gcppro-test',
      });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 8_000);
      console.log('[PSS] Test notification fired (tab focused:', isFocused, ')');
    } catch (e) {
      console.error('[PSS] Notification error:', e);
      return 'blocked';
    }

    const sample: Pattern = {
      id:     'test-alert',
      kind:   'Alignment Ladder',
      start:  0,
      end:    18,
      tStart: Date.now(),
      tEnd:   Date.now(),
      glyph:  'AB# → B↑ → C → D#',
      strength: 0.82,
    };
    onAlert?.(sample);

    return isFocused ? 'focused' : 'sent';
  }, [onAlert]);

  return { testAlert };
}
