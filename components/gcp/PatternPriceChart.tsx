'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  createSeriesMarkers,
  type IChartApi,
  type Time,
} from 'lightweight-charts';
import type { MarketSymbol, Timeframe } from '@/types/gcp';
import { fetchCandlesForWindow, type Candle } from '@/lib/fetchCandles';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
};

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1D': 86_400_000,
};

interface PatternPriceChartProps {
  symbol: MarketSymbol;
  tf:     Timeframe;
  tStart: number;
  tEnd:   number;
}

export default function PatternPriceChart({ symbol, tf, tStart, tEnd }: PatternPriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);

  const [candles, setCandles]         = useState<Candle[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error,   setError]           = useState<string | null>(null);
  const [priceChange, setPriceChange] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPriceChange(null);
    setCandles([]);

    const barMs      = TIMEFRAME_MS[tf] ?? 900_000;
    const bufferBars = 4;
    const fetchEnd   = tEnd + bufferBars * barMs;
    const windowBars = Math.ceil((fetchEnd - (tStart - bufferBars * barMs)) / barMs);
    const outputsize = Math.min(200, Math.max(20, windowBars));

    fetchCandlesForWindow(TD_SYMBOLS[symbol], tf, outputsize, fetchEnd)
      .then(data => {
        if (cancelled) return;
        setCandles(data);

        const inWindow = data.filter(c => c.t >= tStart && c.t <= tEnd);
        if (inWindow.length >= 2) {
          const entry = inWindow[0].o;
          const exit  = inWindow[inWindow.length - 1].c;
          if (entry > 0) setPriceChange(((exit - entry) / entry) * 100);
        }
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [symbol, tf, tStart, tEnd]);

  useEffect(() => {
    if (!containerRef.current || !candles.length) return;

    const chart = createChart(containerRef.current, {
      width:  containerRef.current.offsetWidth,
      height: 110,
      layout: {
        background: { type: ColorType.Solid, color: '#09090c' },
        textColor:  '#464c56',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize:   9,
      },
      grid: {
        vertLines: { color: '#0f1114', style: LineStyle.Dashed },
        horzLines: { color: '#0f1114', style: LineStyle.Dashed },
      },
      crosshair:       { mode: CrosshairMode.Magnet },
      timeScale:       { borderColor: '#15181d', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#15181d', scaleMargins: { top: 0.1, bottom: 0.1 } },
      handleScroll:    false,
      handleScale:     false,
    });

    const cs = chart.addSeries(CandlestickSeries, {
      upColor:         '#22c55e',
      downColor:       '#ef4444',
      borderUpColor:   '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor:     '#22c55e',
      wickDownColor:   '#ef4444',
    });

    cs.setData(
      candles
        .filter(c => c.o > 0 && c.c > 0)
        .map(c => ({
          time:  Math.floor(c.t / 1000) as Time,
          open:  c.o, high: c.h, low: c.l, close: c.c,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number)),
    );

    const inWindow = candles.filter(c => c.t >= tStart && c.t <= tEnd);
    if (inWindow.length) {
      try {
        createSeriesMarkers<Time>(cs, [
          {
            time:     Math.floor(inWindow[0].t / 1000) as Time,
            position: 'belowBar',
            color:    '#4dd9e8',
            shape:    'arrowUp',
            text:     'START',
          },
          {
            time:     Math.floor(inWindow[inWindow.length - 1].t / 1000) as Time,
            position: 'aboveBar',
            color:    '#4dd9e8',
            shape:    'arrowDown',
            text:     'END',
          },
        ]);
      } catch { /* marker plugin failure shouldn't break the chart */ }
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, tStart, tEnd]);

  const changeColor =
    priceChange === null   ? 'var(--fg-4)' :
    priceChange >  0.1     ? '#22c55e'    :
    priceChange < -0.1     ? '#ef4444'    :
    'var(--fg-3)';

  return (
    <div>
      <div style={{
        fontSize: 8, letterSpacing: '0.1em', color: 'var(--fg-4)',
        marginBottom: 4,
      }}>
        PRICE · {symbol}
      </div>

      {loading && (
        <div style={{
          height: 110, background: '#09090c',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.08em',
        }}>
          LOADING…
        </div>
      )}

      {error && !loading && (
        <div style={{
          height: 110, background: '#09090c',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, color: 'var(--red)',
        }}>
          FETCH ERROR
        </div>
      )}

      {!loading && !error && (
        <div ref={containerRef} style={{ height: 110 }} />
      )}

      {priceChange !== null && (
        <div style={{
          marginTop: 4, fontSize: 9,
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span style={{ color: 'var(--fg-4)' }}>during pattern</span>
          <span style={{ color: changeColor, fontVariantNumeric: 'tabular-nums' }}>
            {priceChange > 0 ? '+' : ''}{priceChange.toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}
