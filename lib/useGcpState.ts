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
//
// v11.23.2: replaced the boolean `inflight` flag with an explicit
// `aiStatus` state machine — 'idle' | 'running' | 'success' | 'error' —
// so the UI can distinguish "haven't run yet" from "analysis is
// actively in flight". The previous boolean caused the header badge
// and Dashboard card to show "Analyzing…" by default in manual mode
// even though no API call had been issued. Transitions:
//   idle      -> running     (runCall starts an actual fetch)
//   running   -> success     (Engine returned a classification)
//   running   -> error       (Engine returned null / threw)
//   {success|error} -> running on the next runCall
// `finally` defensively resets a lingering 'running' to 'idle' so a
// thrown exception cannot leave the UI stuck in the analyzing state.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  classifyGcpState, isClassifyError,
  type GcpStateResponse, type ClassifyErrorEnvelope,
} from '@/lib/engine-gcp';
import {
  buildGcpStatePayload, type GcpStateInputs,
} from '@/lib/gcp-state-payload';
import {
  AI_INTERVAL_LS_KEY,
  loadAiAnalysisInterval,
  type AiAnalysisInterval,
} from '@/lib/aiAnalysisInterval';
import { appendAiStateHistory } from '@/lib/aiStateHistory';
import { anchorAiState } from '@/lib/aiStateAnchor';
import { deriveNextState } from '@/lib/stateTransition';
import { deriveDirectionalPressure } from '@/lib/directionalPressure';
import { derivePlateauStateOverlay } from '@/lib/plateauState';
import { deriveDirectionalDecayOverlay } from '@/lib/directionalDecay';
import {
  deriveStructuralDominance, applyStructuralSanityGuard,
} from '@/lib/structuralDominance';
import { deriveTemporalPressureBias } from '@/lib/temporalPressure';
import { loadAiStateHistory } from '@/lib/aiStateHistory';

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

export type AiStatus = 'idle' | 'running' | 'success' | 'error';

export interface UseGcpStateResult {
  state:         GcpStateResponse | null;
  enabled:       boolean;
  lastSuccessAt: Date | null;
  lastErrorAt:   Date | null;
  // v11.15.3: when the next /api/gcp-state decide tick is scheduled.
  nextPollAt:    Date | null;
  // v11.16.4
  intervalSec:   AiAnalysisInterval;
  // v11.23.2: explicit state machine. Replaces the old `inflight`
  // boolean so the UI can render distinct idle / analyzing / success /
  // error views instead of inferring "analyzing" from a null state.
  aiStatus:      AiStatus;
  // v12.0.3: last structured proxy error. null when last attempt
  // succeeded; populated otherwise so the UI can distinguish
  // "ENGINE OFFLINE — using last known Guru state" from a generic
  // "Guru request failed".
  lastError:     ClassifyErrorEnvelope | null;
  // v12.0.4: structured runNow signature. Manual button call sites
  // MUST pass `{ force: true, source: <name> }` to bypass the
  // server-side cost gate. Default is force=false (auto/background)
  // which the hook treats as a silent skip — never reaches the proxy.
  runNow:        (options?: { force?: boolean; source?: string }) => void;
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
  // v11.23.2: status begins at 'idle' — "no analysis run yet". Manual
  // mode never spontaneously flips this to 'running'; only an actual
  // runCall() that survives the gating checks does.
  const [aiStatus, setAiStatus]           = useState<AiStatus>('idle');
  // v12.0.3: last structured failure envelope. Cleared on every
  // successful classification, populated on every typed proxy error.
  const [lastError, setLastError]         = useState<ClassifyErrorEnvelope | null>(null);

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

  // v11.25.4 BUGFIX: clear the saved AI classification on symbol /
  // timeframe change. Without this, runCall() forwards
  // `previousState: stateRef.current` to the engine — and that state
  // was classified for the OLD symbol/tf. Engine receives a BTC
  // payload with a previousState derived from XAUUSD, which can bias
  // its read. Reset on every (symbol, timeframe) transition so each
  // market starts fresh.
  useEffect(() => {
    if (!inputs) return;
    setState(null);
    // Also clear last-call timestamp + snapshot so the auto-loop (if
    // enabled) treats this as a fresh first attempt rather than a
    // gated heartbeat against the prior symbol's pacing.
    lastCallAtRef.current       = null;
    lastSentSnapshotRef.current = null;
    pendingReasonRef.current    = null;
  }, [inputs?.symbol, inputs?.timeframe]);

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
  const runCall = useCallback(async (force: boolean, source: string = 'unknown') => {
    // v12.0.2: structured early-return traces. Every silent no-op the
    // hook can hit now emits a `[GURU RUN SKIPPED]` with a reason +
    // diagnostics, so a "click did nothing" investigation has a single
    // log to grep for instead of scanning the four older message
    // shapes. force=true paths log unconditionally; force=false paths
    // log only when an interesting state change happened (to avoid
    // spamming the 25 s heartbeat ticks).
    const symbolNow    = inputsRef.current?.symbol    ?? null;
    const timeframeNow = inputsRef.current?.timeframe ?? null;
    const skip = (reason: string, extra?: Record<string, unknown>) => {
      if (!isDev()) return;
      if (!force
          && (reason === 'manual_mode'
           || reason === 'blocked_by_interval'
           || reason === 'pending_trigger')) {
        return;  // background-loop noise, already logged below
      }
      console.log('[GURU RUN SKIPPED]', {
        reason,
        symbol:    symbolNow,
        timeframe: timeframeNow,
        force,
        source,
        aiEnabled: true,
        ...(extra ?? {}),
      });
    };

    // v12.0.4: HARD AUTO-BLOCK. The v11.18.5 server-side cost gate
    // refuses any request without manual:true; pre-v12.0.4 the
    // auto-loop happily fired those requests every 25s and ate a 403
    // per tick (and flipped aiStatus to 'error' inside the client,
    // making the Guru header show "Guru request failed" on what was
    // really a background heartbeat). The auto-loop now never reaches
    // the proxy at all — force=false short-circuits here, before any
    // network code runs. Does NOT touch aiStatus / lastError; the UI
    // keeps the last good classification on screen.
    if (!force) {
      skip('manual_required', { hint: 'background auto-call blocked; only manual buttons reach the proxy' });
      return;
    }

    if (inflightRef.current) {
      skip('inflight');
      return;
    }

    const cur = inputsRef.current;
    if (!cur) {
      skip('no_inputs');
      return;
    }

    const currentSnap = snapshotOf(cur);

    let cooldownRemainingMs = 0;
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
        cooldownRemainingMs = Math.max(0, userIntervalMs - sinceLast);
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
      skip('payload_unbuildable', {
        seriesLen:        cur.series?.length ?? 0,
        recentPatterns:   cur.recentPatterns?.length ?? 0,
        hasPatternStory:  !!cur.patternStory,
      });
      return;
    }

    if (isDev()) {
      // v12.0.2: unified run-start trace. One log per attempted
      // classification, before the network fires, capturing the
      // pre-call state. Pairs with [GURU PIPELINE] (post-success)
      // and [GURU RUN ERROR] (post-failure).
      // v12.0.4: includes `source` (which button fired it) so a
      // 403 / engine_forbidden can be traced back to its origin.
      console.log('[GURU RUN START]', {
        symbol:               cur.symbol,
        timeframe:            cur.timeframe,
        force,
        manual:               force,
        source,
        statusBefore:         inflightRef.current ? 'running' : 'idle',
        hasPayloadInputs:     !!cur,
        hasPatternStory:      !!cur.patternStory,
        cooldownRemainingMs,
        seriesLen:            cur.series.length,
        recentPatternsLen:    cur.recentPatterns.length,
        reason:               force ? 'manual' : 'auto',
      });
      console.log('[AI STATE] request payload', payload);
    }

    inflightRef.current         = true;
    setAiStatus('running');
    if (isDev()) console.log('[AI UI] run started');
    lastCallAtRef.current       = Date.now();
    lastSentSnapshotRef.current = currentSnap;
    pendingReasonRef.current    = null;
    // Settings countdown updates the instant a call fires so the UI
    // never shows a stale "Ready now" mid-flight.
    recomputeNextPollAt();
    let resolved = false;
    try {
      // v11.18.5: stamp the manual flag only when this is a deliberate
      // user-triggered run. The proxy's server-side kill switch refuses
      // any non-manual call with `manual_required` so even stale auto
      // loops can't reach the LLM.
      const rawResult = await classifyGcpState(payload, { manual: force, source });

      // v12.0.3: branch on structured error envelope BEFORE the success
      // path. The proxy now returns `{ ok: false, error: { type, ... } }`
      // for every non-2xx + manual_required path. Surface it to the
      // UI as an error state with the typed envelope attached.
      if (isClassifyError(rawResult)) {
        // v12.0.4: a manual_required envelope arriving here means
        // something fired a runCall(false) past the auto-block AND the
        // request still reached the proxy. With v12.0.4's hard auto-
        // block this should be unreachable, but if a stale tab or
        // direct fetch ever produces it, treat it as a silent skip:
        // no aiStatus flip, no lastError update, just a [GURU RUN
        // SKIPPED] log. The user never sees "Guru request failed" for
        // a background heartbeat.
        if (rawResult.error.type === 'manual_required') {
          if (isDev()) {
            console.log('[GURU RUN SKIPPED]', {
              reason:    'manual_required',
              symbol:    cur.symbol,
              timeframe: cur.timeframe,
              force,
              source,
              origin:    'proxy_envelope',
              hint:      'auto-call reached proxy; check call site for missing { force: true }',
            });
          }
          resolved = true;
          return;
        }
        console.warn('[GURU RUN ERROR]', {
          symbol:    cur.symbol,
          timeframe: cur.timeframe,
          force,
          source,
          reason:    'proxy_error_envelope',
          message:   rawResult.error.message,
          type:      rawResult.error.type,
          status:    rawResult.error.status,
          httpStatus: rawResult.httpStatus,
        });
        setLastError(rawResult);
        setLastErrorAt(new Date());
        setAiStatus('error');
        resolved = true;
        return;
      }

      const result = rawResult;
      if (result) {
        // Successful classification — clear any prior error envelope.
        setLastError(null);
        if (isDev()) console.log('[AI STATE] response', result);
        // v12.0.1: detect stale-cache responses early. The proxy serves
        // the warm LastClassificationCache on engine failure paths and
        // marks the body with stale: true + staleReason. We still want
        // the anchored result to reach setState (the UI should reflect
        // the most recent known classification with the STALE badge in
        // the Guru header) but we MUST NOT append it to aiStateHistory
        // — otherwise repeated manual runs against a downed engine
        // would stuff the state-flow ribbon with duplicate FAs / CSs.
        const isStale = result.stale === true;

        // v11.26.1: structural anchor pass. The Engine prompt should
        // already cross-check against patternStory, but until that
        // server-side change deploys we enforce the same rules here:
        // FA hard guard, pressure/compression/post-shock biases,
        // discharge preference, and confidence ±10–20% based on
        // agreement. Anchor reads the SAME payload we just sent so
        // the story / divergence checks are coherent.
        // v12.0.1: anchor runs on stale responses too — the raw cached
        // body is the Engine's response, so it needs the same guard.
        const anchor = anchorAiState(result, payload);
        const anchored = anchor.response;
        if (isDev() && (anchor.overridden || anchor.delta !== 0)) {
          console.log('[AI ANCHOR]', {
            overridden: anchor.overridden,
            delta:      anchor.delta,
            reasons:    anchor.reasons,
            from:       `${result.stateCode} (${(result.confidence * 100).toFixed(0)}%)`,
            to:         `${anchored.stateCode} (${(anchored.confidence * 100).toFixed(0)}%)`,
          });
        }
        // v11.29: state-transition ladder overlay. Runs AFTER anchor +
        // shockDecay so the ladder reads from the corrected state.
        // Never overrides — just attaches nextLikelyState + confidence
        // + reason for the UI to surface as "NEXT → IS (64%)".
        const transition = deriveNextState({
          aiState:      anchored,
          patternStory: payload.patternStory,
          metrics:      payload.metrics,
          goldContext:  payload.goldContext,
        });
        const withTransition = transition.nextLikelyState
          ? { ...anchored, ...transition }
          : anchored;
        if (isDev() && transition.nextLikelyState) {
          console.log('[STATE TRANSITION]', {
            from:       anchored.stateCode,
            next:       transition.nextLikelyState,
            confidence: transition.transitionConfidence,
            reason:     transition.transitionReason,
          });
        }
        // v11.36: directional pressure synthesis. Pure frontend
        // derivation — runs AFTER anchor + transition so it reads from
        // the corrected state and forward-looking ladder, not the raw
        // Engine response. Attaches longPressure / shortPressure /
        // pressureBand / pressureExplanation onto the response so the
        // UI can render under the STANCE block.
        const pressure = deriveDirectionalPressure({
          aiState:      withTransition,
          patternStory: payload.patternStory,
          metrics:      payload.metrics,
          goldContext:  payload.goldContext,
          transition,
        });
        // v12.0.1: carry the proxy's stale + _meta fields through onto
        // the final response so the Guru header chip can render them.
        const respWithPressure: GcpStateResponse = {
          ...withTransition,
          longPressure:        pressure.longPressure,
          shortPressure:       pressure.shortPressure,
          pressureBand:        pressure.confidenceBand,
          pressureExplanation: pressure.explanation,
          _meta:               result._meta,
          stale:               result.stale,
          staleReason:         result.staleReason,
          staleAgeMs:          result.staleAgeMs,
        };
        if (isDev()) {
          console.log('[DIRECTIONAL PRESSURE]', {
            long:  pressure.longPressure,
            short: pressure.shortPressure,
            band:  pressure.confidenceBand,
            why:   pressure.explanation,
          });
        }

        // v12.1: Plateau State overlay. Pure local rename of SS into
        // PS when saturation conditions converge. Runs AFTER pressure
        // so it can inspect the skew. Other state codes pass through
        // unchanged. When upgraded, the helper dampens pressure toward
        // neutral and shaves 0.05 off confidence to communicate that
        // the displayed state is a local read, not Engine ground truth.
        const latestPatternCode =
          cur.recentPatterns[cur.recentPatterns.length - 1]?.patternCode ?? null;
        const plateau = derivePlateauStateOverlay({
          aiState:      respWithPressure,
          patternStory: payload.patternStory,
          metrics:      payload.metrics,
          directionalPressure: {
            longPressure:  respWithPressure.longPressure,
            shortPressure: respWithPressure.shortPressure,
            pressureBand:  respWithPressure.pressureBand,
          },
          transition: { nextLikelyState: respWithPressure.nextLikelyState },
          regime:            cur.regime.code,
          latestPatternCode,
        });
        const respAfterPlateau: GcpStateResponse = plateau.response;
        if (isDev() && respWithPressure.stateCode === 'SS') {
          // Only log when SS was the candidate — avoids noise on every
          // unrelated classification.
          console.log('[PLATEAU STATE]', {
            upgraded: plateau.upgraded,
            from:     'SS',
            to:       respAfterPlateau.stateCode,
            reasons:  plateau.reasons,
            pressure: {
              long:  respAfterPlateau.longPressure,
              short: respAfterPlateau.shortPressure,
            },
            slope:    payload.metrics?.slope,
            phase:    anchored.phase,
            regime:   cur.regime.code,
            pattern:  latestPatternCode,
          });
        }

        // v12.2: Directional Decay overlay. Catches the "stuck CS / SS
        // while price keeps trending" anti-pattern that the existing
        // FA / plateau / weak-pressure stack can suppress. Runs AFTER
        // plateau so PS keeps priority — a mature SS that converged
        // on plateau signal stays PS. DC fires when CS or SS HAS NOT
        // become PS but does meet the directional-decay conditions.
        const decay = deriveDirectionalDecayOverlay({
          aiState:      respAfterPlateau,
          patternStory: payload.patternStory,
          metrics:      payload.metrics,
          goldContext:  payload.goldContext,
          directionalPressure: {
            longPressure:  respAfterPlateau.longPressure,
            shortPressure: respAfterPlateau.shortPressure,
            pressureBand:  respAfterPlateau.pressureBand,
          },
          transition: {
            nextLikelyState:      respAfterPlateau.nextLikelyState,
            transitionConfidence: respAfterPlateau.transitionConfidence,
          },
          previousConfidence: payload.priorState?.confidence ?? null,
          latestPatternCode,
        });
        const respAfterDecay: GcpStateResponse = decay.response;
        const wasDecayCandidate = respAfterPlateau.stateCode === 'CS'
                               || respAfterPlateau.stateCode === 'SS';
        if (isDev() && wasDecayCandidate) {
          console.log('[DIRECTIONAL DECAY]', {
            upgraded: decay.upgraded,
            from:     respAfterPlateau.stateCode,
            to:       respAfterDecay.stateCode,
            reasons:  decay.reasons,
            pressure: {
              long:  respAfterDecay.longPressure,
              short: respAfterDecay.shortPressure,
            },
            slope:     payload.metrics?.slope,
            goldTrend: payload.goldContext?.trend,
            phase:     anchored.phase,
            regime:    cur.regime.code,
            pattern:   latestPatternCode,
          });
        }

        // v13.1: structural dominance — penalties + amplification.
        // v13.2: the sanity guard is now a separate step that runs
        // AFTER the new temporal-pressure layer (which depends on
        // dominance context). So we ask deriveStructuralDominance to
        // skip its internal sanity guard here and re-apply it later.
        const recentHistoryForDominance = loadAiStateHistory()
          .filter(r => r.symbol === cur.symbol)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 10);
        const dominance = deriveStructuralDominance({
          aiState:        respAfterDecay,
          priceStructure: cur.priceStructure,
          metrics:        payload.metrics,
          goldTrend:      payload.goldContext?.trend ?? 'unknown',
          recentHistory:  recentHistoryForDominance,
          latestPatternCode,
          currentPressure: {
            long:  respAfterDecay.longPressure  ?? 50,
            short: respAfterDecay.shortPressure ?? 50,
          },
          runSanityGuard: false,   // v13.2: deferred until after temporal
        });
        if (isDev()) {
          const changed = dominance.adjustedLong  !== dominance.preLong
                       || dominance.adjustedShort !== dominance.preShort;
          if (changed || dominance.dominance !== 'neutral') {
            console.log('[STRUCTURAL DOMINANCE]', {
              dominance: dominance.dominance,
              score:     dominance.score,
              reasons:   dominance.reasons,
              before:    { long: dominance.preLong,      short: dominance.preShort },
              after:     { long: dominance.adjustedLong, short: dominance.adjustedShort },
              structure: cur.priceStructure?.structure ?? null,
            });
          }
        }

        // v13.2: Temporal pressure intelligence. Reads inherited
        // directional energy from the last 5 anchored history rows
        // and applies state-specific nudges so DC / DS / PS / CL no
        // longer collapse into 50/50. Runs BEFORE sanity so any
        // temporal overshoot still gets capped.
        const temporal = deriveTemporalPressureBias({
          aiState:          respAfterDecay,
          recentHistory:    recentHistoryForDominance,
          currentPressure:  {
            long:  dominance.adjustedLong,
            short: dominance.adjustedShort,
          },
          metrics:          payload.metrics,
          priceStructure:   cur.priceStructure,
          latestPatternCode,
        });
        const longAfterTemporal  = dominance.adjustedLong  + temporal.longAdjust;
        const shortAfterTemporal = dominance.adjustedShort + temporal.shortAdjust;
        if (isDev()
            && (temporal.longAdjust !== 0
             || temporal.momentumState !== 'transitioning'
             || temporal.inheritedTrend !== 'neutral')) {
          console.log('[TEMPORAL PRESSURE]', {
            state:          respAfterDecay.stateCode,
            inheritedTrend: temporal.inheritedTrend,
            momentumState:  temporal.momentumState,
            reasons:        temporal.reasons,
            before:         { long: dominance.adjustedLong, short: dominance.adjustedShort },
            after:          { long: longAfterTemporal,      short: shortAfterTemporal },
          });
        }

        // v13.2: sanity guard runs LAST. Same logic as the v13.1.1
        // tiered severity guard; only fires on triple-trigger
        // contradictions (sev>=3) or double-trigger with skew>75.
        const sanity = applyStructuralSanityGuard({
          dominance:      dominance.dominance,
          score:          dominance.score,
          currentPressure: { long: longAfterTemporal, short: shortAfterTemporal },
          faChain:        dominance.faChain,
          reclaim:        dominance.reclaim,
          structureClean: dominance.structureClean,
          priceStructure: cur.priceStructure,
        });
        const finalLong  = Math.max(15, Math.min(85, Math.round(sanity.long)));
        const finalShort = 100 - finalLong;
        const combinedReasons = [
          ...dominance.reasons,
          ...(temporal.longAdjust !== 0 ? temporal.reasons : []),
          ...sanity.reasons,
        ];

        const finalResp: GcpStateResponse = {
          ...respAfterDecay,
          longPressure:       finalLong,
          shortPressure:      finalShort,
          structureDominance: dominance.dominance,
          structureScore:     dominance.score,
          structureReasons:   combinedReasons,
          inheritedTrend:     temporal.inheritedTrend,
          momentumState:      temporal.momentumState,
        };

        // v12.0.1: unified pipeline trace. One log entry per classification
        // showing raw → anchored → final, plus the diagnostics that drove
        // each transition. The single record makes it possible to spot
        // FA regressions / payload drops / stale-cache loops in one
        // scroll instead of stitching together 4 separate logs.
        if (isDev()) {
          console.log('[GURU PIPELINE]', {
            symbol:    cur.symbol,
            timeframe: cur.timeframe,
            payloadPatternStory: payload.patternStory ?? null,
            payloadMetrics: {
              slope:     payload.metrics?.slope,
              curvature: payload.metrics?.curvature,
              ced:       payload.metrics?.ced,
            },
            rawEngine: {
              stateCode:      result.stateCode,
              state:          result.state,
              confidence:     result.confidence,
              reasoningShort: result.reasoningShort,
            },
            anchor: {
              overridden: anchor.overridden,
              reasons:    anchor.reasons,
              from:       result.stateCode,
              to:         anchored.stateCode,
            },
            final: {
              stateCode:  finalResp.stateCode,
              state:      finalResp.state,
              confidence: finalResp.confidence,
            },
            // v12.1: plateau overlay summary for traceability. Empty
            // when SS wasn't a candidate; reasons[] populated when the
            // overlay actually fired.
            plateauOverlay: respWithPressure.stateCode === 'SS' ? {
              upgraded: plateau.upgraded,
              reasons:  plateau.reasons,
            } : null,
            // v12.2: directional decay overlay summary. Empty when
            // CS/SS wasn't a candidate at that pipeline step.
            decayOverlay: wasDecayCandidate ? {
              upgraded: decay.upgraded,
              reasons:  decay.reasons,
            } : null,
            // v13.1: structural dominance summary. Always present
            // since the overlay runs unconditionally; reasons[] can
            // be empty when there's nothing structural to say.
            structuralDominance: {
              dominance: dominance.dominance,
              score:     dominance.score,
              before:    { long: dominance.preLong,      short: dominance.preShort },
              after:     { long: dominance.adjustedLong, short: dominance.adjustedShort },
            },
            // v13.2: temporal pressure summary.
            temporalPressure: {
              inheritedTrend: temporal.inheritedTrend,
              momentumState:  temporal.momentumState,
              longAdjust:     temporal.longAdjust,
              shortAdjust:    temporal.shortAdjust,
              afterTemporal:  { long: longAfterTemporal, short: shortAfterTemporal },
              afterSanity:    { long: finalLong,         short: finalShort },
            },
            nextLikelyState: finalResp.nextLikelyState ?? null,
            directionalPressure: {
              long:  pressure.longPressure,
              short: pressure.shortPressure,
              band:  pressure.confidenceBand,
            },
            stale: isStale,
            meta:  result._meta ?? null,
          });
        }

        // v12.0.1: FA GUARD VIOLATION sentinel. The anchor's FA hard
        // guard must keep FA only when the story or divergence justifies
        // it. If we ever see a final FA that fails all three checks,
        // something has bypassed the guard — either the anchor logic
        // changed, payload.patternStory was dropped in transit, or a
        // future state-transition / pressure override slipped a raw FA
        // back into the final. Loud-fail in the console so we catch it
        // immediately. This should NEVER fire in normal operation.
        if (finalResp.stateCode === 'FA') {
          const story = payload.patternStory;
          const dom   = story?.dom;
          const div   =
            (payload.metrics?.slope ??  0) >  0.10 && payload.goldContext?.trend === 'down' ||
            (payload.metrics?.slope ??  0) < -0.10 && payload.goldContext?.trend === 'up';
          const justified =
            story?.state === 'Failed alignment' ||
            dom          === 'FA' ||
            div;
          if (!justified) {
            console.warn('[FA GUARD VIOLATION] final stateCode is FA but story / dom / divergence do not justify it. This should never happen.', {
              storyState:  story?.state ?? null,
              dom:         dom ?? null,
              slope:       payload.metrics?.slope ?? null,
              goldTrend:   payload.goldContext?.trend ?? null,
              rawEngine:   result.stateCode,
              anchored:    anchored.stateCode,
              final:       finalResp.stateCode,
              overridden:  anchor.overridden,
              reasons:     anchor.reasons,
              stale:       isStale,
            });
          }
        }

        setState(finalResp);
        setLastSuccessAt(new Date());
        setAiStatus('success');
        if (isDev()) console.log('[AI UI] run success');
        resolved = true;

        // v12.0.1: skip aiStateHistory writes for stale responses. The
        // cached classification was already recorded when it was fresh;
        // re-appending it on every fallback would pollute the state
        // flow ribbon with N copies of the same row, exactly the
        // "Guru is showing FA forever" symptom we're trying to kill.
        // Stale still updates setState (so the UI shows the badge) and
        // still runs the full pipeline trace + FA guard.
        if (isStale) {
          if (isDev()) console.log('[AI HISTORY] skipped — stale response');
        } else {
          // v11.20: append the successful classification to the local
          // history ledger so the Research → By AI State view can
          // correlate it against subsequent price moves. Only the
          // success path records — failed/error/stale responses are
          // skipped.
          // v11.26.1: history records the ANCHORED classification so
          // Research statistics reflect what the user actually saw.
          const lastSeries = cur.series[cur.series.length - 1];
          // v12.1: history records the DISPLAYED state (post-plateau)
          // so the State Flow ribbon shows PS when applicable. When
          // the overlay upgraded SS → PS, also record originalStateCode
          // + localOverlay + overlayReasons so future Research can
          // correlate SS vs PS outcomes.
          appendAiStateHistory({
            timestamp:       Date.now(),
            symbol:          cur.symbol,
            timeframe:       cur.timeframe,
            state:           finalResp.state,
            stateCode:       finalResp.stateCode,
            phase:           finalResp.phase,
            direction:       finalResp.direction,
            confidence:      finalResp.confidence,
            marketBias:      finalResp.marketBias,
            regime:          cur.regime.code,
            netVariance:     lastSeries ? lastSeries.v : 0,
            patternCode:     cur.recentPatterns[cur.recentPatterns.length - 1]?.patternCode,
            patternName:     cur.recentPatterns[cur.recentPatterns.length - 1]?.patternName,
            pss:             cur.recentPatterns[cur.recentPatterns.length - 1]?.pss,
            priceAtAnalysis: cur.priceAtAnalysis ?? null,
            // v11.36: snapshot directional pressure alongside the anchored
            // classification so future research can correlate environment
            // bias % with actual price moves.
            // v12.1: post-overlay pressure (PS dampens these toward 50/50).
            longPressure:    finalResp.longPressure,
            shortPressure:   finalResp.shortPressure,
            pressureBand:    finalResp.pressureBand,
            // v12.1 / v12.2: overlay metadata. Plateau wins ordering
            // when both fire (it doesn't — plateau and decay are
            // mutually exclusive in practice, since the decay overlay
            // sees the post-plateau state and PS isn't in its CS/SS
            // candidate set). If somehow both upgrades happened in
            // the same pass, plateau's record wins.
            ...(plateau.upgraded ? {
              originalStateCode: 'SS',
              localOverlay:      'plateau' as const,
              overlayReasons:    plateau.reasons,
            } : decay.upgraded ? {
              originalStateCode: respAfterPlateau.stateCode,
              localOverlay:      'decay' as const,
              overlayReasons:    decay.reasons,
            } : {}),
            // ── v13.3: full snapshot for Expandable Guru History ─────
            pressureExplanation:  finalResp.pressureExplanation,
            structureDominance:   finalResp.structureDominance,
            structureScore:       finalResp.structureScore,
            structureReasons:     finalResp.structureReasons,
            inheritedTrend:       finalResp.inheritedTrend,
            momentumState:        finalResp.momentumState,
            patternStorySnap:     payload.patternStory
              ? {
                  seq:     payload.patternStory.seq,
                  state:   payload.patternStory.state,
                  bias:    payload.patternStory.bias,
                  cycle:   payload.patternStory.cycle,
                  dom:     payload.patternStory.dom,
                  posture: payload.patternStory.posture,
                }
              : undefined,
            nextLikelyState:      finalResp.nextLikelyState,
            transitionConfidence: finalResp.transitionConfidence,
            transitionReason:     finalResp.transitionReason,
            anchorOverridden:     anchor.overridden,
            anchorReasons:        anchor.reasons.length > 0 ? anchor.reasons : undefined,
            anchorFromCode:       anchor.overridden ? result.stateCode : undefined,
            stale:                finalResp.stale ?? false,
            staleReason:          finalResp.staleReason,
            modelMeta:            finalResp._meta
              ? {
                  model:        finalResp._meta.model,
                  provider:     finalResp._meta.provider,
                  latencyMs:    finalResp._meta.latencyMs,
                  routeSource:  finalResp._meta.routeSource,
                  fallback:     finalResp._meta.fallback,
                  deploymentId: finalResp._meta.deploymentId,
                }
              : undefined,
          });
        }
      } else {
        // v12.0.2: classifyGcpState returned null. The proxy serves
        // either {ok:false,...} or a stale-cache 200; null means we hit
        // a hard fail (config_missing without cache, 400, fetch abort).
        // The user sees aiStatus='error' → header verb "Error — try
        // again" and the "TRY AGAIN" button label.
        console.warn('[GURU RUN ERROR]', {
          symbol:    cur.symbol,
          timeframe: cur.timeframe,
          force,
          source,
          reason:    'classify_returned_null',
          message:   'Guru request failed — Engine proxy returned null (config missing, bad request, or aborted).',
        });
        setLastErrorAt(new Date());
        setAiStatus('error');
        resolved = true;
      }
    } catch (err) {
      console.warn('[GURU RUN ERROR]', {
        symbol:    cur.symbol,
        timeframe: cur.timeframe,
        force,
        source,
        reason:    'classify_threw',
        message:   'Guru request failed — exception during classification.',
        err:       err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err),
      });
      setLastErrorAt(new Date());
      setAiStatus('error');
      resolved = true;
    } finally {
      inflightRef.current = false;
      // Defensive: never leave the UI stuck in 'running' if neither
      // branch above ran (would imply an unexpected control-flow
      // escape). Falls back to 'idle' so the UI exits the analyzing
      // state regardless of what happened.
      if (!resolved) {
        setAiStatus('idle');
        if (isDev()) console.log('[AI UI] state reset to idle');
      }
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
      setAiStatus('idle');
      return;
    }
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      // v11.16.6: do NOT anchor nextPollAt to the decide tick — that
      // would show a misleading 25 s countdown when the user picked
      // 600 s. recomputeNextPollAt() reads lastCallAt + userInterval
      // so the displayed wait is always the real one.
      // v12.0.4: source='auto' so the [GURU RUN SKIPPED] log identifies
      // the heartbeat tick (which now never reaches the proxy — see
      // the hard auto-block at the top of runCall).
      recomputeNextPollAt();
      void runCall(false, 'auto');
    };

    tick();
    const id = setInterval(tick, DECIDE_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, runCall, recomputeNextPollAt]);

  // v12.0.4: runNow accepts { force, source }. Bare runNow() defaults
  // to force=false (= auto, skipped at the proxy boundary). Manual
  // button call sites MUST pass `{ force: true, source: '<button>' }`
  // — that's how the proxy's server-side cost gate gets bypassed.
  const runNow = useCallback((options?: { force?: boolean; source?: string }) => {
    const force  = options?.force  ?? false;
    const source = options?.source ?? 'unknown';
    void runCall(force, source);
  }, [runCall]);

  return {
    state, enabled, lastSuccessAt, lastErrorAt, nextPollAt,
    intervalSec, aiStatus, lastError, runNow,
  };
}
