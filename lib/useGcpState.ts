'use client';

// v11.14: polls the Engine /v1/coherence/gcp-state classifier with
// overlapping-request prevention and previous-state carry-forward.
// Designed to be safe to mount before any UI consumes the result: if
// the feature flag is off, the env vars are missing on the server, the
// payload is too short, or the network call fails, the hook preserves
// its prior state and returns it. UI never blanks on a transient
// Engine outage.
//
// v11.14b: hook now returns connection meta alongside the classification
// (enabled flag, last-success timestamp, last-error timestamp) so the
// Settings panel can render an Engine connection indicator.
//
// v11.16.3: cost reduction — heartbeat-vs-trigger model with a 60s
// cooldown and structural-change detection. Most decide ticks no
// longer fire an API call.
//
// v11.16.4: user-controlled minimum interval. The Settings panel now
// exposes 60/120/200/300/600/'manual' via gcpro-ai-analysis-interval.
// When set, the floor for both heartbeats AND triggers becomes
// max(COOLDOWN_MS, userIntervalMs). The 'manual' option disables the
// auto-loop entirely and only runs the API call when the user clicks
// "Run AI Analysis Now". The hook now exposes a runNow() callback
// that bypasses the floor while still respecting the in-flight guard.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  classifyGcpState, type GcpStateResponse,
} from '@/lib/engine-gcp';
import {
  buildGcpStatePayload, type GcpStateInputs,
} from '@/lib/gcp-state-payload';
import {
  AI_INTERVAL_LS_KEY,
  loadAiAnalysisInterval,
  type AiAnalysisInterval,
} from '@/lib/aiAnalysisInterval';

const PREFS_LS_KEY = 'gcpro-settings';

const isDev = (): boolean => process.env.NODE_ENV !== 'production';

// Decide loop ticks every DECIDE_INTERVAL_MS so structural triggers
// feel responsive. Whether a tick fires the actual API call is gated
// by user interval + cooldown + change detection.
const DECIDE_INTERVAL_MS = 25_000;
const COOLDOWN_MS        = 60_000;

export const AI_STATE_POLL_INTERVAL_MS = DECIDE_INTERVAL_MS;

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

export interface UseGcpStateResult {
  state:         GcpStateResponse | null;
  enabled:       boolean;
  lastSuccessAt: Date | null;
  lastErrorAt:   Date | null;
  // v11.15.3: when the next /api/gcp-state decide tick is scheduled.
  nextPollAt:    Date | null;
  // v11.16.4
  intervalSec:   AiAnalysisInterval;
  inflight:      boolean;
  runNow:        () => void;
}

interface Snapshot {
  regimeCode:       string;
  latestPatternKey: string;
  pssTier:          0 | 60 | 70;
  nvSlopeDir:       'up' | 'down' | 'flat';
  goldTrend:        string;
}

function snapshotOf(inputs: GcpStateInputs): Snapshot {
  const last = inputs.recentPatterns[inputs.recentPatterns.length - 1];
  const pss = inputs.metrics.pss ?? 0;
  const slope = inputs.metrics.slope ?? 0;
  return {
    regimeCode:       inputs.regime.code,
    latestPatternKey: last ? `${last.patternCode}|${last.tStart}` : '',
    pssTier:          pss >= 70 ? 70 : pss >= 60 ? 60 : 0,
    nvSlopeDir:       slope > 0.1 ? 'up' : slope < -0.1 ? 'down' : 'flat',
    goldTrend:        inputs.goldContext?.trend ?? 'unknown',
  };
}

function changeReason(prev: Snapshot, cur: Snapshot): string | null {
  if (prev.regimeCode       !== cur.regimeCode)       return 'regime change';
  if (prev.latestPatternKey !== cur.latestPatternKey) return 'new pattern';
  if (prev.pssTier          !== cur.pssTier)          return 'PSS threshold';
  if (prev.nvSlopeDir       !== cur.nvSlopeDir)       return 'NV slope direction';
  if (prev.goldTrend        !== cur.goldTrend)        return 'gold trend';
  return null;
}

export function useGcpState(inputs: GcpStateInputs | null): UseGcpStateResult {
  const [state, setState]                 = useState<GcpStateResponse | null>(null);
  const [enabled, setEnabled]             = useState<boolean>(true);
  const [lastSuccessAt, setLastSuccessAt] = useState<Date | null>(null);
  const [lastErrorAt, setLastErrorAt]     = useState<Date | null>(null);
  const [nextPollAt, setNextPollAt]       = useState<Date | null>(null);
  const [intervalSec, setIntervalSec]     = useState<AiAnalysisInterval>(120);
  const [inflight, setInflight]           = useState<boolean>(false);

  const inputsRef            = useRef<GcpStateInputs | null>(inputs);
  const stateRef             = useRef<GcpStateResponse | null>(null);
  const inflightRef          = useRef<boolean>(false);
  const lastCallAtRef        = useRef<number | null>(null);
  const lastSentSnapshotRef  = useRef<Snapshot | null>(null);
  const intervalRef          = useRef<AiAnalysisInterval>(120);

  useEffect(() => { inputsRef.current = inputs; }, [inputs]);
  useEffect(() => { stateRef.current = state;   }, [state]);
  useEffect(() => { intervalRef.current = intervalSec; }, [intervalSec]);

  // Read both the on/off pref and the interval pref on mount, refresh
  // on storage events so changes from another tab or from the same
  // tab's SettingsPanel propagate live without a reload.
  useEffect(() => {
    setEnabled(loadAiStatePref());
    setIntervalSec(loadAiAnalysisInterval());
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFS_LS_KEY)        setEnabled(loadAiStatePref());
      if (e.key === AI_INTERVAL_LS_KEY)  setIntervalSec(loadAiAnalysisInterval());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Core API call. Used by the auto-loop AND by runNow(). When force
  // is true the heartbeat / cooldown / change-detection gating is
  // skipped, but the in-flight guard still prevents overlap.
  const runCall = useCallback(async (force: boolean) => {
    if (inflightRef.current) {
      if (isDev() && force) console.log('[AI STATE] manual run ignored — request in flight');
      return;
    }

    const cur = inputsRef.current;
    if (!cur) {
      if (isDev() && force) console.log('[AI STATE] manual run ignored — no inputs yet');
      return;
    }

    const currentSnap = snapshotOf(cur);

    if (!force) {
      const prevSnap  = lastSentSnapshotRef.current;
      const sinceLast = lastCallAtRef.current
        ? Date.now() - lastCallAtRef.current
        : Number.POSITIVE_INFINITY;

      const userInt = intervalRef.current;
      if (userInt === 'manual') {
        if (isDev()) console.log('[AI STATE] skipped — manual mode');
        return;
      }

      // The user-selected minimum interval is the floor for both
      // heartbeat and trigger paths. Cooldown still applies as the
      // baseline; effective floor is whichever is larger.
      const userIntervalMs = userInt * 1000;
      const effectiveFloorMs = Math.max(COOLDOWN_MS, userIntervalMs);

      let shouldCall: boolean;
      let logMsg: string;

      if (!prevSnap) {
        shouldCall = true;
        logMsg     = '[AI STATE] triggered — first call';
      } else {
        const reason = changeReason(prevSnap, currentSnap);
        if (reason) {
          if (sinceLast < effectiveFloorMs) {
            shouldCall = false;
            logMsg     = `[AI STATE] skipped — interval floor (${reason}, ${Math.round(sinceLast / 1000)}s of ${Math.round(effectiveFloorMs / 1000)}s)`;
          } else {
            shouldCall = true;
            logMsg     = `[AI STATE] triggered — ${reason}`;
          }
        } else if (sinceLast >= userIntervalMs) {
          shouldCall = true;
          logMsg     = '[AI STATE] triggered — heartbeat';
        } else {
          shouldCall = false;
          logMsg     = '[AI STATE] skipped — no structural change';
        }
      }

      if (isDev()) console.log(logMsg);
      if (!shouldCall) return;
    } else if (isDev()) {
      console.log('[AI STATE] triggered — manual run');
    }

    const payload = buildGcpStatePayload({
      ...cur,
      previousState: stateRef.current,
    });
    if (!payload) {
      if (isDev() && force) console.log('[AI STATE] manual run ignored — payload unbuildable (series too short)');
      return;
    }

    if (isDev()) {
      console.log('[AI STATE] request payload', payload);
    }

    inflightRef.current        = true;
    setInflight(true);
    lastCallAtRef.current      = Date.now();
    lastSentSnapshotRef.current = currentSnap;
    try {
      const result = await classifyGcpState(payload);
      if (result) {
        if (isDev()) console.log('[AI STATE] response', result);
        setState(result);
        setLastSuccessAt(new Date());
      } else {
        if (isDev()) console.log('[AI STATE] error, keeping last state');
        setLastErrorAt(new Date());
      }
    } finally {
      inflightRef.current = false;
      setInflight(false);
    }
  }, []);

  // Decide loop runs every DECIDE_INTERVAL_MS while enabled. In manual
  // mode the loop still runs (so nextPollAt animates) but every tick
  // short-circuits to skipped. Could be optimised away, but keeping
  // the timer alive means runNow() works the moment the user toggles
  // back to a numeric interval.
  useEffect(() => {
    if (!enabled) {
      setState(null);
      setNextPollAt(null);
      return;
    }
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      setNextPollAt(new Date(Date.now() + DECIDE_INTERVAL_MS));
      void runCall(false);
    };

    tick();
    const id = setInterval(tick, DECIDE_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, runCall]);

  const runNow = useCallback(() => { void runCall(true); }, [runCall]);

  return {
    state, enabled, lastSuccessAt, lastErrorAt, nextPollAt,
    intervalSec, inflight, runNow,
  };
}
