'use client';

// v11.22: lightweight hook that fetches the last N candles for a
// symbol + timeframe and refreshes them on a slow interval. Used by
// the dashboard's Trade Plan layer to read price structure (HH/HL,
// LH/LL, range bounds) without piggy-backing on ChartView's progressive
// scroll-back fetching.
//
// Cadence is generous (5 min) because structure changes over many
// bars, not many seconds. Errors are swallowed — Trade Plan handles
// empty-candle state gracefully.

import { useEffect, useState } from 'react';
import { fetchCandlesForWindow, type Candle } from '@/lib/fetchCandles';
import type { MarketSymbol } from '@/types/gcp';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
  EURUSD: 'EUR/USD',
  USDJPY: 'USD/JPY',
  ETH:    'ETH/USD',
  GBPUSD: 'GBP/USD',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF',
};

const REFRESH_MS = 5 * 60_000;

export function useRecentCandles(
  symbol:     MarketSymbol,
  timeframe:  string,
  outputsize: number = 50,
): Candle[] {
  const [candles, setCandles] = useState<Candle[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      fetchCandlesForWindow(TD_SYMBOLS[symbol], timeframe, outputsize, Date.now())
        .then(data => { if (!cancelled) setCandles(data); })
        .catch(() => { /* keep last good candles */ });
    };
    fetchOnce();
    const id = setInterval(fetchOnce, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [symbol, timeframe, outputsize]);

  return candles;
}
