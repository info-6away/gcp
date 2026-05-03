'use client';

import { C } from '../colors';
import { MobileStatus } from '../MobileChrome';
import type { Pattern } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';

const PATTERN_COLORS: Record<string, string> = {
  'Alignment Ladder':         '#4dd9e8',
  'Compression Coil':         '#aeb4bf',
  'Compression Release':      '#22c55e',
  'Failed Alignment':         '#d946ef',
  'Coherence Volcano':        '#f59e0b',
  'Ignition Drift':           '#888780',
  'Shock Jump':               '#e24b4a',
  'Ignition Rise':            '#4dd9e8',
  'Pulse Train':              '#5b8cc0',
  'Staircase Alignment':      '#16a34a',
  'Dead Drift':               '#3a3f47',
  'Echo Spike':               '#fb923c',
  'Discharge Break':          '#dc2626',
  'Discharge Wave':           '#ea580c',
  'Double Spike Exhaustion':  '#9333ea',
  'Synchronization Plateau':  '#15803d',
  'Plateau Decay':            '#9ca3af',
};

const KINDS = [
  'Alignment Ladder',         'Synchronization Plateau',
  'Compression Release',      'Compression Coil',
  'Ignition Rise',            'Staircase Alignment',
  'Failed Alignment',         'Coherence Volcano',
  'Echo Spike',               'Discharge Wave',
  'Discharge Break',          'Plateau Decay',
  'Double Spike Exhaustion',  'Ignition Drift',
  'Pulse Train',              'Dead Drift',
  'Shock Jump',
];

const pssOf = (p: Pattern) => Math.round(p.strength * 100);

export function PatternsScreen({
  patterns, liveNV, liveRegime, connected, aiState, aiEnabled, aiStatus,
}: {
  patterns: Pattern[]; liveNV: number | null;
  liveRegime: string | null; connected: boolean;
  aiState:   GcpStateResponse | null;
  aiEnabled: boolean;
  aiStatus:  AiStatus;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus nv={liveNV} regime={liveRegime} connected={connected}
        aiState={aiState} aiEnabled={aiEnabled} aiStatus={aiStatus} />

      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.line1}`, background: C.bg, flexShrink: 0 }}>
        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3 }}>PATTERN LIBRARY</div>
        <div style={{ fontSize: 9, color: C.fg2, marginTop: 4 }}>
          {patterns.length} detections in current window
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {KINDS.map(kind => {
            const matches = patterns.filter(p => p.kind === kind);
            const count   = matches.length;
            const avgPss  = count ? Math.round(matches.reduce((s, p) => s + pssOf(p), 0) / count) : 0;
            const color   = PATTERN_COLORS[kind] ?? C.fg1;
            return (
              <div key={kind} style={{
                background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3,
                padding: '10px 10px 12px', opacity: count === 0 ? 0.35 : 1,
              }}>
                <div style={{ fontSize: 11, color, fontWeight: 600, lineHeight: 1.2,
                  letterSpacing: '0.02em', minHeight: 28 }}>{kind}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 8 }}>
                  <span style={{ fontSize: 22, color: C.fg0, fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{count}</span>
                  <span style={{ fontSize: 8, color: C.fg3, letterSpacing: '0.1em' }}>
                    {count === 1 ? 'DETECT' : 'DETECTS'}
                  </span>
                </div>
                {count > 0 && (
                  <>
                    <div style={{ fontSize: 8, color: C.fg3, letterSpacing: '0.1em', marginTop: 8 }}>
                      PSS AVG {avgPss}
                    </div>
                    <div style={{ height: 3, background: C.bg3, borderRadius: 1, marginTop: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${avgPss}%`, height: '100%', background: color }} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
