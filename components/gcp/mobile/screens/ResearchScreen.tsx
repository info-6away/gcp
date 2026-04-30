'use client';

import { useMemo } from 'react';
import { C, regimeColor } from '../colors';
import { MobileStatus } from '../MobileChrome';
import type { DataPoint } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';

const REGIME_NAMES: Record<string, string> = {
  A: 'Silence', B: 'Ignition', C: 'Alignment',
  D: 'Synchronization', E: 'Climax', F: 'Shock',
};

const REGIME_RANGE: Record<string, string> = {
  A: '0–50', B: '50–100', C: '100–140',
  D: '140–170', E: '170–220', F: '220+',
};

function regimeFor(v: number): string {
  if (v < 50)  return 'A';
  if (v < 100) return 'B';
  if (v < 140) return 'C';
  if (v < 170) return 'D';
  if (v < 220) return 'E';
  return 'F';
}

export function ResearchScreen({
  series, liveNV, liveRegime, connected, aiState, aiEnabled,
}: {
  series: DataPoint[]; liveNV: number | null;
  liveRegime: string | null; connected: boolean;
  aiState:   GcpStateResponse | null;
  aiEnabled: boolean;
}) {
  const stats = useMemo(() => {
    const map: Record<string, number[]> = { A: [], B: [], C: [], D: [], E: [], F: [] };
    series.forEach(p => {
      const r = p.r ?? regimeFor(p.v);
      map[r]?.push(p.v);
    });
    return map;
  }, [series]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus nv={liveNV} regime={liveRegime} connected={connected}
        aiState={aiState} aiEnabled={aiEnabled} />

      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.line1}`, background: C.bg, flexShrink: 0 }}>
        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3 }}>RESEARCH</div>
        <div style={{ fontSize: 18, color: C.fg0, fontWeight: 600, marginTop: 2 }}>REGIME OVERVIEW</div>
        <div style={{ fontSize: 9, color: C.fg2, marginTop: 4 }}>
          Distribution across {series.length.toLocaleString()} data points · Jan–Apr 2026
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        <div style={{ fontSize: 8, color: C.fg3, letterSpacing: '0.1em', marginBottom: 10 }}>
          For full scatter plot analysis, open on desktop.
        </div>
        {Object.entries(REGIME_NAMES).map(([r, name]) => {
          const pts = stats[r] ?? [];
          const pct = series.length ? (pts.length / series.length * 100) : 0;
          const col = regimeColor(r);
          const isActive = r === liveRegime;
          return (
            <div key={r} style={{
              background: isActive ? `${col}11` : C.bg1,
              border: `1px solid ${isActive ? col + '44' : C.line1}`,
              borderRadius: 3, padding: '12px', marginBottom: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 22, color: col, fontWeight: 600, lineHeight: 1 }}>{r}</span>
                  <span style={{ fontSize: 11, color: C.fg1, letterSpacing: '0.06em' }}>{name}</span>
                  {isActive && <span style={{ fontSize: 8, color: col, letterSpacing: '0.1em' }}>● NOW</span>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 18, color: col, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                    {pct.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 8, color: C.fg3, letterSpacing: '0.1em', marginTop: 3 }}>
                    of time
                  </div>
                </div>
              </div>
              <div style={{ height: 6, background: C.bg3, borderRadius: 1, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(pct * 2, 100)}%`, height: '100%', background: col }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: C.fg3, marginTop: 4 }}>
                <span>{pts.length.toLocaleString()} bars</span>
                <span>{REGIME_RANGE[r]} NV</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
