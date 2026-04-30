'use client';

// v11.15: header pill that surfaces the AI state classification next to
// the symbol / NV summary. Always rendered when the feature is enabled
// so the user has a single-glance read on the environment. Falls back
// to "Analyzing..." before the first successful classification arrives.
//
// Compact form (header / mobile status bar) shows just the state name,
// phase, and direction arrow. The card view (AiStateCard) carries the
// fuller breakdown.

import { memo } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import { directionArrow, stateColor } from '@/lib/aiState';

interface Props {
  state:    GcpStateResponse | null;
  enabled:  boolean;
  compact?: boolean;
}

function Badge({ state, enabled, compact = false }: Props) {
  if (!enabled) return null;

  const fontSize = compact ? 9   : 10;
  const padV     = compact ? 2   : 3;
  const padH     = compact ? 6   : 9;
  const gap      = compact ? 4   : 5;

  if (!state) {
    return (
      <div
        title="Waiting for first AI state classification from the Engine"
        style={{
          display: 'inline-flex', alignItems: 'center', gap,
          padding: `${padV}px ${padH}px`,
          fontSize, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em',
          color: 'var(--fg-3)',
          background: 'var(--bg-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 3,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: 'var(--fg-3)',
          animation: 'livepulse 1.6s ease-in-out infinite',
        }} />
        <span>Analyzing…</span>
      </div>
    );
  }

  const accent = stateColor(state);
  const arrow  = directionArrow(state.direction);
  const upper  = state.state.toUpperCase();
  const phase  = state.phase.toUpperCase();

  return (
    <div
      title={`${state.state} · ${state.direction} · ${state.phase} · ${(state.confidence * 100).toFixed(0)}% confidence`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap,
        padding: `${padV}px ${padH}px`,
        fontSize, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.06em',
        color: accent,
        background: `${accent}14`,
        border: `1px solid ${accent}55`,
        borderRadius: 3,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontWeight: 600 }}>{upper}</span>
      <span style={{ opacity: 0.75 }}>({phase})</span>
      <span style={{ fontWeight: 600 }}>{arrow}</span>
    </div>
  );
}

export default memo(Badge);
