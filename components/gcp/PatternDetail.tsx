'use client';

import { useMemo } from 'react';
import { INTERP } from '@/lib/gcp-data';
import type { DataPoint, Pattern } from '@/types/gcp';

interface PatternDetailProps {
  kind: string;
  series: DataPoint[];
  patterns: Pattern[];
  onBack: () => void;
  onNavToCursor: (i: number) => void;
}

const KIND_COLOR: Record<string, string> = {
  'Alignment Ladder':   'var(--cyan)',
  'Shock Jump':         'var(--red)',
  'Failed Alignment':   'var(--magenta)',
  'Coherence Volcano':  'var(--amber)',
  'Compression Coil':   'var(--r-b)',
  'Compression Release':'var(--r-c)',
  'Ignition Drift':     'var(--fg-2)',
};

function fmtClock(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export default function PatternDetail({
  kind, series, patterns, onBack, onNavToCursor,
}: PatternDetailProps) {
  const matches = useMemo(() => patterns.filter(p => p.kind === kind), [patterns, kind]);
  const color = KIND_COLOR[kind] || 'var(--fg-0)';
  const interp = INTERP[kind] || 'No interpretation available.';

  const avgStrength = matches.length
    ? matches.reduce((a, b) => a + b.strength, 0) / matches.length
    : 0;
  const avgDuration = matches.length
    ? matches.reduce((a, b) => a + (b.end - b.start), 0) / matches.length
    : 0;

  const glyph = matches[0]?.glyph || '';

  return (
    <div className="detail-shell">
      <div className="detail-head">
        <div>
          <button className="back-btn" onClick={onBack}>← Dashboard</button>
          <div className="detail-title" style={{ color, marginTop: 4 }}>{kind}</div>
          <div className="detail-glyph">{glyph}</div>
        </div>
        <div className="kvp" style={{ minWidth: 240 }}>
          <span className="k">Detected</span><span className="v tab">{matches.length}</span>
          <span className="k">Avg Strength</span><span className="v tab">{(avgStrength * 100).toFixed(0)}</span>
          <span className="k">Avg Duration</span><span className="v tab">{avgDuration.toFixed(0)} bars</span>
        </div>
      </div>

      <div className="detail-body">
        <div className="detail-section">
          <h4>Occurrences</h4>
          {matches.length === 0 && (
            <div style={{ color: 'var(--fg-3)', fontSize: 11 }}>No instances of this pattern in the current dataset.</div>
          )}
          <div className="detail-list">
            {matches.map(p => {
              const ts = series[p.start]?.t ?? 0;
              const dur = p.end - p.start;
              return (
                <div
                  key={p.id}
                  className="detail-list-row"
                  onClick={() => onNavToCursor(Math.floor((p.start + p.end) / 2))}
                >
                  <span style={{ color: 'var(--fg-1)' }}>{fmtClock(ts)} · i={p.start}–{p.end}</span>
                  <span className="tab" style={{ color: 'var(--fg-2)' }}>{dur} bars</span>
                  <span className="tab" style={{ color }}>{(p.strength * 100).toFixed(0)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="detail-section">
          <h4>Interpretation</h4>
          <div className="interp-box" style={{ borderColor: color, borderLeftWidth: 2 }}>{interp}</div>

          <h4 style={{ marginTop: 18 }}>Pattern Glyph</h4>
          <div className="kvp">
            <span className="k">Sequence</span><span className="v">{glyph || '—'}</span>
            <span className="k">Color</span><span className="v" style={{ color }}>{kind.toUpperCase()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
