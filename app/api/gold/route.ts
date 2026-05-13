import { NextResponse } from 'next/server';

// v13.5: tightened to surface the provider's actual sample timestamp +
// the last candle's full OHLC so the client can compare upstream
// freshness against its own clock. The 60s `revalidate` on this route
// is intentional — it's a FALLBACK price source, not the live tick
// path (Twelve Data is the primary 1s feed in useGoldData). Hitting
// Yahoo at 1s would get us rate-limited within a minute.
export const revalidate = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? 'XAUUSD';
  const ticker =
    symbol === 'BTC'    ? 'BTC-USD' :
    symbol === 'XAGUSD' ? 'XAGUSD=X' :
    'XAUUSD=X';

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

    const indicators = result.indicators?.quote?.[0] ?? {};
    const timestamps: number[] = result.timestamp ?? [];
    const opens:  (number | null)[] = indicators.open  ?? [];
    const highs:  (number | null)[] = indicators.high  ?? [];
    const lows:   (number | null)[] = indicators.low   ?? [];
    const closes: (number | null)[] = indicators.close ?? [];

    // Scan from the end to find the last index where close is valid.
    let lastIdx = -1;
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (typeof c === 'number' && c > 0) {
        lastIdx = i;
        break;
      }
    }
    if (lastIdx < 0) throw new Error('No valid close');

    const lastPrice = closes[lastIdx] as number;
    const lastOhlc = {
      t: typeof timestamps[lastIdx] === 'number'
        ? timestamps[lastIdx] * 1000
        : null,
      o: opens[lastIdx]  ?? null,
      h: highs[lastIdx]  ?? null,
      l: lows[lastIdx]   ?? null,
      c: lastPrice,
    };
    const providerTs = lastOhlc.t;
    const regularMarketTime = result.meta?.regularMarketTime != null
      ? result.meta.regularMarketTime * 1000
      : null;

    // v13.5: response now includes the OHLC of the last fully-sampled
    // minute + the provider's sample timestamp. The client treats
    // these as a richer fallback when Twelve Data's /price endpoint
    // is unavailable; the live tick path still goes through TD on the
    // happy path.
    return NextResponse.json({
      lastPrice,
      marketStatus:       'live',
      providerTs,                                  // ms epoch of last sample
      regularMarketTime,                           // Yahoo's own "now" stamp
      lastOhlc,
      ageMs: providerTs != null ? Date.now() - providerTs : null,
    });
  } catch (err) {
    console.error('[/api/gold]', err);
    return NextResponse.json(
      { lastPrice: null, error: String(err) },
      { status: 500 }
    );
  }
}
