'use client';

import { useState, useMemo } from 'react';
import type { DataPoint, Pattern, PatternKind, MarketSymbol, Timeframe } from '@/types/gcp';
import { PATTERN_CODE } from '@/lib/patterns-meta';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import {
  derivePatternStory, pickDominantKind,
  PATTERN_WHEN_IT_MATTERS, CYCLE_TO_CHAIN,
  type PatternStory,
} from '@/lib/patternStory';
import PatternPriceChart from './PatternPriceChart';

// v11.25.4: lifecycle role taxonomy for the Pattern Library cards.
// Categorisation matches the v11.24.6 hierarchy + visibility tiers:
//   Flow      — build-up / continuation lifecycle
//   Event     — single-shot occurrences
//   Support   — context layer (one visible per window)
//   Exhaustion— end-of-cycle / fade
//   Shock     — abrupt high-magnitude events
type LifecycleRole = 'Flow' | 'Event' | 'Support' | 'Exhaustion' | 'Shock';

const LIFECYCLE_ROLE: Record<string, LifecycleRole> = {
  'Compression Coil':         'Flow',
  'Compression Release':      'Flow',
  'Synchronization Plateau':  'Flow',
  'Alignment Ladder':         'Flow',
  'Ignition Rise':            'Flow',
  'Staircase Alignment':      'Flow',
  'Plateau Decay':            'Flow',
  'Coherence Volcano':        'Event',
  'Pulse Train':              'Support',
  'Discharge Break':          'Exhaustion',
  'Double Spike Exhaustion':  'Exhaustion',
  'Echo Spike':               'Exhaustion',
  'Failed Alignment':         'Exhaustion',
  'Dead Drift':               'Exhaustion',
  'Ignition Drift':           'Exhaustion',
  'Shock Jump':               'Shock',
  'Discharge Wave':           'Shock',
};

function roleColor(r: LifecycleRole): string {
  switch (r) {
    case 'Flow':       return 'var(--cyan)';
    case 'Event':      return '#d4a028';
    case 'Support':    return '#7F98A3';
    case 'Exhaustion': return '#ef4444';
    case 'Shock':      return '#9333ea';
  }
}

// v11.25.4: status badge per card.
//   active        — count > 0 in the currently-loaded window
//   dormant       — count === 0 in the currently-loaded window
//   experimental  — detector exists but is intentionally rare and is
//                   still being validated (PD added in v11.24.2 falls
//                   here until enough live samples accumulate)
type LibraryStatus = 'active' | 'dormant' | 'experimental';
const EXPERIMENTAL_KINDS: ReadonlySet<string> = new Set([
  'Plateau Decay',
]);
function libraryStatus(kind: string, count: number): LibraryStatus {
  if (count > 0) return 'active';
  if (EXPERIMENTAL_KINDS.has(kind)) return 'experimental';
  return 'dormant';
}
function statusColor(s: LibraryStatus): string {
  switch (s) {
    case 'active':       return '#22c55e';
    case 'experimental': return '#d4a028';
    case 'dormant':      return '#7F98A3';
  }
}

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
  'Ignition Rise': {
    glyph:   'AB# → B↑',
    color:   '#4dd9e8',
    summary: 'Coil energy starting to release upward into B without confirming C yet.',
    market:  'Early breakout environment. Wait for C confirmation before sizing up.',
  },
  'Pulse Train': {
    glyph:   'A → B → A → B …',
    color:   '#5b8cc0',
    summary: 'Repeated low/mid pulses, none holding C. Pressure accumulating.',
    market:  'Sync attempts in progress. Resolution often follows; direction unconfirmed.',
  },
  'Staircase Alignment': {
    glyph:   'B↑ → C↑',
    color:   '#16a34a',
    summary: 'Rising baseline through B into C without violent spikes.',
    market:  'Stealth trend build. High-quality continuation precursor.',
  },
  'Dead Drift': {
    glyph:   'A chop',
    color:   'var(--fg-3)',
    summary: 'Low-energy A regime with no compression tension and no slope.',
    market:  'Low signal environment. No GCP edge — defer to price-only setups.',
  },
  'Echo Spike': {
    glyph:   'D/E peak → smaller D/E',
    color:   '#fb923c',
    summary: 'A second, smaller D/E peak following an earlier larger peak.',
    market:  'Aftershock. Original move likely fading; lower continuation probability.',
  },
  'Discharge Break': {
    glyph:   'D/E → B/A',
    color:   '#dc2626',
    summary: 'Elevated regime collapses rapidly into A/B with strong negative slope.',
    market:  'Trend exhaustion. Momentum fading; watch for reversal.',
  },
  'Discharge Wave': {
    glyph:   'A → E → A',
    color:   '#ea580c',
    summary: 'Sharp climax spike followed by rapid collapse.',
    market:  'Volatility burst. Possible exhaustion event.',
  },
  'Double Spike Exhaustion': {
    glyph:   'A → E → A → E → A',
    color:   '#9333ea',
    summary: 'Two similar-magnitude E spikes separated by reset.',
    market:  'Coherence discharge complete. Likely post-event vacuum.',
  },
  'Synchronization Plateau': {
    glyph:   'C → D# sustained',
    color:   '#15803d',
    summary: 'Sustained D regime hold; minimal collapse below C.',
    market:  'One of the highest-quality gold trend continuation zones.',
  },
  'Plateau Decay': {
    glyph:   'D# fading',
    color:   '#9ca3af',
    summary: 'Sustained D run flattens out without confirmed release.',
    market:  'Plateau is fading. Watch for either a clean discharge '
             + '(slope/volatility expansion) or a re-anchor in D.',
  },
};

const PATTERN_ORDER = [
  'Alignment Ladder',
  'Synchronization Plateau',
  'Compression Release',
  'Compression Coil',
  'Ignition Rise',
  'Staircase Alignment',
  'Failed Alignment',
  'Coherence Volcano',
  'Echo Spike',
  'Discharge Wave',
  'Discharge Break',
  'Plateau Decay',
  'Double Spike Exhaustion',
  'Ignition Drift',
  'Pulse Train',
  'Dead Drift',
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
  kind, matches, series, onSelect, dominant = false,
}: {
  kind: string;
  matches: Pattern[];
  series: DataPoint[];
  onSelect: () => void;
  // v11.25.6: when true, the card gets a stronger border + DOMINANT
  // badge so the user's eye lands on the pattern that currently
  // matters most in the active grid.
  dominant?: boolean;
}) {
  const meta      = LIB_META[kind] ?? LIB_META['Compression Coil'];
  const n         = matches.length;
  const avgPSS    = n ? matches.reduce((s, m) => s + m.strength, 0) / n : 0;
  const lastMatch = n ? matches.reduce((a, b) => b.start > a.start ? b : a) : null;
  const lastT     = lastMatch ? series[lastMatch.start]?.t : null;
  const code      = PATTERN_CODE[kind as PatternKind] ?? '—';
  const role      = LIFECYCLE_ROLE[kind] ?? 'Support';
  const status    = libraryStatus(kind, n);
  const isActive  = status === 'active';
  const whenItMatters = PATTERN_WHEN_IT_MATTERS[kind as PatternKind] ?? null;

  // v11.25.6: dominant emphasis. Slightly stronger border + faint
  // glow keyed off the pattern's own meta colour. Kept restrained per
  // spec ("do not overdo visual effect").
  const baseBorder = dominant
    ? `1px solid ${meta.color}99`
    : '1px solid var(--line-1)';
  const baseShadow = dominant
    ? `0 0 0 1px ${meta.color}33, 0 0 12px ${meta.color}1a`
    : 'none';
  const hoverBorder = dominant ? `${meta.color}` : 'var(--line-3)';

  return (
    <div
      className="lib-card"
      onClick={isActive ? onSelect : undefined}
      style={{
        background: 'var(--bg-2)',
        border: baseBorder,
        boxShadow: baseShadow,
        borderRadius: 'var(--r-md)',
        padding: '14px 16px',
        cursor: isActive ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
        opacity: isActive ? 1 : 0.65,
      }}
      onMouseEnter={e => { if (isActive) e.currentTarget.style.borderColor = hoverBorder; }}
      onMouseLeave={e => {
        if (isActive) e.currentTarget.style.borderColor = dominant ? `${meta.color}99` : 'var(--line-1)';
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
            <span style={{ color: meta.color, fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>
              {kind}
            </span>
            <span style={{ color: 'var(--fg-4)', fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em' }}>
              {code}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{
              padding: '1px 6px',
              fontSize: 8, letterSpacing: '0.12em', fontWeight: 600,
              border: `1px solid ${roleColor(role)}55`,
              color: roleColor(role),
              background: `${roleColor(role)}14`,
              borderRadius: 2,
              fontFamily: 'var(--font-mono)',
            }}>
              {role.toUpperCase()}
            </span>
            <span style={{
              padding: '1px 6px',
              fontSize: 8, letterSpacing: '0.12em', fontWeight: 600,
              border: `1px solid ${statusColor(status)}55`,
              color: statusColor(status),
              background: `${statusColor(status)}14`,
              borderRadius: 2,
              fontFamily: 'var(--font-mono)',
            }}>
              {status.toUpperCase()}
            </span>
            {dominant && (
              <span style={{
                padding: '1px 6px',
                fontSize: 8, letterSpacing: '0.16em', fontWeight: 700,
                border: `1px solid ${meta.color}`,
                color: meta.color,
                background: `${meta.color}1f`,
                borderRadius: 2,
                fontFamily: 'var(--font-mono)',
              }}>
                DOMINANT
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: isActive ? pssColor(avgPSS) : 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>
            {n}
          </div>
          <div style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.08em' }}>DETECTIONS</div>
        </div>
      </div>

      <div style={{ color: 'var(--fg-2)', fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}>
        {meta.summary}
      </div>

      {whenItMatters && (
        <div style={{
          background: 'rgba(127,152,163,0.06)',
          border: '1px solid rgba(127,152,163,0.18)',
          borderRadius: 3,
          padding: '6px 9px',
          marginBottom: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}>
          <div style={{ fontSize: 8, color: 'var(--fg-4)', letterSpacing: '0.14em', fontFamily: 'var(--font-mono)' }}>
            WHEN IT MATTERS
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.5 }}>
            {whenItMatters}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, borderTop: '1px solid var(--line-1)', paddingTop: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>AVG PSS</div>
          <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: pssColor(avgPSS), fontVariantNumeric: 'tabular-nums' }}>
            {n ? (avgPSS * 100).toFixed(0) : '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>LAST SEEN</div>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-1)' }}>
            {lastT ? fmtTime(lastT) : '—'}
          </div>
        </div>
      </div>

      {isActive && (
        <div style={{ marginTop: 10, fontSize: 10, color: meta.color, letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 4 }}>
          VIEW EXAMPLES
          <svg width={8} height={8} viewBox="0 0 8 8">
            <path d="M2 4 L6 4 M4 2 L6 4 L4 6" stroke="currentColor" fill="none" strokeWidth={1.2} />
          </svg>
        </div>
      )}
    </div>
  );
}

// v11.25.4 + v11.25.6: Lifecycle map block. Visual reference for the
// three lifecycle chains. The active chain (driven by
// derivePatternStory().activeCycle) renders at full opacity with a
// faint cyan accent on the chips; inactive chains dim to ~45% so the
// user's eye lands on what's currently happening. activeChain={null}
// reverts to the neutral all-dim baseline.
function LifecycleMap({ activeChain }: { activeChain: string | null }) {
  const chains: { title: string; codes: string[] }[] = [
    {
      title: 'Compression cycle',
      codes: ['CC', 'CR', 'AL', 'FA'],
    },
    {
      title: 'Plateau cycle',
      codes: ['SP', 'PD', 'DB', 'DD'],
    },
    {
      title: 'Shock / exhaustion events',
      codes: ['SJ', 'CV', 'DSE', 'DW'],
    },
  ];
  return (
    <div style={{
      background: 'var(--bg-2)', border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)', padding: '12px 16px',
      marginBottom: 12,
    }}>
      <div className="hairline" style={{ marginBottom: 8 }}>Lifecycle map</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {chains.map(c => {
          const isActive = activeChain != null && c.title === activeChain;
          // When something is active, dim non-matching rows. When
          // activeChain is null (no dominant story), treat all rows
          // as neutral (no dim) so the map still reads as a dictionary.
          const opacity = activeChain == null ? 1 : (isActive ? 1 : 0.4);
          const chipBg     = isActive ? 'rgba(77,217,232,0.10)' : 'var(--bg-3)';
          const chipBorder = isActive ? 'rgba(77,217,232,0.55)' : 'var(--line-2)';
          const chipColor  = isActive ? 'var(--cyan)'           : 'var(--fg-1)';
          const arrowColor = isActive ? 'rgba(77,217,232,0.7)'  : 'var(--fg-4)';
          const titleColor = isActive ? 'var(--cyan)'           : 'var(--fg-4)';
          return (
            <div key={c.title} style={{
              display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
              opacity, transition: 'opacity 0.2s',
            }}>
              <span style={{
                fontSize: 9, color: titleColor, letterSpacing: '0.08em',
                minWidth: 140, fontWeight: isActive ? 700 : 500,
              }}>
                {c.title.toUpperCase()}
              </span>
              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                {c.codes.map((code, i) => (
                  <span key={code} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      padding: '1px 6px',
                      fontSize: 9, fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.04em',
                      color: chipColor,
                      border: `1px solid ${chipBorder}`,
                      background: chipBg,
                      borderRadius: 2,
                    }}>{code}</span>
                    {i < c.codes.length - 1 && (
                      <span style={{ color: arrowColor, fontSize: 10 }}>→</span>
                    )}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// v11.25.6: Current Pattern Story. Now driven by derivePatternStory()
// — the deterministic interpreter in lib/patternStory.ts maps the
// last 3-5 visible patterns into a title + interpretation + posture +
// activeCycle tag. The chip row still shows the code chain so the
// user can audit which patterns drove the story.
function CurrentStory({ story }: { story: PatternStory }) {
  const empty = story.sequence.length === 0;
  return (
    <div style={{
      background: 'var(--bg-2)', border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)', padding: '12px 16px',
      marginBottom: 12,
    }}>
      <div className="hairline" style={{ marginBottom: 8 }}>Current pattern story</div>
      {empty ? (
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          No patterns detected in the current window yet.
        </div>
      ) : (
        <>
          <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            {story.sequence.map((code, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  padding: '2px 8px',
                  fontSize: 11, fontFamily: 'var(--font-mono)',
                  fontWeight: 600, letterSpacing: '0.04em',
                  color: 'var(--cyan)',
                  border: '1px solid rgba(77,217,232,0.45)',
                  background: 'rgba(77,217,232,0.08)',
                  borderRadius: 3,
                }}>{code}</span>
                {i < story.sequence.length - 1 && (
                  <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>→</span>
                )}
              </span>
            ))}
          </div>
          <div style={{
            fontSize: 13, color: 'var(--fg-0)', fontWeight: 600,
            letterSpacing: '0.01em', marginBottom: 4,
          }}>
            {story.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            {story.interpretation}
          </div>
          <div style={{
            marginTop: 6, fontSize: 10, color: '#7F98A3', lineHeight: 1.5,
            fontStyle: 'italic',
          }}>
            Posture: {story.posture}
          </div>
        </>
      )}
    </div>
  );
}

// v11.25.4: dormant / experimental section. Collapsed by default —
// patterns with 0 detections in the current window aren't real
// information and shouldn't take up the same visual weight as active
// cards. Keeps the dictionary entries one click away.
function DormantSection({
  kinds, byKind, series, onSelectKind,
}: {
  kinds:        string[];
  byKind:       Record<string, Pattern[]>;
  series:       DataPoint[];
  onSelectKind: (kind: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (kinds.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 8px',
          background: 'transparent',
          border: '1px solid var(--line-1)',
          borderRadius: 'var(--r-sm)',
          color: 'var(--fg-2)',
          fontSize: 10, letterSpacing: '0.1em',
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          marginBottom: open ? 10 : 0,
        }}
      >
        <span style={{
          display: 'inline-block', width: 8,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
        }}>›</span>
        <span>DORMANT / EXPERIMENTAL PATTERNS ({kinds.length})</span>
      </button>
      {open && (
        <>
          <div style={{
            fontSize: 10, color: 'var(--fg-3)',
            lineHeight: 1.55, marginBottom: 10,
            maxWidth: 640,
          }}>
            Dormant patterns exist but have not appeared in this window. They
            may be rare, stricter after calibration, or only appear in
            different regimes.
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 12,
            alignContent: 'start',
          }}>
            {kinds.map(k => (
              <LibraryCard
                key={k}
                kind={k}
                matches={byKind[k] ?? []}
                series={series}
                onSelect={() => onSelectKind(k)}
              />
            ))}
          </div>
        </>
      )}
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
  timeframe:     Timeframe;
  onBack:        () => void;
  onNavToCursor: (i: number) => void;
  // v11.25.6: optional context inputs the story engine reads when
  // present. Falling back to undefined still produces a useful story
  // from the pattern sequence alone.
  aiState?:      GcpStateResponse | null;
  regime?:       string | null;
  pss?:          number | null;
}

export default function PatternDetail({
  kind: initialKind,
  series,
  patterns,
  symbol,
  timeframe,
  onBack,
  onNavToCursor,
  aiState = null,
  regime  = null,
  pss     = null,
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
    // v11.25.4: split active vs dormant/experimental so 0-detection
    // patterns no longer make the system feel broken. The dormant
    // section is collapsed by default — the user can expand it to
    // browse the dictionary entries.
    const activeKinds:  string[] = [];
    const dormantKinds: string[] = [];
    for (const k of PATTERN_ORDER) {
      const n = (byKind[k] ?? []).length;
      if (n > 0) activeKinds.push(k);
      else       dormantKinds.push(k);
    }

    // v11.25.6: deterministic story over the active patterns.
    // activeChain ties the activeCycle back to a Lifecycle Map row.
    // dominantKind picks the active card to emphasise.
    const story        = derivePatternStory({
      patterns,
      aiState: aiState ?? undefined,
      regime,
      pss,
    });
    const activeChain  = CYCLE_TO_CHAIN[story.activeCycle];
    const dominantKind = pickDominantKind(patterns);

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
            {/* v11.25.4: subtitle reframes the tab as definitions /
                explainability. Statistical performance lives on the
                Research tab now. */}
            <div style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 3, lineHeight: 1.5 }}>
              Definitions, lifecycle role, invalidators, and recent examples.
            </div>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <CurrentStory story={story} />
          <LifecycleMap activeChain={activeChain} />

          {activeKinds.length > 0 && (
            <>
              <div className="hairline" style={{ marginBottom: 10, marginTop: 4 }}>
                Active patterns ({activeKinds.length})
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                gap: 12,
                alignContent: 'start',
                marginBottom: 16,
              }}>
                {activeKinds.map(k => (
                  <LibraryCard
                    key={k}
                    kind={k}
                    matches={byKind[k] ?? []}
                    series={series}
                    dominant={k === dominantKind}
                    onSelect={() => { setKind(k); setSelectedId((byKind[k] ?? [])[0]?.id ?? null); setView('detail'); }}
                  />
                ))}
              </div>
            </>
          )}

          <DormantSection
            kinds={dormantKinds}
            byKind={byKind}
            series={series}
            onSelectKind={(k) => {
              // Dormant cards are non-actionable for "View examples"
              // since there are no occurrences; this handler is left
              // for future use if we ever want to deep-link to the
              // detail view's empty state.
              setKind(k);
              setSelectedId(null);
              setView('detail');
            }}
          />
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

            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 'var(--r-md)', padding: '12px 16px' }}>
              <PatternPriceChart
                symbol={symbol}
                tf={timeframe}
                tStart={selected.tStart}
                tEnd={selected.tEnd}
              />
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
