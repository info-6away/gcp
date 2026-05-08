'use client';

import * as React from 'react';
import { MiniLogo } from './MiniLogo';
import { C, regimeColor } from './colors';
import type { MarketSymbol } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import AiStateBadge from '../AiStateBadge';
import Heartbeat from '../Heartbeat';
import { AI_ANALYSIS_TF } from '@/lib/aiTimeframe';

// v11.35: bottom-nav surfaces 5 pages (Dashboard / Chart / Guru / Research / Trade);
// Patterns and Settings still navigable but only via the top-right drawer.
export type MobilePage =
  | 'dashboard' | 'chart' | 'guru' | 'research' | 'trading'
  | 'pattern' | 'settings';
export const BOTTOM_NAV_PAGES: ReadonlySet<MobilePage> = new Set<MobilePage>([
  'dashboard', 'chart', 'guru', 'research', 'trading',
]);

export function MobileStatus({
  nv, regime, connected, aiState = null, aiEnabled = false, aiStatus = 'idle',
  symbol = 'XAUUSD',
}: {
  nv: number | null; regime: string | null; connected: boolean;
  aiState?:   GcpStateResponse | null;
  aiEnabled?: boolean;
  aiStatus?:  AiStatus;
  symbol?:    MarketSymbol;
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
          alignItems: 'center', gap: 5, overflow: 'hidden',
        }}>
          {/* v11.21: AI timeframe pill */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 5px',
            fontSize: 8, fontFamily: 'inherit',
            letterSpacing: '0.06em',
            background: `${C.cyan}10`,
            border: `1px solid ${C.cyan}30`,
            borderRadius: 2,
            whiteSpace: 'nowrap', flexShrink: 0,
          }}>
            <span style={{ color: C.fg3 }}>AI:</span>
            <span style={{ color: C.cyan }}>{AI_ANALYSIS_TF}</span>
          </span>
          <AiStateBadge state={aiState} enabled={aiEnabled} aiStatus={aiStatus} symbol={symbol} compact />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 8, color: C.fg3, letterSpacing: '0.1em' }}>NV</span>
          <span style={{ fontSize: 11, color: C.fg0, fontVariantNumeric: 'tabular-nums' }}>
            {nv?.toFixed(1) ?? '—'}
          </span>
          <Heartbeat
            mode={connected ? 'live' : nv != null ? 'stale' : 'init'}
            size={5}
            glow={false}
            title={connected ? 'GCP feed live' : 'GCP feed reconnecting'}
          />
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
  active, onNav, aiLastSuccess = null,
}: {
  active: MobilePage;
  onNav:  (p: MobilePage) => void;
  /**
   * v11.35: when the most recent Guru analysis is fresh (< 30s) we
   * pulse the center Guru hero so the user knows new context just
   * arrived without having to navigate.
   */
  aiLastSuccess?: Date | null;
}) {
  const DashboardIcon = () => (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <rect x={2} y={2}  width={6} height={7}  stroke="currentColor" strokeWidth={1.3} />
      <rect x={10} y={2} width={6} height={4}  stroke="currentColor" strokeWidth={1.3} />
      <rect x={2} y={11} width={6} height={5}  stroke="currentColor" strokeWidth={1.3} />
      <rect x={10} y={8} width={6} height={8}  stroke="currentColor" strokeWidth={1.3} />
    </svg>
  );
  const ChartIcon = () => (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <path d="M2 14 L6 10 L9 12 L14 5 L16 7" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
  const ResearchIcon = () => (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <circle cx={7} cy={7} r={5} stroke="currentColor" strokeWidth={1.3} />
      <path d="M11 11 L15 15" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
  const TradeIcon = () => (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <path d="M2 12 L6 8 L9 11 L16 4" stroke="currentColor" strokeWidth={1.4} />
      <path d="M12 4 L16 4 L16 8" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
  // Minimal monk silhouette — round head, robe shoulders. No emoji
  // so it reads professional even at small sizes.
  const GuruHeroIcon = ({ size = 28 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <circle cx={14} cy={9} r={4.2} stroke="currentColor" strokeWidth={1.4} />
      <path
        d="M5 22 C 6 16 10 14 14 14 C 18 14 22 16 23 22 Z"
        stroke="currentColor" strokeWidth={1.4}
        fill="rgba(77,217,232,0.08)"
      />
      <circle cx={14} cy={9} r={1.6} fill="currentColor" />
    </svg>
  );

  const isFresh = aiLastSuccess
    && (Date.now() - aiLastSuccess.getTime() < 30_000);

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

  const guruIsActive = active === 'guru';
  // v11.35: subtle freshness pulse on the Guru hero. Reuses the
  // global `livepulse` keyframe rather than introducing a new one.
  const guruRingShadow = guruIsActive
    ? `0 0 0 4px ${C.bg1}, 0 0 22px ${C.cyan}aa`
    : `0 0 0 4px ${C.bg1}, 0 0 18px ${C.cyan}55`;

  return (
    <div style={{
      height: 78, display: 'flex', alignItems: 'flex-start', paddingTop: 10,
      background: C.bg1,
      borderTop: `1px solid ${C.cyan}33`,
      flexShrink: 0,
    }}>
      {side('dashboard', 'DASHBOARD', DashboardIcon)}
      {side('chart',     'CHART',     ChartIcon)}

      {/* CENTER HERO — Guru. Larger circular pill, raised above the
          row, cyan ring + glow when active, freshness pulse when a
          fresh analysis exists in the last 30 s. */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
        marginTop: -26,
      }}>
        <button
          onClick={() => onNav('guru')}
          aria-label="Guru"
          style={{
            width: 56, height: 56, borderRadius: '50%',
            background: guruIsActive ? `${C.cyan}1f` : C.bg2,
            border: `1.5px solid ${guruIsActive ? C.cyan : `${C.cyan}99`}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: guruRingShadow,
            cursor: 'pointer', padding: 0,
            color: guruIsActive ? C.cyan : C.fg0,
            transition: 'background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
            position: 'relative',
          }}
        >
          <GuruHeroIcon size={28} />
          {isFresh && (
            <span style={{
              position: 'absolute', top: 4, right: 4,
              width: 8, height: 8, borderRadius: '50%',
              background: C.cyan,
              animation: 'livepulse 1.6s ease-in-out infinite',
            }} />
          )}
        </button>
        <span style={{
          fontFamily: 'inherit', fontSize: 9, letterSpacing: '0.16em',
          color: guruIsActive ? C.cyan : C.fg1, fontWeight: 600,
        }}>GURU</span>
      </div>

      {side('research', 'RESEARCH', ResearchIcon)}
      {side('trading',  'TRADE',    TradeIcon)}
    </div>
  );
}

// v11.35: top-right menu button. Lives in MobileStatus / page chrome
// and toggles the MobileDrawer. Pure presentational — parent owns the
// open/close state.
export function MobileMenuButton({
  onOpen,
}: {
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      aria-label="Open menu"
      style={{
        background: 'transparent',
        border: `1px solid ${C.line2}`,
        color: C.fg2,
        padding: '4px 6px',
        borderRadius: 4,
        cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
        <path d="M2 4 H14 M2 8 H14 M2 12 H14" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      </svg>
    </button>
  );
}
