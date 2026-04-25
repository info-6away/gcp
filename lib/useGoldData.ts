'use client';

import { useState, useEffect, useCallback } from 'react';
import type { GoldCandle, GoldResponse, MarketStatus } from '@/app/api/gold/route';
import type { MarketSymbol } from '@/types/gcp';

export interface GoldState {
  candles:      GoldCandle[];
  lastPrice:    number | null;
  lastTs:       number | null;
  marketStatus: MarketStatus;
  sessionDate:  string | null;
  loading:      boolean;
  error:        string | null;
  lastFetch:    Date | null;
}

const REFRESH_LIVE_MS   = 60_000;
const REFRESH_CLOSED_MS = 300_000;

export function useGoldData(symbol: MarketSymbol = 'XAUUSD'): GoldState {
  const [state, setState] = useState<GoldState>({
    candles: [], lastPrice: null, lastTs: null,
    marketStatus: 'live', sessionDate: null,
    loading: true, error: null, lastFetch: null,
  });

  const fetchGold = useCallback(async () => {
    try {
      const res  = await fetch(`/api/gold?symbol=${symbol}`);
      const data: GoldResponse & { error?: string } = await res.json();

      if (data.marketStatus === 'error' || !data.candles?.length) {
        setState({
          candles: [],
          lastPrice: null,
          lastTs: null,
          marketStatus: 'error',
          sessionDate: null,
          loading: false,
          error: data.error ?? 'No data returned',
          lastFetch: new Date(),
        });
        return;
      }

      setState({
        candles:      data.candles,
        lastPrice:    data.lastPrice,
        lastTs:       data.lastTs,
        marketStatus: data.marketStatus,
        sessionDate:  data.sessionDate,
        loading:      false,
        error:        null,
        lastFetch:    new Date(),
      });
    } catch (e) {
      setState({
        candles: [],
        lastPrice: null,
        lastTs: null,
        marketStatus: 'error',
        sessionDate: null,
        loading: false,
        error: String(e),
        lastFetch: new Date(),
      });
    }
  }, [symbol]);

  useEffect(() => {
    setState({
      candles: [],
      lastPrice: null,
      lastTs: null,
      marketStatus: 'live',
      sessionDate: null,
      loading: true,
      error: null,
      lastFetch: null,
    });
    fetchGold();
  }, [fetchGold, symbol]);

  useEffect(() => {
    const interval = state.marketStatus === 'live'
      ? REFRESH_LIVE_MS
      : REFRESH_CLOSED_MS;

    const id = setInterval(fetchGold, interval);
    return () => clearInterval(id);
  }, [fetchGold, state.marketStatus]);

  return state;
}
