'use client';

// v11.35: mobile drawer. Top-right menu button (in MobileStatus)
// opens this; it hosts the items removed from the 5-slot bottom nav
// (Patterns, Settings) plus context controls (symbol, TF, check
// for updates, about).
//
// Pure presentational: parent owns the open/close state and the nav
// callback. Tapping any nav row closes the drawer via onClose().

import { useEffect, useState } from 'react';
import { C } from './colors';
import type { MobilePage } from './MobileChrome';
import type { MarketSymbol, Timeframe } from '@/types/gcp';
import { SYMBOLS, TIMEFRAME_LABELS, getSymbolMeta } from '@/types/gcp';
import { APP_VERSION } from '@/lib/version';
import { checkForUpdate, type UpdateCheckResult } from '@/lib/pwaUpdate';

interface DrawerProps {
  open:        boolean;
  onClose:     () => void;
  onNav:       (page: MobilePage) => void;
  symbol:      MarketSymbol;
  setSymbol:   (s: MarketSymbol) => void;
  timeframe:   Timeframe;
  setTimeframe: (tf: Timeframe) => void;
}

export function MobileDrawer({
  open, onClose, onNav, symbol, setSymbol, timeframe, setTimeframe,
}: DrawerProps) {
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | UpdateCheckResult>('idle');

  // Esc closes the drawer; block body scroll while open so the
  // background page doesn't move under the user's thumb.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const goto = (p: MobilePage) => { onNav(p); onClose(); };
  const handleUpdateCheck = async () => {
    setUpdateState('checking');
    const r = await checkForUpdate();
    setUpdateState(r);
    if (r === 'current' || r === 'unsupported') {
      setTimeout(() => setUpdateState('idle'), 2_500);
    }
  };
  const updateLabel =
    updateState === 'checking'    ? 'Checking…'
  : updateState === 'updated'     ? 'Update ready'
  : updateState === 'current'     ? 'Up to date'
  : updateState === 'unsupported' ? 'Unsupported'
  :                                  'Check for updates';

  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 999,
          background: 'rgba(0,0,0,0.55)',
        }}
      />
      {/* Panel — slides in from the right, full-height. */}
      <aside
        role="dialog"
        aria-label="Menu"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1000,
          width: 'min(86vw, 320px)',
          background: C.bg1,
          borderLeft: `1px solid ${C.line2}`,
          display: 'flex', flexDirection: 'column',
          fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
          boxShadow: '-2px 0 14px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          // v14.1: top safe-area inset — the drawer is a fixed
          // top:0 panel, so its own header must clear the notch.
          paddingTop: 'calc(14px + env(safe-area-inset-top))',
          paddingLeft: 16, paddingRight: 16, paddingBottom: 14,
          borderBottom: `1px solid ${C.line1}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{
            fontSize: 9, letterSpacing: '0.18em', color: C.fg3, fontWeight: 600,
          }}>MENU</span>
          <button
            onClick={onClose}
            aria-label="Close menu"
            style={{
              background: 'transparent', border: `1px solid ${C.line2}`,
              color: C.fg2, fontSize: 11,
              minWidth: 44, minHeight: 36, padding: '0 10px',
              borderRadius: 3, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >ESC</button>
        </div>

        {/* v14.1: bottom safe-area inset on the scroll list so the
            last menu row clears the home indicator. */}
        <div style={{
          flex: 1, overflowY: 'auto',
          padding: '8px 0',
          paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
        }}>
          {/* Pages moved out of the bottom nav. */}
          <Section title="Pages">
            <NavRow label="Patterns" onClick={() => goto('pattern')} />
            <NavRow label="Radar"    onClick={() => goto('radar')} />
            <NavRow label="Settings" onClick={() => goto('settings')} />
          </Section>

          {/* Symbol selector. */}
          <Section title="Symbol">
            {SYMBOLS.map(s => (
              <ToggleRow
                key={s.id}
                label={`${s.id} · ${s.label}`}
                active={s.id === symbol}
                onClick={() => { setSymbol(s.id); }}
                accent={getSymbolMeta(s.id).color}
              />
            ))}
          </Section>

          {/* Timeframe selector — applies to chart. */}
          <Section title="Timeframe">
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 6, padding: '6px 16px',
            }}>
              {TIMEFRAME_LABELS.map(tf => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  style={{
                    // v14.1: 44px min touch target (was ~30px tall).
                    minHeight: 44, padding: '8px 0',
                    fontSize: 11, letterSpacing: '0.08em',
                    fontFamily: 'inherit', fontWeight: 600,
                    background: tf === timeframe ? `${C.cyan}1f` : 'transparent',
                    border: `1px solid ${tf === timeframe ? C.cyan : C.line2}`,
                    color: tf === timeframe ? C.cyan : C.fg2,
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  {tf}
                </button>
              ))}
            </div>
          </Section>

          {/* PWA + version. */}
          <Section title="App">
            <NavRow
              label={updateLabel}
              onClick={handleUpdateCheck}
              accent={updateState === 'updated' ? C.cyan : undefined}
              disabled={updateState === 'checking'}
            />
            <div style={{
              padding: '10px 16px',
              fontSize: 10, color: C.fg3, lineHeight: 1.55,
            }}>
              <div style={{ color: C.fg4, letterSpacing: '0.14em', fontSize: 8, marginBottom: 4 }}>
                ABOUT
              </div>
              <div style={{ color: C.fg1, fontWeight: 600 }}>GCP Pro</div>
              <div style={{ color: C.fg3 }}>v{APP_VERSION}</div>
              <div style={{ color: C.fg4, fontSize: 9, marginTop: 4 }}>
                Coherence regime terminal.
              </div>
            </div>
          </Section>
        </div>
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{
        padding: '8px 16px 4px',
        fontSize: 8, letterSpacing: '0.18em', color: C.fg4,
        fontWeight: 600,
      }}>
        {title.toUpperCase()}
      </div>
      <div>{children}</div>
    </div>
  );
}

function NavRow({
  label, onClick, accent, disabled,
}: {
  label:    string;
  onClick:  () => void;
  accent?:  string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        padding: '10px 16px',
        background: 'transparent',
        border: 'none',
        color: accent ?? C.fg1,
        fontFamily: 'inherit',
        fontSize: 12,
        letterSpacing: '0.04em',
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}
    >
      <span>{label}</span>
      <span style={{ color: C.fg4, fontSize: 11 }}>›</span>
    </button>
  );
}

function ToggleRow({
  label, active, onClick, accent,
}: {
  label:   string;
  active:  boolean;
  onClick: () => void;
  accent?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        padding: '10px 16px',
        background: active ? `${accent ?? C.cyan}14` : 'transparent',
        border: 'none',
        borderLeft: active ? `2px solid ${accent ?? C.cyan}` : '2px solid transparent',
        color: active ? (accent ?? C.cyan) : C.fg1,
        fontFamily: 'inherit',
        fontSize: 12,
        letterSpacing: '0.04em',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}
    >
      <span>{label}</span>
      {active && <span style={{ color: accent ?? C.cyan, fontSize: 11 }}>✓</span>}
    </button>
  );
}
