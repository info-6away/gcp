'use client';

// v11.25: hook that exposes the saved plan memory for a (symbol,
// timeframe) pair and runs lifecycle evaluation against the live
// price. Same pattern as useAiStateHistory / demoAccount — load on
// mount, react to storage events, persist transitions back.
//
// Single source of truth: callers don't need to wire `loadPlan` /
// `savePlan` directly. Two consumers today:
//   - GCPApp:        decides whether to overwrite the snapshot on a
//                    fresh AI run, builds priorPlan engine context.
//   - AiStateCard:   reads plan to render the PLAN STATUS line + the
//                    triggered-plan headline override.
// Both call this hook independently; storage events keep them in sync.

import { useCallback, useEffect, useState } from 'react';
import {
  loadPlan, savePlan, evaluatePlan,
  PLAN_MEMORY_LS_KEY, PLAN_TTL_MS,
  type PlanSnapshot,
} from '@/lib/aiPlanMemory';

export interface UseAiPlanMemoryResult {
  plan: PlanSnapshot | null;
  /** Replace the saved plan unconditionally (used when AI emits a new setup). */
  saveSnapshot: (snap: PlanSnapshot) => void;
  /** Refresh from storage (rarely needed; the hook auto-syncs). */
  refresh:      () => void;
}

export function useAiPlanMemory(
  symbol:        string,
  timeframe:     string,
  currentPrice:  number | null,
): UseAiPlanMemoryResult {
  const [plan, setPlan] = useState<PlanSnapshot | null>(null);

  const refresh = useCallback(() => {
    setPlan(loadPlan(symbol, timeframe));
  }, [symbol, timeframe]);

  // Mount + symbol/tf change.
  useEffect(() => {
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (e.key === PLAN_MEMORY_LS_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refresh]);

  // Lifecycle evaluation. Runs on every price tick. evaluatePlan
  // returns the same reference when no transition occurred so the
  // setState call below is a no-op in steady state (React bails on
  // identical state).
  useEffect(() => {
    if (!plan) return;
    if (currentPrice == null) {
      // v11.25.4 BUGFIX: never call evaluatePlan() with a synthetic
      // price when currentPrice is null. The previous shortcut
      //   evaluatePlan(plan, plan.triggerLevels.sellBelow ?? ... ?? 0)
      // passed the trigger level itself as the "current price",
      // which made `currentPrice <= sellBelow` immediately true and
      // spuriously transitioned the plan to `triggered`. A null price
      // (network hiccup, initial load before the price feed lands)
      // should only be allowed to advance the plan toward `expired`,
      // never toward `triggered` / `invalidated`.
      if (
        plan.status === 'waiting'
        && Date.now() - plan.timestamp > PLAN_TTL_MS
      ) {
        const expired: PlanSnapshot = { ...plan, status: 'expired' };
        setPlan(expired);
        savePlan(expired);
      }
      return;
    }
    const next = evaluatePlan(plan, currentPrice);
    if (next !== plan) {
      setPlan(next);
      savePlan(next);
    }
  }, [plan, currentPrice]);

  const saveSnapshot = useCallback((snap: PlanSnapshot) => {
    setPlan(snap);
    savePlan(snap);
  }, []);

  return { plan, saveSnapshot, refresh };
}
