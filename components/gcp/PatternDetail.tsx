'use client';

import { useState, useMemo } from 'react';
import type { DataPoint, Pattern, MarketSymbol } from '@/types/gcp';

const LIB_META: Record<string, {
  glyph: string; color: string; summary: string; market: string;
}> = {
  'Alignment Ladder': {
    glyph:   'AB# → B↑ → C → D#',
    color:   'var(--cyan)',
    summary: 'Trend environment forming. Highest continuation probability in the taxonomy.',
    market:  'Strong trends most commonly occur here. Favor directional entries with tight invalidation.',
  },
  'Compression Coil': {
    glyph:   'AB# sustained',
    color:   'var(--fg-1)',
    summary: 'Sustained A/B period. Energy accumulating without direction.',
    market:  'Accumulation / range. Liquidity building. No edge until PSS > 0.70 and regime progresses to C.',
  },
  'Compression Release': {
    glyph:   'AB# → B↑ → C',
    color:   'var(--cyan-dim)',
    summary: 'Coil energy releasing upward into C alignment.',
    market:  'Breakout setup forming. Requires confirmation that C persists before sizing.',
  },
  'Failed Alignment': {
    glyph:   'AB# → B → C → B → A',
    color:   'var(--magenta)',
    summary: 'Reached C but failed to sustain; collapsed back through B into A.',
    market:  'Fake breakout. Historically low continuation. Consider fading or standing aside.',
  },
  'Coherence Volcano': {
    glyph:   'A → B → C → B → A',
    color:   'var(--amber)',
    summary: 'Single-peak spike into C that mean-reverts immediately.',
    market:  'Temporary event. No sustained trend. Fade extremes into the mean.',
  },
  'Ignition Drift': {
    glyph:   'B ↔ B',
    color:   'var(--fg-2)',
    summary: 'Oscillation within the ignition band; no decisive direction.',
    market:  'Indecision. Wait for C alignment before committing.',
  },
  'Shock Jump': {
    glyph:   'B → F',
    color:   'var(--red)',
    summary: 'Abrupt jump into the shock band. Typically news/geopolitical origin.',
    market:  'Expect extreme volatility. Reduce size. Price often spikes then retraces violently.',
  },
};

const PATTERN_ORDER = [
  'Alignment Ladder',
  'Compression Release',
  'Compression Coil',
  'Failed Alignment',
  'Coherence Volcano',
  'Ignition Drift',
  'Shock Jump',
];

function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${d.toLocaleString('en-GB', { month: 'short' })} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function pssColor(pss: number) {
  return pss >= 0.70 ? 'var(--green)' : pss >= 0.40 ? 'var(--amber)' : 'var(--fg-2)';
}

function MiniChart({
  match, series, color,
}: { match: Pattern; series: DataPoint[]; color: string }) {
  const W = 760, H = 140;
  const padL = 36, padR = 8, padT = 10, padB = 18;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const PRE = 30, POST = 30;
  const a = Math.max(0, match.start - PRE);
  const b = Math.min(series.length - 1, match.end + POST);
  const slice = series.slice(a, b + 1);
  if (!slice.length) return null;

  const xOf = (i: number) => padL + (i / Math.max(1, slice.length - 1)) * innerW;
  const yOf = (v: number) => padT + (1 - (v / 260)) * innerH;

  const bands: { s: number; e: number; r: string }[] = [];
  let bs = 0;
  for (let i = 1; i <= slice.length; i++) {
    if (i === slice.length || slice[i]?.r !== slice[bs]?.r) {
      bands.push({ s: bs, e: i - 1, r: slice[bs].r });
      bs = i;
    }
  }

  let path = '';
  for (let i = 0; i < slice.length; i++) {
    path += (i === 0 ? 'M' : 'L') + xOf(i).toFixed(1) + ' ' + yOf(slice[i].v).toFixed(1) + ' ';
  }

  const patX1 = xOf(match.start - a);
  const patX2 = xOf(match.end - a);

  const yTicks  = [0, 50, 100, 140, 170, 220];
  const yLabels = ['A', 'B', 'C', 'D', 'E', 'F'];
  const yMids   = [25, 75, 120, 155, 195, 240];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
      {bands.map((bd, i) => (
        <rect key={i} x={xOf(bd.s)} y={padT}
          width={Math.max(0.5, xOf(bd.e) - xOf(bd.s))}
          height={innerH}
          fill={`var(--r-${bd.r.toLowerCase()}-bg)`} />
      ))}
      {yTicks.map(yv => (
        <line key={yv} x1={padL} x2={W - padR}
          y1={yOf(yv)} y2={yOf(yv)}
          stroke="var(--line-1)" strokeDasharray="1 3" />
      ))}
      {yLabels.map((L, i) => (
        <text key={L} x={padL - 5} y={yOf(yMids[i]) + 4}
          fill={`var(--r-${L.toLowerCase()})`}
          fontSize={9} fontFamily="var(--font-mono)"
          textAnchor="end" fontWeight={600}>{L}
        </text>
      ))}
      <rect x={patX1} y={padT} width={Math.max(1, patX2 - patX1)} height={innerH}
        fill={color} fillOpacity={0.07}
        stroke={color} strokeOpacity={0.5} strokeDasharray="2 2" />
      <path d={path} stroke="var(--cyan)" fill="none" strokeWidth={1.3}
        style={{ filter: 'drop-shadow(0 0 2px oklch(0.78 0.14 210 / 0.4))' }} />
      <line x1={patX1} x2={patX1} y1={padT} y2={H - padB}
        stroke={color} strokeWidth={1} strokeOpacity={0.8} />
      <line x1={patX2} x2={patX2} y1={padT} y2={H - padB}
        stroke={color} strokeWidth={1} strokeOpacity={0.5} />
    </svg>
  );
}

function LibraryCard({
  kind, matches, series, onSelect,
}: {
  kind: string;
  matches: Pattern[];
  series: DataPoint[];
  onSelect: () => void;
}) {
  const meta      = LIB_META[kind] ?? LIB_META['Compression Coil'];
  const n         = matches.length;
  const avgPSS    = n ? matches.reduce((s, m) => s + m.strength, 0) / n : 0;
  const lastMatch = n ? matches.reduce((a, b) => b.start > a.start ? b : a) : null;
  const lastT     = lastMatch ? series[lastMatch.start]?.t : null;
  const avgDur    = n ? Math.round(matches.reduce((s, m) => s + (m.end - m.start), 0) / n) : 0;

  const isEmpty = n === 0;
  return (
    <div
      className="lib-card"
      onClick={isEmpty ? undefined : onSelect}
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--line-1)',
        borderRadius: 'var(--r-md)',
        padding: '14px 16px',
        cursor: isEmpty ? 'default' : 'pointer',
        transition: 'border-color 0.15s',
        opacity: isEmpty ? 0.35 : 1,
        pointerEvents: isEmpty ? 'none' : 'auto',
      }}
      onMouseEnter={e => { if (!isEmpty) e.currentTarget.style.borderColor = 'var(--line-3)'; }}
      onMouseLeave={e => { if (!isEmpty) e.currentTarget.style.borderColor = 'var(--line-1)'; }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ color: meta.color, fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em', marginBottom: 2 }}>
            {kind}
          </div>
          <div style={{ color: 'var(--fg-3)', fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em' }}>
            {meta.glyph}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: pssColor(avgPSS), fontVariantNumeric: 'tabular-nums' }}>
            {n}
          </div>
          <div style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.08em' }}>DETECTIONS</div>
        </div>
      </div>

      <div style={{ color: 'var(--fg-2)', fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}>
        {meta.summary}
      </div>

      <div style={{ display: 'flex', gap: 16, borderTop: '1px solid var(--line-1)', paddingTop: 10 }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>AVG PSS</div>
          <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: pssColor(avgPSS), fontVariantNumeric: 'tabular-nums' }}>
            {n ? (avgPSS * 100).toFixed(0) : '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>AVG BARS</div>
          <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
            {n ? avgDur : '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>LAST SEEN</div>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-1)' }}>
            {lastT ? fmtTime(lastT) : '—'}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 10, color: meta.color, letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 4 }}>
        VIEW {n} OCCURRENCE{n !== 1 ? 'S' : ''}
        <svg width={8} height={8} viewBox="0 0 8 8">
          <path d="M2 4 L6 4 M4 2 L6 4 L4 6" stroke="currentColor" fill="none" strokeWidth={1.2} />
        </svg>
      </div>
    </div>
  );
}

function OccurrenceRow({
  match, series, isSelected, onSelect,
}: {
  match: Pattern;
  series: DataPoint[];
  isSelected: boolean;
  onSelect: () => void;
}) {
  const t    = series[match.start]?.t;
  const dur  = match.end - match.start;
  const meta = LIB_META[match.kind] ?? LIB_META['Compression Coil'];

  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px',
        cursor: 'pointer',
        background: isSelected ? 'var(--bg-3)' : 'transparent',
        borderLeft: `2px solid ${isSelected ? meta.color : 'transparent'}`,
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-2)'; }}
      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ width: 28, flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)', color: pssColor(match.strength), fontVariantNumeric: 'tabular-nums' }}>
          {(match.strength * 100).toFixed(0)}
        </div>
        <div style={{ height: 2, background: 'var(--bg-4)', borderRadius: 1, marginTop: 2 }}>
          <div style={{ height: '100%', width: `${match.strength * 100}%`, background: pssColor(match.strength), borderRadius: 1 }} />
        </div>
      </div>

      <div style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-1)' }}>
        {t ? fmtTime(t) : `i=${match.start}`}
      </div>

      <div style={{ fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
        {dur} bars
      </div>
    </div>
  );
}

interface PatternDetailProps {
  kind:          string | null;
  series:        DataPoint[];
  patterns:      Pattern[];
  symbol:        MarketSymbol;
  onBack:        () => void;
  onNavToCursor: (i: number) => void;
}

export default function PatternDetail({
  kind: initialKind,
  series,
  patterns,
  onBack,
  onNavToCursor,
}: PatternDetailProps) {
  const [view, setView]     = useState<'library' | 'detail'>(initialKind ? 'detail' : 'library');
  const [kind, setKind]     = useState<string>(initialKind ?? 'Alignment Ladder');
  const [sortBy, setSortBy] = useState<'pss' | 'time'>('pss');

  const matchesForKind = useMemo(() =>
    patterns.filter(p => p.kind === kind),
  [patterns, kind]);

  const sortedMatches = useMemo(() => {
    const m = [...matchesForKind];
    return sortBy === 'pss'
      ? m.sort((a, b) => b.strength - a.strength)
      : m.sort((a, b) => b.start - a.start);
  }, [matchesForKind, sortBy]);

  const [selectedId, setSelectedId] = useState<string | null>(sortedMatches[0]?.id ?? null);
  const selected = sortedMatches.find(m => m.id === selectedId) ?? sortedMatches[0];

  const meta = LIB_META[kind] ?? LIB_META['Compression Coil'];

  const stats = useMemo(() => {
    const n = matchesForKind.length;
    if (!n) return { n: 0, avgDur: 0, avgPSS: 0, lastT: null as number | null };
    const avgDur = matchesForKind.reduce((s, m) => s + (m.end - m.start), 0) / n;
    const avgPSS = matchesForKind.reduce((s, m) => s + m.strength, 0) / n;
    const last   = matchesForKind.reduce((a, b) => b.start > a.start ? b : a);
    return { n, avgDur: Math.round(avgDur), avgPSS, lastT: series[last.start]?.t ?? null };
  }, [matchesForKind, series]);

  if (view === 'library') {
    const byKind: Record<string, Pattern[]> = {};
    for (const p of patterns) {
      if (!byKind[p.kind]) byKind[p.kind] = [];
      byKind[p.kind].push(p);
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: '1px solid var(--line-1)', flexShrink: 0 }}>
          <button className="btn ghost" onClick={onBack} style={{ fontSize: 10, letterSpacing: '0.1em' }}>
            <svg width={10} height={10} viewBox="0 0 10 10" style={{ marginRight: 4 }}>
              <path d="M7 2 L3 5 L7 8" stroke="currentColor" fill="none" strokeWidth={1.4} />
            </svg>
            DASHBOARD
          </button>
          <div>
            <div className="hairline">Pattern Library</div>
            <div style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 3, lineHeight: 1.5 }}>
              <span style={{ color: 'var(--fg-2)' }}>TF</span> sets bar resolution
              &nbsp;·&nbsp;
              <span style={{ color: 'var(--fg-2)' }}>VIEW</span> sets time window
              &nbsp;·&nbsp;
              patterns re-detect on every change
            </div>
          </div>
        </div>

        <div style={{
          flex: 1, overflow: 'auto', padding: 20,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 12,
          alignContent: 'start',
        }}>
          {PATTERN_ORDER.map(k => (
            <LibraryCard
              key={k}
              kind={k}
              matches={byKind[k] ?? []}
              series={series}
              onSelect={() => { setKind(k); setSelectedId((byKind[k] ?? [])[0]?.id ?? null); setView('detail'); }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderBottom: '1px solid var(--line-1)', flexShrink: 0 }}>
        <button className="btn ghost" onClick={() => setView('library')} style={{ fontSize: 10, letterSpacing: '0.1em' }}>
          <svg width={10} height={10} viewBox="0 0 10 10" style={{ marginRight: 4 }}>
            <path d="M7 2 L3 5 L7 8" stroke="currentColor" fill="none" strokeWidth={1.4} />
          </svg>
          LIBRARY
        </button>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ color: meta.color, fontWeight: 600, fontSize: 16, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>
            {kind}
          </span>
          <span style={{ color: 'var(--fg-3)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
            {meta.glyph}
          </span>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 20 }}>
          {[
            { label: 'Occurrences', value: stats.n },
            { label: 'Avg Bars',    value: stats.avgDur },
            { label: 'Avg PSS',     value: stats.n ? (stats.avgPSS * 100).toFixed(0) : '—' },
            { label: 'Last Seen',   value: stats.lastT ? fmtTime(stats.lastT) : '—' },
          ].map(({ label, value }) => (
            <div key={label} style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>{label}</div>
              <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--fg-0)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ width: 260, flexShrink: 0, borderRight: '1px solid var(--line-1)', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: 0, padding: '8px 12px', borderBottom: '1px solid var(--line-1)', flexShrink: 0 }}>
            <span className="hairline" style={{ marginRight: 8 }}>Sort</span>
            {(['pss', 'time'] as const).map(s => (
              <button key={s} onClick={() => setSortBy(s)}
                style={{ fontSize: 9, letterSpacing: '0.08em', marginRight: 6, padding: '2px 6px', borderRadius: 2,
                  background: sortBy === s ? 'var(--bg-3)' : 'transparent',
                  border: `1px solid ${sortBy === s ? 'var(--line-2)' : 'transparent'}`,
                  color: sortBy === s ? 'var(--fg-0)' : 'var(--fg-3)',
                }}>
                {s === 'pss' ? 'STRENGTH' : 'RECENT'}
              </button>
            ))}
          </div>

          {sortedMatches.length === 0 && (
            <div style={{ padding: 20, color: 'var(--fg-3)', fontSize: 11, textAlign: 'center' }}>
              No occurrences detected
            </div>
          )}

          {sortedMatches.map(m => (
            <OccurrenceRow
              key={m.id}
              match={m}
              series={series}
              isSelected={m.id === selected?.id}
              onSelect={() => setSelectedId(m.id)}
            />
          ))}
        </div>

        {selected ? (
          <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 'var(--r-md)', padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>
                  {fmtTime(series[selected.start]?.t ?? 0)} — {selected.end - selected.start} bars
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: pssColor(selected.strength), fontFamily: 'var(--font-mono)' }}>
                    PSS {(selected.strength * 100).toFixed(0)}
                  </span>
                  <button
                    onClick={() => { onNavToCursor(selected.start); }}
                    style={{
                      fontSize: 9, letterSpacing: '0.08em', padding: '3px 8px',
                      background: 'var(--bg-3)', border: '1px solid var(--line-2)',
                      borderRadius: 2, color: meta.color, cursor: 'pointer',
                    }}
                  >
                    JUMP TO CHART →
                  </button>
                </div>
              </div>
              <MiniChart match={selected} series={series} color={meta.color} />
            </div>

            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 'var(--r-md)', padding: '14px 16px' }}>
              <div className="hairline" style={{ marginBottom: 8 }}>Interpretation</div>
              <div style={{ color: 'var(--fg-1)', fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
                {meta.summary}
              </div>
              <div className="hairline" style={{ marginBottom: 6 }}>Market Implication</div>
              <div style={{ color: 'var(--fg-2)', fontSize: 11, lineHeight: 1.6 }}>
                {meta.market}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-3)', fontSize: 11 }}>
            Select an occurrence from the list
          </div>
        )}
      </div>
    </div>
  );
}
