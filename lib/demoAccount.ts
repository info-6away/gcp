'use client';

// v11.24: paper-trading demo account.
//
// Pure data + persistence layer for the TRD page's demo trading panel.
// No broker wiring, no real orders — every state transition is local
// and goes through localStorage. Alignment classification compares the
// user's action against the AI's posture so the closed-trade table can
// later be analysed by which AI states / actions performed best.
//
// Sizing is fixed-notional (no leverage) per spec. PnL math is simple
// price-ratio:
//   long:  (current - entry) / entry * notional
//   short: (entry - current) / entry * notional

import type { MarketSymbol } from '@/types/gcp';
import type { ActionTone, MarketMode, SizeGuidance } from '@/lib/aiAction';

export const DEMO_LS_KEY = 'gcpro-demo-account';
export const STARTING_BALANCE = 10_000;
export const DEFAULT_NOTIONAL = 1_000;
export const QUICK_SIZES = [500, 1_000, 2_500] as const;
export const MAX_TRADES = 500;

export type Side = 'long' | 'short';
export type Alignment = 'followed' | 'against' | 'neutral' | 'unknown';

// Snapshot of the GCP / AI / Pattern context captured the moment a
// position is opened. Stored as primitives only so a future schema
// migration can read old records back.
export interface TradeContext {
  symbol:            MarketSymbol;
  timeframe:         string;

  aiState:           string | null;
  aiStateCode:       string | null;
  phase:             string | null;
  direction:         string | null;
  confidence:        number | null;

  actionText:        string | null;
  actionTone:        ActionTone | null;
  marketMode:        MarketMode | null;
  sizeGuidance:      SizeGuidance | null;

  tradePlanHeadline: string | null;

  patternCode:       string | null;
  patternName:       string | null;
  pss:               number | null;

  regime:            string | null;
  netVariance:       number | null;
}

export interface OpenPosition {
  side:        Side;
  size:        number;        // notional in USD
  entryPrice:  number;
  entryTime:   number;        // ms
  context:     TradeContext;
}

export interface ClosedTrade {
  id:          string;
  symbol:      MarketSymbol;
  side:        Side;
  size:        number;
  entryPrice:  number;
  entryTime:   number;
  exitPrice:   number;
  exitTime:    number;
  pnl:         number;
  alignment:   Alignment;
  context:     TradeContext;
}

export interface DemoAccount {
  balance:      number;       // realized cash
  realizedPnl:  number;       // cumulative
  open:         OpenPosition | null;
  trades:       ClosedTrade[];
}

const DEFAULT_ACCOUNT: DemoAccount = {
  balance:     STARTING_BALANCE,
  realizedPnl: 0,
  open:        null,
  trades:      [],
};

// --------------------------- Persistence ---------------------------

export function loadDemoAccount(): DemoAccount {
  if (typeof window === 'undefined') return { ...DEFAULT_ACCOUNT };
  try {
    const raw = window.localStorage.getItem(DEMO_LS_KEY);
    if (!raw) return { ...DEFAULT_ACCOUNT };
    const obj = JSON.parse(raw);
    return {
      balance:     typeof obj?.balance === 'number' ? obj.balance : STARTING_BALANCE,
      realizedPnl: typeof obj?.realizedPnl === 'number' ? obj.realizedPnl : 0,
      open:        obj?.open ?? null,
      trades:      Array.isArray(obj?.trades) ? obj.trades.slice(0, MAX_TRADES) : [],
    };
  } catch {
    return { ...DEFAULT_ACCOUNT };
  }
}

export function saveDemoAccount(acct: DemoAccount): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEMO_LS_KEY, JSON.stringify(acct));
    // Same-tab listeners need an explicit dispatch — `storage` only
    // fires cross-tab. Mirrors the pattern used by aiStateHistory.
    window.dispatchEvent(new StorageEvent('storage', { key: DEMO_LS_KEY }));
  } catch {
    /* quota / disabled storage: silent — paper trading is a nice-to-have */
  }
}

export function resetDemoAccount(): DemoAccount {
  const fresh = { ...DEFAULT_ACCOUNT };
  saveDemoAccount(fresh);
  return fresh;
}

// --------------------------- Math ---------------------------

export function computePnl(side: Side, entryPrice: number, currentPrice: number, size: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 0;
  const ratio = side === 'long'
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  return ratio * size;
}

export function computeEquity(acct: DemoAccount, currentPrice: number | null): number {
  if (!acct.open || currentPrice == null) return acct.balance;
  const open = computePnl(acct.open.side, acct.open.entryPrice, currentPrice, acct.open.size);
  return acct.balance + open;
}

// --------------------------- Mutations ---------------------------

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface OpenArgs {
  side:    Side;
  size:    number;
  price:   number;
  context: TradeContext;
}

// Opens a NEW position. If a position is already open, the caller must
// close it first — this function refuses rather than implicitly
// netting, so the demo behavior matches a one-position-at-a-time
// paper-trading flow.
export function openPosition(acct: DemoAccount, args: OpenArgs): DemoAccount {
  if (acct.open) return acct;
  if (!Number.isFinite(args.price) || args.price <= 0) return acct;
  if (!Number.isFinite(args.size)  || args.size  <= 0) return acct;
  return {
    ...acct,
    open: {
      side:       args.side,
      size:       args.size,
      entryPrice: args.price,
      entryTime:  Date.now(),
      context:    args.context,
    },
  };
}

// Closes the current position at exitPrice. PnL is realized into
// balance; the closed trade is prepended to the history (newest first)
// and the array is capped at MAX_TRADES.
export function closePosition(acct: DemoAccount, exitPrice: number): DemoAccount {
  if (!acct.open) return acct;
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return acct;
  const pos = acct.open;
  const pnl = computePnl(pos.side, pos.entryPrice, exitPrice, pos.size);
  const closed: ClosedTrade = {
    id:         newId(),
    symbol:     pos.context.symbol,
    side:       pos.side,
    size:       pos.size,
    entryPrice: pos.entryPrice,
    entryTime:  pos.entryTime,
    exitPrice,
    exitTime:   Date.now(),
    pnl,
    alignment:  classifyAlignment(pos.side, pos.context),
    context:    pos.context,
  };
  const trades = [closed, ...acct.trades].slice(0, MAX_TRADES);
  return {
    ...acct,
    balance:     acct.balance + pnl,
    realizedPnl: acct.realizedPnl + pnl,
    open:        null,
    trades,
  };
}

// --------------------------- Alignment ---------------------------

// Compares the user's BUY/SELL decision against the AI's posture.
// Intentionally coarse — the goal is bucket the trade for later
// performance analysis ("did following AI guidance help?"), not to
// score the trade in real-time.
//
// Rules (in priority order):
//   1. No AI context at all                           → 'unknown'
//   2. Posture says avoid / no-trade                  → 'against'
//   3. Size says No trade                             → 'against'
//   4. Posture risk / wait, or Small size, or DD      → 'neutral'
//   5. Posture favor + side aligned with direction    → 'followed'
//   6. Posture favor + side OPPOSED to direction      → 'against'
//   7. Anything else                                  → 'neutral'
export function classifyAlignment(side: Side, ctx: TradeContext): Alignment {
  if (!ctx.aiStateCode && !ctx.actionTone) return 'unknown';

  const tone = ctx.actionTone;
  if (tone === 'avoid')                  return 'against';
  if (ctx.sizeGuidance === 'No trade')   return 'against';
  if (tone === 'risk' || tone === 'wait') return 'neutral';
  if (ctx.sizeGuidance === 'Small')       return 'neutral';

  if (tone === 'favor') {
    const dir = ctx.direction;
    if (side === 'long'  && dir === 'Up')   return 'followed';
    if (side === 'short' && dir === 'Down') return 'followed';
    if (dir === 'Up' || dir === 'Down')      return 'against';
    return 'neutral';
  }
  return 'neutral';
}

// True if BUY/SELL should pop a confirmation dialog. Mirrors the
// "against" classification but without committing to a side, since the
// confirmation runs before the user has chosen long vs short.
export function isCautionPosture(ctx: TradeContext): boolean {
  if (ctx.actionTone === 'avoid')                   return true;
  if (ctx.sizeGuidance === 'No trade')              return true;
  if (ctx.aiStateCode === 'FA' || ctx.aiStateCode === 'DS') return true;
  if (ctx.aiStateCode === 'CL') return true;
  return false;
}

export function alignmentLabel(a: Alignment): string {
  switch (a) {
    case 'followed': return 'Followed AI';
    case 'against':  return 'Against AI';
    case 'neutral':  return 'Neutral / unclear';
    case 'unknown':  return 'No AI context';
  }
}

export function alignmentColor(a: Alignment): string {
  switch (a) {
    case 'followed': return '#22c55e';
    case 'against':  return '#ef4444';
    case 'neutral':  return '#d4a028';
    case 'unknown':  return '#7F98A3';
  }
}

// --------------------------- Performance summary (v11.24.1) ---------------------------

// Minimum closed trades before the TRD panel renders the summary
// instead of the "not enough data yet" placeholder. Below this, win
// rates are noise — three trades with one win shows 33% which tells
// the user nothing useful.
export const MIN_TRADES_FOR_SUMMARY = 5;

export interface BucketStats {
  count:   number;
  wins:    number;
  losses:  number;
  winRate: number;   // 0..1, NaN-safe (0 when count === 0)
  avgPnl:  number;
  totalPnl: number;
}

export interface PerformanceSummary {
  total:     BucketStats;
  byAlignment: Record<Alignment, BucketStats>;
}

const EMPTY_BUCKET: BucketStats = {
  count: 0, wins: 0, losses: 0, winRate: 0, avgPnl: 0, totalPnl: 0,
};

function bucketize(trades: ClosedTrade[]): BucketStats {
  if (!trades.length) return { ...EMPTY_BUCKET };
  let wins = 0, losses = 0, totalPnl = 0;
  for (const t of trades) {
    totalPnl += t.pnl;
    if (t.pnl > 0)      wins++;
    else if (t.pnl < 0) losses++;
  }
  return {
    count:    trades.length,
    wins,
    losses,
    winRate:  trades.length ? wins / trades.length : 0,
    avgPnl:   trades.length ? totalPnl / trades.length : 0,
    totalPnl,
  };
}

export function computePerformanceSummary(trades: ClosedTrade[]): PerformanceSummary {
  return {
    total: bucketize(trades),
    byAlignment: {
      followed: bucketize(trades.filter(t => t.alignment === 'followed')),
      against:  bucketize(trades.filter(t => t.alignment === 'against')),
      neutral:  bucketize(trades.filter(t => t.alignment === 'neutral')),
      unknown:  bucketize(trades.filter(t => t.alignment === 'unknown')),
    },
  };
}
