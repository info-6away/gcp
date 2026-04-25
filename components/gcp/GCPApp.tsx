'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { buildSeries, detectPatterns, resampleSeries } from '@/lib/gcp-data';
import { useGCPData } from '@/lib/useGCPData';
import { useGoldData } from '@/lib/useGoldData';
import { useCandleData } from '@/lib/useCandleData';
import Chrome from './Chrome';
import Dashboard from './Dashboard';
import PatternDetail from './PatternDetail';
import type { CursorInfo, MarketSymbol, Timeframe, ViewWindow } from '@/types/gcp';
import { formatPrice, TIMEFRAME_BARS, VIEW_MINUTES } from '@/types/gcp';

export default function GCPApp() {
  const [page, setPage] = useState<'dashboard' | 'pattern' | 'settings'>('dashboard');
  const [live, setLive] = useState(true);
  const [selectedPatternKind, setSelectedPatternKind] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<MarketSymbol>('XAUUSD');
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [viewWindow, setViewWindow] = useState<ViewWindow>('24h');

  const {
    series: liveBaseSeries,
    liveNetvar,
    gcpLoading,
    gcpError,
    isLive: gcpIsLive,
  } = useGCPData();

  const fallbackSeries = useMemo(() => buildSeries().series, []);
  const baseSeries = liveBaseSeries.length > 0 ? liveBaseSeries : fallbackSeries;

  const [cursor, setCursor] = useState(0);
  const didInitCursor = useRef(false);
  useEffect(() => {
    if (baseSeries.length > 0 && !didInitCursor.current) {
      setCursor(baseSeries.length - 1);
      didInitCursor.current = true;
    }
  }, [baseSeries.length]);

  const goldData = useGoldData(symbol);
  const candleData = useCandleData(symbol);

  const mergedSeries = useMemo(() => {
    const series = baseSeries.map(p => ({
      ...p,
      gReal: false as boolean | undefined,
    }));

    const candles = candleData.candles;

    if (candles.length > 0) {
      const n = Math.min(candles.length, series.length);
      for (let i = 0; i < n; i++) {
        const gcpIdx = series.length - n + i;
        series[gcpIdx] = {
          ...baseSeries[gcpIdx],
          g:     candles[i].c,
          gReal: true,
        };
      }
    } else if (goldData.price !== null && series.length > 0) {
      const last = series.length - 1;
      series[last] = {
        ...baseSeries[last],
        g:     goldData.price,
        gReal: true,
      };
    }

    return series;
  }, [baseSeries, candleData.candles, goldData.price]);

  const windowedSeries = useMemo(() => {
    const mins = VIEW_MINUTES[viewWindow];
    if (!Number.isFinite(mins)) return mergedSeries;
    return mergedSeries.slice(-mins);
  }, [mergedSeries, viewWindow]);

  const displaySeries = useMemo(() => {
    const bars = TIMEFRAME_BARS[timeframe];
    return resampleSeries(windowedSeries, bars);
  }, [windowedSeries, timeframe]);

  const displayPatterns = useMemo(
    () => detectPatterns(displaySeries),
    [displaySeries]
  );

  useEffect(() => {
    setCursor(displaySeries.length - 1);
  }, [timeframe, displaySeries.length]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      setCursor(c => {
        const maxI = displaySeries.length - 1;
        const minI = Math.floor(maxI * 0.25);
        const next = c + 1;
        return next > maxI ? minI : next;
      });
    }, 500);
    return () => clearInterval(id);
  }, [live, displaySeries.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
      if (e.key === 'd') setPage('dashboard');
      if (e.key === 'p') setPage('pattern');
      if (e.key === 's') setPage('settings');
      if (e.key === ' ') { e.preventDefault(); setLive(l => !l); }
      if (e.key === 'ArrowLeft') setCursor(c => Math.max(0, c - 10));
      if (e.key === 'ArrowRight') setCursor(c => Math.min(displaySeries.length - 1, c + 10));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [displaySeries.length]);

  const effectiveCursor = Math.min(
    Math.max(0, cursor),
    Math.max(0, displaySeries.length - 1),
  );
  const cursorS = displaySeries[effectiveCursor] || displaySeries[0];
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = new Date(cursorS.t);
  const cursorInfo: CursorInfo = {
    i: effectiveCursor,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
    v: cursorS.v.toFixed(1),
    r: cursorS.r,
    g: cursorS.gReal && cursorS.g > 0
      ? formatPrice(cursorS.g, symbol)
      : goldData.price
        ? `${formatPrice(goldData.price, symbol)} (live)`
        : '—',
  };

  const handleSelectPatternKind = (kind: string) => {
    setSelectedPatternKind(kind);
    setPage('pattern');
  };

  const lastDataDate = useMemo(() => {
    if (!baseSeries.length) return null;
    return new Date(baseSeries[baseSeries.length - 1].t)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }, [baseSeries]);

  if (gcpLoading) {
    return (
      <div className="app">
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100vh', flexDirection: 'column', gap: 16,
        }}>
          <div style={{ color: 'var(--cyan)', fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '0.15em' }}>
            GCP PRO
          </div>
          <div style={{ color: 'var(--fg-2)', fontSize: 11, letterSpacing: '0.1em' }}>
            LOADING COHERENCE DATA…
          </div>
          <div style={{
            width: 200, height: 2, background: 'var(--bg-3)',
            borderRadius: 1, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', width: '40%',
              background: 'var(--cyan)',
              animation: 'scanline 1.2s ease-in-out infinite',
            }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Chrome.Header
        page={page}
        onNav={setPage}
        live={live}
        onToggleLive={() => setLive(l => !l)}
        symbol={symbol}
        onSymbolChange={setSymbol}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
        viewWindow={viewWindow}
        onViewWindowChange={setViewWindow}
        goldPrice={goldData.price}
        goldLoading={goldData.loading}
        goldMarketStatus={goldData.marketStatus}
        goldSessionDate={null}
        candleLoading={candleData.loading}
        candleError={!!candleData.error}
        gcpLive={gcpIsLive}
        gcpNetvar={liveNetvar}
        gcpError={!!gcpError}
      />
      <div className="app-body">
        <Chrome.LeftRail page={page} onNav={setPage} lastDataDate={lastDataDate} />
        <main className="main">
          {page === 'dashboard' && (
            <Dashboard
              series={displaySeries}
              patterns={displayPatterns}
              cursor={effectiveCursor}
              setCursor={setCursor}
              live={live}
              onSelectPatternKind={handleSelectPatternKind}
              symbol={symbol}
              timeframe={timeframe}
            />
          )}
          {page === 'pattern' && (
            <PatternDetail
              kind={selectedPatternKind || 'Alignment Ladder'}
              series={displaySeries}
              patterns={displayPatterns}
              onBack={() => setPage('dashboard')}
              onNavToCursor={(i) => { setCursor(i); setPage('dashboard'); }}
            />
          )}
          {page === 'settings' && (
            <div className="settings-shell" style={{ color: 'var(--fg-2)' }}>
              Settings panel — coming soon
            </div>
          )}
        </main>
      </div>
      <Chrome.StatusBar cursorInfo={cursorInfo} series={displaySeries} symbol={symbol} timeframe={timeframe} />
    </div>
  );
}
