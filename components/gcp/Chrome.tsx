'use client';

import { useState, useEffect } from 'react';
import type { DataPoint, CursorInfo, MarketSymbol } from '@/types/gcp';
import { SYMBOLS, formatPrice } from '@/types/gcp';

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
  symbol:            MarketSymbol;
  onSymbolChange:    (s: MarketSymbol) => void;
  goldPrice:         number | null;
  goldLoading:       boolean;
  goldMarketStatus:  'live' | 'closed' | 'error';
  goldSessionDate:   string | null;
}

function SymbolPicker({
  symbol, onSymbolChange,
  goldPrice, goldLoading, goldMarketStatus, goldSessionDate,
}: {
  symbol:           MarketSymbol;
  onSymbolChange:   (s: MarketSymbol) => void;
  goldPrice:        number | null;
  goldLoading:      boolean;
  goldMarketStatus: 'live' | 'closed' | 'error';
  goldSessionDate:  string | null;
}) {
  const [open, setOpen] = useState(false);
  const meta = SYMBOLS.find(s => s.id === symbol)!;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="symbol-pick"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{ cursor: 'pointer' }}
      >
        <span className="hairline" style={{ color: 'var(--fg-3)' }}>Symbol</span>
        <span style={{ color: 'var(--fg-0)', fontWeight: 600 }}>{symbol}</span>
        <span style={{ color: 'var(--fg-2)' }}>· {meta.label}</span>

        {goldLoading && (
          <span style={{ color: 'var(--fg-3)', fontSize: 10 }}>· loading…</span>
        )}
        {!goldLoading && goldMarketStatus !== 'error' && goldPrice !== null && (
          <span style={{
            color: meta.color,
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 600,
          }}>
            · {formatPrice(goldPrice, symbol)}
          </span>
        )}
        {!goldLoading && goldMarketStatus === 'closed' && goldSessionDate && (
          <span style={{ color: 'var(--fg-3)', fontSize: 10, marginLeft: 2 }}>
            ({goldSessionDate})
          </span>
        )}

        {!goldLoading && (
          <span style={{
            fontSize: 9,
            letterSpacing: '0.08em',
            marginLeft: 6,
            color:
              goldMarketStatus === 'live'   ? 'var(--green)' :
              goldMarketStatus === 'closed' ? 'var(--amber)' :
              'var(--red)',
          }}>
            {goldMarketStatus === 'live'   ? '● LIVE'    :
             goldMarketStatus === 'closed' ? '● WEEKEND' :
             '● ERR'}
          </span>
        )}

        <svg width={10} height={10} viewBox="0 0 10 10"
          style={{
            marginLeft: 4,
            opacity: 0.5,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}>
          <path d="M2 4 L5 7 L8 4" stroke="var(--fg-1)" fill="none" strokeWidth={1.2} />
        </svg>
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            background: 'var(--bg-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--r-sm)',
            zIndex: 100,
            minWidth: 200,
            overflow: 'hidden',
          }}
        >
          {SYMBOLS.map(s => (
            <button
              key={s.id}
              onClick={() => { onSymbolChange(s.id); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '9px 14px',
                background: s.id === symbol ? 'var(--bg-3)' : 'transparent',
                borderBottom: '1px solid var(--line-1)',
                textAlign: 'left',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-3)')}
              onMouseLeave={e => (e.currentTarget.style.background = s.id === symbol ? 'var(--bg-3)' : 'transparent')}
            >
              <span style={{
                width: 8, height: 8, borderRadius: 1,
                background: s.color, flexShrink: 0,
              }} />
              <div>
                <div style={{ color: 'var(--fg-0)', fontWeight: 600, fontSize: 12 }}>{s.id}</div>
                <div style={{ color: 'var(--fg-3)', fontSize: 10, marginTop: 1 }}>{s.label}</div>
              </div>
              {s.id === symbol && (
                <span style={{ marginLeft: 'auto', color: 'var(--cyan)', fontSize: 10 }}>✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Header({
  live, onToggleLive,
  symbol, onSymbolChange,
  goldPrice, goldLoading, goldMarketStatus, goldSessionDate,
}: HeaderProps) {
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
        <SymbolPicker
          symbol={symbol}
          onSymbolChange={onSymbolChange}
          goldPrice={goldPrice}
          goldLoading={goldLoading}
          goldMarketStatus={goldMarketStatus}
          goldSessionDate={goldSessionDate}
        />
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
  symbol?: MarketSymbol;
}

function StatusBar({ cursorInfo, series, symbol = 'XAUUSD' }: StatusBarProps) {
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
        <span className="hairline">{symbol}</span>
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
