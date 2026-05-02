'use client';

// v11.15.4: a small modal/popover that demystifies the AI State output.
// The card and badge each render a button that opens this — purpose is
// to make the GCP-event-vs-environment distinction obvious so users
// don't conflate "Compression" (a GCP-only pattern event) with
// "Down / Late" (the AI-interpreted environment built from GCP +
// gold). Mounted as a fixed overlay so it works on both desktop and
// mobile without layout work in either parent.

import { useEffect } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import { directionArrow, stateColor } from '@/lib/aiState';
import type { MarketSymbol } from '@/types/gcp';
import { symbolEnvLabel } from '@/types/gcp';

interface Props {
  open:    boolean;
  state:   GcpStateResponse | null;
  onClose: () => void;
  // v11.23.3: explainer copy adapts to the active symbol so BTC users
  // don't see "gold response" definitions on a Bitcoin chart.
  symbol?: MarketSymbol;
}

function directionDefs(envLabel: string): { key: string; def: string }[] {
  const lower = envLabel.toLowerCase();
  return [
    { key: 'Up',      def: `Environment favors upward ${lower} response` },
    { key: 'Down',    def: `Environment favors downward ${lower} response` },
    { key: 'Neutral', def: 'No directional edge' },
    { key: 'Mixed',   def: 'Conflicting signals' },
  ];
}

const PHASE_DEF: { key: string; def: string }[] = [
  { key: 'Early',     def: 'Move may be forming' },
  { key: 'Mid',       def: 'Move is active' },
  { key: 'Late',      def: 'Move may be mature / weaker edge' },
  { key: 'Exhausted', def: 'Risk of reversal or discharge' },
];

function stateDefs(envLabel: string): { key: string; def: string }[] {
  const lower = envLabel.toLowerCase();
  return [
    { key: 'Compression',           def: 'GCP energy is building' },
    { key: 'Alignment Trend',       def: `GCP and ${lower} are moving together` },
    { key: 'Failed Alignment',      def: `GCP rises but ${lower} does not confirm` },
    { key: 'Dead Drift / Noise',    def: 'No meaningful environment' },
    { key: 'Discharge',             def: 'Energy release / exhaustion risk' },
    { key: 'Shock Synchronization', def: 'Extreme coherence event' },
  ];
}

export default function AiStateExplainer({ open, state, onClose, symbol = 'XAUUSD' }: Props) {
  const envLabel = symbolEnvLabel(symbol);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const accent = state ? stateColor(state) : 'var(--cyan)';
  const arrow  = state ? directionArrow(state.direction) : '';
  const conf   = state ? Math.round(state.confidence * 100) : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        fontFamily: 'var(--font-mono)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 560, width: '100%',
          maxHeight: '85vh', overflowY: 'auto',
          background: 'var(--bg-1)',
          border: '1px solid var(--line-2)',
          borderRadius: 6,
          padding: '20px 22px',
          color: 'var(--fg-1)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 14, gap: 10,
        }}>
          <div style={{ fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-3)' }}>
            AI STATE · GCP + {envLabel} ENVIRONMENT
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: '1px solid var(--line-2)',
              color: 'var(--fg-2)', borderRadius: 3,
              padding: '2px 8px', fontSize: 10, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >ESC</button>
        </div>

        {state ? (
          <div style={{ marginBottom: 18 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 8,
            }}>
              <span style={{
                fontSize: 22, color: accent, fontWeight: 600,
                letterSpacing: '-0.01em',
              }}>
                {state.state.toUpperCase()}
              </span>
              <span style={{ fontSize: 18, color: accent, fontWeight: 600 }}>{arrow}</span>
            </div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6,
              fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.05em',
            }}>
              <span><span style={{ color: 'var(--fg-4)' }}>STATE </span><span style={{ color: 'var(--fg-1)' }}>{state.stateCode}</span></span>
              <span><span style={{ color: 'var(--fg-4)' }}>DIR </span><span style={{ color: 'var(--fg-1)' }}>{state.direction}</span></span>
              <span><span style={{ color: 'var(--fg-4)' }}>PHASE </span><span style={{ color: 'var(--fg-1)' }}>{state.phase}</span></span>
              <span><span style={{ color: 'var(--fg-4)' }}>BIAS </span><span style={{ color: 'var(--fg-1)' }}>{state.marketBias || '—'}</span></span>
              <span><span style={{ color: 'var(--fg-4)' }}>CONF </span><span style={{ color: 'var(--fg-1)' }}>{conf}%</span></span>
            </div>
          </div>
        ) : (
          <div style={{
            marginBottom: 18, fontSize: 11, color: 'var(--fg-3)',
            fontStyle: 'italic',
          }}>
            Waiting for first Engine classification.
          </div>
        )}

        <div style={{
          fontSize: 12, color: 'var(--fg-1)', lineHeight: 1.55,
          marginBottom: 18,
        }}>
          AI State explains the current environment by comparing GCP coherence
          with gold behavior.
          <br /><br />
          <span style={{ color: 'var(--fg-2)' }}>Pattern Detection finds GCP events.</span><br />
          <span style={{ color: 'var(--fg-2)' }}>AI State interprets whether gold is confirming, rejecting, or ignoring the coherence signal.</span>
        </div>

        {state && (state.reasoningShort?.trim() || state.goldInterpretation?.trim()) && (
          <Detail title="ENGINE REASONING">
            {state.reasoningShort?.trim() && (
              <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.55 }}>
                {state.reasoningShort.trim()}
              </p>
            )}
            {state.goldInterpretation?.trim() && (
              <p style={{ margin: 0, fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.55 }}>
                {state.goldInterpretation.trim()}
              </p>
            )}
          </Detail>
        )}

        {state && state.invalidators && state.invalidators.length > 0 && (
          <Detail title="INVALIDATORS">
            <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.6 }}>
              {state.invalidators.map((inv, i) => <li key={i}>{inv}</li>)}
            </ul>
          </Detail>
        )}

        {state && state.watchNext && state.watchNext.length > 0 && (
          <Detail title="WATCH NEXT">
            <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.6 }}>
              {state.watchNext.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </Detail>
        )}

        <Glossary title="DIRECTION" items={directionDefs(envLabel)} />
        <Glossary title="PHASE"     items={PHASE_DEF} />
        <Glossary title="STATE EXAMPLES" items={stateDefs(envLabel)} />
      </div>
    </div>
  );
}

function Detail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 8, letterSpacing: '0.18em', color: 'var(--fg-4)',
        marginBottom: 6, paddingBottom: 4,
        borderBottom: '1px solid var(--line-1)',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Glossary({ title, items }: {
  title: string;
  items: { key: string; def: string }[];
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 8, letterSpacing: '0.18em', color: 'var(--fg-4)',
        marginBottom: 6, paddingBottom: 4,
        borderBottom: '1px solid var(--line-1)',
      }}>
        {title}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4 }}>
        {items.map(it => (
          <div key={it.key} style={{ display: 'contents' }}>
            <span style={{ fontSize: 11, color: 'var(--fg-1)', fontWeight: 600 }}>{it.key}</span>
            <span style={{ fontSize: 10, color: 'var(--fg-3)', lineHeight: 1.5 }}>{it.def}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
