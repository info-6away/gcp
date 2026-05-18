'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MarketSymbol } from '@/types/gcp';
import { isValidPrice, isReasonableJump } from '@/lib/sanity';

const TD_BASE = 'https://api.twelvedata.com';
const TD_KEY  = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY ?? '';

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

// gold-api.com only serves metals/crypto. FX entries here are
// placeholders — tryGoldApi will 404 for them and the polling loop
// falls through to Twelve Data (which does support FX pairs).
const GOLD_API_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU',
  BTC:    'BTC',
  XAGUSD: 'XAG',
  EURUSD: 'EUR',
  USDJPY: 'JPY',
  ETH:    'ETH',
  GBPUSD: 'GBP',
  AUDUSD: 'AUD',
  USDCAD: 'CAD',
  USDCHF: 'CHF',
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

// v11.16.2: typed marker so the polling loop can distinguish a rate-limit
// response from any other transient failure and apply an explicit
// backoff instead of treating it like ordinary noise.
class Rate429Error extends Error {
  constructor(source: string) {
    super(`${source} 429`);
    this.name = 'Rate429Error';
  }
}

async function tryGoldApi(symbol: MarketSymbol): Promise<number> {
  const s = GOLD_API_SYMBOLS[symbol];
  const res = await fetch(`https://api.gold-api.com/price/${s}`, { signal: AbortSignal.timeout(5000) });
  if (res.status === 429) throw new Rate429Error('gold-api');
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
  if (res.status === 429) throw new Rate429Error('twelve-data');
  if (!res.ok) throw new Error(`TD ${res.status}`);
  const d = await res.json();
  // TD also signals rate-limit inside the JSON body with status: 'error',
  // code 429 — handle that path too so the backoff actually engages.
  if (d.status === 'error') {
    if (d.code === 429) throw new Rate429Error('twelve-data');
    throw new Error(d.message ?? 'TD error');
  }
  const p = parseFloat(d.price);
  if (!isFinite(p) || p <= 0) throw new Error('Invalid price');
  return p;
}

async function tryYahoo(symbol: MarketSymbol): Promise<{ price: number; providerTs: number | null }> {
  const res = await fetch(`/api/gold?symbol=${symbol}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Yahoo proxy ${res.status}`);
  const d = await res.json();
  if (!d.lastPrice) throw new Error('No price in response');
  // v13.5: surface the provider's sample timestamp so the [PRICE FEED]
  // diagnostic can compute upstream age (helpful for detecting whether
  // the synthetic feel is upstream sample lag).
  return {
    price:      d.lastPrice,
    providerTs: typeof d.providerTs === 'number' ? d.providerTs : null,
  };
}

interface PriceResult {
  price:      number;
  source:     string;
  saw429:     boolean;
  providerTs: number | null;
}

// Twelve Data is the primary live-price source for all three symbols
// (XAU/USD, XAG/USD, BTC/USD) on the TD Grow plan. gold-api stays as a
// fallback when TD errors or times out, and the Yahoo proxy is the last
// resort behind both. v11.16.2 also reports whether any source threw
// 429 so the caller can switch the polling loop into a backoff window
// even when a fallback succeeded.
async function fetchPrice(symbol: MarketSymbol): Promise<PriceResult> {
  // v13.5: Yahoo returns { price, providerTs }; TD + gold-api return
  // a bare number. Unify on { price, providerTs? } so the diagnostic
  // log can surface upstream age uniformly.
  const sources: Array<{
    name: string;
    fn:   () => Promise<number | { price: number; providerTs: number | null }>;
  }> = [
    { name: 'twelve-data', fn: () => tryTwelveData(symbol) },
    { name: 'gold-api',    fn: () => tryGoldApi(symbol)    },
    { name: 'yahoo',       fn: () => tryYahoo(symbol)      },
  ];

  let saw429 = false;
  const errors: string[] = [];
  for (const { name, fn } of sources) {
    try {
      const raw = await fn();
      const price      = typeof raw === 'number' ? raw : raw.price;
      const providerTs = typeof raw === 'number' ? null : raw.providerTs;
      return { price, source: name, saw429, providerTs };
    } catch (e) {
      if (e instanceof Rate429Error) saw429 = true;
      errors.push(`${name}: ${e}`);
      console.debug(`[price] ${name} failed:`, e);
    }
  }
  const err = new Error(`All sources failed: ${errors.join(' | ')}`) as Error & { saw429?: boolean };
  err.saw429 = saw429;
  throw err;
}

// v11.16.2: polling cadence is now adaptive. The TD Grow plan supports
// the 1 s active rate; gold-api / Yahoo only fire on TD failure. Hidden
// tabs slow down so a backgrounded PWA isn't hammering the wallet, and
// any 429 escalates the wait window so we stop poking the rate-limited
// source. None of these constants change the chart candle integrity
// logic, GCP polling, or the AI Engine loop.
const ACTIVE_INTERVAL_MS  = 1_000;
const HIDDEN_INTERVAL_MS  = 8_000;
const BACKOFF_INITIAL_MS  = 15_000;
const BACKOFF_MAX_MS      = 30_000;

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

  // v13.5: per-tick diagnostic state. Carries the last seen price /
  // source / localTs so the [PRICE FEED] log can compute tickDelta +
  // detect repeated ticks (a leading indicator of stale upstream data
  // during low-volatility periods).
  const priceDiagRef = useRef<{
    price:         number | null;
    source:        string | null;
    localTs:       number | null;
    repeatedTicks: number;
  }>({ price: null, source: null, localTs: null, repeatedTicks: 0 });

  const fetchGold = useCallback(async (): Promise<{ saw429: boolean }> => {
    const fetchStartedAt = Date.now();
    try {
      const { price, source, saw429, providerTs } = await fetchPrice(symbol);
      const fetchEndedAt = Date.now();

      // v11.13.1 sanity gate. tryTwelveData / tryGoldApi / tryYahoo
      // already throw on parse failure / non-positive prices, but
      // defense in depth: re-validate at the boundary so any future
      // source helper that forgets the check can't poison state.
      if (!isValidPrice(price)) {
        console.warn('[GOLD] invalid price rejected:', price);
        return { saw429 };
      }

      // v13.5 — [PRICE FEED] diagnostic. Logs the actual cadence + freshness
      // characteristics of the upstream feed so the user can confirm the
      // chart's "synthetic" feel is upstream-data-driven rather than a
      // rendering bug. Only logs when:
      //  - the price changed vs last tick (so quiet markets don't spam), OR
      //  - the source changed (provider fell back), OR
      //  - a 429 was seen on any source (rate-limit window engaged).
      if (process.env.NODE_ENV !== 'production') {
        const last         = priceDiagRef.current;
        const tickDeltaMs  = last.localTs ? fetchEndedAt - last.localTs : null;
        const priceChanged = last.price == null ? true : price !== last.price;
        const sourceChanged = last.source !== source;
        if (priceChanged || sourceChanged || saw429) {
          console.log('[PRICE FEED]', {
            symbol,
            source,
            price,
            localTs:        new Date(fetchEndedAt).toISOString(),
            providerTs:     providerTs != null ? new Date(providerTs).toISOString() : null,
            providerAgeMs:  providerTs != null ? fetchEndedAt - providerTs : null,
            tickDeltaMs,
            repeatedTicks:  priceChanged ? 0 : last.repeatedTicks + 1,
            roundTripMs:    fetchEndedAt - fetchStartedAt,
            saw429,
            stale:          tickDeltaMs != null && tickDeltaMs > ACTIVE_INTERVAL_MS * 4,
          });
        }
        priceDiagRef.current = {
          price,
          source,
          localTs:        fetchEndedAt,
          repeatedTicks:  priceChanged ? 0 : last.repeatedTicks + 1,
        };
      }

      setState(s => {
        // Reject unrealistic single-tick jumps (>10%). Real markets
        // don't move 10% in a second, even on BTC; a tick that large
        // is almost always a feed glitch. Returning `s` keeps the
        // previous state and skips the cache write.
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
      return { saw429 };
    } catch (e) {
      // Don't blow away the last-known price on a single failed poll.
      // Keep the previous value visible, mark error, let the next tick
      // try again. If the user is fully offline the value stays in
      // place + OfflineBanner from v11.11 indicates state.
      setState(s => ({
        ...s,
        marketStatus: 'error',
        loading:      false,
        error:        String(e),
        lastFetch:    new Date(),
      }));
      const saw429 = (e as { saw429?: boolean })?.saw429 === true;
      return { saw429 };
    }
  }, [symbol]);

  // Hydrate from localStorage so the dashboard shows last-known price
  // immediately on reload (offline or online). marketStatus stays
  // 'closed' because we cannot prove this value is currently live --
  // the OfflineBanner from v11.11 covers the freshness cue. The first
  // successful fetchGold below flips marketStatus to 'live' and
  // overwrites with a fresh price.
  useEffect(() => {
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
  }, [symbol]);

  // v11.16.2: adaptive polling loop. Self-scheduling setTimeout chain
  // so each tick re-evaluates document visibility and any current
  // backoff window before deciding when the next fetch fires. The loop
  // does NOT call fetchPrice in parallel with itself (each tick awaits
  // before scheduling the next), so a slow upstream just stretches the
  // gap rather than racing requests.
  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let backoffMs: number | null = null;
    let lastLoggedMs = -1;

    const computeInterval = () => {
      if (backoffMs !== null) return backoffMs;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      return hidden ? HIDDEN_INTERVAL_MS : ACTIVE_INTERVAL_MS;
    };

    const reasonFor = (ms: number) => {
      if (backoffMs !== null) return `backoff (${ms}ms after 429)`;
      if (ms === HIDDEN_INTERVAL_MS) return 'hidden tab';
      return 'active';
    };

    const tick = async () => {
      if (cancelled) return;
      const result = await fetchGold();
      if (cancelled) return;

      if (result.saw429) {
        backoffMs = backoffMs == null
          ? BACKOFF_INITIAL_MS
          : Math.min(BACKOFF_MAX_MS, backoffMs * 2);
      } else if (backoffMs !== null) {
        // First clean tick after a backoff window: drop straight back
        // to the visibility-aware interval. No gradual decay -- we
        // either are or aren't being rate-limited.
        backoffMs = null;
      }

      const next = computeInterval();
      if (next !== lastLoggedMs) {
        console.log(`[GOLD] poll interval adjusted -> ${next}ms (${reasonFor(next)})`);
        lastLoggedMs = next;
      }
      timerId = setTimeout(tick, next);
    };

    // Kick the first poll immediately so the dashboard shows a fresh
    // price as fast as the proxy chain can deliver one.
    tick();

    // Visibility flips don't cancel the in-flight request; the next
    // scheduled tick simply picks up the new interval. Forcing an
    // immediate re-fetch on becoming visible would be nicer but costs
    // an extra TD call every time the user tabs in -- skipped for now.
    const onVisibility = () => {
      const next = computeInterval();
      if (next !== lastLoggedMs) {
        console.log(`[GOLD] poll interval adjusted -> ${next}ms (${reasonFor(next)})`);
        lastLoggedMs = next;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchGold]);

  return state;
}
