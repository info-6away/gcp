'use client';

import { useState, useEffect, useMemo } from 'react';
import { buildSeries, detectPatterns, resampleSeries } from '@/lib/gcp-data';
import { loadGCPEntries, entriesToSeries } from '@/lib/gcp-loader';
import { useGoldData } from '@/lib/useGoldData';
import Chrome from './Chrome';
import Dashboard from './Dashboard';
import PatternDetail from './PatternDetail';
import type { CursorInfo, MarketSymbol, Timeframe, GCPEntry, ViewWindow } from '@/types/gcp';
import { formatPrice, TIMEFRAME_BARS, VIEW_MINUTES } from '@/types/gcp';

export default function GCPApp() {
  const [page, setPage] = useState<'dashboard' | 'pattern' | 'settings'>('dashboard');
  const [live, setLive] = useState(true);
  const [selectedPatternKind, setSelectedPatternKind] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<MarketSymbol>('XAUUSD');
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const [viewWindow, setViewWindow] = useState<ViewWindow>('24h');

  const [gcpEntries, setGcpEntries] = useState<GCPEntry[]>([]);
  const [gcpLoading, setGcpLoading] = useState(true);

  useEffect(() => {
    loadGCPEntries().then(entries => {
      setGcpEntries(entries);
      setGcpLoading(false);
    });
  }, []);

  const baseSeries = useMemo(() => {
    if (gcpEntries.length === 0) {
      return buildSeries().series;
    }
    return entriesToSeries(gcpEntries);
  }, [gcpEntries]);

  const [cursor, setCursor] = useState(0);
  const goldData = useGoldData(symbol);

  const mergedSeries = useMemo(() => {
    if (!goldData.candles.length) {
      return baseSeries.map(p => ({ ...p, gReal: false as const }));
    }

    const real = goldData.candles;
    const series = baseSeries.map(p => ({
      ...p,
      gReal: false as boolean | undefined,
    }));

    const n = Math.min(real.length, series.length);
    for (let i = 0; i < n; i++) {
      const gcpIdx = series.length - n + i;
      series[gcpIdx] = {
        ...baseSeries[gcpIdx],
        g:     real[i].c,
        gReal: true,
      };
    }

    return series;
  }, [baseSeries, goldData.candles]);

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
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`,
    v: cursorS.v.toFixed(1),
    r: cursorS.r,
    g: formatPrice(cursorS.g, symbol),
  };

  const handleSelectPatternKind = (kind: string) => {
    setSelectedPatternKind(kind);
    setPage('pattern');
  };

  const lastDataDate = useMemo(() => {
    if (!gcpEntries.length) return null;
    return new Date(gcpEntries[gcpEntries.length - 1].t)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }, [gcpEntries]);

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
        goldPrice={goldData.lastPrice}
        goldLoading={goldData.loading}
        goldMarketStatus={goldData.marketStatus}
        goldSessionDate={goldData.sessionDate}
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
