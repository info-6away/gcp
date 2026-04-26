const TD_BASE = 'https://api.twelvedata.com';
const TD_KEY  = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY ?? '';

const TD_INTERVALS: Record<string, string> = {
  '1m': '1min', '5m': '5min', '15m': '15min',
  '1h': '1h',   '4h': '4h',   '1D': '1day',
};

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

interface RawValue {
  datetime: string;
  open:     string;
  high:     string;
  low:      string;
  close:    string;
}

// Fetch up to `outputsize` candles ending at `endMs` (Unix ms).
// `symbol` is a Twelve Data slash-form ticker (e.g. 'XAU/USD').
export async function fetchCandlesForWindow(
  symbol:     string,
  tf:         string,
  outputsize: number,
  endMs:      number,
): Promise<Candle[]> {
  if (!TD_KEY) throw new Error('No Twelve Data API key configured');

  const interval = TD_INTERVALS[tf] ?? '15min';
  const endDate  = new Date(endMs).toISOString().replace('T', ' ').slice(0, 19);

  const url = `${TD_BASE}/time_series`
    + `?symbol=${encodeURIComponent(symbol)}`
    + `&interval=${interval}`
    + `&outputsize=${outputsize}`
    + `&end_date=${encodeURIComponent(endDate)}`
    + `&apikey=${TD_KEY}`;

  const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Twelve Data ${res.status}`);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message ?? 'TD error');

  const values: RawValue[] = data.values ?? [];
  return values.slice().reverse().map(v => ({
    t: new Date(v.datetime + 'Z').getTime(),
    o: parseFloat(v.open),
    h: parseFloat(v.high),
    l: parseFloat(v.low),
    c: parseFloat(v.close),
  }));
}
