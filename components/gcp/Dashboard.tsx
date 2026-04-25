'use client';

import { useState, useMemo } from 'react';
import { REGIMES, energyAt, persistenceAt, INTERP } from '@/lib/gcp-data';
import GCPChartResponsive from './GCPChart';
import type { DataPoint, Pattern, MarketSymbol, Timeframe } from '@/types/gcp';
import { getSymbolMeta } from '@/types/gcp';

interface DashboardProps {
  series: DataPoint[];
  patterns: Pattern[];
  cursor: number;
  setCursor: (i: number) => void;
  live: boolean;
  onSelectPatternKind: (kind: string) => void;
  symbol: MarketSymbol;
  timeframe: Timeframe;
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

function PSSGauge({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  const score = Math.round(pct * 100);
  const color =
    pct >= 0.7 ? 'var(--green)' :
    pct >= 0.4 ? 'var(--amber)' :
    'var(--fg-2)';
  const label =
    pct >= 0.7 ? 'STRONG' :
    pct >= 0.4 ? 'MEDIUM' :
    'WEAK';

  return (
    <div style={{ padding: '12px 0 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span className="hairline">Pattern Strength Score</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{
            fontSize: 28,
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            color,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {score}
          </span>
          <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>/ 100</span>
          <span style={{
            fontSize: 9,
            letterSpacing: '0.1em',
            color,
            textTransform: 'uppercase',
            marginLeft: 4,
          }}>
            {label}
          </span>
        </div>
      </div>

      <div style={{
        position: 'relative',
        height: 6,
        background: 'var(--bg-3)',
        borderRadius: 1,
        overflow: 'visible',
      }}>
        <div style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: `${pct * 100}%`,
          background: color,
          borderRadius: 1,
          transition: 'width 0.3s ease, background 0.3s ease',
          boxShadow: pct >= 0.7 ? `0 0 8px ${color}` : 'none',
        }} />
        {[0.25, 0.5, 0.75].map(t => (
          <div key={t} style={{
            position: 'absolute',
            left: `${t * 100}%`,
            top: -3,
            bottom: -3,
            width: 1,
            background: 'var(--line-2)',
          }} />
        ))}
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: 5,
        fontSize: 9,
        color: 'var(--fg-3)',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.06em',
      }}>
        <span>WEAK</span>
        <span>FORMING</span>
        <span>STRONG</span>
        <span>EXPLOSIVE</span>
      </div>
    </div>
  );
}

function EnergyGrid({
  slope, curv, ced, persistence, timeframe,
}: {
  slope: number;
  curv: number;
  ced: number;
  persistence: { tag: string; label: string; duration: number };
  timeframe: Timeframe;
}) {
  const unit = timeframe === '1m' ? 'bars' : `× ${timeframe}`;
  return (
    <div className="metrics-grid">
      <div className="metric-cell">
        <span className="metric-label">Slope</span>
        <span className="metric-val tab">{slope.toFixed(2)}</span>
      </div>
      <div className="metric-cell">
        <span className="metric-label">Curvature</span>
        <span className="metric-val tab">{curv.toFixed(2)}</span>
      </div>
      <div className="metric-cell">
        <span className="metric-label">CED</span>
        <span className="metric-val tab">{ced.toFixed(2)}</span>
      </div>
      <div className="metric-cell">
        <span className="metric-label">Persist</span>
        <span style={{ fontSize: 14, fontFamily: 'var(--font-mono)', color: 'var(--fg-0)' }}>
          {persistence.duration}
          <span style={{ fontSize: 10, color: 'var(--fg-2)', marginLeft: 4 }}>{unit}</span>
        </span>
        <span style={{ fontSize: 9.5, color: 'var(--fg-2)', letterSpacing: '0.04em' }}>
          {persistence.tag} · {persistence.label}
        </span>
      </div>
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
  series, patterns, cursor, setCursor, onSelectPatternKind, symbol, timeframe,
}: DashboardProps) {
  const [showGold, setShowGold] = useState(true);
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(null);
  const symbolMeta = getSymbolMeta(symbol);

  const energy = useMemo(() => energyAt(series, cursor), [series, cursor]);
  const persistence = useMemo(() => persistenceAt(series, cursor), [series, cursor]);

  const activePattern = useMemo(() => {
    if (selectedPatternId) return patterns.find(p => p.id === selectedPatternId) || null;
    return patterns.find(p => cursor >= p.start && cursor <= p.end) || null;
  }, [patterns, cursor, selectedPatternId]);

  const interp = activePattern ? INTERP[activePattern.kind] : 'Cursor outside any detected pattern. Use feed to inspect a region.';

  return (
    <div className="dashboard">
      <section className="panel panel-chart">
        <div className="panel-head">
          <span className="title">{symbol} · Coherence Regime · {timeframe}</span>
          <div className="chart-tools">
            <button
              className={`tool-btn ${showGold ? 'on' : ''}`}
              onClick={() => setShowGold(s => !s)}
            >
              <span style={{
                width: 8, height: 8,
                background: symbolMeta.color,
                display: 'inline-block',
                borderRadius: 1,
                marginRight: 5,
                verticalAlign: 'middle',
              }} />
              {symbol} {showGold ? '◉' : '○'}
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
            symbolColor={symbolMeta.color}
            symbolId={symbol}
          />
        </div>
      </section>

      <section className="panel panel-side">
        <div className="panel-head">
          <span className="title">Energy / Persistence</span>
        </div>
        <div className="panel-body">
          <div className="gauge-wrap">
            <PSSGauge value={energy.pss} />
            <EnergyGrid
              slope={energy.slope}
              curv={energy.curv}
              ced={energy.ced}
              persistence={persistence}
              timeframe={timeframe}
            />
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
