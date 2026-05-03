'use client';

import { useState, useEffect } from 'react';
import type { DataPoint, CursorInfo, MarketSymbol, Timeframe, ViewWindow, AppPage } from '@/types/gcp';
import { SYMBOLS, formatPrice, getSymbolMeta, TIMEFRAME_LABELS, VIEW_LABELS } from '@/types/gcp';
import { APP_MODEL } from '@/lib/version';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import AiStateBadge from './AiStateBadge';
import Heartbeat, { type HeartbeatMode } from './Heartbeat';
import { AI_ANALYSIS_TF } from '@/lib/aiTimeframe';

const TF_DESCRIPTIONS: Record<string, string> = {
  '1m':  'Each bar = 1 minute',
  '5m':  'Each bar = 5 minutes',
  '15m': 'Each bar = 15 minutes',
  '1h':  'Each bar = 1 hour',
  '4h':  'Each bar = 4 hours',
  '1D':  'Each bar = 1 day',
};

const VW_DESCRIPTIONS: Record<string, string> = {
  '24h': 'Show last 24 hours',
  '7d':  'Show last 7 days',
  '30d': 'Show last 30 days',
  'all': 'Show all available history (Feb–Apr 2026)',
};

function LogoMark({ size = 22 }: { size?: number }) {
  const cyan    = '#4dd9e8';
  const cyanDim = '#2a8a96';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
      <circle cx={16} cy={16} r={13.5}
        fill="none" stroke={cyan} strokeWidth={0.8}
        strokeDasharray="2 3" opacity={0.6} />
      <circle cx={16} cy={16} r={9}
        fill="none" stroke={cyanDim} strokeWidth={0.8} opacity={0.45} />
      <path
        d="M3 16 Q7 9 11 16 Q15 23 19 16 Q23 9 27 16"
        fill="none" stroke={cyan} strokeWidth={1.3} opacity={0.85} />
      <circle cx={16} cy={16} r={2.2} fill={cyan} />
    </svg>
  );
}

interface HeaderProps {
  page: string;
  onNav: (p: AppPage) => void;
  live: boolean;
  onToggleLive: () => void;
  symbol:            MarketSymbol;
  onSymbolChange:    (s: MarketSymbol) => void;
  timeframe:          Timeframe;
  onTimeframeChange:  (tf: Timeframe) => void;
  viewWindow:         ViewWindow;
  onViewWindowChange: (w: ViewWindow) => void;
  goldPrice:          number | null;
  goldLoading:       boolean;
  goldMarketStatus:  'live' | 'closed' | 'error';
  goldSessionDate:   string | null;
  goldSource:        string | null;
  gcpLive:           boolean;
  gcpNetvar:         number | null;
  gcpError:          boolean;
  aiState:           GcpStateResponse | null;
  aiEnabled:         boolean;
  aiStatus:          AiStatus;
}

function SymbolPicker({
  symbol, onSymbolChange,
}: {
  symbol:         MarketSymbol;
  onSymbolChange: (s: MarketSymbol) => void;
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
  page,
  live, onToggleLive,
  symbol, onSymbolChange,
  timeframe, onTimeframeChange,
  viewWindow, onViewWindowChange,
  goldPrice, goldLoading, goldMarketStatus, goldSessionDate, goldSource,
  gcpLive, gcpNetvar, gcpError,
  aiState, aiEnabled, aiStatus,
}: HeaderProps) {
  // On Patterns we only expose VIEW. Pattern detection always runs at 1m
  // resolution (compression coils etc. are meaningless at 4h/1D), so the
  // TF selector is hidden there.
  // On Trading we expose TF (5m, 15m, 1h, etc) but not VIEW -- the chart
  // owns its own scroll history.
  const showTF   = page === 'trading';
  const showView = page === 'pattern';
  return (
    <header className="app-header">
      <div className="brand" style={{ gap: 8 }}>
        <div style={{ filter: 'drop-shadow(0 0 6px rgba(77,217,232,0.25))' }}>
          <LogoMark size={28} />
        </div>
        <div className="brand-name">
          <span style={{ color: 'var(--fg-0)', fontWeight: 700, letterSpacing: '0.06em', fontSize: 13 }}>GCP</span>
          <span style={{ color: 'var(--cyan)', fontWeight: 700, letterSpacing: '0.06em', fontSize: 13 }}> PRO</span>
        </div>
      </div>

      <div className="header-center" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <SymbolPicker
          symbol={symbol}
          onSymbolChange={onSymbolChange}
        />

        {/* v11.21: AI timeframe pill — tells the user what time scale
            the AI is operating on. Locked to 15m for now. Visible
            even when AI is disabled so the chart-vs-AI scale is
            always clear. */}
        {aiEnabled && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 6px',
            fontSize: 9, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em',
            color: '#7F98A3',
            background: 'rgba(56, 189, 248, 0.04)',
            border: '1px solid rgba(56, 189, 248, 0.18)',
            borderRadius: 3,
            whiteSpace: 'nowrap',
          }}
          title="AI analysis timeframe — fixed at 15m for now"
          >
            <span style={{ color: 'var(--fg-4)' }}>AI:</span>
            <span style={{ color: 'var(--cyan)' }}>{AI_ANALYSIS_TF}</span>
          </div>
        )}

        <AiStateBadge state={aiState} enabled={aiEnabled} aiStatus={aiStatus} symbol={symbol} />

        {showTF && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)',
              textTransform: 'uppercase', marginRight: 2,
            }}>TF</span>
            <div className="tf-group">
              {TIMEFRAME_LABELS.map(tf => (
                <button
                  key={tf}
                  className={`tf-btn ${tf === timeframe ? 'active' : ''}`}
                  onClick={() => onTimeframeChange(tf)}
                  title={TF_DESCRIPTIONS[tf]}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
        )}

        {showView && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)',
              textTransform: 'uppercase', marginRight: 2,
            }}>VIEW</span>
            <div className="tf-group">
              {VIEW_LABELS.map(w => (
                <button
                  key={w}
                  className={`tf-btn ${w === viewWindow ? 'active' : ''}`}
                  onClick={() => onViewWindowChange(w)}
                  title={VW_DESCRIPTIONS[w]}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="header-right" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          background: 'var(--bg-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 3,
          overflow: 'hidden',
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
        }}>
          {page !== 'dashboard' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 10px',
              borderRight: '1px solid var(--line-1)',
            }}>
              <span style={{ color: 'var(--fg-3)', letterSpacing: '0.08em' }}>GCP</span>
              {gcpNetvar !== null && (
                <span style={{ color: 'var(--fg-0)', fontVariantNumeric: 'tabular-nums' }}>
                  {gcpNetvar.toFixed(1)}
                </span>
              )}
              <Heartbeat
                mode={gcpError ? 'stale' : gcpLive ? 'live' : 'init'}
                size={6}
                title={gcpError ? 'GCP feed error' : gcpLive ? 'GCP feed live' : 'GCP feed initializing'}
              />
            </div>
          )}

          <div
            title={goldSource ? `Price source: ${goldSource}` : 'Price source: pending'}
            style={{
              display: 'flex', flexDirection: 'column', gap: 1,
              padding: '4px 10px',
              cursor: 'default',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ color: 'var(--fg-3)', letterSpacing: '0.08em' }}>{symbol}</span>
              {goldPrice !== null && (
                <span style={{ color: getSymbolMeta(symbol).color, fontVariantNumeric: 'tabular-nums' }}>
                  {formatPrice(goldPrice, symbol)}
                </span>
              )}
              <Heartbeat
                mode={goldMarketStatus === 'error' ? 'stale'
                  : goldMarketStatus === 'closed' ? 'disabled'
                  : 'live'}
                size={6}
                title={`Price feed ${goldMarketStatus}`}
              />
            </div>
            {goldSource && (
              <span style={{ fontSize: 8, color: 'var(--fg-4)', letterSpacing: '0.06em', textAlign: 'right' }}>
                {goldSource}
              </span>
            )}
          </div>

        </div>

        <div className="divider-v" style={{ height: 20 }} />

        <button
          className={`live-toggle ${live ? 'on' : ''}`}
          onClick={onToggleLive}
          title={live ? 'Pause auto-scroll' : 'Resume live auto-scroll'}
          style={{ minWidth: 32, justifyContent: 'center' }}
        >
          {live ? (
            <svg width={14} height={14} viewBox="0 0 14 14">
              <rect x={3} y={3} width={3} height={8} fill="currentColor" rx={0.5} />
              <rect x={8} y={3} width={3} height={8} fill="currentColor" rx={0.5} />
            </svg>
          ) : (
            <svg width={14} height={14} viewBox="0 0 14 14">
              <polygon points="4,3 11,7 4,11" fill="currentColor" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}

interface LeftRailProps {
  page: string;
  onNav: (p: AppPage) => void;
  lastDataDate?: string | null;
}

function LeftRail({ page, onNav, lastDataDate }: LeftRailProps) {
  const items = [
    { id: 'dashboard' as const, label: 'Dashboard', hint: 'D' },
    { id: 'pattern'   as const, label: 'Patterns',  hint: 'P' },
    { id: 'chart'     as const, label: 'Chart',     hint: 'C' },
    { id: 'research'  as const, label: 'Research',  hint: 'R' },
    { id: 'trading'   as const, label: 'TRD',       hint: 'T' },
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
        <div style={{ color: 'var(--fg-1)', fontSize: 11 }}>{lastDataDate ?? '—'}</div>
      </div>
    </nav>
  );
}

interface StatusBarProps {
  cursorInfo: CursorInfo;
  series: DataPoint[];
  symbol?: MarketSymbol;
  timeframe?: Timeframe;
}

function StatusBar({ cursorInfo, series, symbol = 'XAUUSD', timeframe }: StatusBarProps) {
  const [utcTime, setUtcTime] = useState('');
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>('unsupported');
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      setUtcTime(`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    setNotifPerm(Notification.permission);
    const poll = setInterval(() => setNotifPerm(Notification.permission), 5_000);
    return () => clearInterval(poll);
  }, []);
  return (
    <footer className="status-bar">
      <div className="sb-left">
        <span className="hairline">Cursor</span>
        <span className="tab">{cursorInfo.time}</span>
        <span style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          {cursorInfo.i} <span style={{ color: 'var(--fg-4)' }}>/</span> {series.length}
        </span>
        {timeframe && (
          <span style={{
            marginLeft: 8,
            padding: '1px 6px',
            background: 'var(--bg-3)',
            border: '1px solid var(--line-2)',
            borderRadius: 2,
            fontSize: 9,
            color: 'var(--cyan)',
            letterSpacing: '0.08em',
          }}>
            {timeframe}
          </span>
        )}
      </div>
      <div className="sb-center">
        <span
          title="Net Variance — the GCP2 network coherence score. Higher values = more synchronized global attention. Updates every 60 seconds from the live HeartMath GCP2 API."
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'help' }}
        >
          <span className="hairline">Net Var</span>
          <span className="tab">{cursorInfo.v}</span>
          <span style={{
            fontSize: 9, color: 'var(--green)', letterSpacing: '0.08em',
          }}>↻</span>
        </span>
        <span className="sep" />
        <span className="hairline">Regime</span>
        <span className="tab" style={{ color: `var(--r-${cursorInfo.r.toLowerCase()})` }}>{cursorInfo.r}</span>
        <span className="sep" />
        <span className="hairline">{symbol}</span>
        <span className="tab">{cursorInfo.g}</span>
      </div>
      <div className="sb-right" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {notifPerm === 'granted' && (
          <span
            title="PSS Alerts enabled — browser notifications will fire on high-PSS patterns"
            style={{ fontSize: 8, color: 'var(--green)', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}
          >
            ALERTS ON
          </span>
        )}
        {notifPerm === 'denied' && (
          <span
            title="Notifications blocked — enable them in your browser settings to receive PSS alerts"
            style={{ fontSize: 8, color: 'var(--red)', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}
          >
            ALERTS OFF
          </span>
        )}
        <div style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          <span style={{ color: 'var(--fg-4)', marginRight: 4 }}>UTC</span>
          <span className="tab" style={{ color: 'var(--fg-1)' }}>{utcTime}</span>
        </div>
        <div className="divider-v" style={{ height: 12 }} />
        <span className="hairline">Model</span>
        <span>{APP_MODEL}</span>
      </div>
    </footer>
  );
}

export function PageHeader({
  crumbs,
  right,
}: {
  crumbs: { label: string; back?: boolean }[];
  right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '7px 16px',
      borderBottom: '1px solid var(--line-1)',
      fontSize: 10, letterSpacing: '0.06em',
      color: 'var(--fg-3)',
      flexShrink: 0,
    }}>
      {crumbs.map((c, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center' }}>
          {i > 0 && <span style={{ color: 'var(--fg-4)', margin: '0 4px' }}>·</span>}
          <span style={{ color: c.back ? 'var(--fg-2)' : 'var(--fg-3)' }}>
            {c.back && '‹ '}{c.label}
          </span>
        </span>
      ))}
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  );
}

const Chrome = { Header, LeftRail, StatusBar };
export default Chrome;
