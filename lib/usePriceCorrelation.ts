'use client';

import { useState, useEffect } from 'react';
import type { Pattern, MarketSymbol, Timeframe } from '@/types/gcp';
import { fetchCandlesForWindow } from './fetchCandles';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
};

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1D': 86_400_000,
};

export interface PatternStats {
  avgPriceChange: number;
  count:          number;
  bullish:        number;
  bearish:        number;
}

// Map of pattern kind → averaged outcome stats. Fetches up to the most-recent
// 20 occurrences across all kinds with a small per-call delay to stay under
// Twelve Data's burst limit.
export function usePriceCorrelation(
  patterns: Pattern[],
  symbol:   MarketSymbol,
  tf:       Timeframe,
): Map<string, PatternStats> {
  const [stats, setStats] = useState<Map<string, PatternStats>>(new Map());

  useEffect(() => {
    if (!patterns.length) {
      setStats(new Map());
      return;
    }

    let cancelled = false;
    const barMs = TIMEFRAME_MS[tf] ?? 900_000;

    async function processAll() {
      const buckets = new Map<string, number[]>();
      for (const p of patterns) {
        if (!buckets.has(p.kind)) buckets.set(p.kind, []);
      }

      const toProcess = patterns.slice(-20);

      for (let i = 0; i < toProcess.length; i++) {
        if (cancelled) return;

        const p   = toProcess[i];
        const end = p.tEnd + 4 * barMs;
        const sz  = Math.min(50, Math.ceil((p.tEnd - p.tStart) / barMs) + 8);

        try {
          const candles = await fetchCandlesForWindow(TD_SYMBOLS[symbol], tf, sz, end);
          const inWin   = candles.filter(c => c.t >= p.tStart && c.t <= p.tEnd);
          if (inWin.length >= 2) {
            const entry = inWin[0].o;
            const exit  = inWin[inWin.length - 1].c;
            if (entry > 0) {
              const pct = ((exit - entry) / entry) * 100;
              buckets.get(p.kind)!.push(pct);
            }
          }
        } catch { /* skip failed fetches silently */ }

        if (i < toProcess.length - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      if (cancelled) return;

      const out = new Map<string, PatternStats>();
      buckets.forEach((changes, kind) => {
        if (!changes.length) return;
        const avg     = changes.reduce((a, b) => a + b, 0) / changes.length;
        const bullish = changes.filter(c => c >  0.1).length;
        const bearish = changes.filter(c => c < -0.1).length;
        out.set(kind, { avgPriceChange: avg, count: changes.length, bullish, bearish });
      });

      setStats(out);
    }

    processAll();
    return () => { cancelled = true; };
  }, [patterns, symbol, tf]);

  return stats;
}
