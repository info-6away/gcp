'use client';

import { useState, useEffect } from 'react';
import type { DataPoint, CursorInfo } from '@/types/gcp';

function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <circle cx={16} cy={16} r={14} fill="none" stroke="var(--cyan)" strokeWidth={1} strokeDasharray="2 3" />
      <circle cx={16} cy={16} r={9}  fill="none" stroke="var(--cyan-dim)" strokeWidth={1} />
      <circle cx={16} cy={16} r={3}  fill="var(--cyan)" />
    </svg>
  );
}

function Clock() {
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => {
    setT(new Date());
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  const utc = t
    ? `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
    : '--:--:--';
  return (
    <div className="clock tab">
      <span style={{ color: 'var(--fg-2)' }}>UTC </span>
      <span>{utc}</span>
    </div>
  );
}

interface HeaderProps {
  page: string;
  onNav: (p: 'dashboard' | 'pattern' | 'settings') => void;
  live: boolean;
  onToggleLive: () => void;
}

function Header({ live, onToggleLive }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">
        <LogoMark size={20} />
        <div className="brand-name">
          <span style={{ color: 'var(--fg-0)', fontWeight: 600, letterSpacing: '0.04em' }}>GCP</span>
          <span style={{ color: 'var(--cyan)', fontWeight: 600, letterSpacing: '0.04em' }}> PRO</span>
          <span style={{ color: 'var(--fg-3)', marginLeft: 10, fontSize: 10, letterSpacing: '0.15em' }}>v1.0</span>
        </div>
      </div>

      <div className="header-center">
        <div className="symbol-pick">
          <span className="hairline" style={{ color: 'var(--fg-3)' }}>Symbol</span>
          <span style={{ color: 'var(--fg-0)', fontWeight: 600 }}>XAUUSD</span>
          <span style={{ color: 'var(--fg-2)' }}>· Gold Spot</span>
        </div>
        <div className="tf-group">
          {['1m', '5m', '15m', '1h', '4h', '1D'].map(tf => (
            <button key={tf} className={`tf-btn ${tf === '1m' ? 'active' : ''}`}>{tf}</button>
          ))}
        </div>
      </div>

      <div className="header-right">
        <button className={`live-toggle ${live ? 'on' : ''}`} onClick={onToggleLive}>
          <span className={live ? 'live-dot' : 'paused-dot'} />
          {live ? 'LIVE' : 'PAUSED'}
        </button>
        <Clock />
      </div>
    </header>
  );
}

interface LeftRailProps {
  page: string;
  onNav: (p: 'dashboard' | 'pattern' | 'settings') => void;
}

function LeftRail({ page, onNav }: LeftRailProps) {
  const items = [
    { id: 'dashboard' as const, label: 'Dashboard', hint: 'D' },
    { id: 'pattern'   as const, label: 'Patterns',  hint: 'P' },
    { id: 'settings'  as const, label: 'Settings',  hint: 'S' },
  ];
  return (
    <nav className="left-rail">
      <div className="rail-group">
        {items.map(it => (
          <button
            key={it.id}
            className={`rail-btn ${page === it.id ? 'active' : ''}`}
            onClick={() => onNav(it.id)}
            title={it.label}
          >
            <span className="rail-lbl">{it.label}</span>
            <span className="rail-kbd">{it.hint}</span>
          </button>
        ))}
      </div>
      <div className="rail-spacer" />
      <div className="rail-foot">
        <div className="hairline">Session</div>
        <div style={{ color: 'var(--fg-1)', fontSize: 11 }}>24 Apr 2026</div>
      </div>
    </nav>
  );
}

interface StatusBarProps {
  cursorInfo: CursorInfo;
  series: DataPoint[];
}

function StatusBar({ cursorInfo, series }: StatusBarProps) {
  return (
    <footer className="status-bar">
      <div className="sb-left">
        <span className="hairline">Cursor</span>
        <span className="tab">{cursorInfo.time}</span>
        <span style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          {cursorInfo.i} <span style={{ color: 'var(--fg-4)' }}>/</span> {series.length}
        </span>
      </div>
      <div className="sb-center">
        <span className="hairline">Net Var</span>
        <span className="tab">{cursorInfo.v}</span>
        <span className="sep" />
        <span className="hairline">Regime</span>
        <span className="tab" style={{ color: `var(--r-${cursorInfo.r.toLowerCase()})` }}>{cursorInfo.r}</span>
        <span className="sep" />
        <span className="hairline">XAUUSD</span>
        <span className="tab">{cursorInfo.g}</span>
      </div>
      <div className="sb-right">
        <span className="hairline">Model</span>
        <span>GCP-Pro/v1</span>
      </div>
    </footer>
  );
}

const Chrome = { Header, LeftRail, StatusBar };
export default Chrome;
