import { NextResponse } from 'next/server';
import { getSymbolMeta, type MarketSymbol } from '@/types/gcp';

export const revalidate = 300;

export type MarketStatus = 'live' | 'closed' | 'error';

export interface GoldCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface GoldResponse {
  candles:      GoldCandle[];
  lastPrice:    number | null;
  lastTs:       number | null;
  currency:     string;
  marketStatus: MarketStatus;
  sessionDate:  string | null;
  symbol:       MarketSymbol;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};

async function fetchCandles(ticker: string, range: string): Promise<GoldCandle[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}` +
    `?interval=1m&range=${range}&includePrePost=false`;

  const res = await fetch(url, { headers: HEADERS, next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);

  const data   = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('No chart result');

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators.quote[0];

  return timestamps
    .map((t, i) => ({
      t: t * 1000,
      o: q.open[i]  ?? 0,
      h: q.high[i]  ?? 0,
      l: q.low[i]   ?? 0,
      c: q.close[i] ?? 0,
    }))
    .filter(c => c.o !== 0 && c.c !== 0);
}

function lastSessionCandles(allCandles: GoldCandle[]): GoldCandle[] {
  if (!allCandles.length) return [];

  const byDate = new Map<string, GoldCandle[]>();
  for (const c of allCandles) {
    const key = new Date(c.t).toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(c);
  }

  const sortedDates = [...byDate.keys()].sort();
  const lastDate    = sortedDates[sortedDates.length - 1];
  return byDate.get(lastDate) ?? [];
}

function formatSessionDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const symbolId = (searchParams.get('symbol') ?? 'XAUUSD') as MarketSymbol;
  const meta     = getSymbolMeta(symbolId);
  const ticker   = meta.yahooTicker;

  try {
    let candles = await fetchCandles(ticker, '1d');
    let marketStatus: MarketStatus = 'live';

    if (candles.length === 0) {
      const all    = await fetchCandles(ticker, '5d');
      candles      = lastSessionCandles(all);
      marketStatus = symbolId === 'BTC' ? 'live' : 'closed';
    }

    if (!candles.length) throw new Error('No candles after fallback');

    const last: GoldCandle = candles[candles.length - 1];

    const body: GoldResponse = {
      candles,
      lastPrice:   last.c,
      lastTs:      last.t,
      currency:    'USD',
      marketStatus,
      sessionDate: formatSessionDate(last.t),
      symbol:      symbolId,
    };

    return NextResponse.json(body);

  } catch (err) {
    console.error('[/api/gold]', err);
    const fallback: GoldResponse = {
      candles: [], lastPrice: null, lastTs: null,
      currency: 'USD', marketStatus: 'error', sessionDate: null,
      symbol: symbolId,
    };
    return NextResponse.json(fallback, { status: 500 });
  }
}
