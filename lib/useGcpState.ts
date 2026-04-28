'use client';

// Polls the Engine /v1/coherence/gcp-state classifier on a 60 s cadence.
// Designed to be safe to mount before any UI consumes the result: if the
// feature flag is off, the env vars are missing on the server, the
// payload is too short, or the network call fails, the hook simply
// returns null and the UI hides itself.

import { useEffect, useRef, useState } from 'react';
import {
  classifyGcpState, type GcpStateResponse,
} from '@/lib/engine-gcp';
import {
  buildGcpStatePayload, type GcpStateInputs,
} from '@/lib/gcp-state-payload';

const PREFS_LS_KEY = 'gcpro-settings';
const INTERVAL_MS  = 60_000;

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
  const inputsRef = useRef<GcpStateInputs | null>(inputs);

  // Keep latest inputs in a ref so the interval callback always sees the
  // current series / metrics / patterns without re-creating the timer.
  useEffect(() => { inputsRef.current = inputs; }, [inputs]);

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
      const cur = inputsRef.current;
      if (!cur) return;
      const payload = buildGcpStatePayload(cur);
      if (!payload) return;
      const result = await classifyGcpState(payload);
      if (cancelled) return;
      if (result) {
        console.log('[AI STATE]', result);
        setState(result);
      }
      // null result: leave previous state in place so a transient Engine
      // failure doesn't blank a working classification.
    };

    tick();
    const id = setInterval(tick, INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return state;
}
