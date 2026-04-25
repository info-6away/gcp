import { NextResponse } from 'next/server';

export const revalidate = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? 'XAUUSD';
  const ticker = symbol === 'BTC' ? 'BTC-USD' : 'XAUUSD=X';

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);

    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No result');

    const closes: number[] = (result.indicators.quote[0].close ?? []).filter(
      (v: number | null): v is number => typeof v === 'number' && v > 0,
    );
    const lastPrice = closes[closes.length - 1];
    if (!lastPrice) throw new Error('No valid close');

    return NextResponse.json({ lastPrice, marketStatus: 'live' });
  } catch (err) {
    console.error('[/api/gold]', err);
    return NextResponse.json(
      { lastPrice: null, error: String(err) },
      { status: 500 }
    );
  }
}
