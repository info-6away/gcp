const TD_BASE = 'https://api.twelvedata.com';
const TD_KEY  = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY ?? '';

const TD_INTERVALS: Record<string, string> = {
  '1m': '1min', '5m': '5min', '15m': '15min',
  '1h': '1h',   '4h': '4h',   '1D': '1day',
};

const TF_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1D': 86_400_000,
};

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  synthetic?: boolean;
}

// BTC trades 24/7 so its candles never have weekend/session gaps. Gold/silver
// (XAU/USD, XAG/USD) close on weekends, leaving multi-day holes that the
// GCP pane's continuous time axis paints over -- making the GCP line look
// shifted from the candle pane. Filling missing slots with flat synthetic
// bars forces LW Charts to allocate time-axis space for those windows so
// the two panes line up.
function shouldFillGaps(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return !(s === 'BTC' || s === 'BTC/USD' || s === 'BTCUSD');
}

function fillWeekendGaps(candles: Candle[], tfMs: number): Candle[] {
  if (candles.length < 2) return candles;
  const out: Candle[] = [candles[0]];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const gap  = curr.t - prev.t;
    if (gap > 2 * tfMs) {
      const flat = prev.c;
      for (let t = prev.t + tfMs; t < curr.t; t += tfMs) {
        out.push({ t, o: flat, h: flat, l: flat, c: flat, synthetic: true });
      }
    }
    out.push(curr);
  }
  return out;
}

// Extend the candle series with flat synthetic bars from the last candle up
// to "now" so LW Charts allocates time-axis space for the post-close period.
// Without this, gold/silver close at ~21:00 UTC daily and Twelve Data
// returns no further candles -- the GCP line's live tail past close is
// rendered past the right edge of the chart and disappears.
function extendToNow(candles: Candle[], tfMs: number): Candle[] {
  if (!candles.length || tfMs <= 0) return candles;
  const last     = candles[candles.length - 1];
  const nowSlot  = Math.floor(Date.now() / tfMs) * tfMs;
  if (nowSlot <= last.t) return candles;

  const flat = last.c;
  const out  = candles.slice();
  let added  = 0;
  const MAX  = 500;
  for (let t = last.t + tfMs; t <= nowSlot && added < MAX; t += tfMs) {
    out.push({ t, o: flat, h: flat, l: flat, c: flat, synthetic: true });
    added++;
  }
  return out;
}

interface RawValue {
  datetime: string;
  open:     string;
  high:     string;
  low:      string;
  close:    string;
}

// Single source of truth for Twelve Data /time_series requests. Centralises
// the two things that have already broken alignment once: the timezone=UTC
// query param (without it metals localize to NY exchange time) and the ISO
// 8601 datetime normalization (space + 'Z' is implementation-defined; T + Z
// parses as UTC on every engine). Any new candle fetch site should call
// through here.
export async function tdTimeSeries(opts: {
  symbol:     string;
  tf:         string;
  outputsize: number;
  endMs?:     number;
  signal?:    AbortSignal;
}): Promise<Candle[]> {
  if (!TD_KEY) throw new Error('No Twelve Data API key configured');

  const interval = TD_INTERVALS[opts.tf] ?? '15min';
  const params: string[] = [
    `symbol=${encodeURIComponent(opts.symbol)}`,
    `interval=${interval}`,
    `outputsize=${opts.outputsize}`,
    `timezone=UTC`,
    `apikey=${TD_KEY}`,
  ];
  if (opts.endMs != null) {
    const endDate = new Date(opts.endMs).toISOString().replace('T', ' ').slice(0, 19);
    params.push(`end_date=${encodeURIComponent(endDate)}`);
  }
  const url = `${TD_BASE}/time_series?${params.join('&')}`;

  const res  = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`Twelve Data ${res.status}`);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message ?? 'TD error');

  const values: RawValue[] = data.values ?? [];
  return values.slice().reverse().map(v => ({
    t: new Date(v.datetime.replace(' ', 'T') + 'Z').getTime(),
    o: parseFloat(v.open),
    h: parseFloat(v.high),
    l: parseFloat(v.low),
    c: parseFloat(v.close),
  }));
}

// Fetch up to `outputsize` candles ending at `endMs` (Unix ms). Adds the
// non-BTC weekend / overnight / extend-to-now synthetic bar passes so the
// time axis stays continuous when gold/silver markets are closed.
export async function fetchCandlesForWindow(
  symbol:     string,
  tf:         string,
  outputsize: number,
  endMs:      number,
): Promise<Candle[]> {
  const candles = await tdTimeSeries({
    symbol, tf, outputsize, endMs,
    signal: AbortSignal.timeout(8_000),
  });

  const tfMs = TF_MS[tf] ?? 0;
  if (tfMs > 0 && shouldFillGaps(symbol)) {
    return extendToNow(fillWeekendGaps(candles, tfMs), tfMs);
  }
  return candles;
}
