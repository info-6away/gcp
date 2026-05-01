'use client';

import { useRef, useEffect, useState, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  CrosshairMode,
  LineStyle,
  LineType,
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
import { tdTimeSeries } from '@/lib/fetchCandles';
import { sanitizeCandles, isValidCandle, nearZeroFloorFor } from '@/lib/sanity';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
};

type ChartTF = '1m' | '5m' | '15m' | '1h' | '4h' | '1D';

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

// Thin wrapper around the shared tdTimeSeries helper. The lazy-scroll
// path doesn't want the synthetic weekend / extend-to-now passes that
// fetchCandlesForWindow applies — backfill candles need to land at their
// real timestamps so they merge cleanly with the existing buffer. All
// timezone / ISO parsing concerns live in tdTimeSeries.
async function fetchCandlesBefore(
  symbol: MarketSymbol,
  tf: ChartTF,
  outputsize: number,
  before?: number,
): Promise<Candle[]> {
  const sym = TD_SYMBOLS[symbol];
  if (!sym) throw new Error('No symbol');
  return tdTimeSeries({ symbol: sym, tf, outputsize, endMs: before });
}

import type { SensitivityThresholds } from '@/lib/sensitivity';

interface ChartViewProps {
  series:    DataPoint[];
  patterns:  Pattern[];
  symbol:    MarketSymbol;
  timeframe: Timeframe;
  sensitivityThresholds?: SensitivityThresholds;
  livePrice?:     number | null;     // most recent spot tick from useGoldData
  livePriceTime?: Date   | null;     // when that tick landed
}

const CHART_TF_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1D': 86_400_000,
};

export default function ChartView({
  series, patterns, symbol, timeframe, sensitivityThresholds,
  livePrice, livePriceTime,
}: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const gcpLineRef      = useRef<ISeriesApi<'Line'> | null>(null);
  const markersRef       = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // v11.20.2: hold the latest live price + its timestamp in refs so
  // the candles-applied effect can re-apply them after every setData
  // without taking a dependency on livePrice (which would refire that
  // whole effect on every tick).
  const livePriceRef     = useRef<number | null>(livePrice ?? null);
  const livePriceTimeRef = useRef<Date   | null>(livePriceTime ?? null);
  useEffect(() => { livePriceRef.current     = livePrice     ?? null; }, [livePrice]);
  useEffect(() => { livePriceTimeRef.current = livePriceTime ?? null; }, [livePriceTime]);

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

  // Pattern selected by clicking its marker -- drives the explanation
  // panel and the +15/+30/+60 min reaction shading on the candle pane.
  const [selectedPattern, setSelectedPattern] = useState<Pattern | null>(null);
  const [reactionPx, setReactionPx] = useState<{
    start: number | null; p15: number | null; p30: number | null; p60: number | null;
  }>({ start: null, p15: null, p30: null, p60: null });
  const chartPatternsRef            = useRef<Pattern[]>([]);
  const chartGCPSeriesRef           = useRef<DataPoint[]>([]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctxMenu]);

  // Esc dismisses the explanation panel.
  useEffect(() => {
    if (!selectedPattern) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedPattern(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPattern]);

  // Recompute the +15/+30/+60 min reaction-window x-coordinates whenever
  // the selected pattern changes or the chart's visible range scrolls.
  useEffect(() => {
    if (!selectedPattern || !chartReady) {
      setReactionPx({ start: null, p15: null, p30: null, p60: null });
      return;
    }
    const chart = chartRef.current;
    if (!chart) return;
    const ts0 = chart.timeScale();

    // Anchor at the pattern's tStart (the timestamp the marker is drawn
    // at), not tEnd. The marker effect places each marker at the GCP
    // point closest to tStart, so the +15/+30/+60 lines should fan out
    // from that same x position. Using tEnd put the band at the END of
    // the pattern's window, which can be hours past the marker for
    // long-running patterns.
    const startSec = Math.floor(selectedPattern.tStart / 1000);
    const update = () => {
      const px = (sec: number): number | null => {
        const c = ts0.timeToCoordinate(sec as Time);
        return typeof c === 'number' ? c : null;
      };
      setReactionPx({
        start: px(startSec),
        p15:   px(startSec + 15 * 60),
        p30:   px(startSec + 30 * 60),
        p60:   px(startSec + 60 * 60),
      });
    };
    update();
    ts0.subscribeVisibleTimeRangeChange(update);
    return () => ts0.unsubscribeVisibleTimeRangeChange(update);
  }, [selectedPattern, chartReady]);

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

    // Market-window alignment for gold/silver. GCP runs 24/7 but XAU/USD
    // and XAG/USD have weekend / overnight gaps. When LW Charts shares a
    // time axis between panes and GCP has points inside those gaps, the
    // candle pane gets empty horizontal stripes. Drop GCP points that
    // sit further than ~2 bars from any real candle so the shared axis
    // only allocates time for periods both sides have data. BTC trades
    // 24/7 so it skips this filter and shows GCP continuously.
    let aligned = windowed;
    if (symbol !== 'BTC' && displayCandles.length >= 2) {
      const tfMs        = CHART_TF_MS[chartTF] ?? 300_000;
      const candleTs    = displayCandles.map(c => c.t);
      const allowance   = 2 * tfMs;
      // Binary search the nearest candle timestamp for each GCP point.
      const nearest = (target: number): number => {
        let lo = 0, hi = candleTs.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (candleTs[mid] < target) lo = mid + 1;
          else hi = mid;
        }
        const a = lo > 0 ? candleTs[lo - 1] : Infinity;
        const b = lo < candleTs.length ? candleTs[lo] : Infinity;
        return Math.min(Math.abs(a - target), Math.abs(b - target));
      };
      aligned = windowed.filter(p => nearest(p.t) <= allowance);
    }

    return aligned.length > 3000 ? lttbDownsample(aligned, 800) : aligned;
  }, [series, displayCandles, symbol, chartTF]);

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
      // Curved line type: visually smooths between consecutive 1-min
      // points so the line reads as continuous rather than jagged.
      // Original data frequency is preserved; this is a render-time
      // bezier smoothing only, no data fabrication.
      lineType:                   LineType.Curved,
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

    // Click-to-select: if the click lands within ±2 minutes of a pattern's
    // tStart, open the explanation panel for that pattern. Off-marker
    // clicks are ignored so the user has to dismiss explicitly (Esc / X).
    chart.subscribeClick(param => {
      if (param.time == null) return;
      const ts  = (param.time as number) * 1000;
      const HIT = 2 * 60_000;
      let best: Pattern | null = null;
      let bestDiff = Infinity;
      for (const p of chartPatternsRef.current) {
        if (p.tStart <= 0) continue;
        const d = Math.abs(p.tStart - ts);
        if (d < HIT && d < bestDiff) { bestDiff = d; best = p; }
      }
      if (best) setSelectedPattern(best);
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

    // Gap fill via linear interpolation (was carry-forward earlier).
    // Carry-forward produced flat plateaus that read as step jumps; a
    // straight-line interpolation between prev and curr keeps the line
    // smooth across the merge boundary while preserving original data
    // frequency at the actual sample points.
    const filled: { time: number; value: number }[] = [base[0]];
    for (let i = 1; i < base.length; i++) {
      const prev = base[i - 1];
      const curr = base[i];
      const gap  = curr.time - prev.time;
      if (gap > 300) {
        const steps = Math.floor((curr.time - prev.time) / 60);
        for (let k = 1; k < steps; k++) {
          const t = prev.time + k * 60;
          const f = k / steps;
          filled.push({ time: t, value: prev.value + (curr.value - prev.value) * f });
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

    // v11.13.2: sanitize before mapping to LW Charts shape. Drops any
    // candle with invalid OHLC + filters >10% single-bar jumps as a
    // feed-glitch guard. nearZeroFloor surfaces a console warn for the
    // first few suspicious bars on this symbol so we can identify the
    // source of any future near-zero spike without spamming logs.
    const sortedCandles = sanitizeCandles(
      displayCandles.slice().sort((a, b) => a.t - b.t),
      `ChartView.setData(${symbol},${chartTF})`,
      {
        filterJumps:    true,
        nearZeroFloor:  nearZeroFloorFor(symbol),
      },
    );

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

    // v11.20.2: re-apply the latest live tick to the rightmost bar
    // immediately after setData. Without this, the 60 s fetch loop
    // can leave a stale "API snapshot" candle on screen — and if that
    // snapshot happened to land while close < open, the bar reads
    // RED even though subsequent live ticks pushed close above open.
    // The live-tick effect alone doesn't refire because livePrice
    // hasn't changed; we have to mutate explicitly here.
    const lp = livePriceRef.current;
    const lt = livePriceTimeRef.current;
    if (lp != null && lt != null && Number.isFinite(lp) && lp > 0) {
      const tfMs = CHART_TF_MS[chartTF] ?? 60_000;
      const slot = Math.floor(lt.getTime() / tfMs) * tfMs;
      const last = allCandlesRef.current[allCandlesRef.current.length - 1];
      if (last && slot === last.t && isValidCandle(last)) {
        const bar: Candle = {
          ...last,
          h: Math.max(last.h, lp),
          l: Math.min(last.l, lp),
          c: lp,
        };
        if (isValidCandle(bar)) {
          allCandlesRef.current[allCandlesRef.current.length - 1] = bar;
          try {
            cs.update({ time: toTime(slot), open: bar.o, high: bar.h, low: bar.l, close: bar.c });
          } catch { /* */ }
          if (process.env.NODE_ENV !== 'production') {
            console.log('[CANDLE]', { open: bar.o, close: bar.c, isUp: bar.c >= bar.o, source: 'after-setData' });
          }
        }
      }
    }

    if (isInitRef.current) {
      requestAnimationFrame(() => {
        chartRef.current?.timeScale().fitContent();
        chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
      });
      isInitRef.current = false;
    }
  }, [chartReady, displayCandles, chartTF]);

  // Live-bar update: every spot-price tick mutates the rightmost candle's
  // close (and updates high/low if the tick exceeds them). When the tick
  // crosses into a new TF slot, a fresh bar is appended and starts
  // tracking. Uses cs.update() so the chart paints immediately without
  // a full setData rebuild. The 60 s candle-fetch loop continues to land
  // and replaces the live bar's OHLC with the API's official values
  // when its slot has fully closed -- live updates are an approximation
  // for the currently-forming bar only.
  useEffect(() => {
    if (!chartReady) return;
    if (livePrice == null || !livePriceTime) return;
    // v11.13.1 sanity gate: never let a NaN / Infinity / <=0 livePrice
    // mutate the live bar. cs.update() with a NaN close paints a vertical
    // spike on the candle pane.
    if (!Number.isFinite(livePrice) || livePrice <= 0) return;
    const cs = candleSeriesRef.current;
    if (!cs || !allCandlesRef.current.length) return;

    const tfMs = CHART_TF_MS[chartTF] ?? 60_000;
    const slot = Math.floor(livePriceTime.getTime() / tfMs) * tfMs;
    const last = allCandlesRef.current[allCandlesRef.current.length - 1];

    if (slot > last.t) {
      const bar: Candle = {
        t: slot,
        o: livePrice, h: livePrice, l: livePrice, c: livePrice,
      };
      // v11.13.2: validate the synthesised bar before pushing. livePrice
      // already passed the v11.13.1 finite + > 0 gate above, but defense
      // in depth keeps the candle pipeline self-consistent.
      if (!isValidCandle(bar)) return;
      allCandlesRef.current.push(bar);
      try {
        cs.update({
          time:  toTime(slot),
          open:  bar.o, high: bar.h, low: bar.l, close: bar.c,
        });
      } catch { /* */ }
      // v11.20.2 dev log: confirms color decision is per-candle.
      // isUp computed ONLY from this bar's open/close, never from
      // previous candle or external feed.
      if (process.env.NODE_ENV !== 'production') {
        console.log('[CANDLE]', { open: bar.o, close: bar.c, isUp: bar.c >= bar.o, source: 'new-slot' });
      }
    } else if (slot === last.t) {
      // v11.13.2: if the existing last candle is corrupt (h/l NaN from
      // a bad upstream bar), Math.max(NaN, livePrice) propagates NaN
      // into the live bar's high/low and paints a vertical spike.
      // Replace a bad last candle outright with a fresh synthetic bar
      // built from livePrice alone -- safer than letting NaN compound.
      const useLast = isValidCandle(last);
      const bar: Candle = useLast
        ? {
            ...last,
            h: Math.max(last.h, livePrice),
            l: Math.min(last.l, livePrice),
            c: livePrice,
          }
        : { t: slot, o: livePrice, h: livePrice, l: livePrice, c: livePrice };
      if (!isValidCandle(bar)) return;
      allCandlesRef.current[allCandlesRef.current.length - 1] = bar;
      try {
        cs.update({
          time:  toTime(slot),
          open:  bar.o, high: bar.h, low: bar.l, close: bar.c,
        });
      } catch { /* */ }
      if (process.env.NODE_ENV !== 'production') {
        console.log('[CANDLE]', { open: bar.o, close: bar.c, isUp: bar.c >= bar.o, source: 'live-tick' });
      }
    }
    // slot < last.t: out-of-order tick, ignore.
  }, [chartReady, livePrice, livePriceTime, chartTF]);

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
  // Split at any > 30 min time gap so detectPatterns doesn't merge regime
  // runs across the historical/live merge boundary into one giant pattern
  // that consumes detection slots and starves the live tail.
  const chartPatterns = useMemo(() => {
    if (!chartGCPSeries.length) return [] as Pattern[];

    const GAP_MS = 30 * 60_000;
    const patterns: Pattern[] = [];
    let segStart = 0;

    for (let i = 1; i <= chartGCPSeries.length; i++) {
      const atEnd = i === chartGCPSeries.length;
      const isGap = !atEnd && chartGCPSeries[i].t - chartGCPSeries[i - 1].t > GAP_MS;
      if (isGap || atEnd) {
        const seg = chartGCPSeries.slice(segStart, i);
        if (seg.length >= 10) {
          for (const p of detectPatterns(seg, 1, sensitivityThresholds)) {
            // detectPatterns returns indices local to `seg`. Offset them
            // back into the full chartGCPSeries index space; tStart/tEnd
            // are absolute timestamps and need no offset.
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

    return patterns;
  }, [chartGCPSeries, sensitivityThresholds]);

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
      // Compression / ignition family — cyan / grey
      'Compression Coil':         '#6b7280',
      'Ignition Drift':           '#888780',
      'Ignition Rise':            '#4dd9e8',
      'Pulse Train':              '#5b8cc0',
      'Dead Drift':               '#3a3f47',
      // Alignment / continuation family — green
      'Alignment Ladder':         C.cyan,
      'Compression Release':      '#22c55e',
      'Staircase Alignment':      '#16a34a',
      'Synchronization Plateau':  '#15803d',
      // Climax / spike family — yellow / orange
      'Coherence Volcano':        '#f59e0b',
      'Echo Spike':               '#fb923c',
      // Failed / discharge family — red / magenta
      'Failed Alignment':         '#d946ef',
      'Discharge Break':          '#dc2626',
      'Discharge Wave':           '#ea580c',
      'Double Spike Exhaustion':  '#9333ea',
      // Shock — red
      'Shock Jump':               C.red,
    };

    const gcpMarkers: SeriesMarker<Time>[] = chartPatterns
      .filter(p => p.tStart > 0)
      .map(p => {
        const closest = chartGCPSeries.reduce((best, pt) =>
          Math.abs(pt.t - p.tStart) < Math.abs(best.t - p.tStart) ? pt : best
        );
        const isSelected = selectedPattern?.id === p.id;
        return {
          time:     toTime(closest.t),
          position: 'aboveBar' as const,
          // Selected marker: cyan-tinted color override + bumped size +
          // arrowDown shape so it stands out from the other circles. Other
          // markers stay at their category color and circle size 1.
          color:    isSelected ? C.cyan : (MARKER_COLORS[p.kind] ?? C.text),
          shape:    isSelected ? ('arrowDown' as const) : ('circle' as const),
          text:     p.patternCode ?? p.kind.split(' ').map(w => w[0]).join(''),
          size:     isSelected ? 2 : 1,
        };
      })
      .sort((a, b) => (a.time as number) - (b.time as number));

    if (markersRef.current) markersRef.current.setMarkers(gcpMarkers);
    else                    markersRef.current = createSeriesMarkers<Time>(gcpLine, gcpMarkers);
  }, [chartPatterns, chartGCPSeries, selectedPattern]);

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

        {livePriceTime && (
          <span style={{
            fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.06em',
            fontFamily: 'var(--font-mono)', marginLeft: 8,
          }}>
            Last update <span style={{ color: 'var(--fg-1)' }}>
              {(() => {
                const d = livePriceTime;
                const p = (n: number) => String(n).padStart(2, '0');
                return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
              })()}
            </span>
          </span>
        )}

      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}
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
        {/* Reaction-window shading + +15 / +30 / +60 min markers for the
            selected pattern. Spans the candle pane only (top 67% of the
            chart container, which matches the 68/32 pane stretch). */}
        {selectedPattern && reactionPx.start != null && reactionPx.p60 != null && (
          <>
            <div style={{
              position: 'absolute',
              left:   Math.min(reactionPx.start, reactionPx.p60),
              top:    0,
              width:  Math.abs(reactionPx.p60 - reactionPx.start),
              height: '67%',
              background: 'rgba(77,217,232,0.06)',
              borderLeft:  `1px solid ${C.cyan}`,
              pointerEvents: 'none',
              zIndex: 6,
            }} />
            {([['+15m', reactionPx.p15], ['+30m', reactionPx.p30], ['+60m', reactionPx.p60]] as const).map(([label, x]) =>
              x == null ? null : (
                <div key={label} style={{
                  position: 'absolute',
                  left: x, top: 0, height: '67%',
                  width: 1, background: `${C.cyan}66`,
                  pointerEvents: 'none', zIndex: 7,
                }}>
                  <div style={{
                    position: 'absolute', top: 4, left: 3,
                    fontSize: 8, letterSpacing: '0.06em',
                    color: C.cyan, fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-1)',
                    padding: '1px 4px', borderRadius: 2,
                    whiteSpace: 'nowrap',
                  }}>{label}</div>
                </div>
              )
            )}
          </>
        )}

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

      {/* Side panel: appears next to the chart when a pattern marker is
          clicked. The chart container shrinks horizontally via its
          ResizeObserver so both panes stay fully visible. */}
      {selectedPattern && (
        <aside style={{
          width: 300, flexShrink: 0,
          borderLeft: `1px solid ${C.cyan}`,
          background: 'var(--bg-2)',
          padding: '10px 12px 12px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          overflowY: 'auto',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            marginBottom: 8,
          }}>
            <div>
              <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-3)' }}>
                PATTERN DETECTED
              </div>
              <div style={{
                fontSize: 13, color: C.cyan, fontWeight: 600,
                letterSpacing: '0.02em', marginTop: 2,
              }}>
                {selectedPattern.patternCode ?? ''} · {selectedPattern.patternName ?? selectedPattern.kind}
              </div>
            </div>
            <button
              onClick={() => setSelectedPattern(null)}
              style={{
                width: 18, height: 18, padding: 0,
                background: 'transparent', border: '1px solid var(--line-2)',
                color: 'var(--fg-3)', cursor: 'pointer',
                fontSize: 10, lineHeight: 1, borderRadius: 2,
              }}
              title="Close (Esc)"
            >×</button>
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
            marginBottom: 8,
          }}>
            <div>
              <div style={{ fontSize: 8, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>REGIME</div>
              <div style={{ fontSize: 11, color: 'var(--fg-1)', marginTop: 2 }}>
                {selectedPattern.regime ?? '?'} · {selectedPattern.regimeName ?? ''}
              </div>
              {selectedPattern.persistence && (
                <div style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 2 }}>
                  Persistence: {selectedPattern.persistence}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 8, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>CONFIDENCE / PSS</div>
              <div style={{ fontSize: 11, color: '#d4a028', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
                {Math.round((selectedPattern.confidence ?? selectedPattern.strength) * 100)}%
                <span style={{ color: 'var(--fg-3)' }}> / </span>
                {Math.round((selectedPattern.pss ?? 0) * 100)}%
              </div>
            </div>
          </div>

          <div style={{
            display: 'flex', gap: 10, fontSize: 9, color: 'var(--fg-2)',
            padding: '6px 0', borderTop: '1px solid var(--line-1)',
            borderBottom: '1px solid var(--line-1)', marginBottom: 8,
          }}>
            <span><span style={{ color: 'var(--fg-3)' }}>slope</span> {selectedPattern.slope ?? '—'}</span>
            <span><span style={{ color: 'var(--fg-3)' }}>curv</span> {selectedPattern.curvature ?? '—'}</span>
            <span><span style={{ color: 'var(--fg-3)' }}>ced</span> {selectedPattern.ced?.toFixed(0) ?? '—'}</span>
          </div>

          <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-3)', marginBottom: 4 }}>
            GOLD INTERPRETATION
          </div>
          <div style={{ fontSize: 10, color: 'var(--fg-1)', lineHeight: 1.5, marginBottom: 8 }}>
            {selectedPattern.goldInterpretation ?? '—'}
          </div>

          {selectedPattern.invalidators && selectedPattern.invalidators.length > 0 && (
            <>
              <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-3)', marginBottom: 4 }}>
                INVALIDATORS
              </div>
              <ul style={{
                margin: 0, padding: 0, listStyle: 'none',
                fontSize: 9, color: 'var(--fg-2)', lineHeight: 1.5,
              }}>
                {selectedPattern.invalidators.map((s, i) => (
                  <li key={i} style={{ paddingLeft: 10, position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 0, color: '#ef4444' }}>·</span>
                    {s}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div style={{
            fontSize: 8, color: 'var(--fg-4)', marginTop: 8, paddingTop: 6,
            borderTop: '1px solid var(--line-1)', letterSpacing: '0.06em',
            lineHeight: 1.55,
          }}>
            Reaction window anchored at{' '}
            <span style={{ color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
              {(() => {
                const d = new Date(selectedPattern.tStart);
                const p = (n: number) => String(n).padStart(2, '0');
                return `${p(d.getHours())}:${p(d.getMinutes())}`;
              })()}
            </span>
            <br />
            Esc to close
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}
