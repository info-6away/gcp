// v14.7 — Phase 14.7: Market session awareness.
//
// Evidence layer only. The Radar has been returning 10/10 BLOCKED on
// early-hour scans. Before touching any rule, this asks a different
// question: WHEN are those scans happening? FX liquidity collapses
// outside the London / New York windows — a 05:00 UTC scan sees a
// thin, low-participation market, which is a different thing from a
// genuine coherence failure.
//
// deriveSessionContext maps each symbol to its active trading
// session(s) and a liquidity estimate. deriveFieldParticipation
// rolls that up across the scan universe.
//
// DISPLAY ONLY. confidencePenalty is returned for transparency but
// is NEVER applied — no Engine, classification, GO, pressure or
// action logic reads this file. Pure time derivation.

import type { MarketSymbol } from '@/types/gcp';

type Session = 'Sydney' | 'Tokyo' | 'London' | 'NewYork';

// Approximate session windows in UTC hours. Sydney wraps midnight.
const SESSION_HOURS: Record<Session, { start: number; end: number }> = {
  Sydney:  { start: 21, end: 6  },
  Tokyo:   { start: 0,  end: 9  },
  London:  { start: 7,  end: 16 },
  NewYork: { start: 12, end: 21 },
};

const SESSION_LABEL: Record<Session, string> = {
  Sydney: 'Sydney', Tokyo: 'Tokyo', London: 'London', NewYork: 'New York',
};

const ALL_SESSIONS: Session[] = ['Sydney', 'Tokyo', 'London', 'NewYork'];

// The sessions that actually drive each symbol's liquidity. Crypto
// trades 24/7 — an empty list flags the always-open path.
const SYMBOL_SESSIONS: Record<MarketSymbol, Session[]> = {
  XAUUSD: ['London', 'NewYork'],
  XAGUSD: ['London', 'NewYork'],
  EURUSD: ['London', 'NewYork'],
  GBPUSD: ['London', 'NewYork'],
  USDCHF: ['London', 'NewYork'],
  USDCAD: ['London', 'NewYork'],
  USDJPY: ['Tokyo',  'London'],
  AUDUSD: ['Sydney', 'Tokyo'],
  BTC:    [],
  ETH:    [],
};

export type LiquidityLevel = 'low' | 'moderate' | 'high';

export interface SessionContext {
  /** Human label of the active session(s). */
  sessionName:  string;
  liquidity:    LiquidityLevel;
  /** True when two relevant sessions overlap (peak participation). */
  overlap:      boolean;
  /** FX weekend close. Always false for crypto. */
  marketClosed: boolean;
  /** Display-only transparency hint — NEVER applied to any read. */
  confidencePenalty: number;
}

function sessionActive(s: Session, hour: number): boolean {
  const { start, end } = SESSION_HOURS[s];
  return start <= end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

// FX is closed Fri 21:00 UTC → Sun 21:00 UTC (approx).
function fxClosed(d: Date): boolean {
  const day = d.getUTCDay();   // 0 Sun … 6 Sat
  const h   = d.getUTCHours();
  if (day === 6) return true;
  if (day === 0 && h < 21) return true;
  if (day === 5 && h >= 21) return true;
  return false;
}

export function deriveSessionContext(
  symbol: MarketSymbol,
  now: number = Date.now(),
): SessionContext {
  const d    = new Date(now);
  const hour = d.getUTCHours();
  const prefs = SYMBOL_SESSIONS[symbol];

  // ── crypto — always open ──────────────────────────────────────────
  if (prefs.length === 0) {
    const londonNY = sessionActive('London', hour) && sessionActive('NewYork', hour);
    const anyMajor = sessionActive('London', hour) || sessionActive('NewYork', hour)
                  || sessionActive('Tokyo', hour);
    const liquidity: LiquidityLevel =
        londonNY  ? 'high'
      : anyMajor  ? 'moderate'
      :             'low';
    return {
      sessionName:  '24/7',
      liquidity,
      overlap:      londonNY,
      marketClosed: false,
      confidencePenalty: liquidity === 'low' ? 8 : liquidity === 'moderate' ? 3 : 0,
    };
  }

  // ── FX — weekend close ────────────────────────────────────────────
  if (fxClosed(d)) {
    return {
      sessionName:  'Closed · weekend',
      liquidity:    'low',
      overlap:      false,
      marketClosed: true,
      confidencePenalty: 15,
    };
  }

  // ── FX — session-driven liquidity ─────────────────────────────────
  const activePrefs = prefs.filter(s => sessionActive(s, hour));
  const activeAny   = ALL_SESSIONS.filter(s => sessionActive(s, hour));
  const overlap     = activePrefs.length >= 2;
  const liquidity: LiquidityLevel =
      overlap                  ? 'high'
    : activePrefs.length === 1 ? 'moderate'
    :                            'low';

  const sessionName =
      overlap
        ? `${SESSION_LABEL[activePrefs[0]]} + ${SESSION_LABEL[activePrefs[1]]} overlap`
    : activePrefs.length === 1
        ? SESSION_LABEL[activePrefs[0]]
    : activeAny.length > 0
        ? `${SESSION_LABEL[activeAny[0]]} · off-peak`
    :     'Off-session';

  return {
    sessionName,
    liquidity,
    overlap,
    marketClosed: false,
    confidencePenalty: liquidity === 'low' ? 12 : liquidity === 'moderate' ? 4 : 0,
  };
}

// ── field-wide participation roll-up ────────────────────────────────

export interface FieldParticipation {
  level: LiquidityLevel;
  lines: string[];
}

export function deriveFieldParticipation(
  symbols: MarketSymbol[],
  now: number = Date.now(),
): FieldParticipation {
  const hour = new Date(now).getUTCHours();
  const ctx  = symbols.map(s => deriveSessionContext(s, now));
  const total = ctx.length || 1;
  const low  = ctx.filter(c => c.liquidity === 'low').length;
  const high = ctx.filter(c => c.liquidity === 'high').length;

  const activeGlobal = ALL_SESSIONS.filter(s => sessionActive(s, hour));
  const lnOverlap = sessionActive('London', hour) && sessionActive('NewYork', hour);

  const level: LiquidityLevel =
      low  >= Math.ceil(total * 0.6) ? 'low'
    : high >= Math.ceil(total * 0.4) ? 'high'
    :                                  'moderate';

  const lines: string[] = [];
  lines.push(activeGlobal.length > 0
    ? `${activeGlobal.map(s => SESSION_LABEL[s]).join(' + ')} active`
    : 'No major session active');
  lines.push(lnOverlap
    ? 'London + NY overlap active'
    : 'No London/NY overlap');
  if (low > 0) {
    lines.push(`${low}/${total} symbols in low-liquidity hours`);
  } else if (high > 0) {
    lines.push(`${high}/${total} symbols in high-liquidity hours`);
  }

  return { level, lines };
}
