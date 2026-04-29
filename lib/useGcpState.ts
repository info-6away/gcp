'use client';

// v11.14: polls the Engine /v1/coherence/gcp-state classifier on a 25 s
// cadence with overlapping-request prevention and previous-state carry-
// forward. Designed to be safe to mount before any UI consumes the
// result: if the feature flag is off, the env vars are missing on the
// server, the payload is too short, or the network call fails, the hook
// preserves its prior state and returns it. UI never blanks on a
// transient Engine outage.

import { useEffect, useRef, useState } from 'react';
import {
  classifyGcpState, type GcpStateResponse,
} from '@/lib/engine-gcp';
import {
  buildGcpStatePayload, type GcpStateInputs,
} from '@/lib/gcp-state-payload';

const PREFS_LS_KEY = 'gcpro-settings';
const INTERVAL_MS  = 25_000;     // v11.14: 60 s -> 25 s per spec.

const isDev = (): boolean => process.env.NODE_ENV !== 'production';

// Default ON so a fresh deploy can verify the proxy chain end-to-end via
// the dev console; flip { aiState: false } in localStorage gcpro-settings
// to silence the loop.
function loadAiStatePref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(PREFS_LS_KEY);
    if (!raw) return true;
    const obj = JSON.parse(raw);
    return obj?.aiState ?? true;
  } catch {
    return true;
  }
}

export function useGcpState(inputs: GcpStateInputs | null): GcpStateResponse | null {
  const [state, setState] = useState<GcpStateResponse | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);

  const inputsRef   = useRef<GcpStateInputs | null>(inputs);
  const stateRef    = useRef<GcpStateResponse | null>(null);
  const inflightRef = useRef<boolean>(false);

  // Latest inputs go into a ref so the timer doesn't re-create on every
  // input change. State also mirrored into a ref so the tick callback
  // can carry the prior classification forward as priorState in the
  // payload without forcing the effect to re-subscribe.
  useEffect(() => { inputsRef.current = inputs; }, [inputs]);
  useEffect(() => { stateRef.current = state;   }, [state]);

  // Read the feature-flag pref once + refresh on cross-tab storage events.
  useEffect(() => {
    setEnabled(loadAiStatePref());
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFS_LS_KEY) setEnabled(loadAiStatePref());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Poll loop: fires immediately when enabled flips true, then every
  // INTERVAL_MS. Aborts in-flight setState on unmount via cancelled flag.
  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      // v11.14 in-flight guard: if a previous request is still running
      // (Engine slow / network slow), skip this tick rather than firing
      // a second concurrent request. Only one /api/gcp-state call in
      // flight at a time.
      if (inflightRef.current) return;

      const cur = inputsRef.current;
      if (!cur) return;

      const payload = buildGcpStatePayload({
        ...cur,
        previousState: stateRef.current,
      });
      if (!payload) return;

      if (isDev()) {
        console.log('[AI STATE] request payload', payload);
      }

      inflightRef.current = true;
      try {
        const result = await classifyGcpState(payload);
        if (cancelled) return;
        if (result) {
          if (isDev()) {
            console.log('[AI STATE] response', result);
          }
          setState(result);
        } else {
          if (isDev()) {
            console.log('[AI STATE] error, keeping last state');
          }
          // null result -> leave state untouched. UI never blanks on a
          // transient failure or a 503 from the proxy when env is
          // missing.
        }
      } finally {
        inflightRef.current = false;
      }
    };

    tick();
    const id = setInterval(tick, INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return state;
}
