'use client';

import { useState, useEffect, useMemo } from 'react';
import { buildSeries, detectPatterns, resampleSeries } from '@/lib/gcp-data';
import { useGoldData } from '@/lib/useGoldData';
import Chrome from './Chrome';
import Dashboard from './Dashboard';
import PatternDetail from './PatternDetail';
import type { CursorInfo, MarketSymbol, Timeframe } from '@/types/gcp';
import { formatPrice, TIMEFRAME_BARS } from '@/types/gcp';

export default function GCPApp() {
  const [page, setPage] = useState<'dashboard' | 'pattern' | 'settings'>('dashboard');
  const [live, setLive] = useState(true);
  const [selectedPatternKind, setSelectedPatternKind] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<MarketSymbol>('XAUUSD');
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');

  const dataset = useMemo(() => buildSeries(), []);
  const [cursor, setCursor] = useState(dataset.series.length - 1);
  const goldData = useGoldData(symbol);

  const mergedSeries = useMemo(() => {
    if (!goldData.candles.length) {
      return dataset.series.map(p => ({ ...p, gReal: false as const }));
    }

    const real = goldData.candles;
    const series = dataset.series.map(p => ({
      ...p,
      gReal: false as boolean | undefined,
    }));

    const n = Math.min(real.length, series.length);
    for (let i = 0; i < n; i++) {
      const gcpIdx = series.length - n + i;
      series[gcpIdx] = {
        ...dataset.series[gcpIdx],
        g:     real[i].c,
        gReal: true,
      };
    }

    return series;
  }, [dataset.series, goldData.candles]);

  const displaySeries = useMemo(() => {
    const bars = TIMEFRAME_BARS[timeframe];
    return resampleSeries(mergedSeries, bars);
  }, [mergedSeries, timeframe]);

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
        goldPrice={goldData.lastPrice}
        goldLoading={goldData.loading}
        goldMarketStatus={goldData.marketStatus}
        goldSessionDate={goldData.sessionDate}
      />
      <div className="app-body">
        <Chrome.LeftRail page={page} onNav={setPage} />
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
