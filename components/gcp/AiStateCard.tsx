'use client';

// v11.16: Dashboard primary-focus block. The AI state is the user's
// "environment read" — the single thing they should be able to glance
// at and understand. Card now shows just:
//   - title + ⓘ button (opens AiStateExplainer)
//   - large state name + direction arrow
//   - phase / bias / confidence row
//   - one-line interpretation (DEFAULT_INTERPRETATION fallback when
//     the Engine returns long-form copy — long copy belongs in the
//     explainer modal, not on the dashboard).
//
// Invalidators, watchNext, and the Engine's reasoningShort all live in
// the explainer now. Dashboard = decision surface, modal = explanation
// surface.

import { memo, useState } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import {
  directionArrow, stateColor, DEFAULT_INTERPRETATION,
} from '@/lib/aiState';
import AiStateExplainer from './AiStateExplainer';
import Heartbeat from './Heartbeat';

interface Props {
  state:   GcpStateResponse | null;
  enabled: boolean;
  flash?:  boolean;
}

// One-liner picker: prefer the Engine's reasoningShort only if it
// fits (<= 90 chars). Anything longer is collapsed to the default
// per-state copy so the dashboard never grows a paragraph.
function pickOneLiner(state: GcpStateResponse): string {
  const candidates = [state.reasoningShort, state.goldInterpretation];
  for (const raw of candidates) {
    const t = raw?.trim();
    if (t && t.length <= 90) return t;
  }
  return DEFAULT_INTERPRETATION[state.stateCode] || '—';
}

function Card({ state, enabled, flash = false }: Props) {
  const [showExplainer, setShowExplainer] = useState(false);

  const flashStyle: React.CSSProperties = flash ? {
    outline: '1px solid var(--cyan)',
    transition: 'outline 0.3s ease',
  } : {
    outline: '1px solid transparent',
    transition: 'outline 0.3s ease',
  };

  const InfoButton = (
    <button
      onClick={() => setShowExplainer(true)}
      title="What does this mean?"
      style={{
        background: 'transparent', border: '1px solid var(--line-2)',
        borderRadius: '50%',
        width: 16, height: 16, padding: 0,
        fontSize: 10, color: 'var(--fg-2)', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'inherit', letterSpacing: 0,
      }}
    >ⓘ</button>
  );

  if (!enabled) {
    return (
      <div style={{
        background: 'var(--bg-1)', padding: 18,
        height: '100%', display: 'flex', flexDirection: 'column',
        ...flashStyle,
      }}>
        <div style={{ fontSize: 9, letterSpacing: '0.14em', color: 'var(--fg-4)', marginBottom: 10 }}>
          AI STATE · GCP + GOLD ENVIRONMENT
        </div>
        <div style={{ fontSize: 16, color: 'var(--fg-4)' }}>Disabled</div>
        <div style={{ fontSize: 10, color: 'var(--fg-4)', marginTop: 4 }}>
          Enable in Settings → aiState
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div style={{
        background: 'var(--bg-1)', padding: 18,
        height: '100%', display: 'flex', flexDirection: 'column',
        ...flashStyle,
      }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.14em', color: 'var(--fg-4)',
          marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>AI STATE · GCP + GOLD ENVIRONMENT</span>
          {InfoButton}
        </div>
        <div style={{
          fontSize: 26, color: 'var(--fg-3)',
          letterSpacing: '0.02em', fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Heartbeat mode="init" size={9} />
          Analyzing…
        </div>
        <div style={{ fontSize: 10, color: 'var(--fg-4)', marginTop: 8 }}>
          Waiting for first Engine classification
        </div>
        <AiStateExplainer
          open={showExplainer}
          state={null}
          onClose={() => setShowExplainer(false)}
        />
      </div>
    );
  }

  const accent = stateColor(state);
  const arrow  = directionArrow(state.direction);
  const conf   = Math.round(state.confidence * 100);
  const oneLiner = pickOneLiner(state);

  return (
    <div style={{
      background: 'var(--bg-1)', padding: '18px 20px',
      borderLeft: `3px solid ${accent}`,
      height: '100%', display: 'flex', flexDirection: 'column',
      ...flashStyle,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12, gap: 8,
      }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.14em', color: 'var(--fg-4)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>AI STATE · GCP + GOLD ENVIRONMENT</span>
          {InfoButton}
        </div>
        <div style={{
          fontSize: 9, letterSpacing: '0.08em',
          color: accent, fontFamily: 'var(--font-mono)',
        }}>
          {state.coherenceType.toUpperCase()}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10,
        lineHeight: 1.0,
      }}>
        <span style={{
          fontSize: 32, color: accent, fontWeight: 600,
          letterSpacing: '-0.015em',
        }}>
          {state.state.toUpperCase()}
        </span>
        <span style={{
          fontSize: 26, color: accent, fontWeight: 600,
        }}>
          {arrow}
        </span>
      </div>

      <div style={{
        display: 'flex', gap: 18, marginTop: 12,
        fontSize: 10, color: 'var(--fg-3)',
        fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
      }}>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>PHASE </span>
          <span style={{ color: 'var(--fg-0)' }}>{state.phase}</span>
        </span>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>BIAS </span>
          <span style={{ color: 'var(--fg-0)' }}>{state.direction}</span>
        </span>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>CONF </span>
          <span style={{ color: 'var(--fg-0)' }}>{conf}%</span>
        </span>
      </div>

      <div style={{
        fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.5,
        marginTop: 14,
      }}>
        {oneLiner}
      </div>

      <AiStateExplainer
        open={showExplainer}
        state={state}
        onClose={() => setShowExplainer(false)}
      />
    </div>
  );
}

export default memo(Card);
