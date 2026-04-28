'use client';

import { useRef, useEffect, useState, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  CrosshairMode,
  LineStyle,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type Time,
  type CandlestickData,
  type LineData,
  type HistogramData,
} from 'lightweight-charts';
import type { MarketSymbol, Timeframe } from '@/types/gcp';
import { tdTimeSeries, type Candle } from '@/lib/fetchCandles';
import { sma, ema, rsi } from '@/lib/indicators';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
};

const INIT_SIZE: Record<Timeframe, number> = {
  '1m': 500, '5m': 500, '15m': 500, '1h': 500, '4h': 300, '1D': 180,
};

const C = {
  bg:      '#07080a',
  bgPanel: '#0f1114',
  grid:    '#15181d',
  text:    '#6b7280',
  textBr:  '#aeb4bf',
  border:  '#1c2026',
  cyan:    '#4dd9e8',
  amber:   '#d4a028',
  purple:  '#d946ef',
  green:   '#22c55e',
  red:     '#ef4444',
  upBar:   '#22c55e44',
  dnBar:   '#ef444444',
};

function toTime(ms: number): Time {
  return Math.floor(ms / 1000) as Time;
}

interface TradingViewProps {
  symbol:    MarketSymbol;
  timeframe: Timeframe;
}

export default function TradingView({ symbol, timeframe }: TradingViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);

  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const smaRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const emaRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const volRef    = useRef<ISeriesApi<'Histogram'> | null>(null);
  const rsi70Ref  = useRef<IPriceLine | null>(null);
  const rsi30Ref  = useRef<IPriceLine | null>(null);

  const [candles,       setCandles]       = useState<Candle[]>([]);
  const [isLoading,     setIsLoading]     = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreLeft,   setHasMoreLeft]   = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [chartReady,    setChartReady]    = useState(false);
  const [retryNonce,    setRetryNonce]    = useState(0);

  const allCandlesRef = useRef<Candle[]>([]);
  const earliestTsRef = useRef<number | null>(null);
  const isInitRef     = useRef(true);
  const prevSymbolRef = useRef<MarketSymbol>(symbol);

  // Wipe everything on symbol change so old data doesn't paint into the
  // new symbol's panes during the brief window before fresh candles land.
  useEffect(() => {
    if (prevSymbolRef.current === symbol) return;
    prevSymbolRef.current = symbol;
    try { candleRef.current?.setData([]); } catch { /* */ }
    try { smaRef.current?.setData([]);    } catch { /* */ }
    try { emaRef.current?.setData([]);    } catch { /* */ }
    try { rsiRef.current?.setData([]);    } catch { /* */ }
    try { volRef.current?.setData([]);    } catch { /* */ }
    isInitRef.current = true;
  }, [symbol]);

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

    // Pane 0: candles + SMA20 + EMA50
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor:         C.green,
      downColor:       C.red,
      borderUpColor:   C.green,
      borderDownColor: C.red,
      wickUpColor:     C.green,
      wickDownColor:   C.red,
    }, 0);
    smaRef.current = chart.addSeries(LineSeries, {
      color: C.cyan, lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
    }, 0);
    emaRef.current = chart.addSeries(LineSeries, {
      color: C.amber, lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
    }, 0);

    // Pane 1: RSI line, locked 0-100
    rsiRef.current = chart.addSeries(LineSeries, {
      color: C.purple, lineWidth: 1,
      lastValueVisible: true, priceLineVisible: false,
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 100 },
      }),
    }, 1);
    rsi70Ref.current = rsiRef.current.createPriceLine({
      price: 70, color: C.red,   lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: '70',
    });
    rsi30Ref.current = rsiRef.current.createPriceLine({
      price: 30, color: C.green, lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: '30',
    });

    // Pane 2: volume histogram
    volRef.current = chart.addSeries(HistogramSeries, {
      priceFormat:      { type: 'volume' },
      priceScaleId:     '',
      lastValueVisible: false,
      priceLineVisible: false,
    }, 2);

    // 60 / 25 / 15 stretch.
    try {
      const panes = chart.panes();
      if (panes.length >= 3) {
        panes[0].setStretchFactor(60);
        panes[1].setStretchFactor(25);
        panes[2].setStretchFactor(15);
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
      chartRef.current = null;
      candleRef.current = null;
      smaRef.current = null;
      emaRef.current = null;
      rsiRef.current = null;
      volRef.current = null;
      rsi70Ref.current = null;
      rsi30Ref.current = null;
      setChartReady(false);
    };
  }, []);

  // ── Initial fetch + reset on symbol/TF change ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
    isInitRef.current = true;
    setIsLoading(true);
    setError(null);
    setHasMoreLeft(true);
    allCandlesRef.current = [];
    earliestTsRef.current = null;
    setCandles([]);

    tdTimeSeries({
      symbol:     TD_SYMBOLS[symbol],
      tf:         timeframe,
      outputsize: INIT_SIZE[timeframe] ?? 500,
    })
      .then(initial => {
        if (cancelled) return;
        allCandlesRef.current = initial;
        earliestTsRef.current = initial[0]?.t ?? null;
        setCandles(initial);
        setIsLoading(false);
      })
      .catch(e => {
        if (cancelled) return;
        console.warn('[TradingView] initial fetch error:', e);
        setError(String(e));
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [symbol, timeframe, retryNonce]);

  // ── Compute indicator series + push everything to LW Charts ────────────────
  const computed = useMemo(() => {
    if (!candles.length) return null;
    const closes = candles.map(c => c.c);
    return {
      sma20: sma(closes, 20),
      ema50: ema(closes, 50),
      rsi14: rsi(closes, 14),
    };
  }, [candles]);

  useEffect(() => {
    if (!chartReady) return;
    if (!candleRef.current || !smaRef.current || !emaRef.current ||
        !rsiRef.current || !volRef.current) return;
    if (!candles.length || !computed) return;

    const candleData: CandlestickData[] = candles
      .filter(c => c.o > 0 && c.c > 0)
      .map(c => ({
        time:  toTime(c.t),
        open:  c.o, high: c.h, low: c.l, close: c.c,
      }));
    try { candleRef.current.setData(candleData); } catch { /* */ }

    const lineFor = (vals: (number | null)[]): LineData[] =>
      candles
        .map((c, i) => ({ t: c.t, v: vals[i] }))
        .filter(p => p.v != null)
        .map(p => ({ time: toTime(p.t), value: p.v as number }));

    try { smaRef.current.setData(lineFor(computed.sma20)); } catch { /* */ }
    try { emaRef.current.setData(lineFor(computed.ema50)); } catch { /* */ }
    try { rsiRef.current.setData(lineFor(computed.rsi14)); } catch { /* */ }

    const volData: HistogramData[] = candles.map(c => ({
      time:  toTime(c.t),
      value: c.v ?? 0,
      color: c.c >= c.o ? C.upBar : C.dnBar,
    }));
    try { volRef.current.setData(volData); } catch { /* */ }

    if (isInitRef.current) {
      requestAnimationFrame(() => {
        chartRef.current?.timeScale().fitContent();
      });
      isInitRef.current = false;
    }
  }, [chartReady, candles, computed]);

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
        const older  = await tdTimeSeries({
          symbol:     TD_SYMBOLS[symbol],
          tf:         timeframe,
          outputsize: 500,
          endMs:      before,
        });
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
        console.warn('[TradingView] lazy load error:', e);
      } finally {
        inFlight = false;
        setIsLoadingMore(false);
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
  }, [chartReady, symbol, timeframe, isLoadingMore, hasMoreLeft]);

  // ── Right-side live append every 60 s ──────────────────────────────────────
  useEffect(() => {
    const id = setInterval(async () => {
      if (!allCandlesRef.current.length) return;
      try {
        const latest = await tdTimeSeries({
          symbol:     TD_SYMBOLS[symbol],
          tf:         timeframe,
          outputsize: 10,
        });
        if (!latest.length) return;
        const lastTs  = allCandlesRef.current[allCandlesRef.current.length - 1].t;
        const newOnes = latest.filter(c => c.t > lastTs);
        if (!newOnes.length) return;
        allCandlesRef.current = [...allCandlesRef.current, ...newOnes];
        setCandles([...allCandlesRef.current]);
      } catch { /* silent */ }
    }, 60_000);
    return () => clearInterval(id);
  }, [symbol, timeframe]);

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
        <span style={{ color: 'var(--fg-2)' }}>TECHNICAL</span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-3)' }}>{timeframe} bars</span>

        <div style={{ flex: 1 }} />

        <span style={{ color: C.cyan, fontSize: 9, letterSpacing: '0.06em' }}>SMA 20</span>
        <span style={{ color: 'var(--fg-4)' }}>·</span>
        <span style={{ color: C.amber, fontSize: 9, letterSpacing: '0.06em' }}>EMA 50</span>
        <span style={{ color: 'var(--fg-4)' }}>·</span>
        <span style={{ color: C.purple, fontSize: 9, letterSpacing: '0.06em' }}>RSI 14</span>

        {isLoadingMore && (
          <span style={{ fontSize: 9, color: 'var(--cyan)', letterSpacing: '0.08em', marginLeft: 8 }}>
            ← loading…
          </span>
        )}
        {!hasMoreLeft && !isLoading && (
          <span style={{ fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.08em', marginLeft: 8 }}>
            ← history limit
          </span>
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
            LOADING {symbol} {timeframe}…
          </div>
        )}

        {error && !candles.length && !isLoading && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(7,8,10,0.85)', zIndex: 11,
            gap: 8, fontFamily: 'var(--font-mono)',
          }}>
            <div style={{ fontSize: 10, color: 'var(--red)', letterSpacing: '0.08em' }}>
              CANDLE FETCH ERROR
            </div>
            <div style={{ fontSize: 9, color: 'var(--fg-4)', maxWidth: 320, textAlign: 'center' }}>
              {error.slice(0, 140)}
            </div>
            <button
              onClick={() => { setError(null); setRetryNonce(n => n + 1); }}
              style={{
                marginTop: 8, padding: '4px 14px', fontSize: 9,
                fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
                background: 'transparent', border: '1px solid var(--line-2)',
                color: 'var(--fg-2)', borderRadius: 2, cursor: 'pointer',
              }}
            >
              RETRY
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
