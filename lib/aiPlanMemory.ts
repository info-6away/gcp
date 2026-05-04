'use client';

// v11.25: AI plan memory + lifecycle tracking.
//
// Pure data layer. Persists the latest Trade Plan snapshot per
// (symbol, timeframe) to localStorage so subsequent price ticks can
// detect when the AI's stated trigger actually fires, when its
// invalidation level is reclaimed, or when the plan ages out. The
// dashboard reads this to show a "PLAN STATUS" line under the trade
// plan; the engine payload reads it to give the AI a compact summary
// of "what your last plan said and what happened to it" so a re-run
// doesn't repeat the same breakout-watch framing after the breakout
// already played out.
//
// No broker, no real orders — this is purely a frontend memory layer.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { TradePlan, TriggerLevels, InvalidationLevels } from '@/lib/tradePlan';
import type { MarketSymbol } from '@/types/gcp';

export const PLAN_MEMORY_LS_KEY = 'gcpro-ai-plan-memory';

// 4 h plan TTL per spec — older waiting plans auto-expire.
export const PLAN_TTL_MS = 4 * 3_600_000;

// Tolerance buffer on triggered-side reclaim checks. A bid that pokes
// 0.05% back through the trigger shouldn't immediately invalidate the
// active position; require a meaningful reclaim. Used as
// price * (1 ± BUFFER) for symmetric checks.
const RECLAIM_BUFFER = 0.002;

export type PlanStatus = 'waiting' | 'triggered' | 'invalidated' | 'expired';
export type TriggeredSide = 'buy' | 'sell';

export interface PlanSnapshot {
  id:        string;
  timestamp: number;            // ms epoch when the snapshot was taken
  symbol:    MarketSymbol;
  timeframe: string;

  aiState:        string;
  aiStateCode:    string;
  phase:          string;
  direction:      string;
  confidence:     number;

  analysisPrice:          number | null;
  currentPriceAtAnalysis: number | null;

  tradePlanHeadline:  string;
  triggers:           string[];
  triggerLevels:      TriggerLevels;
  invalidationLevels: InvalidationLevels;

  status:         PlanStatus;
  triggeredSide?: TriggeredSide;
  triggeredAt?:   number;
  triggeredPrice?: number;
}

// Compact prior-plan context forwarded to the engine on the next AI
// run. Tiny by design — the engine just needs to know "don't repeat
// the breakout-watch story; the trigger already fired".
export interface PriorPlanContext {
  status:               PlanStatus;
  triggeredSide?:       TriggeredSide;
  triggeredPrice?:      number;
  currentPrice?:        number;
  distanceFromTrigger?: number;
  ageMin:               number;
}

type PlanMap = Record<string, PlanSnapshot>;

function planKey(symbol: string, timeframe: string): string {
  return `${symbol}|${timeframe}`;
}

// --------------------------- Persistence ---------------------------

export function loadAllPlans(): PlanMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PLAN_MEMORY_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as PlanMap : {};
  } catch { return {}; }
}

export function loadPlan(symbol: string, timeframe: string): PlanSnapshot | null {
  return loadAllPlans()[planKey(symbol, timeframe)] ?? null;
}

export function saveAllPlans(plans: PlanMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PLAN_MEMORY_LS_KEY, JSON.stringify(plans));
    // Same-tab listeners need an explicit dispatch (storage event only
    // fires cross-tab). Mirrors aiStateHistory / demoAccount.
    window.dispatchEvent(new StorageEvent('storage', { key: PLAN_MEMORY_LS_KEY }));
  } catch { /* quota / disabled storage: silent */ }
}

export function savePlan(plan: PlanSnapshot): void {
  const all = loadAllPlans();
  all[planKey(plan.symbol, plan.timeframe)] = plan;
  saveAllPlans(all);
}

export function clearPlan(symbol: string, timeframe: string): void {
  const all = loadAllPlans();
  delete all[planKey(symbol, timeframe)];
  saveAllPlans(all);
}

// --------------------------- Build snapshot ---------------------------

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface BuildSnapshotArgs {
  symbol:        MarketSymbol;
  timeframe:     string;
  state:         GcpStateResponse;
  plan:          TradePlan;
  currentPrice:  number | null;
}

export function buildPlanSnapshot(args: BuildSnapshotArgs): PlanSnapshot {
  const { symbol, timeframe, state, plan, currentPrice } = args;
  return {
    id:        newId(),
    timestamp: Date.now(),
    symbol,
    timeframe,
    aiState:        state.state,
    aiStateCode:    state.stateCode,
    phase:          state.phase,
    direction:      state.direction,
    confidence:     state.confidence,
    analysisPrice:          plan.analysisPrice ?? null,
    currentPriceAtAnalysis: currentPrice ?? null,
    tradePlanHeadline:      plan.headline,
    triggers:               plan.triggers ?? [],
    triggerLevels:          plan.triggerLevels      ?? {},
    invalidationLevels:     plan.invalidationLevels ?? {},
    status:                 'waiting',
  };
}

// --------------------------- Lifecycle evaluation ---------------------------

// Pure function: given an existing plan and the current price, return
// the same plan or a new snapshot with an updated status. Returns the
// SAME object reference when no transition occurred so the caller can
// `if (next !== prev) save(next)`.
export function evaluatePlan(
  plan: PlanSnapshot,
  currentPrice: number,
  now: number = Date.now(),
): PlanSnapshot {
  if (plan.status === 'invalidated' || plan.status === 'expired') return plan;

  // Expiry only applies to plans that never triggered. A triggered
  // plan that hasn't been invalidated stays "active" until the user
  // resolves it.
  if (plan.status === 'waiting' && now - plan.timestamp > PLAN_TTL_MS) {
    return { ...plan, status: 'expired' };
  }

  if (plan.status === 'waiting') {
    const { sellBelow, buyAbove } = plan.triggerLevels;

    // Sell trigger (price drops through the breakdown level)
    if (sellBelow != null && currentPrice <= sellBelow) {
      return {
        ...plan,
        status:         'triggered',
        triggeredSide:  'sell',
        triggeredAt:    now,
        triggeredPrice: currentPrice,
      };
    }
    // Buy trigger (price breaks through the breakout level)
    if (buyAbove != null && currentPrice >= buyAbove) {
      return {
        ...plan,
        status:         'triggered',
        triggeredSide:  'buy',
        triggeredAt:    now,
        triggeredPrice: currentPrice,
      };
    }

    // Pullback-style invalidation (no buy/sell breakout level set,
    // just a drift through the structural reference).
    const { above, below } = plan.invalidationLevels;
    if (above != null && currentPrice >= above) {
      return { ...plan, status: 'invalidated' };
    }
    if (below != null && currentPrice <= below) {
      return { ...plan, status: 'invalidated' };
    }
    return plan;
  }

  // Triggered: invalidate if price reclaims back through the trigger
  // by more than RECLAIM_BUFFER (so a minor poke doesn't flip status).
  if (plan.status === 'triggered') {
    const { sellBelow, buyAbove } = plan.triggerLevels;
    if (plan.triggeredSide === 'sell' && sellBelow != null) {
      if (currentPrice >= sellBelow * (1 + RECLAIM_BUFFER)) {
        return { ...plan, status: 'invalidated' };
      }
    }
    if (plan.triggeredSide === 'buy' && buyAbove != null) {
      if (currentPrice <= buyAbove * (1 - RECLAIM_BUFFER)) {
        return { ...plan, status: 'invalidated' };
      }
    }
  }

  return plan;
}

// --------------------------- Engine payload context ---------------------------

export function buildPriorPlanContext(
  plan: PlanSnapshot,
  currentPrice: number | null,
  now: number = Date.now(),
): PriorPlanContext {
  const ageMin = Math.max(0, Math.round((now - plan.timestamp) / 60_000));
  const ctx: PriorPlanContext = {
    status: plan.status,
    ageMin,
  };
  if (plan.triggeredSide)  ctx.triggeredSide  = plan.triggeredSide;
  if (plan.triggeredPrice) ctx.triggeredPrice = +plan.triggeredPrice.toFixed(2);
  if (currentPrice != null) ctx.currentPrice  = +currentPrice.toFixed(2);
  if (plan.triggeredPrice != null && currentPrice != null) {
    ctx.distanceFromTrigger = +(currentPrice - plan.triggeredPrice).toFixed(2);
  }
  return ctx;
}

// --------------------------- Display helpers ---------------------------

function fmtLevel(n: number, symbol: MarketSymbol): string {
  if (symbol === 'BTC')    return Math.round(n).toLocaleString();
  if (symbol === 'XAGUSD') return n.toFixed(3);
  return n.toFixed(2);
}

export interface PlanStatusDisplay {
  text:   string;
  tone:   'wait' | 'good' | 'bad' | 'neutral';
}

// One-line plan status for the dashboard. Examples:
//   waiting:     "Waiting for sell break below 4573.77"
//   triggered:   "Triggered SELL at 4570.20 · now +31.97 in favor"
//   invalidated: "Invalidated — price reclaimed level"
//   expired:     "Expired — refresh AI analysis"
export function describePlanStatus(
  plan: PlanSnapshot,
  currentPrice: number | null,
): PlanStatusDisplay {
  const symbol = plan.symbol;
  if (plan.status === 'waiting') {
    const { sellBelow, buyAbove, resistance, support } = plan.triggerLevels;
    if (sellBelow != null) {
      return { text: `Waiting for sell break below ${fmtLevel(sellBelow, symbol)}`, tone: 'wait' };
    }
    if (buyAbove != null) {
      return { text: `Waiting for buy break above ${fmtLevel(buyAbove, symbol)}`, tone: 'wait' };
    }
    if (resistance != null && support != null) {
      return {
        text: `Waiting for breakout · ${fmtLevel(support, symbol)} – ${fmtLevel(resistance, symbol)}`,
        tone: 'wait',
      };
    }
    return { text: 'Waiting for setup', tone: 'wait' };
  }

  if (plan.status === 'triggered') {
    const side       = plan.triggeredSide ?? 'sell';
    const trigPrice  = plan.triggeredPrice ?? 0;
    const trigLabel  = trigPrice > 0 ? fmtLevel(trigPrice, symbol) : '—';
    let favorTxt = '';
    if (currentPrice != null && trigPrice > 0) {
      const inFavor = side === 'sell' ? trigPrice - currentPrice : currentPrice - trigPrice;
      const sign    = inFavor >= 0 ? '+' : '−';
      const abs     = Math.abs(inFavor);
      favorTxt      = ` · now ${sign}${fmtLevel(abs, symbol)} ${inFavor >= 0 ? 'in favor' : 'against'}`;
    }
    return {
      text: `Triggered ${side.toUpperCase()} at ${trigLabel}${favorTxt}`,
      tone: 'good',
    };
  }

  if (plan.status === 'invalidated') {
    return { text: 'Invalidated — price reclaimed level', tone: 'bad' };
  }

  // expired
  return { text: 'Expired — refresh AI analysis', tone: 'neutral' };
}

// Headline / triggers / invalidation override for a triggered plan.
// Returns null if no override should apply.
export interface TriggeredOverride {
  headline:     string;
  triggers:     string[];
  invalidation: string;
}

export function triggeredPlanOverride(plan: PlanSnapshot): TriggeredOverride | null {
  if (plan.status !== 'triggered' || !plan.triggeredSide) return null;
  if (plan.triggeredSide === 'sell') {
    return {
      headline:     'Manage active sell',
      triggers:     ['Manage sell / avoid late chase'],
      invalidation: 'Reclaim above breakdown level',
    };
  }
  return {
    headline:     'Manage active buy',
    triggers:     ['Manage buy / avoid late chase'],
    invalidation: 'Lose breakout level',
  };
}
