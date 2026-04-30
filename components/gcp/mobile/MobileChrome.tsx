'use client';

import * as React from 'react';
import { MiniLogo } from './MiniLogo';
import { C, regimeColor } from './colors';
import type { MarketSymbol } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import AiStateBadge from '../AiStateBadge';

export type MobilePage = 'dashboard' | 'chart' | 'pattern' | 'research' | 'settings';

export function MobileStatus({
  nv, regime, connected, aiState = null, aiEnabled = false,
}: {
  nv: number | null; regime: string | null; connected: boolean;
  aiState?:   GcpStateResponse | null;
  aiEnabled?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 14px', borderBottom: `1px solid ${C.line1}`, background: C.bg1,
      flexShrink: 0, gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <MiniLogo size={18} />
        <span style={{ fontSize: 9, letterSpacing: '0.18em', color: C.fg3 }}>GCP</span>
        <span style={{ fontSize: 9, letterSpacing: '0.18em', color: C.cyan, fontWeight: 600 }}>PRO</span>
      </div>
      {aiEnabled && (
        <div style={{
          flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center',
          overflow: 'hidden',
        }}>
          <AiStateBadge state={aiState} enabled={aiEnabled} compact />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 8, color: C.fg3, letterSpacing: '0.1em' }}>NV</span>
          <span style={{ fontSize: 11, color: C.fg0, fontVariantNumeric: 'tabular-nums' }}>
            {nv?.toFixed(1) ?? '—'}
          </span>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: connected ? C.green : C.red,
          }} />
        </div>
        {regime && (
          <div style={{
            padding: '2px 6px', borderRadius: 2, fontSize: 9, letterSpacing: '0.08em',
            background: `${regimeColor(regime)}22`,
            color: regimeColor(regime),
            border: `1px solid ${regimeColor(regime)}44`,
          }}>
            {regime}
          </div>
        )}
      </div>
    </div>
  );
}

export function SymbolBar({
  symbol, price, onSymbolPress,
}: {
  symbol: MarketSymbol; price: number | null; onSymbolPress?: () => void;
}) {
  const labels: Record<MarketSymbol, [string, string]> = {
    XAUUSD: ['XAUUSD', 'GOLD · SPOT'],
    BTC:    ['BTC',    'BITCOIN'],
    XAGUSD: ['XAGUSD', 'SILVER · SPOT'],
  };
  const [sym, sub] = labels[symbol];
  const formatPrice = (p: number) =>
    symbol === 'BTC' ? `$${Math.round(p).toLocaleString()}`
    : symbol === 'XAGUSD' ? `$${p.toFixed(3)}`
    : `$${p.toFixed(2)}`;

  return (
    <div
      onClick={onSymbolPress}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: `1px solid ${C.line1}`, background: C.bg,
        flexShrink: 0,
        cursor: onSymbolPress ? 'pointer' : 'default',
      }}
    >
      <div>
        <div style={{ fontSize: 13, color: C.fg0, fontWeight: 600, letterSpacing: '0.04em' }}>{sym}</div>
        <div style={{ fontSize: 8, color: C.fg3, letterSpacing: '0.12em', marginTop: 1 }}>{sub}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 14, color: C.fg0, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
          {price != null ? formatPrice(price) : '—'}
        </div>
      </div>
    </div>
  );
}

export function BottomNav({
  active, onNav,
}: {
  active: MobilePage; onNav: (p: MobilePage) => void;
}) {
  const ChartIcon = () => (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <path d="M2 14 L6 10 L9 12 L14 5 L16 7" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
  const PatternIcon = () => (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <path d="M2 14 L5 14 L5 10 L8 10 L8 6 L11 6 L11 3 L16 3" stroke="currentColor" strokeWidth={1.3} />
      <circle cx={5} cy={14} r={1.4} fill="currentColor" />
      <circle cx={11} cy={6} r={1.4} fill="currentColor" />
    </svg>
  );
  const ResearchIcon = () => (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <circle cx={7} cy={7} r={5} stroke="currentColor" strokeWidth={1.3} />
      <path d="M11 11 L15 15" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
  const SettingsIcon = () => (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <circle cx={9} cy={9} r={2.4} stroke="currentColor" strokeWidth={1.2} />
      <path d="M9 1V3 M9 15V17 M1 9H3 M15 9H17" stroke="currentColor" strokeWidth={1.1} />
    </svg>
  );

  const side = (id: MobilePage, label: string, Icon: () => React.ReactElement) => {
    const isActive = active === id;
    return (
      <button key={id} onClick={() => onNav(id)} style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
        background: 'transparent', border: 'none', padding: '4px 2px', cursor: 'pointer',
        color: isActive ? C.cyan : C.fg0,
        fontFamily: 'inherit', fontSize: 8.5, letterSpacing: '0.12em', fontWeight: 600,
      }}>
        <div style={{
          width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 7,
          background: isActive ? `${C.cyan}1f` : 'transparent',
          border: isActive ? `1px solid ${C.cyan}66` : '1px solid transparent',
          color: isActive ? C.cyan : C.fg0,
        }}>
          <Icon />
        </div>
        <span>{label}</span>
      </button>
    );
  };

  return (
    <div style={{
      height: 78, display: 'flex', alignItems: 'flex-start', paddingTop: 10,
      background: C.bg1,
      borderTop: `1px solid ${C.cyan}33`,
      flexShrink: 0,
    }}>
      {side('chart', 'CHART', ChartIcon)}
      {side('pattern', 'PATTERNS', PatternIcon)}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, marginTop: -26 }}>
        <button onClick={() => onNav('dashboard')} style={{
          width: 56, height: 56, borderRadius: '50%',
          background: C.bg2,
          border: `1.5px solid ${C.cyan}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 0 4px ${C.bg1}, 0 0 18px ${C.cyan}66`,
          cursor: 'pointer', padding: 0,
        }}>
          <MiniLogo size={26} />
        </button>
        <span style={{
          fontFamily: 'inherit', fontSize: 9, letterSpacing: '0.16em',
          color: active === 'dashboard' ? C.cyan : C.fg1, fontWeight: 600,
        }}>FEED</span>
      </div>

      {side('research', 'RESEARCH', ResearchIcon)}
      {side('settings', 'SETTINGS', SettingsIcon)}
    </div>
  );
}
