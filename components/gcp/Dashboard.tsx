'use client';

import { useState, useMemo } from 'react';
import { REGIMES, energyAt, persistenceAt, INTERP } from '@/lib/gcp-data';
import GCPChartResponsive from './GCPChart';
import type { DataPoint, Pattern } from '@/types/gcp';

interface DashboardProps {
  series: DataPoint[];
  patterns: Pattern[];
  cursor: number;
  setCursor: (i: number) => void;
  live: boolean;
  onSelectPatternKind: (kind: string) => void;
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

function PSSGauge({ pss }: { pss: number }) {
  const pct = Math.round(pss * 100);
  return (
    <div className="gauge-block">
      <div className="hairline">Pattern Strength Score</div>
      <div className="gauge-row">
        <span className="gauge-num">{pct}</span>
        <span className="gauge-meta">/ 100</span>
        <span className="gauge-meta" style={{ marginLeft: 'auto' }}>
          {pss > 0.7 ? 'HIGH' : pss > 0.4 ? 'MEDIUM' : 'LOW'}
        </span>
      </div>
      <div className="gauge-bar"><div className="gauge-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function EnergyGrid({ slope, curv, ced }: { slope: number; curv: number; ced: number }) {
  const cells = [
    { label: 'Slope', val: slope.toFixed(2) },
    { label: 'Curvature', val: curv.toFixed(2) },
    { label: 'CED', val: ced.toFixed(2) },
    { label: 'Persist', val: '—' },
  ];
  return (
    <div className="metrics-grid">
      {cells.map(c => (
        <div className="metric-cell" key={c.label}>
          <span className="metric-label">{c.label}</span>
          <span className="metric-val tab">{c.val}</span>
        </div>
      ))}
    </div>
  );
}

function PersistCard({ tag, label, duration }: { tag: string; label: string; duration: number }) {
  return (
    <div className="persist-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span className="persist-tag" style={{ color: 'var(--cyan)' }}>{tag}</span>
        <span style={{ color: 'var(--fg-1)', fontSize: 11 }}>{label}</span>
      </div>
      <div className="hairline">Duration</div>
      <div className="tab" style={{ color: 'var(--fg-0)', fontSize: 14, marginTop: 2 }}>{duration} bars</div>
    </div>
  );
}

function PatternFeed({
  patterns, series, onPick, activeId,
}: {
  patterns: Pattern[];
  series: DataPoint[];
  onPick: (p: Pattern) => void;
  activeId: string | null;
}) {
  if (!patterns.length) return <div style={{ color: 'var(--fg-3)', fontSize: 11 }}>No patterns detected.</div>;
  return (
    <div className="feed-list">
      {patterns.slice(-30).reverse().map(p => {
        const ts = series[p.start]?.t ?? 0;
        return (
          <div
            key={p.id}
            className={`feed-row ${activeId === p.id ? 'active' : ''}`}
            onClick={() => onPick(p)}
          >
            <span className="feed-dot" style={{ background: KIND_COLOR[p.kind] || 'var(--fg-2)' }} />
            <span className="feed-kind">{p.kind}</span>
            <span className="feed-glyph">{p.glyph}</span>
            <span className="feed-strength tab">{(p.strength * 100).toFixed(0)}</span>
            <span className="feed-time tab">{fmtClock(ts)}</span>
          </div>
        );
      })}
    </div>
  );
}

function RegimeLegend() {
  return (
    <div className="legend-grid">
      {REGIMES.map(r => (
        <div className="legend-row" key={r.id}>
          <span className="legend-swatch" style={{ background: `var(--r-${r.id.toLowerCase()})` }} />
          <span style={{ color: 'var(--fg-0)', fontWeight: 500 }}>{r.id}</span>
          <span style={{ color: 'var(--fg-2)' }}>{r.name}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard({
  series, patterns, cursor, setCursor, onSelectPatternKind,
}: DashboardProps) {
  const [showGold, setShowGold] = useState(true);
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(null);

  const energy = useMemo(() => energyAt(series, cursor), [series, cursor]);
  const persist = useMemo(() => persistenceAt(series, cursor), [series, cursor]);

  const activePattern = useMemo(() => {
    if (selectedPatternId) return patterns.find(p => p.id === selectedPatternId) || null;
    return patterns.find(p => cursor >= p.start && cursor <= p.end) || null;
  }, [patterns, cursor, selectedPatternId]);

  const interp = activePattern ? INTERP[activePattern.kind] : 'Cursor outside any detected pattern. Use feed to inspect a region.';

  return (
    <div className="dashboard">
      <section className="panel panel-chart">
        <div className="panel-head">
          <span className="title">XAUUSD · Coherence Regime</span>
          <div className="chart-tools">
            <button
              className={`tool-btn ${showGold ? 'on' : ''}`}
              onClick={() => setShowGold(s => !s)}
            >
              GOLD {showGold ? '◉' : '○'}
            </button>
          </div>
        </div>
        <div className="panel-body">
          <GCPChartResponsive
            series={series}
            patterns={patterns}
            cursor={cursor}
            setCursor={setCursor}
            showGold={showGold}
            selectedPatternId={selectedPatternId}
            onSelectPattern={(id) => setSelectedPatternId(id)}
          />
        </div>
      </section>

      <section className="panel panel-side">
        <div className="panel-head">
          <span className="title">Energy / Persistence</span>
        </div>
        <div className="panel-body">
          <div className="gauge-wrap">
            <PSSGauge pss={energy.pss} />
            <EnergyGrid slope={energy.slope} curv={energy.curv} ced={energy.ced} />
            <PersistCard tag={persist.tag} label={persist.label} duration={persist.duration} />
          </div>
        </div>
      </section>

      <section className="panel panel-feed">
        <div className="panel-head">
          <span className="title">Pattern Feed</span>
          <span className="hairline">{patterns.length} detected</span>
        </div>
        <div className="panel-body">
          <PatternFeed
            patterns={patterns}
            series={series}
            activeId={activePattern?.id ?? null}
            onPick={(p) => {
              setSelectedPatternId(p.id);
              setCursor(Math.floor((p.start + p.end) / 2));
            }}
          />
        </div>
      </section>

      <section className="panel panel-meta">
        <div className="panel-head">
          <span className="title">Interpretation</span>
          {activePattern && (
            <button
              className="tool-btn"
              onClick={() => onSelectPatternKind(activePattern.kind)}
            >
              DETAIL →
            </button>
          )}
        </div>
        <div className="panel-body">
          {activePattern && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: KIND_COLOR[activePattern.kind] || 'var(--fg-0)', fontSize: 13, fontWeight: 600, letterSpacing: '0.04em' }}>
                {activePattern.kind.toUpperCase()}
              </div>
              <div className="hairline" style={{ marginTop: 2 }}>{activePattern.glyph}</div>
            </div>
          )}
          <div className="interp-box">{interp}</div>
          <div className="hairline" style={{ marginTop: 14 }}>Regime Legend</div>
          <RegimeLegend />
        </div>
      </section>
    </div>
  );
}
