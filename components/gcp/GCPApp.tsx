'use client';

import { useState, useEffect, useMemo } from 'react';
import { buildSeries, detectPatterns } from '@/lib/gcp-data';
import Chrome from './Chrome';
import Dashboard from './Dashboard';
import PatternDetail from './PatternDetail';
import type { CursorInfo } from '@/types/gcp';

export default function GCPApp() {
  const [page, setPage] = useState<'dashboard' | 'pattern' | 'settings'>('dashboard');
  const [live, setLive] = useState(true);
  const [selectedPatternKind, setSelectedPatternKind] = useState<string | null>(null);

  const dataset = useMemo(() => buildSeries(), []);
  const [cursor, setCursor] = useState(dataset.series.length - 1);
  const patterns = useMemo(() => detectPatterns(dataset.series), [dataset]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      setCursor(c => {
        const maxI = dataset.series.length - 1;
        const minI = Math.floor(maxI * 0.25);
        const next = c + 3;
        return next > maxI ? minI : next;
      });
    }, 500);
    return () => clearInterval(id);
  }, [live, dataset.series.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
      if (e.key === 'd') setPage('dashboard');
      if (e.key === 'p') setPage('pattern');
      if (e.key === 's') setPage('settings');
      if (e.key === ' ') { e.preventDefault(); setLive(l => !l); }
      if (e.key === 'ArrowLeft') setCursor(c => Math.max(0, c - 10));
      if (e.key === 'ArrowRight') setCursor(c => Math.min(dataset.series.length - 1, c + 10));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dataset.series.length]);

  const cursorS = dataset.series[cursor] || dataset.series[0];
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = new Date(cursorS.t);
  const cursorInfo: CursorInfo = {
    i: cursor,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`,
    v: cursorS.v.toFixed(1),
    r: cursorS.r,
    g: `$${cursorS.g.toFixed(2)}`,
  };

  const handleSelectPatternKind = (kind: string) => {
    setSelectedPatternKind(kind);
    setPage('pattern');
  };

  return (
    <div className="app">
      <Chrome.Header page={page} onNav={setPage} live={live} onToggleLive={() => setLive(l => !l)} />
      <div className="app-body">
        <Chrome.LeftRail page={page} onNav={setPage} />
        <main className="main">
          {page === 'dashboard' && (
            <Dashboard
              series={dataset.series}
              patterns={patterns}
              cursor={cursor}
              setCursor={setCursor}
              live={live}
              onSelectPatternKind={handleSelectPatternKind}
            />
          )}
          {page === 'pattern' && (
            <PatternDetail
              kind={selectedPatternKind || 'Alignment Ladder'}
              series={dataset.series}
              patterns={patterns}
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
      <Chrome.StatusBar cursorInfo={cursorInfo} series={dataset.series} />
    </div>
  );
}
