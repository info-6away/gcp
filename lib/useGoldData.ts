'use client';

import { useState, useEffect, useCallback } from 'react';
import type { MarketSymbol } from '@/types/gcp';

const TD_BASE = 'https://api.twelvedata.com';
const TD_KEY  = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY ?? '';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
};

const GOLD_API_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU',
  BTC:    'BTC',
};

export interface GoldState {
  price:        number | null;
  prevPrice:    number | null;
  change:       number | null;
  changePct:    number | null;
  marketStatus: 'live' | 'closed' | 'error';
  source:       string | null;
  loading:      boolean;
  error:        string | null;
  lastFetch:    Date | null;
}

async function tryGoldApi(symbol: MarketSymbol): Promise<number> {
  const s = GOLD_API_SYMBOLS[symbol];
  const res = await fetch(`https://api.gold-api.com/price/${s}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`gold-api ${res.status}`);
  const d = await res.json();
  const raw = d.price ?? d.rate ?? d.bid;
  const p = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  if (!isFinite(p) || p <= 0) throw new Error('Invalid price');
  return p;
}

async function tryTwelveData(symbol: MarketSymbol): Promise<number> {
  if (!TD_KEY) throw new Error('No TD key');
  const s = encodeURIComponent(TD_SYMBOLS[symbol]);
  const res = await fetch(
    `${TD_BASE}/price?symbol=${s}&apikey=${TD_KEY}`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`TD ${res.status}`);
  const d = await res.json();
  if (d.status === 'error') throw new Error(d.message ?? 'TD error');
  const p = parseFloat(d.price);
  if (!isFinite(p) || p <= 0) throw new Error('Invalid price');
  return p;
}

async function tryYahoo(symbol: MarketSymbol): Promise<number> {
  const res = await fetch(`/api/gold?symbol=${symbol}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Yahoo proxy ${res.status}`);
  const d = await res.json();
  if (!d.lastPrice) throw new Error('No price in response');
  return d.lastPrice;
}

async function fetchPrice(symbol: MarketSymbol): Promise<{ price: number; source: string }> {
  const sources = [
    { name: 'gold-api',    fn: () => tryGoldApi(symbol)   },
    { name: 'twelve-data', fn: () => tryTwelveData(symbol) },
    { name: 'yahoo',       fn: () => tryYahoo(symbol)      },
  ];

  const errors: string[] = [];
  for (const { name, fn } of sources) {
    try {
      const price = await fn();
      return { price, source: name };
    } catch (e) {
      errors.push(`${name}: ${e}`);
      console.debug(`[price] ${name} failed:`, e);
    }
  }
  throw new Error(`All sources failed: ${errors.join(' | ')}`);
}

const REFRESH_MS = 60_000;

export function useGoldData(symbol: MarketSymbol = 'XAUUSD'): GoldState {
  const [state, setState] = useState<GoldState>({
    price: null, prevPrice: null, change: null, changePct: null,
    marketStatus: 'live', source: null,
    loading: true, error: null, lastFetch: null,
  });

  const fetchGold = useCallback(async () => {
    try {
      const { price, source } = await fetchPrice(symbol);

      setState(s => {
        const prev    = s.price ?? price;
        const change  = price - prev;
        const chgPct  = prev > 0 ? (change / prev) * 100 : 0;
        return {
          price,
          prevPrice:    prev,
          change:       +change.toFixed(2),
          changePct:    +chgPct.toFixed(2),
          marketStatus: 'live',
          source,
          loading:      false,
          error:        null,
          lastFetch:    new Date(),
        };
      });
    } catch (e) {
      setState({
        price: null, prevPrice: null, change: null, changePct: null,
        marketStatus: 'error', source: null,
        loading:      false,
        error:        String(e),
        lastFetch:    new Date(),
      });
    }
  }, [symbol]);

  useEffect(() => {
    setState({
      price: null, prevPrice: null, change: null, changePct: null,
      marketStatus: 'live', source: null,
      loading: true, error: null, lastFetch: null,
    });
    fetchGold();
  }, [fetchGold, symbol]);

  useEffect(() => {
    const id = setInterval(fetchGold, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchGold]);

  return state;
}
