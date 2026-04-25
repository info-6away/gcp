import { NextResponse } from 'next/server';

export const revalidate = 60;

interface YahooQuote {
  open: (number | null)[];
  high: (number | null)[];
  low:  (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
}

export interface GoldCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface GoldResponse {
  candles: GoldCandle[];
  lastPrice: number;
  lastTs: number;
  currency: string;
}

export async function GET() {
  try {
    const url =
      'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X' +
      '?interval=1m&range=1d&includePrePost=false';

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      throw new Error(`Yahoo Finance returned ${res.status}`);
    }

    const data = await res.json();
    const result = data?.chart?.result?.[0];

    if (!result) {
      throw new Error('No chart result in Yahoo Finance response');
    }

    const timestamps: number[] = result.timestamp ?? [];
    const quotes: YahooQuote   = result.indicators.quote[0];
    const currency: string     = result.meta?.currency ?? 'USD';

    const candles: GoldCandle[] = timestamps
      .map((t, i) => ({
        t: t * 1000,
        o: quotes.open[i]  ?? 0,
        h: quotes.high[i]  ?? 0,
        l: quotes.low[i]   ?? 0,
        c: quotes.close[i] ?? 0,
      }))
      .filter(c => c.o !== 0 && c.c !== 0);

    if (!candles.length) {
      throw new Error('No valid candles returned');
    }

    const last = candles[candles.length - 1];

    const body: GoldResponse = {
      candles,
      lastPrice: last.c,
      lastTs:    last.t,
      currency,
    };

    return NextResponse.json(body);
  } catch (err) {
    console.error('[/api/gold]', err);
    return NextResponse.json(
      { error: String(err), candles: [], lastPrice: null, lastTs: null },
      { status: 500 }
    );
  }
}
