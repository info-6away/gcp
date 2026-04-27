'use client';

import { useRef, useEffect, useState, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  CrosshairMode,
  LineStyle,
  ColorType,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type CandlestickData,
  type LineData,
  type SeriesMarker,
  type ISeriesMarkersPluginApi,
} from 'lightweight-charts';
import type { DataPoint, Pattern, MarketSymbol, Timeframe } from '@/types/gcp';
import { lttbDownsample, detectPatterns } from '@/lib/gcp-data';

const TD_BASE = 'https://api.twelvedata.com';
const TD_KEY  = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY ?? '';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
};

type ChartTF = '1m' | '5m' | '15m' | '1h' | '4h' | '1D';

const TD_INTERVALS: Record<ChartTF, string> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1D': '1day',
};

const INIT_SIZE: Record<ChartTF, number> = {
  '1m': 500, '5m': 500, '15m': 500, '1h': 500, '4h': 300, '1D': 180,
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
  green:   '#22c55e',
  redCdl:  '#ef4444',
};

interface Candle { t: number; o: number; h: number; l: number; c: number; synthetic?: boolean; }

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

  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const gcpLineRef      = useRef<ISeriesApi<'Line'> | null>(null);
  const markersRef       = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [chartTF,       setChartTF]       = useState<ChartTF>('5m');
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

  // Wipe series immediately when the symbol changes so the old ticker's
  // data doesn't briefly bleed onto the new symbol's axes.
  useEffect(() => {
    if (prevSymbolRef.current === symbol) return;
    prevSymbolRef.current = symbol;
    try { candleSeriesRef.current?.setData([]); } catch { /* */ }
    try { gcpLineRef.current?.setData([]); } catch { /* */ }
    isInitRef.current = true;
  }, [symbol]);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number; price: number | null; time: number | null;
  } | null>(null);

  type GcpTooltipState =
    | { mode: 'nv';      x: number; nv: number; regime: string; regimeLabel: string; time: string }
    | { mode: 'pattern'; x: number; kind: string; pss: number; regime: string; bars: number; time: string };

  const [gcpTooltip, setGcpTooltip] = useState<GcpTooltipState | null>(null);
  const chartPatternsRef            = useRef<Pattern[]>([]);
  const chartGCPSeriesRef           = useRef<DataPoint[]>([]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctxMenu]);

  // No clipping. LW Charts shares a time axis between panes but renders
  // each series at its own timestamps; if one ends before the other, the
  // shorter pane simply stops where its data does. Past attempts to clip
  // either side either blanked the whole chart (intersection clip with no
  // overlap) or lost recent candles (clipping price to GCP). The honest
  // representation is the right one.
  const displayCandles = candles;

  const chartGCPSeries = useMemo(() => {
    if (!series.length) return [];
    const sorted = [...series].sort((a, b) => a.t - b.t);

    // Window GCP to roughly the same time span the candles cover, anchored
    // to the latest GCP point we have. Without this, 4 months of historical
    // 1-minute GCP gets compressed into a tiny x-range next to ~24h of
    // candles, and the high-frequency NV oscillation paints the historical
    // section as a near-solid filled block. Falls back to 48h if candles
    // haven't loaded yet.
    const lastT = sorted[sorted.length - 1].t;
    const candleSpan = displayCandles.length >= 2
      ? displayCandles[displayCandles.length - 1].t - displayCandles[0].t
      : 0;
    const span    = candleSpan > 0 ? candleSpan : 48 * 3_600_000;
    const cutoff  = lastT - span;
    const windowed = sorted.filter(p => p.t >= cutoff);

    return windowed.length > 3000 ? lttbDownsample(windowed, 800) : windowed;
  }, [series, displayCandles]);

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

    // Pane 0: single candle series, standard green/red.
    const cs = chart.addSeries(CandlestickSeries, {
      upColor:         C.green,
      downColor:       C.redCdl,
      borderUpColor:   C.green,
      borderDownColor: C.redCdl,
      wickUpColor:     C.green,
      wickDownColor:   C.redCdl,
    }, 0);
    candleSeriesRef.current = cs;

    // Pane 1: GCP NetVar line
    const gcpLine = chart.addSeries(LineSeries, {
      color:                      C.cyan,
      lineWidth:                  1,
      lastValueVisible:           true,
      priceLineVisible:           false,
      crosshairMarkerVisible:     true,
      crosshairMarkerRadius:      3,
      crosshairMarkerBorderColor: C.bg,
    }, 1);
    gcpLineRef.current = gcpLine;

    // 68/32 split between candles (top) and GCP line (bottom).
    try {
      const panes = chart.panes();
      if (panes.length >= 2) {
        panes[0].setStretchFactor(68);
        panes[1].setStretchFactor(32);
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

    // Hovering the GCP pane shows a floating NV/regime/time tooltip.
    const REGIME_LABELS: Record<string, string> = {
      A: 'Silence', B: 'Ignition', C: 'Alignment',
      D: 'Synchronization', E: 'Climax', F: 'Shock',
    };

    chart.subscribeCrosshairMove(param => {
      const line = gcpLineRef.current;
      if (!param.point || param.time == null || !line) {
        setGcpTooltip(null);
        return;
      }

      const cursorTs = (param.time as number) * 1000;

      // If the crosshair is within a couple of bars of a pattern start,
      // show the pattern name + PSS instead of the NV reading.
      const PATTERN_HIT_MS = 2 * 60_000;
      const nearPattern = chartPatternsRef.current.find(p =>
        p.tStart > 0 && Math.abs(p.tStart - cursorTs) < PATTERN_HIT_MS,
      );
      if (nearPattern) {
        const startPt = chartGCPSeriesRef.current[nearPattern.start];
        setGcpTooltip({
          mode:   'pattern',
          x:      param.point.x,
          kind:   nearPattern.kind,
          pss:    Math.round(nearPattern.strength * 100),
          regime: startPt?.r ?? '?',
          bars:   nearPattern.end - nearPattern.start,
          time:   new Date(nearPattern.tStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
        return;
      }

      const data = param.seriesData.get(line) as { value?: number } | undefined;
      if (!data || typeof data.value !== 'number') {
        setGcpTooltip(null);
        return;
      }
      const nv     = data.value;
      const regime = nv < 50 ? 'A' : nv < 100 ? 'B' : nv < 140 ? 'C'
                   : nv < 170 ? 'D' : nv < 220 ? 'E' : 'F';
      const time   = new Date(cursorTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setGcpTooltip({
        mode:        'nv',
        x:           param.point.x,
        nv:          Math.round(nv * 10) / 10,
        regime,
        regimeLabel: REGIME_LABELS[regime] ?? '',
        time,
      });
    });

    setChartReady(true);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current        = null;
      gcpLineRef.current      = null;
      candleSeriesRef.current = null;
      markersRef.current       = null;
      setChartReady(false);
    };
  }, []);

  // ── GCP line updates ───────────────────────────────────────────────────────
  // Empirically: DataPoint.t is in MILLISECONDS in this codebase
  // (gcp_2026.json values are ~1.7e12, useGCPData multiplies end_epoch by
  // 1000). LW Charts wants Unix seconds. Divide by 1000 here so the GCP
  // pane lines up with the candle pane (which goes through toTime).
  useEffect(() => {
    const line = gcpLineRef.current;
    if (!line) return;

    if (!chartGCPSeries.length) {
      line.setData([]);
      return;
    }

    const base = chartGCPSeries.map(p => ({
      time:  Math.floor(p.t / 1000),
      value: p.v,
    }));

    // Gap fill in seconds: > 300 s threshold, 60 s step.
    const filled: { time: number; value: number }[] = [base[0]];
    for (let i = 1; i < base.length; i++) {
      const prev = base[i - 1];
      const curr = base[i];
      const gap  = curr.time - prev.time;
      if (gap > 300) {
        for (let t = prev.time + 60; t < curr.time; t += 60) {
          filled.push({ time: t, value: prev.value });
        }
      }
      filled.push(curr);
    }

    // Trailing extension at "now" in Unix seconds.
    const last    = filled[filled.length - 1];
    const nowSlot = Math.floor(Date.now() / 1000);
    if (nowSlot > last.time) {
      filled.push({ time: nowSlot, value: last.value });
    }

    line.setData(filled.map(p => ({ time: p.time as Time, value: p.value })));
  }, [chartGCPSeries]);

  // ── Apply candles to the single series ─────────────────────────────────────
  useEffect(() => {
    if (!chartReady) return;
    const cs = candleSeriesRef.current;
    if (!cs || !displayCandles.length) return;

    const sortedCandles = displayCandles.slice().sort((a, b) => a.t - b.t);

    if (process.env.NODE_ENV !== 'production') {
      console.debug(
        '[ChartView] first 5 candle bars (synthetic flag check):',
        sortedCandles.slice(0, 5).map(c => ({ t: c.t, synthetic: c.synthetic })),
      );
    }

    const data: CandlestickData[] = sortedCandles.map(c => {
      const base = {
        time:  toTime(c.t),
        open:  c.o,
        high:  c.h,
        low:   c.l,
        close: c.c,
      };
      // Strict synthetic check: only apply transparent override when the
      // flag is explicitly true. Real candles (synthetic absent/undefined)
      // fall through with no per-bar color and inherit the series defaults.
      if (c.synthetic === true) {
        return {
          ...base,
          color:       'rgba(0,0,0,0)',
          wickColor:   'rgba(0,0,0,0)',
          borderColor: 'rgba(0,0,0,0)',
        };
      }
      return base;
    });

    try { cs.setData(data); } catch { /* time ordering harmless */ }

    if (isInitRef.current) {
      requestAnimationFrame(() => {
        chartRef.current?.timeScale().fitContent();
        chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
      });
      isInitRef.current = false;
    }
  }, [chartReady, displayCandles]);

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
  }, [symbol, chartTF, retryNonce]);

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

  // ── Chart-local pattern detection on the chart's own GCP series ────────────
  // The `patterns` prop is windowed to the Dashboard's VIEW; the Chart tab
  // should detect on its own visible GCP slice so users see all patterns
  // for the candle range they're scrolled to.
  //
  // Gap-aware: detectPatterns walks regime runs by INDEX, treating
  // consecutive array entries as contiguous regardless of time. With the
  // historical/live merge boundary often sitting in the middle of the
  // windowed slice, a single regime run could span multiple days (e.g.
  // an A/B run from Apr 24 historical end straight into Apr 26 live
  // start) and consume detection slots that should belong to live-side
  // patterns. Splitting at any > 5 minute time gap and detecting per
  // segment prevents that.
  const chartPatterns = useMemo(() => {
    if (!chartGCPSeries.length) return [] as Pattern[];

    const GAP_MS  = 5 * 60_000;
    const patterns: Pattern[] = [];
    let segStart = 0;

    // Diagnostic: surface the largest inter-point gap so the data side of
    // the issue is visible without inspecting state.
    let maxGapMs = 0;
    for (let i = 1; i < chartGCPSeries.length; i++) {
      const g = chartGCPSeries[i].t - chartGCPSeries[i - 1].t;
      if (g > maxGapMs) maxGapMs = g;
    }

    const segSizes: number[] = [];
    for (let i = 1; i <= chartGCPSeries.length; i++) {
      const atEnd = i === chartGCPSeries.length;
      const isGap = !atEnd && chartGCPSeries[i].t - chartGCPSeries[i - 1].t > GAP_MS;
      if (isGap || atEnd) {
        const seg = chartGCPSeries.slice(segStart, i);
        segSizes.push(seg.length);
        if (seg.length >= 10) {
          for (const p of detectPatterns(seg, 1)) {
            // detectPatterns returns indices local to `seg`. Offset them
            // back into the full chartGCPSeries index space so the marker
            // and tooltip lookups hit the right point. tStart/tEnd are
            // absolute timestamps and need no offset.
            patterns.push({
              ...p,
              start: p.start + segStart,
              end:   p.end   + segStart,
            });
          }
        }
        segStart = i;
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      console.debug(
        '[ChartView] chartPatterns:',
        'windowed:', chartGCPSeries.length,
        'segments:', segSizes.length,
        'segSizes:', segSizes,
        'maxGapMs:', maxGapMs,
        'patterns:', patterns.length,
        'firstT:', chartGCPSeries.length ? new Date(chartGCPSeries[0].t).toISOString() : null,
        'lastT:',  chartGCPSeries.length ? new Date(chartGCPSeries[chartGCPSeries.length - 1].t).toISOString() : null,
      );
    }

    return patterns;
  }, [chartGCPSeries]);

  useEffect(() => { chartPatternsRef.current = chartPatterns; }, [chartPatterns]);
  useEffect(() => { chartGCPSeriesRef.current = chartGCPSeries; }, [chartGCPSeries]);

  // ── Pattern markers on the GCP line (bottom pane only) ───────────────────
  // Candle-pane markers were dropped: they cluttered the price action and
  // ran into LW Charts marker-snapping issues at coarser TFs. The GCP pane
  // is the right place to surface coherence patterns.
  useEffect(() => {
    const gcpLine = gcpLineRef.current;
    if (!gcpLine) return;

    if (!chartPatterns.length || !chartGCPSeries.length) {
      markersRef.current?.setMarkers([]);
      return;
    }

    const MARKER_COLORS: Record<string, string> = {
      'Alignment Ladder':    C.cyan,
      'Shock Jump':          C.red,
      'Failed Alignment':    '#d946ef',
      'Coherence Volcano':   '#f59e0b',
      'Compression Coil':    '#6b7280',
      'Compression Release': '#22c55e',
      'Ignition Drift':      '#888780',
    };

    const gcpMarkers: SeriesMarker<Time>[] = chartPatterns
      .filter(p => p.tStart > 0)
      .map(p => {
        const closest = chartGCPSeries.reduce((best, pt) =>
          Math.abs(pt.t - p.tStart) < Math.abs(best.t - p.tStart) ? pt : best
        );
        return {
          time:     toTime(closest.t),
          position: 'aboveBar' as const,
          color:    MARKER_COLORS[p.kind] ?? C.text,
          shape:    'circle' as const,
          text:     p.kind.split(' ').map(w => w[0]).join(''),
          size:     1,
        };
      })
      .sort((a, b) => (a.time as number) - (b.time as number));

    if (markersRef.current) markersRef.current.setMarkers(gcpMarkers);
    else                    markersRef.current = createSeriesMarkers<Time>(gcpLine, gcpMarkers);
  }, [chartPatterns, chartGCPSeries]);

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
        <span style={{ color: 'var(--fg-3)' }}>{chartTF} bars</span>

        <select
          value={chartTF}
          onChange={e => { isInitRef.current = true; setChartTF(e.target.value as ChartTF); }}
          style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 2,
            color: 'var(--fg-1)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            padding: '2px 6px',
            cursor: 'pointer',
            marginLeft: 6,
          }}
        >
          {(['1m','5m','15m','1h','4h','1D'] as ChartTF[]).map(tf => (
            <option key={tf} value={tf}>{tf}</option>
          ))}
        </select>

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

      </div>

      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, position: 'relative' }}
        onMouseLeave={() => setGcpTooltip(null)}
        onContextMenu={e => {
          e.preventDefault();
          const chart = chartRef.current;
          if (!chart) return;
          const rect  = e.currentTarget.getBoundingClientRect();
          let priceVal: number | null = null;
          try {
            // coordinateToPrice lives on the series API in lightweight-charts v5
            const p = candleSeriesRef.current?.coordinateToPrice(e.clientY - rect.top);
            priceVal = (p as number | null) ?? null;
          } catch { /* not on price pane */ }
          let tsVal: number | null = null;
          try {
            const ts = chart.timeScale().coordinateToTime(e.clientX - rect.left);
            tsVal = ts != null ? (ts as number) * 1000 : null;
          } catch { /* off-axis */ }
          setCtxMenu({ x: e.clientX, y: e.clientY, price: priceVal, time: tsVal });
        }}
        onClick={() => setCtxMenu(null)}
      >
        {gcpTooltip && (
          <div style={{
            position: 'absolute',
            left: Math.min(gcpTooltip.x + 12, (containerRef.current?.offsetWidth ?? 800) - 170),
            bottom: 40,
            pointerEvents: 'none',
            zIndex: 8,
            background: 'var(--bg-2)',
            border: `1px solid ${gcpTooltip.mode === 'pattern' ? C.cyan : 'var(--line-2)'}`,
            borderRadius: 3,
            padding: '6px 10px',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            minWidth: 130,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}>
            {gcpTooltip.mode === 'pattern' ? (
              <>
                <div style={{ color: 'var(--fg-3)', fontSize: 8, letterSpacing: '0.1em', marginBottom: 3 }}>
                  PATTERN DETECTED
                </div>
                <div style={{ color: C.cyan, fontSize: 13, letterSpacing: '0.02em', lineHeight: 1.1 }}>
                  {gcpTooltip.kind}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 5 }}>
                  <span style={{ color: '#d4a028', fontSize: 9, fontVariantNumeric: 'tabular-nums' }}>
                    PSS {gcpTooltip.pss}
                  </span>
                  <span style={{ color: 'var(--fg-3)', fontSize: 9 }}>
                    {gcpTooltip.regime} regime
                  </span>
                  <span style={{ color: 'var(--fg-4)', fontSize: 9, fontVariantNumeric: 'tabular-nums' }}>
                    {gcpTooltip.bars}b
                  </span>
                </div>
                <div style={{ color: 'var(--fg-4)', fontSize: 8, marginTop: 3 }}>
                  {gcpTooltip.time}
                </div>
              </>
            ) : (
              <>
                <div style={{ color: 'var(--fg-3)', fontSize: 8, letterSpacing: '0.1em', marginBottom: 3 }}>
                  GCP NET VARIANCE
                </div>
                <div style={{ color: C.cyan, fontSize: 18, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                  {gcpTooltip.nv.toFixed(1)}
                </div>
                <div style={{ color: 'var(--fg-2)', fontSize: 9, marginTop: 4 }}>
                  {gcpTooltip.regime} · {gcpTooltip.regimeLabel}
                </div>
                <div style={{ color: 'var(--fg-4)', fontSize: 8, marginTop: 2 }}>
                  {gcpTooltip.time}
                </div>
              </>
            )}
          </div>
        )}

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

        {ctxMenu && (
          <div
            style={{
              position: 'fixed',
              left: ctxMenu.x, top: ctxMenu.y,
              background: 'var(--bg-2)',
              border: '1px solid var(--line-2)',
              borderRadius: 4,
              zIndex: 1000,
              minWidth: 180,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
          >
            {(ctxMenu.price != null || ctxMenu.time != null) && (
              <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--line-1)', fontSize: 10, color: 'var(--fg-2)' }}>
                {ctxMenu.price != null && (
                  <div>Price <span style={{ color: 'var(--fg-0)', float: 'right' }}>
                    {symbol === 'BTC'
                      ? `$${Math.round(ctxMenu.price).toLocaleString()}`
                      : `$${ctxMenu.price.toFixed(2)}`}
                  </span></div>
                )}
                {ctxMenu.time != null && (
                  <div>Time <span style={{ color: 'var(--fg-0)', float: 'right' }}>
                    {new Date(ctxMenu.time).toLocaleTimeString()}
                  </span></div>
                )}
              </div>
            )}

            {[
              { label: 'Fit all data',  fn: () => chartRef.current?.timeScale().fitContent() },
              { label: 'Go to live',    fn: () => chartRef.current?.timeScale().scrollToRealTime() },
              { label: '─────────────', fn: null as null | (() => void | Promise<void>) },
              {
                label: 'Load more history ←',
                fn: async () => {
                  if (!earliestTsRef.current || isLoadingMore) return;
                  setIsLoadingMore(true);
                  try {
                    const older = await fetchCandlesBefore(symbol, chartTF, 500, earliestTsRef.current - 60_000);
                    if (older.length) {
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
                    } else {
                      setHasMoreLeft(false);
                    }
                  } finally {
                    setIsLoadingMore(false);
                  }
                },
              },
            ].map((item, i) =>
              item.fn === null ? (
                <div key={i} style={{ padding: '2px 12px', color: 'var(--fg-4)', fontSize: 9 }}>
                  {item.label}
                </div>
              ) : (
                <button key={i}
                  onClick={() => { item.fn?.(); setCtxMenu(null); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px 12px', background: 'transparent',
                    border: 'none', color: 'var(--fg-1)',
                    fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-3)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {item.label}
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
