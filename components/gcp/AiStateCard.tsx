'use client';

// v11.15: Dashboard card that surfaces the AI state classification as
// the user's "environment read". Sits alongside NV / Regime / PSS but
// is conceptually different: those three describe individual signals,
// this one describes the regime the signals live in. The card is the
// primary interpretation layer — a user should be able to look at it
// once and know what the system thinks the market is doing.
//
// Loading: "Analyzing…" state shown only on first call, before any
// classification has succeeded. Errors carry forward the prior state
// upstream (useStableAiState + useGcpState), so this card never blanks
// once a real classification has been received.

import { memo, useState } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import {
  directionArrow, stateColor, DEFAULT_INTERPRETATION,
} from '@/lib/aiState';
import AiStateExplainer from './AiStateExplainer';

interface Props {
  state:   GcpStateResponse | null;
  enabled: boolean;
  flash?:  boolean;
}

function Card({ state, enabled, flash = false }: Props) {
  const [showInvalidators, setShowInvalidators] = useState(false);
  const [showExplainer,    setShowExplainer]    = useState(false);

  const flashStyle: React.CSSProperties = flash ? {
    outline: '1px solid var(--cyan)',
    transition: 'outline 0.3s ease',
  } : {
    outline: '1px solid transparent',
    transition: 'outline 0.3s ease',
  };

  if (!enabled) {
    return (
      <div style={{
        background: 'var(--bg-1)', padding: 16,
        borderRight: '1px solid var(--line-0)',
        ...flashStyle,
      }}>
        <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)', marginBottom: 8 }}>
          AI STATE · GCP + GOLD ENVIRONMENT
        </div>
        <div style={{ fontSize: 14, color: 'var(--fg-4)' }}>Disabled</div>
        <div style={{ fontSize: 9, color: 'var(--fg-4)', marginTop: 4 }}>
          Enable in Settings → aiState
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div style={{
        background: 'var(--bg-1)', padding: 16,
        borderRight: '1px solid var(--line-0)',
        ...flashStyle,
      }}>
        <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)', marginBottom: 8 }}>
          AI STATE · GCP + GOLD ENVIRONMENT
        </div>
        <div style={{
          fontSize: 22, color: 'var(--fg-3)',
          letterSpacing: '0.02em',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: 'var(--fg-3)',
            animation: 'livepulse 1.6s ease-in-out infinite',
          }} />
          Analyzing…
        </div>
        <div style={{ fontSize: 9, color: 'var(--fg-4)', marginTop: 6 }}>
          Waiting for first Engine classification
        </div>
      </div>
    );
  }

  const accent = stateColor(state);
  const arrow  = directionArrow(state.direction);
  const conf   = Math.round(state.confidence * 100);
  const interpretation =
    state.reasoningShort?.trim() ||
    state.goldInterpretation?.trim() ||
    DEFAULT_INTERPRETATION[state.stateCode] ||
    '—';

  const hasInvalidators = state.invalidators && state.invalidators.length > 0;

  return (
    <div style={{
      background: 'var(--bg-1)', padding: 16,
      borderRight: '1px solid var(--line-0)',
      borderLeft: `2px solid ${accent}`,
      ...flashStyle,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8, gap: 8,
      }}>
        <div style={{
          fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>AI STATE · GCP + GOLD ENVIRONMENT</span>
          <button
            onClick={() => setShowExplainer(true)}
            title="What does this mean?"
            style={{
              background: 'transparent', border: '1px solid var(--line-2)',
              borderRadius: '50%',
              width: 14, height: 14, padding: 0,
              fontSize: 9, color: 'var(--fg-2)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'inherit', letterSpacing: 0,
            }}
          >ⓘ</button>
        </div>
        <div style={{
          fontSize: 8, letterSpacing: '0.08em',
          color: accent, fontFamily: 'var(--font-mono)',
        }}>
          {state.coherenceType.toUpperCase()}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        lineHeight: 1.05,
      }}>
        <span style={{
          fontSize: 22, color: accent, fontWeight: 600,
          letterSpacing: '-0.01em',
        }}>
          {state.state.toUpperCase()}
        </span>
        <span style={{
          fontSize: 18, color: accent, fontWeight: 600,
        }}>
          {arrow}
        </span>
      </div>

      <div style={{
        display: 'flex', gap: 14, marginTop: 8,
        fontSize: 9, color: 'var(--fg-3)',
        fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
      }}>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>PHASE </span>
          <span style={{ color: 'var(--fg-1)' }}>{state.phase}</span>
        </span>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>BIAS </span>
          <span style={{ color: 'var(--fg-1)' }}>{state.direction}</span>
        </span>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>CONF </span>
          <span style={{ color: 'var(--fg-1)' }}>{conf}%</span>
        </span>
      </div>

      <div style={{
        fontSize: 10, color: 'var(--fg-2)', lineHeight: 1.5,
        marginTop: 10,
      }}>
        {interpretation}
      </div>

      {hasInvalidators && (
        <>
          <button
            onClick={() => setShowInvalidators(s => !s)}
            style={{
              marginTop: 8, padding: 0,
              background: 'transparent', border: 'none',
              color: 'var(--fg-4)', cursor: 'pointer',
              fontSize: 8, letterSpacing: '0.1em',
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
            }}
          >
            {showInvalidators ? '▾ Hide invalidators' : '▸ Show invalidators'}
          </button>
          {showInvalidators && (
            <ul style={{
              margin: '6px 0 0', padding: '0 0 0 14px',
              fontSize: 9, color: 'var(--fg-3)', lineHeight: 1.6,
            }}>
              {state.invalidators.map((inv, i) => (
                <li key={i}>{inv}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <AiStateExplainer
        open={showExplainer}
        state={state}
        onClose={() => setShowExplainer(false)}
      />
    </div>
  );
}

export default memo(Card);
