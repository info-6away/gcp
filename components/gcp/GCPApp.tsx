'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { buildSeries, detectPatterns, processSeries } from '@/lib/gcp-data';
import { useGCPData } from '@/lib/useGCPData';
import { useGoldData } from '@/lib/useGoldData';
import Chrome from './Chrome';
import Dashboard from './Dashboard';
import PatternDetail from './PatternDetail';
import SettingsPanel from './SettingsPanel';
import ChartView from './ChartView';
import type { CursorInfo, MarketSymbol, Timeframe, ViewWindow, AppPage } from '@/types/gcp';
import { formatPrice, TIMEFRAME_BARS, VIEW_MINUTES } from '@/types/gcp';

export default function GCPApp() {
  const [page, setPage] = useState<AppPage>('dashboard');
  const [live, setLive] = useState(true);
  const [selectedPatternKind, setSelectedPatternKind] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<MarketSymbol>('XAUUSD');
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [viewWindow, setViewWindow] = useState<ViewWindow>('24h');

  const gcpData = useGCPData();
  const {
    series: liveBaseSeries,
    liveNetvar,
    gcpLoading,
    gcpError,
    isLive: gcpIsLive,
    scaleFactor: gcpScaleFactor,
  } = gcpData;

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

  // Dashboard is GCP-only. Price overlay lives on the Chart tab now;
  // ChartView consumes candleData directly so we don't need to merge
  // gold/BTC closes into the GCP series anymore.
  const windowedSeries = useMemo(() => {
    const mins = VIEW_MINUTES[viewWindow];
    const sliced = !Number.isFinite(mins) ? baseSeries : baseSeries.slice(-mins);
    return [...sliced].sort((a, b) => a.t - b.t);
  }, [baseSeries, viewWindow]);

  const { displaySeries, analysisSeries } = useMemo(() => {
    const bars = TIMEFRAME_BARS[timeframe];
    const { display, analysis } = processSeries(windowedSeries, bars);
    return { displaySeries: display, analysisSeries: analysis };
  }, [windowedSeries, timeframe]);

  const displayPatterns = useMemo(
    () => detectPatterns(analysisSeries, TIMEFRAME_BARS[timeframe]),
    [analysisSeries, timeframe]
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
      if (e.key === 'p') { setSelectedPatternKind(null); setPage('pattern'); }
      if (e.key === 'c') setPage('chart');
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
    g: goldData.price
      ? `${formatPrice(goldData.price, symbol)} (live)`
      : '—',
  };

  const handleNav = (p: AppPage) => {
    if (p === 'pattern') setSelectedPatternKind(null);
    setPage(p);
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
        onNav={handleNav}
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
        goldSource={goldData.source}
        gcpLive={gcpIsLive}
        gcpNetvar={liveNetvar}
        gcpError={!!gcpError}
      />
      <div className="app-body">
        <Chrome.LeftRail page={page} onNav={handleNav} lastDataDate={lastDataDate} />
        <main className="main">
          {page === 'dashboard' && (
            <Dashboard
              gcpData={gcpData}
              series={baseSeries}
              patterns={displayPatterns}
              symbol={symbol}
              symbolPrice={goldData.price}
            />
          )}
          {page === 'pattern' && (
            <PatternDetail
              kind={selectedPatternKind}
              series={displaySeries}
              patterns={displayPatterns}
              symbol={symbol}
              timeframe={timeframe}
              onBack={() => setPage('dashboard')}
              onNavToCursor={(i) => { setCursor(i); setPage('dashboard'); }}
            />
          )}
          {page === 'chart' && (
            <ChartView
              series={baseSeries}
              patterns={displayPatterns}
              symbol={symbol}
              timeframe={timeframe}
            />
          )}
          {page === 'settings' && (
            <SettingsPanel
              gcpLive={gcpIsLive}
              gcpNetvar={liveNetvar}
              gcpScale={gcpScaleFactor}
              goldStatus={goldData.marketStatus}
              goldPrice={goldData.price}
              goldSource={goldData.source}
              symbol={symbol}
              timeframe={timeframe}
              seriesLength={displaySeries.length}
              historicalPoints={baseSeries.length}
            />
          )}
        </main>
      </div>
      <Chrome.StatusBar cursorInfo={cursorInfo} series={displaySeries} symbol={symbol} timeframe={timeframe} />
    </div>
  );
}
