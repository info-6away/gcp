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
// v11.16.3: cost reduction. Engine calls are LLM-backed, so 25 s
// polling -> ~3,500 calls/day per active client. Now:
//   - Heartbeat interval: 120 s in production (was 25 s); 25 s in dev
//     so local debugging stays responsive.
//   - Structural triggers: regime change, new pattern, PSS threshold
//     crossing (60 / 70), NV slope direction flip, or gold-trend flip
//     can fire a call sooner than the heartbeat.
//   - Cooldown: 60 s minimum between actual API calls regardless of
//     trigger, so a flood of small structural changes doesn't reopen
//     the floodgates.
//   - Change detection: even on the heartbeat tick, if nothing has
//     structurally changed AND we already have a recent classification,
//     skip the call.
// Every decision the loop makes is logged in dev so the cost story is
// visible in the console.

import { useEffect, useRef, useState } from 'react';
import {
  classifyGcpState, type GcpStateResponse,
} from '@/lib/engine-gcp';
import {
  buildGcpStatePayload, type GcpStateInputs,
} from '@/lib/gcp-state-payload';

const PREFS_LS_KEY = 'gcpro-settings';

const isDev = (): boolean => process.env.NODE_ENV !== 'production';

// v11.16.3: decide loop runs every 25 s so structural triggers feel
// responsive. Actual API calls are governed by HEARTBEAT_MS + COOLDOWN_MS
// + change detection -- a tick can fire and still skip the API call.
const DECIDE_INTERVAL_MS  = 25_000;
const HEARTBEAT_MS_PROD   = 120_000;
const HEARTBEAT_MS_DEV    = 25_000;
const COOLDOWN_MS         = 60_000;

export const AI_STATE_POLL_INTERVAL_MS = DECIDE_INTERVAL_MS;

function heartbeatMs(): number {
  return isDev() ? HEARTBEAT_MS_DEV : HEARTBEAT_MS_PROD;
}

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
  // v11.15.3: when the next /api/gcp-state decide tick is scheduled to
  // fire. The loop ticks every DECIDE_INTERVAL_MS and may or may not
  // make an API call depending on triggers / cooldown / change-detect.
  nextPollAt:    Date | null;
}

// v11.16.3 structural snapshot. Two snapshots are equal when every
// field matches, which is what we use to decide whether to skip the
// call. A change in any field surfaces a human-readable reason via
// changeReason() so the dev console says exactly which trigger fired.
interface Snapshot {
  regimeCode:       string;
  latestPatternKey: string; // `${patternCode}|${tStart}` or '' if none
  pssTier:          0 | 60 | 70;
  nvSlopeDir:       'up' | 'down' | 'flat';
  goldTrend:        string;
}

function snapshotOf(inputs: GcpStateInputs): Snapshot {
  const last = inputs.recentPatterns[inputs.recentPatterns.length - 1];
  const pss = inputs.metrics.pss ?? 0;
  // Slope is in NV/min; ±0.1 dead-zone keeps tiny oscillations from
  // flapping the snapshot back and forth. Tuned to match what the
  // existing detectors treat as "flat".
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

  const inputsRef          = useRef<GcpStateInputs | null>(inputs);
  const stateRef           = useRef<GcpStateResponse | null>(null);
  const inflightRef        = useRef<boolean>(false);
  const lastCallAtRef      = useRef<number | null>(null);
  const lastSentSnapshotRef = useRef<Snapshot | null>(null);

  // Latest inputs / state mirrored into refs so the timer doesn't
  // re-create on every input or response change.
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

  // Decide loop: runs every DECIDE_INTERVAL_MS while enabled, but the
  // tick itself only fires an API call if a structural trigger or the
  // heartbeat threshold is met AND the cooldown has elapsed.
  useEffect(() => {
    if (!enabled) {
      setState(null);
      setNextPollAt(null);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      // Settings panel reads nextPollAt to render its 1 Hz countdown.
      // The loop fires DECIDE_INTERVAL_MS after the previous tick
      // started regardless of fetch duration, so this anchor is
      // always correct. (A skipped tick still anchors the countdown.)
      setNextPollAt(new Date(Date.now() + DECIDE_INTERVAL_MS));

      // v11.14 in-flight guard: if a previous request is still running
      // (Engine slow / network slow), skip this tick rather than
      // firing a second concurrent request.
      if (inflightRef.current) return;

      const cur = inputsRef.current;
      if (!cur) return;

      const currentSnap = snapshotOf(cur);
      const prevSnap    = lastSentSnapshotRef.current;
      const sinceLast   = lastCallAtRef.current
        ? Date.now() - lastCallAtRef.current
        : Number.POSITIVE_INFINITY;

      let shouldCall: boolean;
      let logMsg: string;

      if (!prevSnap) {
        // Never called before — always fire the first request so the
        // UI gets an initial classification.
        shouldCall = true;
        logMsg     = '[AI STATE] triggered — first call';
      } else {
        const reason = changeReason(prevSnap, currentSnap);
        if (reason) {
          if (sinceLast < COOLDOWN_MS) {
            shouldCall = false;
            logMsg     = `[AI STATE] skipped — cooldown active (${reason}, ${Math.round(sinceLast / 1000)}s of ${COOLDOWN_MS / 1000}s)`;
          } else {
            shouldCall = true;
            logMsg     = `[AI STATE] triggered — ${reason}`;
          }
        } else if (sinceLast >= heartbeatMs()) {
          shouldCall = true;
          logMsg     = '[AI STATE] triggered — heartbeat';
        } else {
          shouldCall = false;
          logMsg     = '[AI STATE] skipped — no structural change';
        }
      }

      if (isDev()) console.log(logMsg);
      if (!shouldCall) return;

      const payload = buildGcpStatePayload({
        ...cur,
        previousState: stateRef.current,
      });
      // Series too short etc. — no API call, no snapshot update so we
      // re-evaluate next tick once enough data arrives.
      if (!payload) return;

      if (isDev()) {
        console.log('[AI STATE] request payload', payload);
      }

      inflightRef.current        = true;
      lastCallAtRef.current      = Date.now();
      lastSentSnapshotRef.current = currentSnap;
      try {
        const result = await classifyGcpState(payload);
        if (cancelled) return;
        if (result) {
          if (isDev()) console.log('[AI STATE] response', result);
          setState(result);
          setLastSuccessAt(new Date());
        } else {
          if (isDev()) console.log('[AI STATE] error, keeping last state');
          // null result -> leave state untouched. UI never blanks on a
          // transient failure or a 503 from the proxy when env is
          // missing. Stamp lastErrorAt so Settings can show staleness.
          setLastErrorAt(new Date());
        }
      } finally {
        inflightRef.current = false;
      }
    };

    tick();
    const id = setInterval(tick, DECIDE_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return { state, enabled, lastSuccessAt, lastErrorAt, nextPollAt };
}
