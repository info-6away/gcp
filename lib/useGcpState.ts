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
// 'manual' disables the auto-loop entirely; runNow() bypasses the
// floor while still respecting the in-flight guard.
//
// v11.16.6: the user-selected interval is now the AUTHORITATIVE floor.
// Removed the 60s baseline cooldown — if you pick 600s and a regime
// flips at t=10s, the call still waits until t=600s (the trigger is
// logged as "pending" in the dev console). Manual run resets the
// last-attempt timestamp so the countdown restarts from the selected
// interval. nextPollAt is now derived from lastAttempt + interval, not
// from the 25s decide loop tick, so the Settings countdown reflects
// the actual user expectation (e.g., 600s -> 9m 50s, not 25s).

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

// Decide loop ticks every DECIDE_INTERVAL_MS so we can log pending
// triggers and refresh the Settings countdown. Whether a tick fires
// the actual API call is gated entirely by the user-selected interval.
const DECIDE_INTERVAL_MS = 25_000;

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
  // v11.18.3: lazy initialiser pulls the saved interval from
  // localStorage on the first render so the very first decide tick
  // respects the user's choice (manual by default). Without the lazy
  // init the ref would start at 120 and runCall(false) would fire
  // an Engine call before the storage-read effect resolved.
  const [intervalSec, setIntervalSec]     = useState<AiAnalysisInterval>(() => loadAiAnalysisInterval());
  const [inflight, setInflight]           = useState<boolean>(false);

  const inputsRef            = useRef<GcpStateInputs | null>(inputs);
  const stateRef             = useRef<GcpStateResponse | null>(null);
  const inflightRef          = useRef<boolean>(false);
  const lastCallAtRef        = useRef<number | null>(null);
  const lastSentSnapshotRef  = useRef<Snapshot | null>(null);
  const intervalRef          = useRef<AiAnalysisInterval>(intervalSec);
  const pendingReasonRef     = useRef<string | null>(null);

  useEffect(() => { inputsRef.current = inputs; }, [inputs]);
  useEffect(() => { stateRef.current = state;   }, [state]);
  useEffect(() => { intervalRef.current = intervalSec; }, [intervalSec]);

  // v11.16.6: nextPollAt is anchored to lastCallAt + userInterval, not
  // to the decide loop tick. Recompute on every tick AND whenever the
  // user changes interval, so the Settings countdown reflects the real
  // wait time. null means "auto-loop off" (manual mode) or "never
  // attempted" — Settings renders Ready now / Waiting for first
  // response in both cases.
  const recomputeNextPollAt = useCallback(() => {
    const userInt = intervalRef.current;
    if (userInt === 'manual') {
      setNextPollAt(null);
      return;
    }
    if (lastCallAtRef.current == null) {
      // No attempt yet — first decide tick will fire as soon as inputs
      // are ready. Surface that to the UI as null so it can render the
      // "Ready now / Waiting for first response" label.
      setNextPollAt(null);
      return;
    }
    const userIntervalMs = userInt * 1000;
    setNextPollAt(new Date(lastCallAtRef.current + userIntervalMs));
  }, []);

  // Recompute the countdown anchor whenever the user changes interval
  // so the displayed wait jumps to the new floor immediately rather
  // than after the next call.
  useEffect(() => { recomputeNextPollAt(); }, [intervalSec, recomputeNextPollAt]);

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
  // is true the user-interval / change-detection gating is skipped,
  // but the in-flight guard still prevents overlap. Manual run resets
  // the last-attempt timestamp on completion so the countdown
  // restarts from the user-selected interval.
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
      const userInt = intervalRef.current;
      if (userInt === 'manual') {
        if (isDev()) console.log('[AI STATE] skipped — manual mode');
        return;
      }

      const userIntervalMs = userInt * 1000;
      const sinceLast = lastCallAtRef.current
        ? Date.now() - lastCallAtRef.current
        : Number.POSITIVE_INFINITY;
      const prevSnap = lastSentSnapshotRef.current;

      if (!prevSnap) {
        // First attempt — fire immediately so the UI gets data.
        if (isDev()) console.log('[AI STATE] triggered — first call');
      } else if (sinceLast < userIntervalMs) {
        // v11.16.6: user-selected interval is authoritative. Triggers
        // do NOT bypass — they're logged as "pending" and execute
        // when the interval expires. Dedupe pending-reason logs so the
        // console doesn't spam every 25 s tick with the same reason.
        const reason = changeReason(prevSnap, currentSnap);
        if (isDev()) {
          if (reason && pendingReasonRef.current !== reason) {
            console.log(`[AI STATE] pending trigger — ${reason}`);
            pendingReasonRef.current = reason;
          } else if (!reason) {
            const remaining = Math.max(0, Math.round((userIntervalMs - sinceLast) / 1000));
            console.log(`[AI STATE] blocked by selected interval — ${remaining}s remaining`);
          }
        }
        return;
      } else {
        // Interval expired. Fire — heartbeat or trigger; only
        // semantic difference is the dev log.
        const reason = changeReason(prevSnap, currentSnap);
        if (isDev()) {
          console.log(reason
            ? `[AI STATE] triggered — ${reason}`
            : '[AI STATE] triggered — heartbeat');
        }
        pendingReasonRef.current = null;
      }
    } else if (isDev()) {
      console.log('[AI STATE] manual run');
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

    inflightRef.current         = true;
    setInflight(true);
    lastCallAtRef.current       = Date.now();
    lastSentSnapshotRef.current = currentSnap;
    pendingReasonRef.current    = null;
    // Settings countdown updates the instant a call fires so the UI
    // never shows a stale "Ready now" mid-flight.
    recomputeNextPollAt();
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
      // Reset the countdown anchor regardless of success/failure so
      // the user sees the interval restart whenever an attempt
      // completes — including manual runs.
      recomputeNextPollAt();
    }
  }, [recomputeNextPollAt]);

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
      // v11.16.6: do NOT anchor nextPollAt to the decide tick — that
      // would show a misleading 25 s countdown when the user picked
      // 600 s. recomputeNextPollAt() reads lastCallAt + userInterval
      // so the displayed wait is always the real one.
      recomputeNextPollAt();
      void runCall(false);
    };

    tick();
    const id = setInterval(tick, DECIDE_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, runCall, recomputeNextPollAt]);

  const runNow = useCallback(() => { void runCall(true); }, [runCall]);

  return {
    state, enabled, lastSuccessAt, lastErrorAt, nextPollAt,
    intervalSec, inflight, runNow,
  };
}
