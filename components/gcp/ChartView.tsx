'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
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
};

const REGIME_CANDLE: Record<string, string> = {
  A: '#4a72c4',
  B: '#4dd9e8',
  C: '#2db8b4',
  D: '#d4a028',
  E: '#d46428',
  F: '#e24b4a',
};

const REGIME_IDS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
type RegimeKey = (typeof REGIME_IDS)[number];

const REGIME_BG: Record<string, string> = {
  A: 'rgba(59,90,160,0.13)',
  B: 'rgba(50,130,180,0.13)',
  C: 'rgba(40,180,175,0.13)',
  D: 'rgba(200,160,40,0.16)',
  E: 'rgba(210,100,40,0.16)',
  F: 'rgba(220,50,50,0.22)',
};

const REGIME_LABEL_COLOR: Record<string, string> = {
  A: '#4a72c4', B: '#4dd9e8', C: '#2db8b4',
  D: '#d4a028', E: '#d46428', F: '#e24b4a',
};

const REGIME_STRIP_COLOR: Record<string, string> = {
  A: 'rgba(74,114,196,0.7)',
  B: 'rgba(77,217,232,0.7)',
  C: 'rgba(45,184,180,0.7)',
  D: 'rgba(212,160,40,0.85)',
  E: 'rgba(212,100,40,0.85)',
  F: 'rgba(226,75,74,0.95)',
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

function drawRegimeBands(canvas: HTMLCanvasElement, chart: IChartApi, series: DataPoint[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!series.length) return;

  const ts = chart.timeScale();
  const H = canvas.height;

  let i = 0;
  while (i < series.length) {
    const regime = series[i].r;
    let j = i;
    while (j < series.length && series[j].r === regime) j++;

    const t1 = Math.floor(series[i].t / 1000);
    const t2 = Math.floor(series[Math.min(j, series.length - 1)].t / 1000);
    const x1 = ts.timeToCoordinate(t1 as Time);
    const x2 = ts.timeToCoordinate(t2 as Time);

    if (x1 !== null && x2 !== null && x2 > x1) {
      ctx.fillStyle = REGIME_BG[regime] ?? 'transparent';
      ctx.fillRect(x1, 0, x2 - x1, H);
    }
    i = j;
  }

  i = 0;
  while (i < series.length) {
    const regime = series[i].r;
    let j = i;
    while (j < series.length && series[j].r === regime) j++;

    const t1 = Math.floor(series[i].t / 1000);
    const t2 = Math.floor(series[Math.min(j, series.length - 1)].t / 1000);
    const x1 = ts.timeToCoordinate(t1 as Time);
    const x2 = ts.timeToCoordinate(t2 as Time);

    if (x1 !== null && x2 !== null && (x2 - x1) > 20) {
      ctx.fillStyle = REGIME_LABEL_COLOR[regime] ?? '#aaa';
      ctx.font = '9px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.globalAlpha = 0.6;
      ctx.fillText(regime, (x1 + x2) / 2, 12);
      ctx.globalAlpha = 1;
    }
    i = j;
  }
}

function drawRegimeStrip(canvas: HTMLCanvasElement, chart: IChartApi, series: DataPoint[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!series.length) return;

  const ts = chart.timeScale();
  const H = canvas.height;

  let i = 0;
  while (i < series.length) {
    const regime = series[i].r;
    let j = i;
    while (j < series.length && series[j].r === regime) j++;

    const t1 = Math.floor(series[i].t / 1000);
    const t2 = Math.floor(series[Math.min(j, series.length - 1)].t / 1000);
    const x1 = ts.timeToCoordinate(t1 as Time);
    const x2 = ts.timeToCoordinate(t2 as Time);

    if (x1 !== null && x2 !== null && x2 > x1) {
      ctx.fillStyle = REGIME_STRIP_COLOR[regime] ?? 'transparent';
      ctx.fillRect(x1, 0, x2 - x1, H);
    }
    i = j;
  }
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

  const gcpOverlayRef   = useRef<HTMLCanvasElement>(null);
  const priceOverlayRef = useRef<HTMLCanvasElement>(null);

  const priceChart = useRef<IChartApi | null>(null);
  const gcpChart   = useRef<IChartApi | null>(null);

  const regimeSeries  = useRef<Map<string, ISeriesApi<'Candlestick'>>>(new Map());
  const volumeSeries  = useRef<ISeriesApi<'Histogram'>   | null>(null);
  const gcpLineSeries = useRef<ISeriesApi<'Line'>        | null>(null);

  const markersPlugin = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [candleColorMode, setCandleColorMode] = useState<'regime' | 'updown'>('regime');

  const applyColorMode = useCallback((mode: 'regime' | 'updown') => {
    setCandleColorMode(mode);
    regimeSeries.current.forEach((s, regime) => {
      if (mode === 'updown') {
        s.applyOptions({
          upColor:         COLORS.green,
          downColor:       COLORS.red,
          borderUpColor:   COLORS.green,
          borderDownColor: COLORS.red,
          wickUpColor:     COLORS.green,
          wickDownColor:   COLORS.red,
        });
      } else {
        const col = REGIME_CANDLE[regime] ?? COLORS.cyan;
        s.applyOptions({
          upColor:         col,
          downColor:       'transparent',
          borderUpColor:   col,
          borderDownColor: col,
          wickUpColor:     col,
          wickDownColor:   col,
        });
      }
    });
  }, []);

  // Series snapshot the redraw fn reads from — kept in a ref so callbacks are stable
  const seriesRef = useRef<DataPoint[]>(series);
  seriesRef.current = series;

  const redrawOverlays = () => {
    const gcpInst = gcpChart.current;
    const gcpCanvas = gcpOverlayRef.current;
    const gcpHost = gcpRef.current;
    if (gcpInst && gcpCanvas && gcpHost) {
      const rect = gcpHost.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        if (gcpCanvas.width !== rect.width)  gcpCanvas.width  = rect.width;
        if (gcpCanvas.height !== rect.height) gcpCanvas.height = rect.height;
        drawRegimeBands(gcpCanvas, gcpInst, seriesRef.current);
      }
    }

    const priceInst = priceChart.current;
    const priceCanvas = priceOverlayRef.current;
    const priceHost = priceRef.current;
    if (priceInst && priceCanvas && priceHost) {
      const rect = priceHost.getBoundingClientRect();
      if (rect.width > 0) {
        if (priceCanvas.width !== rect.width) priceCanvas.width = rect.width;
        if (priceCanvas.height !== 8)         priceCanvas.height = 8;
        drawRegimeStrip(priceCanvas, priceInst, seriesRef.current);
      }
    }
  };

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

    const rSeriesMap = new Map<string, ISeriesApi<'Candlestick'>>();
    REGIME_IDS.forEach(r => {
      const col = REGIME_CANDLE[r] ?? COLORS.cyan;
      const series = pc.addSeries(CandlestickSeries, {
        upColor:         col,
        downColor:       'transparent',
        borderUpColor:   col,
        borderDownColor: col,
        wickUpColor:     col,
        wickDownColor:   col,
      });
      rSeriesMap.set(r, series);
    });
    regimeSeries.current = rSeriesMap;

    const vs = pc.addSeries(HistogramSeries, {
      color:            'rgba(77,217,232,0.3)',
      priceFormat:      { type: 'volume' },
      priceScaleId:     '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    pc.priceScale('').applyOptions({
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
    volumeSeries.current  = vs;
    gcpLineSeries.current = gl;

    let syncing = false;

    const syncFromPrice = (range: ReturnType<typeof pc.timeScale>['getVisibleLogicalRange'] extends () => infer R ? R : null) => {
      if (!syncing && range) {
        syncing = true;
        gc.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      }
      redrawOverlays();
    };
    const syncFromGCP = (range: typeof syncFromPrice extends (r: infer R) => unknown ? R : null) => {
      if (!syncing && range) {
        syncing = true;
        pc.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      }
      redrawOverlays();
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
      redrawOverlays();
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
      regimeSeries.current = new Map();
      markersPlugin.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!regimeSeries.current.size || !volumeSeries.current) return;
    if (!candles.length) {
      regimeSeries.current.forEach(s => s.setData([]));
      volumeSeries.current.setData([]);
      return;
    }

    const regimeByTs = new Map<number, RegimeKey>();
    for (const s of series) {
      regimeByTs.set(Math.floor(s.t / 1000), s.r as RegimeKey);
    }

    const findRegime = (ts: number): RegimeKey => {
      const direct = regimeByTs.get(ts);
      if (direct) return direct;
      for (let delta = 1; delta <= 60; delta++) {
        const nearest = regimeByTs.get(ts - delta) ?? regimeByTs.get(ts + delta);
        if (nearest) return nearest;
      }
      return 'B';
    };

    const byRegime = new Map<string, CandlestickData[]>();
    REGIME_IDS.forEach(r => byRegime.set(r, []));

    for (const c of candlesToTV(candles)) {
      const ts = c.time as number;
      let bucketKey: string;
      if (candleColorMode === 'updown') {
        bucketKey = c.close >= c.open ? '_up' : '_down';
      } else {
        bucketKey = findRegime(ts);
      }
      const bucket = byRegime.get(bucketKey) ?? byRegime.get('B')!;
      bucket.push(c);
    }

    regimeSeries.current.forEach((s, regime) => {
      const data = byRegime.get(regime) ?? [];
      data.sort((a, b) => (a.time as number) - (b.time as number));
      try { s.setData(data); } catch { /* time ordering is harmless */ }
    });

    const seenVol = new Set<number>();
    const volData: HistogramData[] = [];
    for (const c of candles) {
      if (!(c.o > 0)) continue;
      const t = Math.floor(c.t / 1000);
      if (seenVol.has(t)) continue;
      seenVol.add(t);
      const regime = findRegime(t);
      const baseCol = REGIME_CANDLE[regime] ?? COLORS.cyan;
      volData.push({
        time:  t as Time,
        value: c.v ?? 50,
        color: baseCol + '55',
      });
    }
    volData.sort((a, b) => (a.time as number) - (b.time as number));
    volumeSeries.current.setData(volData);

    priceChart.current?.timeScale().fitContent();
    redrawOverlays();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, series, candleColorMode]);

  useEffect(() => {
    if (!gcpLineSeries.current) return;
    if (!series.length) {
      gcpLineSeries.current.setData([]);
      redrawOverlays();
      return;
    }

    gcpLineSeries.current.setData(seriesToLine(series));
    gcpChart.current?.timeScale().fitContent();
    redrawOverlays();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  useEffect(() => {
    const markerHost =
      regimeSeries.current.get('D') ??
      regimeSeries.current.values().next().value;
    if (!markerHost) return;

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
      markersPlugin.current = createSeriesMarkers<Time>(markerHost, markers);
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
          <span style={{ color: 'var(--amber)', fontSize: 9, letterSpacing: '0.08em' }}>
            ⚠ No candle data — check OHLCV status in header
          </span>
        )}
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            fontSize: 8, letterSpacing: '0.12em',
            color: 'var(--fg-4)', marginRight: 2,
          }}>CANDLE</span>
          <button
            onClick={() => applyColorMode(candleColorMode === 'regime' ? 'updown' : 'regime')}
            style={{
              padding: '2px 8px',
              fontSize: 9, letterSpacing: '0.08em',
              fontFamily: 'var(--font-mono)',
              background: candleColorMode === 'regime' ? 'var(--bg-3)' : 'transparent',
              border: '1px solid var(--line-2)',
              borderRadius: 2,
              color: candleColorMode === 'regime' ? 'var(--cyan)' : 'var(--fg-3)',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {candleColorMode === 'regime' ? 'BY REGIME' : 'UP / DOWN'}
          </button>
          {candleColorMode === 'regime' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
              {REGIME_IDS.map(r => (
                <span key={r} style={{
                  fontSize: 9,
                  fontFamily: 'var(--font-mono)',
                  color: REGIME_CANDLE[r] ?? '#aaa',
                  letterSpacing: '0.04em',
                }}>
                  {r}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: '0 0 68%', position: 'relative', minHeight: 0 }}>
        <div ref={priceRef} style={{ width: '100%', height: '100%' }} />
        <canvas
          ref={priceOverlayRef}
          style={{
            position: 'absolute',
            bottom: 28,
            left: 0,
            width: '100%',
            height: 8,
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
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
        <canvas
          ref={gcpOverlayRef}
          style={{
            position: 'absolute',
            top: 0, left: 0,
            width: '100%', height: '100%',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />

        <div style={{
          position: 'absolute', bottom: 6, left: 12,
          display: 'flex', gap: 8, pointerEvents: 'none', zIndex: 2,
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
