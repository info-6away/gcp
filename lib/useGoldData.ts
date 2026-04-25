'use client';

import { useState, useEffect, useCallback } from 'react';
import type { GoldCandle, GoldResponse } from '@/app/api/gold/route';

export interface GoldState {
  candles:   GoldCandle[];
  lastPrice: number | null;
  lastTs:    number | null;
  loading:   boolean;
  error:     string | null;
  lastFetch: Date | null;
}

const REFRESH_MS = 60_000;

export function useGoldData(): GoldState {
  const [state, setState] = useState<GoldState>({
    candles: [], lastPrice: null, lastTs: null,
    loading: true, error: null, lastFetch: null,
  });

  const fetchGold = useCallback(async () => {
    try {
      const res  = await fetch('/api/gold');
      const data: GoldResponse & { error?: string } = await res.json();

      if (data.error || !data.candles?.length) {
        setState(s => ({
          ...s,
          loading: false,
          error: data.error ?? 'Empty response',
          lastFetch: new Date(),
        }));
        return;
      }

      setState({
        candles:   data.candles,
        lastPrice: data.lastPrice,
        lastTs:    data.lastTs,
        loading:   false,
        error:     null,
        lastFetch: new Date(),
      });
    } catch (e) {
      setState(s => ({
        ...s,
        loading: false,
        error: String(e),
        lastFetch: new Date(),
      }));
    }
  }, []);

  useEffect(() => {
    fetchGold();
    const id = setInterval(fetchGold, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchGold]);

  return state;
}
