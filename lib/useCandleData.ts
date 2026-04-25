'use client';

import { useState, useEffect, useCallback } from 'react';
import type { MarketSymbol, Timeframe, ViewWindow } from '@/types/gcp';
import { TIMEFRAME_BARS } from '@/types/gcp';

const TD_BASE = 'https://api.twelvedata.com';
const TD_KEY  = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY ?? '';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
};

const TD_INTERVALS: Record<Timeframe, string> = {
  '1m':  '1min',
  '5m':  '5min',
  '15m': '15min',
  '1h':  '1h',
  '4h':  '4h',
  '1D':  '1day',
};

function calcOutputsize(timeframe: Timeframe, viewWindow: ViewWindow): number {
  const minutesPerBar = TIMEFRAME_BARS[timeframe];
  const windowMinutes: Record<ViewWindow, number> = {
    '24h':  1_440,
    '7d':   10_080,
    '30d':  43_200,
    'all':  129_600,
  };
  const needed = Math.ceil(windowMinutes[viewWindow] / minutesPerBar);
  return Math.min(5000, Math.max(100, needed));
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface CandleState {
  candles:   Candle[];
  loading:   boolean;
  error:     string | null;
  lastFetch: Date | null;
}

const REFRESH_MS = 60_000;

export function useCandleData(
  symbol: MarketSymbol,
  timeframe: Timeframe,
  viewWindow: ViewWindow,
): CandleState {
  const [state, setState] = useState<CandleState>({
    candles: [], loading: true, error: null, lastFetch: null,
  });

  const fetchCandles = useCallback(async () => {
    const tdSymbol = TD_SYMBOLS[symbol];
    if (!tdSymbol || !TD_KEY) {
      setState(s => ({ ...s, loading: false, error: 'No API key configured' }));
      return;
    }

    try {
      const tdInterval = TD_INTERVALS[timeframe] ?? '15min';
      const outputsize = calcOutputsize(timeframe, viewWindow);

      const url = `${TD_BASE}/time_series`
        + `?symbol=${encodeURIComponent(tdSymbol)}`
        + `&interval=${tdInterval}`
        + `&outputsize=${outputsize}`
        + `&apikey=${TD_KEY}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Twelve Data returned ${res.status}`);

      const data = await res.json();

      if (data.status === 'error') {
        throw new Error(data.message ?? 'Twelve Data error');
      }

      const values: { datetime: string; open: string; high: string; low: string; close: string }[] =
        (data.values ?? []).slice().reverse();

      const candles: Candle[] = values.map(v => ({
        t: new Date(v.datetime + 'Z').getTime(),
        o: parseFloat(v.open),
        h: parseFloat(v.high),
        l: parseFloat(v.low),
        c: parseFloat(v.close),
      }));

      setState({ candles, loading: false, error: null, lastFetch: new Date() });
    } catch (e) {
      setState(s => ({
        ...s, loading: false, error: String(e), lastFetch: new Date(),
      }));
    }
  }, [symbol, timeframe, viewWindow]);

  useEffect(() => {
    setState({ candles: [], loading: true, error: null, lastFetch: null });
    fetchCandles();
  }, [fetchCandles, symbol, timeframe, viewWindow]);

  useEffect(() => {
    const id = setInterval(fetchCandles, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchCandles]);

  return state;
}
