'use client';

import { useState, useEffect, useCallback } from 'react';
import type { MarketSymbol } from '@/types/gcp';
import { isValidPrice, isReasonableJump } from '@/lib/sanity';

const TD_BASE = 'https://api.twelvedata.com';
const TD_KEY  = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY ?? '';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
};

const GOLD_API_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU',
  BTC:    'BTC',
  XAGUSD: 'XAG',
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

// Twelve Data is the primary live-price source for all three symbols
// (XAU/USD, XAG/USD, BTC/USD) on the TD Grow plan. gold-api stays as a
// fallback when TD errors or times out, and the Yahoo proxy is the last
// resort behind both.
async function fetchPrice(symbol: MarketSymbol): Promise<{ price: number; source: string }> {
  const sources = [
    { name: 'twelve-data', fn: () => tryTwelveData(symbol) },
    { name: 'gold-api',    fn: () => tryGoldApi(symbol)    },
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

// 2 s poll for TradingView-like live feel. TD Grow allows a single-symbol
// /price call at this rate without rate limiting; gold-api / Yahoo only
// fire when TD fails. This drives the chart's live-bar update too:
// ChartView mutates the rightmost candle's close on every tick.
const REFRESH_MS = 2_000;

// v11.12.1 localStorage warm-start. Per-symbol cache so switching XAUUSD
// <-> BTC <-> XAGUSD doesn't bleed the wrong last-known price into the
// new symbol's UI on reload. marketStatus is intentionally NOT cached --
// hydrating "live" from disk would lie to the user; the freshness cue
// stays the OfflineBanner + the existing source label.
const LS_GOLD_KEY = (symbol: MarketSymbol) => `gcpro-cache-gold-${symbol}`;

interface CachedGold {
  price:     number | null;
  prevPrice: number | null;
  change:    number | null;
  changePct: number | null;
  source:    string | null;
  lastFetch: number;     // Date.now() when the cache was written
}

function loadCachedGold(symbol: MarketSymbol): CachedGold | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LS_GOLD_KEY(symbol));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.price !== 'number') return null;
    return obj as CachedGold;
  } catch {
    return null;
  }
}

function saveCachedGold(symbol: MarketSymbol, c: CachedGold): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_GOLD_KEY(symbol), JSON.stringify(c));
  } catch {
    /* ignore quota / serialization */
  }
}

export function useGoldData(symbol: MarketSymbol = 'XAUUSD'): GoldState {
  const [state, setState] = useState<GoldState>({
    price: null, prevPrice: null, change: null, changePct: null,
    marketStatus: 'live', source: null,
    loading: true, error: null, lastFetch: null,
  });

  const fetchGold = useCallback(async () => {
    try {
      const { price, source } = await fetchPrice(symbol);

      // v11.13.1 sanity gate. tryTwelveData / tryGoldApi / tryYahoo
      // already throw on parse failure / non-positive prices, but
      // defense in depth: re-validate at the boundary so any future
      // source helper that forgets the check can't poison state.
      if (!isValidPrice(price)) {
        console.warn('[GOLD] invalid price rejected:', price);
        return; // keep prior state
      }

      setState(s => {
        // Reject unrealistic single-tick jumps (>10%). Real markets
        // don't move 10% in 2 seconds, even on BTC; a tick that
        // large is almost always a feed glitch. Returning `s` keeps
        // the previous state and skips the cache write.
        if (!isReasonableJump(s.price, price)) {
          console.warn('[GOLD] unrealistic jump rejected:', s.price, '->', price);
          return s;
        }

        const prev    = s.price ?? price;
        const change  = price - prev;
        const chgPct  = prev > 0 ? (change / prev) * 100 : 0;
        const next: GoldState = {
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
        // v11.12.1 + v11.13.1: persist last-known so the next reload
        // can warm-start. Cache write only fires on the success path
        // where we KNOW price passed both isValidPrice and the jump
        // guard, so the persisted value is always sane.
        saveCachedGold(symbol, {
          price:     next.price,
          prevPrice: next.prevPrice,
          change:    next.change,
          changePct: next.changePct,
          source:    next.source,
          lastFetch: next.lastFetch ? next.lastFetch.getTime() : Date.now(),
        });
        return next;
      });
    } catch (e) {
      // Don't blow away the last-known price on a single failed poll.
      // Keep the previous value visible, mark error, let the next tick
      // (2 s away) try again. If the user is fully offline the value
      // stays in place + OfflineBanner from v11.11 indicates state.
      setState(s => ({
        ...s,
        marketStatus: 'error',
        loading:      false,
        error:        String(e),
        lastFetch:    new Date(),
      }));
    }
  }, [symbol]);

  useEffect(() => {
    // Hydrate from localStorage so the dashboard shows last-known price
    // immediately on reload (offline or online). marketStatus stays
    // 'closed' because we cannot prove this value is currently live --
    // the OfflineBanner from v11.11 covers the freshness cue. The first
    // successful fetchGold below flips marketStatus to 'live' and
    // overwrites with a fresh price.
    const cached = loadCachedGold(symbol);
    if (cached) {
      setState({
        price:        cached.price,
        prevPrice:    cached.prevPrice,
        change:       cached.change,
        changePct:    cached.changePct,
        marketStatus: 'closed',
        source:       cached.source,
        loading:      true,
        error:        null,
        lastFetch:    cached.lastFetch ? new Date(cached.lastFetch) : null,
      });
    } else {
      setState({
        price: null, prevPrice: null, change: null, changePct: null,
        marketStatus: 'live', source: null,
        loading: true, error: null, lastFetch: null,
      });
    }
    fetchGold();
  }, [fetchGold, symbol]);

  useEffect(() => {
    const id = setInterval(fetchGold, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchGold]);

  return state;
}
