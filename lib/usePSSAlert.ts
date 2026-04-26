'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { Pattern, DataPoint } from '@/types/gcp';

export const PSS_THRESHOLD = 70;
const COOLDOWN_MS          = 300_000;

interface AlertState {
  lastAlertTime: Record<string, number>;
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
) {
  const stateRef        = useRef<AlertState>({ lastAlertTime: {} });
  const prevPatternsRef = useRef<Pattern[]>([]);

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
    if (!enabled || !patterns.length) {
      prevPatternsRef.current = patterns;
      return;
    }

    const now   = Date.now();
    const prev  = prevPatternsRef.current;
    const state = stateRef.current;

    for (const pattern of patterns) {
      const pss = pssOf(pattern);
      if (pss < PSS_THRESHOLD) continue;

      const lastAlert = state.lastAlertTime[pattern.kind] ?? 0;
      if (now - lastAlert < COOLDOWN_MS) continue;

      const wasPresent = prev.some(
        p => p.kind === pattern.kind && p.start === pattern.start,
      );
      if (wasPresent) continue;

      const regime = regimeOf(pattern, series);
      const bars   = barsOf(pattern);

      (async () => {
        const granted = await requestPermission();
        if (!granted) return;
        fireNotification(pattern, pss, regime, bars);
        state.lastAlertTime[pattern.kind] = now;
        onAlert?.(pattern);
      })();
    }

    prevPatternsRef.current = patterns;
  }, [patterns, series, enabled, requestPermission, fireNotification, onAlert]);

  const testAlert = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      console.warn('[PSS] Notifications not supported in this environment');
      return;
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
      return;
    }

    try {
      const n = new Notification('GCP PRO — Test Alert', {
        body: 'PSS 82 · D regime · Alignment Ladder · 18 bars\nAlerts are working correctly.',
        tag:  'gcppro-test',
      });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 8_000);
      console.log('[PSS] Test notification fired');
    } catch (e) {
      console.error('[PSS] Notification error:', e);
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
  }, [onAlert]);

  return { testAlert };
}
