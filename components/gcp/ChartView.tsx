'use client';

import { useRef, useEffect } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  CrosshairMode,
  LineStyle,
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
import type { Candle } from '@/lib/useCandleData';
import { REGIMES } from '@/lib/gcp-data';

const COLORS = {
  bg:         '#0a0b0d',
  bgPanel:    '#0f1114',
  line:       '#1c2026',
  text:       '#6b7280',
  textBright: '#aeb4bf',
  cyan:       '#4dd9e8',
  amber:      '#d4a028',
  green:      '#22c55e',
  red:        '#ef4444',
  regimes: {
    A: 'rgba(59,  90, 160, 0.10)',
    B: 'rgba(50, 130, 180, 0.10)',
    C: 'rgba(40, 180, 175, 0.10)',
    D: 'rgba(200, 160,  40, 0.12)',
    E: 'rgba(210, 100,  40, 0.12)',
    F: 'rgba(220,  50,  50, 0.14)',
  } as Record<string, string>,
};

const KIND_COLOR: Record<string, string> = {
  'Alignment Ladder':   '#4dd9e8',
  'Shock Jump':         '#ef4444',
  'Failed Alignment':   '#d946ef',
  'Coherence Volcano':  '#f59e0b',
  'Compression Coil':   '#6b7280',
  'Compression Release':'#2a8a96',
  'Ignition Drift':     '#6b7280',
};

const KIND_ABBR: Record<string, string> = {
  'Alignment Ladder':    'AL',
  'Compression Coil':    'CC',
  'Compression Release': 'CR',
  'Failed Alignment':    'FA',
  'Coherence Volcano':   'CV',
  'Ignition Drift':      'ID',
  'Shock Jump':          'SJ',
};

function toTVTime(ms: number): Time {
  return Math.floor(ms / 1000) as Time;
}

function candlesToTV(candles: Candle[]): CandlestickData[] {
  // Lightweight Charts requires unique, ascending times.
  const seen = new Set<number>();
  const out: CandlestickData[] = [];
  for (const c of candles) {
    if (!(c.o > 0 && c.c > 0)) continue;
    const t = Math.floor(c.t / 1000);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ time: t as Time, open: c.o, high: c.h, low: c.l, close: c.c });
  }
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}

function seriesToLine(series: DataPoint[]): LineData[] {
  const seen = new Set<number>();
  const out: LineData[] = [];
  for (const s of series) {
    const t = Math.floor(s.t / 1000);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ time: t as Time, value: s.v });
  }
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}

function buildRegimeBands(series: DataPoint[]): HistogramData[] {
  const seen = new Set<number>();
  const out: HistogramData[] = [];
  for (const s of series) {
    const t = Math.floor(s.t / 1000);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ time: t as Time, value: 320, color: COLORS.regimes[s.r] ?? COLORS.regimes.A });
  }
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}

interface ChartViewProps {
  series:      DataPoint[];
  patterns:    Pattern[];
  candles:     Candle[];
  symbol:      MarketSymbol;
  symbolColor: string;
  timeframe:   Timeframe;
}

export default function ChartView({
  series, patterns, candles, symbol, timeframe,
}: ChartViewProps) {
  const priceRef = useRef<HTMLDivElement>(null);
  const gcpRef   = useRef<HTMLDivElement>(null);

  const priceChart = useRef<IChartApi | null>(null);
  const gcpChart   = useRef<IChartApi | null>(null);

  const candleSeries  = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries  = useRef<ISeriesApi<'Histogram'>   | null>(null);
  const gcpLineSeries = useRef<ISeriesApi<'Line'>        | null>(null);
  const gcpBandSeries = useRef<ISeriesApi<'Histogram'>   | null>(null);

  const markersPlugin = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!priceRef.current || !gcpRef.current) return;

    const sharedOptions = {
      layout: {
        background: { color: COLORS.bg },
        textColor:  COLORS.text,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize:   11,
      },
      grid: {
        vertLines: { color: COLORS.line, style: LineStyle.Dashed },
        horzLines: { color: COLORS.line, style: LineStyle.Dashed },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: COLORS.textBright, width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: COLORS.bgPanel },
        horzLine: { color: COLORS.textBright, width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: COLORS.bgPanel },
      },
      timeScale: {
        borderColor:    COLORS.line,
        timeVisible:    true,
        secondsVisible: false,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
    };

    const pc = createChart(priceRef.current, {
      ...sharedOptions,
      width:  priceRef.current.clientWidth,
      height: priceRef.current.clientHeight,
      rightPriceScale: {
        borderColor:  COLORS.line,
        scaleMargins: { top: 0.05, bottom: 0.2 },
      },
    });

    const cs = pc.addSeries(CandlestickSeries, {
      upColor:         COLORS.green,
      downColor:       COLORS.red,
      borderUpColor:   COLORS.green,
      borderDownColor: COLORS.red,
      wickUpColor:     COLORS.green,
      wickDownColor:   COLORS.red,
    });

    const vs = pc.addSeries(HistogramSeries, {
      priceFormat:  { type: 'volume' },
      priceScaleId: 'volume',
    });
    pc.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    const gc = createChart(gcpRef.current, {
      ...sharedOptions,
      width:  gcpRef.current.clientWidth,
      height: gcpRef.current.clientHeight,
      rightPriceScale: {
        borderColor:  COLORS.line,
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
    });

    const bands = gc.addSeries(HistogramSeries, {
      priceFormat:      { type: 'price', precision: 0, minMove: 1 },
      priceScaleId:     'bands',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    gc.priceScale('bands').applyOptions({
      scaleMargins: { top: 0, bottom: 0 },
    });

    const gl = gc.addSeries(LineSeries, {
      color:                      COLORS.cyan,
      lineWidth:                  2,
      lastValueVisible:           true,
      priceLineVisible:           false,
      crosshairMarkerVisible:     true,
      crosshairMarkerRadius:      4,
      crosshairMarkerBorderColor: COLORS.bg,
    });

    priceChart.current    = pc;
    gcpChart.current      = gc;
    candleSeries.current  = cs;
    volumeSeries.current  = vs;
    gcpLineSeries.current = gl;
    gcpBandSeries.current = bands;

    let syncing = false;

    const syncFromPrice = (range: ReturnType<typeof pc.timeScale>['getVisibleLogicalRange'] extends () => infer R ? R : null) => {
      if (syncing || !range) return;
      syncing = true;
      gc.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    };
    const syncFromGCP = (range: typeof syncFromPrice extends (r: infer R) => unknown ? R : null) => {
      if (syncing || !range) return;
      syncing = true;
      pc.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    };

    pc.timeScale().subscribeVisibleLogicalRangeChange(syncFromPrice);
    gc.timeScale().subscribeVisibleLogicalRangeChange(syncFromGCP);

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (entry.target === priceRef.current) {
          pc.applyOptions({ width: Math.max(400, width), height: Math.max(200, height) });
        } else if (entry.target === gcpRef.current) {
          gc.applyOptions({ width: Math.max(400, width), height: Math.max(100, height) });
        }
      }
    });
    ro.observe(priceRef.current);
    ro.observe(gcpRef.current);

    return () => {
      pc.timeScale().unsubscribeVisibleLogicalRangeChange(syncFromPrice);
      gc.timeScale().unsubscribeVisibleLogicalRangeChange(syncFromGCP);
      ro.disconnect();
      pc.remove();
      gc.remove();
      priceChart.current = null;
      gcpChart.current = null;
      markersPlugin.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleSeries.current || !volumeSeries.current) return;
    if (!candles.length) {
      candleSeries.current.setData([]);
      volumeSeries.current.setData([]);
      return;
    }

    const tvCandles = candlesToTV(candles);
    candleSeries.current.setData(tvCandles);

    const seenVol = new Set<number>();
    const volData: HistogramData[] = [];
    for (const c of candles) {
      if (!(c.o > 0)) continue;
      const t = Math.floor(c.t / 1000);
      if (seenVol.has(t)) continue;
      seenVol.add(t);
      volData.push({
        time:  t as Time,
        value: c.v ?? 100,
        color: c.c >= c.o ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)',
      });
    }
    volData.sort((a, b) => (a.time as number) - (b.time as number));
    volumeSeries.current.setData(volData);

    priceChart.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    if (!gcpLineSeries.current || !gcpBandSeries.current) return;
    if (!series.length) {
      gcpLineSeries.current.setData([]);
      gcpBandSeries.current.setData([]);
      return;
    }

    gcpLineSeries.current.setData(seriesToLine(series));
    gcpBandSeries.current.setData(buildRegimeBands(series));
    gcpChart.current?.timeScale().fitContent();
  }, [series]);

  useEffect(() => {
    if (!candleSeries.current) return;
    if (!candles.length || !patterns.length || !series.length) {
      if (markersPlugin.current) {
        markersPlugin.current.setMarkers([]);
      }
      return;
    }

    const candleTimes = new Set<number>();
    for (const c of candles) {
      if (c.o > 0 && c.c > 0) candleTimes.add(Math.floor(c.t / 1000));
    }

    const markers: SeriesMarker<Time>[] = [];
    for (const p of patterns) {
      const sp = series[p.start];
      if (!sp) continue;
      const t = Math.floor(sp.t / 1000);
      if (!candleTimes.has(t)) continue;
      markers.push({
        time:     t as Time,
        position: 'aboveBar',
        color:    KIND_COLOR[p.kind] ?? '#6b7280',
        shape:    'arrowDown',
        text:     KIND_ABBR[p.kind] ?? '',
      });
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));

    if (markersPlugin.current) {
      markersPlugin.current.setMarkers(markers);
    } else {
      markersPlugin.current = createSeriesMarkers<Time>(candleSeries.current, markers);
    }
  }, [patterns, series, candles]);

  const showNoCandleMessage = !candles.length;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      background: COLORS.bg,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 16px',
        borderBottom: '1px solid var(--line-1)',
        flexShrink: 0,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
      }}>
        <span style={{ color: 'var(--fg-0)', fontWeight: 600, letterSpacing: '0.04em' }}>{symbol}</span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-2)' }}>OHLCV + GCP Coherence</span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-3)' }}>{timeframe} bars</span>
        {showNoCandleMessage && (
          <span style={{ marginLeft: 'auto', color: 'var(--amber)', fontSize: 9, letterSpacing: '0.08em' }}>
            ⚠ No candle data — check OHLCV status in header
          </span>
        )}
      </div>

      <div style={{ flex: '0 0 68%', position: 'relative', minHeight: 0 }}>
        <div ref={priceRef} style={{ width: '100%', height: '100%' }} />
      </div>

      <div style={{ height: 2, background: 'var(--line-1)', flexShrink: 0, position: 'relative' }}>
        <span style={{
          position: 'absolute', left: 16, top: -8,
          fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)',
          background: COLORS.bg, padding: '0 6px',
        }}>
          GCP NET VARIANCE
        </span>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <div ref={gcpRef} style={{ width: '100%', height: '100%' }} />

        <div style={{
          position: 'absolute', bottom: 6, left: 12,
          display: 'flex', gap: 8, pointerEvents: 'none',
        }}>
          {REGIMES.map(r => (
            <span key={r.id} style={{
              fontSize: 9, fontFamily: 'var(--font-mono)',
              color: r.color, letterSpacing: '0.06em',
              textShadow: '0 0 8px rgba(0,0,0,0.8)',
            }}>
              {r.id}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
