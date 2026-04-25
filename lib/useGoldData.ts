'use client';

import { useState, useEffect, useCallback } from 'react';
import type { MarketSymbol } from '@/types/gcp';

const GOLD_API_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU',
  BTC:    'BTC',
};

const GOLD_API_BASE = 'https://api.gold-api.com';

export interface GoldState {
  price:        number | null;
  prevPrice:    number | null;
  change:       number | null;
  changePct:    number | null;
  marketStatus: 'live' | 'closed' | 'error';
  loading:      boolean;
  error:        string | null;
  lastFetch:    Date | null;
}

const REFRESH_MS = 60_000;

export function useGoldData(symbol: MarketSymbol = 'XAUUSD'): GoldState {
  const [state, setState] = useState<GoldState>({
    price: null, prevPrice: null, change: null, changePct: null,
    marketStatus: 'live', loading: true, error: null, lastFetch: null,
  });

  const fetchGold = useCallback(async () => {
    const apiSymbol = GOLD_API_SYMBOLS[symbol];
    if (!apiSymbol) return;

    try {
      const res = await fetch(`${GOLD_API_BASE}/price/${apiSymbol}`);
      if (!res.ok) throw new Error(`gold-api returned ${res.status}`);

      const data = await res.json();
      console.log('[gold-api]', symbol, apiSymbol, data);

      const rawPrice = data.price ?? data.rate ?? data.bid ?? null;
      const rawPrev  = data.prev_close_price ?? data.previousClose ?? rawPrice;

      if (rawPrice === null || rawPrice === undefined) {
        throw new Error(`No price field in response: ${JSON.stringify(data)}`);
      }

      const price     = typeof rawPrice === 'string' ? parseFloat(rawPrice) : Number(rawPrice);
      const prevClose = typeof rawPrev  === 'string' ? parseFloat(rawPrev)  : Number(rawPrev);

      if (!isFinite(price) || price <= 0) {
        throw new Error(`Invalid price value: ${rawPrice}`);
      }

      const change    = price - prevClose;
      const changePct = prevClose ? (change / prevClose) * 100 : 0;

      setState({
        price,
        prevPrice:    prevClose,
        change:       +change.toFixed(2),
        changePct:    +changePct.toFixed(2),
        marketStatus: 'live',
        loading:      false,
        error:        null,
        lastFetch:    new Date(),
      });
    } catch (e) {
      setState({
        price: null, prevPrice: null, change: null, changePct: null,
        marketStatus: 'error',
        loading:      false,
        error:        String(e),
        lastFetch:    new Date(),
      });
    }
  }, [symbol]);

  useEffect(() => {
    setState({
      price: null, prevPrice: null, change: null, changePct: null,
      marketStatus: 'live', loading: true, error: null, lastFetch: null,
    });
    fetchGold();
  }, [fetchGold, symbol]);

  useEffect(() => {
    const id = setInterval(fetchGold, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchGold]);

  return state;
}
