'use client';

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  CrosshairMode,
  LineStyle,
  ColorType,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type SeriesMarker,
  type ISeriesMarkersPluginApi,
} from 'lightweight-charts';
import type { DataPoint, Pattern, MarketSymbol, Timeframe } from '@/types/gcp';
import { lttbDownsample } from '@/lib/gcp-data';

const TD_BASE = 'https://api.twelvedata.com';
const TD_KEY  = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY ?? '';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
};

type ChartTF = '5m' | '15m' | '1h' | '4h' | '1D';

const TD_INTERVALS: Record<ChartTF, string> = {
  '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1D': '1day',
};

const INIT_SIZE: Record<ChartTF, number> = {
  '5m': 500, '15m': 500, '1h': 500, '4h': 300, '1D': 180,
};

const C = {
  bg:      '#07080a',
  bgPanel: '#0f1114',
  grid:    '#15181d',
  text:    '#6b7280',
  textBr:  '#aeb4bf',
  cyan:    '#4dd9e8',
  border:  '#1c2026',
  red:     '#e24b4a',
  regime: {
    A: 'rgba(59,90,160,0.4)',
    B: 'rgba(50,130,180,0.4)',
    C: 'rgba(40,180,175,0.4)',
    D: 'rgba(200,160,40,0.55)',
    E: 'rgba(210,100,40,0.55)',
    F: 'rgba(220,50,50,0.65)',
  } as Record<string, string>,
  candle: {
    A: '#4a72c4',
    B: '#4dd9e8',
    C: '#2db8b4',
    D: '#d4a028',
    E: '#d46428',
    F: '#e24b4a',
  } as Record<string, string>,
};

const REGIME_IDS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

interface Candle { t: number; o: number; h: number; l: number; c: number; }
type ColorMode = 'regime' | 'updown';

function toTime(ms: number): Time {
  return Math.floor(ms / 1000) as Time;
}

async function fetchCandlesBefore(
  symbol: MarketSymbol,
  tf: ChartTF,
  outputsize: number,
  before?: number,
): Promise<Candle[]> {
  const sym = TD_SYMBOLS[symbol];
  if (!sym || !TD_KEY) throw new Error('No symbol or API key');

  let url = `${TD_BASE}/time_series`
    + `?symbol=${encodeURIComponent(sym)}`
    + `&interval=${TD_INTERVALS[tf]}`
    + `&outputsize=${outputsize}`
    + `&apikey=${TD_KEY}`;

  if (before) {
    const d = new Date(before).toISOString().replace('T', ' ').slice(0, 19);
    url += `&end_date=${encodeURIComponent(d)}`;
  }

  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data ${res.status}`);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message ?? 'TD error');

  const values: { datetime: string; open: string; high: string; low: string; close: string }[] =
    data.values ?? [];
  return values
    .slice()
    .reverse()
    .map(v => ({
      t: new Date(v.datetime + 'Z').getTime(),
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
    }));
}

interface ChartViewProps {
  series:    DataPoint[];
  patterns:  Pattern[];
  symbol:    MarketSymbol;
  timeframe: Timeframe;
}

export default function ChartView({ series, patterns, symbol, timeframe }: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<Map<string, ISeriesApi<'Candlestick'>>>(new Map());
  const regimeStripRef  = useRef<ISeriesApi<'Histogram'> | null>(null);
  const gcpLineRef      = useRef<ISeriesApi<'Line'> | null>(null);
  const markersRef      = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [chartTF,       setChartTF]       = useState<ChartTF>('1h');
  const [colorMode,     setColorMode]     = useState<ColorMode>('regime');
  const [candles,       setCandles]       = useState<Candle[]>([]);
  const [isLoading,     setIsLoading]     = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreLeft,   setHasMoreLeft]   = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [chartReady,    setChartReady]    = useState(false);

  const allCandlesRef = useRef<Candle[]>([]);
  const earliestTsRef = useRef<number | null>(null);
  const isInitRef     = useRef(true);

  const chartGCPSeries = useMemo(() => {
    if (!series.length) return series;
    if (!candles.length) {
      const fallback = series.slice(-1440);
      return fallback.length > 800 ? lttbDownsample(fallback, 800) : fallback;
    }
    const earliest = candles[0].t;
    const latest   = candles[candles.length - 1].t;
    const buffer   = (latest - earliest) * 0.05;
    const filtered = series
      .filter(p => p.t >= earliest - buffer)
      .sort((a, b) => a.t - b.t);
    return filtered.length > 800 ? lttbDownsample(filtered, 800) : filtered;
  }, [series, candles]);

  // ── Create chart + 3 panes (once) ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: C.bg },
        textColor:  C.text,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize:   11,
      },
      grid: {
        vertLines: { color: C.grid, style: LineStyle.Dashed },
        horzLines: { color: C.grid, style: LineStyle.Dashed },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: C.textBr, width: 1, style: LineStyle.Dashed, labelBackgroundColor: C.bgPanel },
        horzLine: { color: C.textBr, width: 1, style: LineStyle.Dashed, labelBackgroundColor: C.bgPanel },
      },
      timeScale: {
        borderColor:    C.border,
        timeVisible:    true,
        secondsVisible: false,
        tickMarkFormatter: (t: number) => {
          const d = new Date(t * 1000);
          const p = (n: number) => String(n).padStart(2, '0');
          return `${p(d.getHours())}:${p(d.getMinutes())}`;
        },
      },
      rightPriceScale: { borderColor: C.border },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
    });

    chartRef.current = chart;

    // Pane 0: six regime candle series
    const csMap = new Map<string, ISeriesApi<'Candlestick'>>();
    REGIME_IDS.forEach(r => {
      const col = C.candle[r];
      const cs = chart.addSeries(CandlestickSeries, {
        upColor:         col,
        downColor:       'transparent',
        borderUpColor:   col,
        borderDownColor: col,
        wickUpColor:     col,
        wickDownColor:   col,
      }, 0);
      csMap.set(r, cs);
    });
    candleSeriesRef.current = csMap;

    // Pane 1: regime color strip
    const strip = chart.addSeries(HistogramSeries, {
      priceFormat:      { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    }, 1);
    regimeStripRef.current = strip;

    // Pane 2: GCP NetVar line
    const gcpLine = chart.addSeries(LineSeries, {
      color:                      C.cyan,
      lineWidth:                  2,
      lastValueVisible:           true,
      priceLineVisible:           false,
      crosshairMarkerVisible:     true,
      crosshairMarkerRadius:      4,
      crosshairMarkerBorderColor: C.bg,
    }, 2);
    gcpLineRef.current = gcpLine;

    // Set pane height ratios. Best-effort — works on lightweight-charts 5.x
    // panes() returns IPane[]; setStretchFactor controls relative size.
    try {
      const panes = chart.panes();
      if (panes.length >= 3) {
        panes[0].setStretchFactor(70);
        panes[1].setStretchFactor(8);
        panes[2].setStretchFactor(22);
      }
    } catch { /* older versions silently ignore */ }

    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      chart.applyOptions({
        width:  Math.max(400, r.width),
        height: Math.max(300, r.height),
      });
    });
    ro.observe(containerRef.current);

    setChartReady(true);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current        = null;
      regimeStripRef.current  = null;
      gcpLineRef.current      = null;
      candleSeriesRef.current = new Map();
      markersRef.current      = null;
      setChartReady(false);
    };
  }, []);

  // ── GCP line + regime strip updates ────────────────────────────────────────
  useEffect(() => {
    const line  = gcpLineRef.current;
    const strip = regimeStripRef.current;
    if (!line || !strip) return;

    if (!chartGCPSeries.length) {
      line.setData([]);
      strip.setData([]);
      return;
    }

    const lineData: LineData[] = chartGCPSeries.map(p => ({
      time:  toTime(p.t),
      value: p.v,
    }));
    line.setData(lineData);

    const stripData: HistogramData[] = chartGCPSeries.map(p => ({
      time:  toTime(p.t),
      value: 1,
      color: C.regime[p.r] ?? C.regime.A,
    }));
    strip.setData(stripData);
  }, [chartGCPSeries]);

  // ── Split candles by regime + apply to series ──────────────────────────────
  const updateCandleSeries = useCallback((candleList: Candle[]) => {
    if (!candleSeriesRef.current.size) return;

    const regimeByTs = new Map<number, string>();
    chartGCPSeries.forEach(p => regimeByTs.set(Math.floor(p.t / 1000), p.r));

    const byRegime = new Map<string, CandlestickData[]>();
    REGIME_IDS.forEach(r => byRegime.set(r, []));

    for (const c of candleList) {
      const ts = Math.floor(c.t / 1000);
      let regime: string | undefined = regimeByTs.get(ts);
      if (!regime) {
        for (let d = 1; d <= 60; d++) {
          regime = regimeByTs.get(ts - d) ?? regimeByTs.get(ts + d);
          if (regime) break;
        }
        regime = regime ?? 'B';
      }

      const bucketKey = colorMode === 'updown'
        ? (c.c >= c.o ? 'A' : 'F') // map up → A series, down → F series
        : regime;

      const bucket = byRegime.get(bucketKey) ?? byRegime.get('B')!;
      bucket.push({
        time:  toTime(c.t),
        open:  c.o,
        high:  c.h,
        low:   c.l,
        close: c.c,
      });
    }

    candleSeriesRef.current.forEach((cs, regime) => {
      if (colorMode === 'updown') {
        // Use only A (green) and F (red) buckets in updown mode
        const isUp = regime === 'A';
        const isDn = regime === 'F';
        const col  = isUp ? '#22c55e' : isDn ? '#ef4444' : 'transparent';
        cs.applyOptions({
          upColor:         col,
          downColor:       col,
          borderUpColor:   col,
          borderDownColor: col,
          wickUpColor:     col,
          wickDownColor:   col,
        });
      } else {
        const col = C.candle[regime] ?? C.cyan;
        cs.applyOptions({
          upColor:         col,
          downColor:       'transparent',
          borderUpColor:   col,
          borderDownColor: col,
          wickUpColor:     col,
          wickDownColor:   col,
        });
      }

      const data = (byRegime.get(regime) ?? [])
        .slice()
        .sort((a, b) => (a.time as number) - (b.time as number));
      try { cs.setData(data); } catch { /* time ordering harmless */ }
    });

    if (isInitRef.current) {
      requestAnimationFrame(() => {
        chartRef.current?.timeScale().fitContent();
        chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
      });
      isInitRef.current = false;
    }
  }, [chartGCPSeries, colorMode]);

  useEffect(() => {
    if (!chartReady) return;
    updateCandleSeries(candles);
  }, [chartReady, candles, updateCandleSeries]);

  // ── Initial candle fetch + reset on symbol/TF change ───────────────────────
  useEffect(() => {
    let cancelled = false;
    isInitRef.current = true;
    setIsLoading(true);
    setError(null);
    setHasMoreLeft(true);
    allCandlesRef.current = [];
    earliestTsRef.current = null;
    setCandles([]);

    fetchCandlesBefore(symbol, chartTF, INIT_SIZE[chartTF])
      .then(initial => {
        if (cancelled) return;
        allCandlesRef.current = initial;
        earliestTsRef.current = initial[0]?.t ?? null;
        setCandles(initial);
        setIsLoading(false);
      })
      .catch(e => {
        if (cancelled) return;
        console.warn('[ChartView] initial candle fetch error:', e);
        setError(String(e));
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [symbol, chartTF]);

  // ── Lazy scroll-back ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartReady) return;
    const chart = chartRef.current;
    if (!chart) return;

    let inFlight = false;

    const onRangeChange = async (range: { from: number; to: number } | null) => {
      if (!range) return;
      if (inFlight || isLoadingMore || !hasMoreLeft) return;
      if (range.from > 5) return;
      const earliest = earliestTsRef.current;
      if (!earliest) return;

      inFlight = true;
      setIsLoadingMore(true);
      try {
        const before = earliest - 60_000;
        const older  = await fetchCandlesBefore(symbol, chartTF, 500, before);
        if (!older.length) {
          setHasMoreLeft(false);
          return;
        }

        const seen = new Set<number>();
        const merged: Candle[] = [];
        for (const c of [...older, ...allCandlesRef.current]) {
          if (seen.has(c.t)) continue;
          seen.add(c.t);
          merged.push(c);
        }
        merged.sort((a, b) => a.t - b.t);

        allCandlesRef.current = merged;
        earliestTsRef.current = merged[0].t;
        setCandles([...merged]);
      } catch (e) {
        console.warn('[ChartView] lazy load error:', e);
      } finally {
        inFlight = false;
        setIsLoadingMore(false);
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
  }, [chartReady, symbol, chartTF, isLoadingMore, hasMoreLeft]);

  // ── Right-side live append every 60s ───────────────────────────────────────
  useEffect(() => {
    const id = setInterval(async () => {
      if (!allCandlesRef.current.length) return;
      try {
        const latest = await fetchCandlesBefore(symbol, chartTF, 10);
        if (!latest.length) return;
        const lastTs  = allCandlesRef.current[allCandlesRef.current.length - 1].t;
        const newOnes = latest.filter(c => c.t > lastTs);
        if (!newOnes.length) return;
        allCandlesRef.current = [...allCandlesRef.current, ...newOnes];
        setCandles([...allCandlesRef.current]);
      } catch { /* silent */ }
    }, 60_000);
    return () => clearInterval(id);
  }, [symbol, chartTF]);

  // ── Pattern markers on the D-regime candle series ──────────────────────────
  useEffect(() => {
    const dSeries = candleSeriesRef.current.get('D')
      ?? candleSeriesRef.current.values().next().value;
    if (!dSeries) return;

    if (!patterns.length || !chartGCPSeries.length) {
      markersRef.current?.setMarkers([]);
      return;
    }

    const MARKER_COLORS: Record<string, string> = {
      'Alignment Ladder':   C.cyan,
      'Shock Jump':         C.red,
      'Failed Alignment':   '#d946ef',
      'Coherence Volcano':  '#f59e0b',
    };

    const markers: SeriesMarker<Time>[] = patterns
      .filter(p => p.start < chartGCPSeries.length)
      .map(p => {
        const gcpPt = chartGCPSeries[Math.min(p.start, chartGCPSeries.length - 1)];
        return {
          time:     toTime(gcpPt.t),
          position: 'aboveBar' as const,
          color:    MARKER_COLORS[p.kind] ?? C.text,
          shape:    'arrowDown' as const,
          text:     p.kind.split(' ').map(w => w[0]).join(''),
        };
      })
      .sort((a, b) => (a.time as number) - (b.time as number));

    if (markersRef.current) {
      markersRef.current.setMarkers(markers);
    } else {
      markersRef.current = createSeriesMarkers<Time>(dSeries, markers);
    }
  }, [patterns, chartGCPSeries]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px',
        borderBottom: '1px solid var(--line-1)',
        flexShrink: 0,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
      }}>
        <span style={{ color: 'var(--fg-0)', fontWeight: 600 }}>{symbol}</span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-2)' }}>OHLCV + GCP Coherence</span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-3)' }}>dashboard {timeframe}</span>

        <div style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
          {(['5m','15m','1h','4h','1D'] as ChartTF[]).map(tf => (
            <button key={tf}
              onClick={() => { isInitRef.current = true; setChartTF(tf); }}
              style={{
                padding: '2px 7px', fontSize: 9, letterSpacing: '0.08em',
                fontFamily: 'var(--font-mono)',
                background: chartTF === tf ? 'var(--bg-3)' : 'transparent',
                border: `1px solid ${chartTF === tf ? 'var(--line-2)' : 'transparent'}`,
                borderRadius: 2,
                color: chartTF === tf ? 'var(--fg-0)' : 'var(--fg-3)',
                cursor: 'pointer',
              }}>
              {tf}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {isLoadingMore && (
          <span style={{ fontSize: 9, color: 'var(--cyan)', letterSpacing: '0.08em' }}>
            ← loading…
          </span>
        )}
        {!hasMoreLeft && !isLoading && (
          <span style={{ fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.08em' }}>
            ← history limit
          </span>
        )}
        {error && (
          <span style={{ fontSize: 9, color: 'var(--red)' }}>
            {error.slice(0, 40)}
          </span>
        )}

        <button
          onClick={() => setColorMode(m => m === 'regime' ? 'updown' : 'regime')}
          style={{
            padding: '2px 8px', fontSize: 9, letterSpacing: '0.08em',
            fontFamily: 'var(--font-mono)',
            background: colorMode === 'regime' ? 'var(--bg-3)' : 'transparent',
            border: '1px solid var(--line-2)', borderRadius: 2,
            color: colorMode === 'regime' ? 'var(--cyan)' : 'var(--fg-3)',
            cursor: 'pointer',
          }}>
          {colorMode === 'regime' ? 'BY REGIME' : 'UP / DOWN'}
        </button>

        {colorMode === 'regime' && (
          <div style={{ display: 'flex', gap: 6 }}>
            {REGIME_IDS.map(r => (
              <span key={r} style={{ fontSize: 9, color: C.candle[r], fontFamily: 'var(--font-mono)' }}>
                {r}
              </span>
            ))}
          </div>
        )}
      </div>

      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {isLoading && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: C.bg, zIndex: 10,
            color: 'var(--fg-2)', fontSize: 11, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.1em',
          }}>
            LOADING {symbol} {chartTF}…
          </div>
        )}
      </div>
    </div>
  );
}
