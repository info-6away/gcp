'use client';

// v11.15: header pill that surfaces the AI state classification next to
// the symbol / NV summary. Always rendered when the feature is enabled
// so the user has a single-glance read on the environment.
//
// v11.23.2: badge is now driven by an explicit aiStatus state machine
// instead of inferring "Analyzing…" from a null state. Manual mode
// rests in 'idle' until the user clicks RUN AI ANALYSIS, so the badge
// no longer shows ghost analyzing text on first load.
//
// Compact form (header / mobile status bar) shows just the state name,
// phase, and direction arrow. The card view (AiStateCard) carries the
// fuller breakdown.

import { memo, useState } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import { directionArrow, stateColor } from '@/lib/aiState';
import AiStateExplainer from './AiStateExplainer';

interface Props {
  state:    GcpStateResponse | null;
  enabled:  boolean;
  // v11.23.2: optional for backward compat — defaults to 'idle' so a
  // missing prop never accidentally shows "Analyzing…".
  aiStatus?: AiStatus;
  compact?: boolean;
}

function Badge({ state, enabled, aiStatus = 'idle', compact = false }: Props) {
  const [open, setOpen] = useState(false);
  if (!enabled) return null;

  const fontSize = compact ? 9   : 10;
  const padV     = compact ? 2   : 3;
  const padH     = compact ? 6   : 9;
  const gap      = compact ? 4   : 5;

  // No classification yet → render an idle / running / error pill driven
  // by aiStatus. Only 'running' shows the pulsing "Analyzing…" copy.
  if (!state) {
    const isRunning = aiStatus === 'running';
    const isError   = aiStatus === 'error';
    const label     = isRunning ? 'Analyzing…'
                    : isError   ? 'AI failed — retry'
                    : 'AI not run';
    const tone      = isRunning ? 'var(--cyan)'
                    : isError   ? 'var(--red)'
                    : 'var(--fg-3)';
    const dotAnim   = isRunning
      ? 'animation: livepulse 1.6s ease-in-out infinite;'
      : '';
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          title="What does this mean?"
          style={{
            display: 'inline-flex', alignItems: 'center', gap,
            padding: `${padV}px ${padH}px`,
            fontSize, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em',
            color: tone,
            background: 'var(--bg-2)',
            border: `1px solid ${isError ? 'var(--red)' : 'var(--line-2)'}`,
            borderRadius: 3,
            whiteSpace: 'nowrap', cursor: 'pointer',
          }}
        >
          <span
            style={{
              width: 5, height: 5, borderRadius: '50%',
              background: tone,
              ...(isRunning ? { animation: 'livepulse 1.6s ease-in-out infinite' } : {}),
            }}
          />
          <span>{label}</span>
          <span style={{
            marginLeft: 2, opacity: 0.6, fontSize: fontSize - 1, fontWeight: 600,
          }}>ⓘ</span>
        </button>
        <AiStateExplainer open={open} state={state} onClose={() => setOpen(false)} />
      </>
    );
  }

  const accent = stateColor(state);
  const arrow  = directionArrow(state.direction);
  const upper  = state.state.toUpperCase();
  const phase  = state.phase.toUpperCase();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`${state.state} · ${state.direction} · ${state.phase} · ${(state.confidence * 100).toFixed(0)}% confidence — click for definitions`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap,
          padding: `${padV}px ${padH}px`,
          fontSize, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em',
          color: accent,
          background: `${accent}14`,
          border: `1px solid ${accent}55`,
          borderRadius: 3,
          whiteSpace: 'nowrap', cursor: 'pointer',
        }}
      >
        <span style={{ fontWeight: 600 }}>{upper}</span>
        <span style={{ opacity: 0.75 }}>({phase})</span>
        <span style={{ fontWeight: 600 }}>{arrow}</span>
        <span style={{
          marginLeft: 2, opacity: 0.7, fontSize: fontSize - 1, fontWeight: 600,
        }}>ⓘ</span>
      </button>
      <AiStateExplainer open={open} state={state} onClose={() => setOpen(false)} />
    </>
  );
}

export default memo(Badge);
