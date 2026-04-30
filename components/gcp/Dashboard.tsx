'use client';

import { useState, useEffect } from 'react';
import type { DataPoint, Pattern, MarketSymbol } from '@/types/gcp';
import type { GCPDataState } from '@/lib/useGCPData';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import { useNewsData, type NewsItem } from '@/lib/useNewsData';
import AiStateCard from './AiStateCard';

const REGIME_META: Record<string, { label: string; color: string; bg: string; range: string }> = {
  A: { label: 'Silence',         color: '#4a72c4', bg: 'rgba(59,90,160,0.15)',  range: '0–50' },
  B: { label: 'Ignition',        color: '#4dd9e8', bg: 'rgba(50,130,180,0.15)', range: '50–100' },
  C: { label: 'Alignment',       color: '#2db8b4', bg: 'rgba(40,180,175,0.15)', range: '100–140' },
  D: { label: 'Synchronization', color: '#d4a028', bg: 'rgba(200,160,40,0.15)', range: '140–170' },
  E: { label: 'Climax',          color: '#d46428', bg: 'rgba(210,100,40,0.15)', range: '170–220' },
  F: { label: 'Shock',           color: '#e24b4a', bg: 'rgba(220,50,50,0.18)',  range: '220+' },
};

const REGIME_TAG_LABEL: Record<string, string> = {
  A: 'A SILENCE', B: 'B EVENT', C: 'C ALIGN',
  D: 'D SYNC',    E: 'E CLIMAX', F: 'F SHOCK',
};

const PATTERN_ONELINER: Record<string, string> = {
  'Alignment Ladder':         'Stepwise sync building. Strongest continuation setup.',
  'Compression Coil':         'Energy coiling in A/B. Watching for release trigger.',
  'Compression Release':      'Coil released into alignment. Catalyst likely in play.',
  'Failed Alignment':         'Sync attempt failed. Mean-reversion / fade setup.',
  'Coherence Volcano':        'Single spike, fast return. Sharp move then reversal.',
  'Ignition Drift':           'Sustained ignition, no escalation. Slow drift likely.',
  'Shock Jump':               'Shock jump detected. Extreme volatility — both directions.',
  'Ignition Rise':            'Coil starting to release. Watching for C confirmation.',
  'Pulse Train':              'Repeated low/mid pulses. Pressure building.',
  'Staircase Alignment':      'Stealth trend build. High-quality continuation precursor.',
  'Dead Drift':               'Low signal environment. Defer to price-only setups.',
  'Echo Spike':               'Aftershock — original move likely fading.',
  'Discharge Break':          'D/E collapse. Trend exhaustion / momentum fading.',
  'Discharge Wave':           'Climax burst. Volatility spike, possible exhaustion.',
  'Double Spike Exhaustion':  'Twin spikes. Discharge complete, post-event vacuum.',
  'Synchronization Plateau':  'Strong gold trend zone. One of the highest-quality setups.',
};

// REGIME_ORDER previously powered the per-regime mini-bar in RegimeCard.
// v11.16 simplified that into a single StatRow so the constant is gone.

function pssOf(p: Pattern): number {
  return Math.round(p.strength * 100);
}

function regimeOfPattern(p: Pattern, series: DataPoint[]): string | null {
  return series[p.start]?.r ?? null;
}

function barsOfPattern(p: Pattern): number {
  return p.end - p.start;
}

function RegimeTag({ regime }: { regime: string }) {
  const meta = REGIME_META[regime];
  if (!meta) return null;
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 5px',
      borderRadius: 2,
      fontSize: 7,
      letterSpacing: '0.08em',
      background: meta.bg,
      color: meta.color,
      marginLeft: 6,
      verticalAlign: 'middle',
      border: `1px solid ${meta.color}44`,
    }}>
      {REGIME_TAG_LABEL[regime]}
    </span>
  );
}

function NVSparkline({ series }: { series: DataPoint[] }) {
  const last15 = series.slice(-15);
  if (!last15.length) return null;
  const max = Math.max(...last15.map(p => p.v));
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 2,
      height: 18, marginTop: 6,
    }}>
      {last15.map((p, i) => (
        <div key={i} style={{
          flex: 1, borderRadius: 1,
          background: '#4dd9e8',
          opacity: 0.4 + (i / last15.length) * 0.6,
          height: `${Math.max(10, (p.v / (max || 1)) * 100)}%`,
        }} />
      ))}
    </div>
  );
}

// v11.16: compact horizontal stat row used in the dashboard's top
// right column. Label + value on one row, optional meta sub-line, and
// optional supplementary content (sparkline, mini bar) below.
function StatRow({
  label, value, valueColor, meta, children,
}: {
  label:      string;
  value:      string;
  valueColor: string;
  meta:       string;
  children?:  React.ReactNode;
}) {
  return (
    <div style={{
      padding: '6px 0',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8,
      }}>
        <span style={{
          fontSize: 8, letterSpacing: '0.14em', color: 'var(--fg-4)',
        }}>
          {label}
        </span>
        <span style={{
          fontSize: 22, color: valueColor, fontWeight: 600,
          fontVariantNumeric: 'tabular-nums', lineHeight: 1,
          letterSpacing: '-0.01em',
        }}>
          {value}
        </span>
      </div>
      <div style={{
        fontSize: 9, color: 'var(--fg-3)', marginTop: 2,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {meta}
      </div>
      {children}
    </div>
  );
}

function PatternCard({
  patterns, series, flash,
}: {
  patterns: Pattern[]; series: DataPoint[]; flash: boolean;
}) {
  // v11.16: secondary block (sits below the AI primary focus). The AI
  // environment line + helper text are surfaced once in the dashboard
  // shell, so this card just shows the pattern itself.
  const latest = patterns[patterns.length - 1] ?? null;

  const flashStyle: React.CSSProperties = flash ? {
    outline:    '1px solid #d4a028',
    animation:  'pssPulse 0.5s ease-in-out 3',
    transition: 'outline 0.3s ease',
  } : {
    outline:    '1px solid transparent',
    transition: 'outline 0.3s ease',
  };

  const Header = (
    <div style={{
      fontSize: 9, letterSpacing: '0.12em', color: 'var(--fg-4)',
      marginBottom: 6,
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    }}>
      <span>PATTERN DETECTION</span>
      <span style={{
        padding: '1px 5px', borderRadius: 2,
        border: '1px solid var(--line-2)',
        color: 'var(--fg-3)', fontSize: 7,
      }}>GCP EVENT</span>
    </div>
  );

  if (!latest) {
    return (
      <div style={{ background: 'var(--bg-1)', padding: '10px 16px', ...flashStyle }}>
        {Header}
        <div style={{ fontSize: 12, color: 'var(--fg-4)' }}>No pattern detected</div>
      </div>
    );
  }

  const pss    = pssOf(latest);
  const regime = regimeOfPattern(latest, series);
  const bars   = barsOfPattern(latest);
  const tier   = pss >= 80 ? 'STRONG' : pss >= 60 ? 'FORMING' : 'WEAK';
  const oneLiner = PATTERN_ONELINER[latest.kind] ?? '—';

  return (
    <div style={{ background: 'var(--bg-1)', padding: '10px 16px', ...flashStyle }}>
      {Header}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        columnGap: 18, alignItems: 'center',
      }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 6,
        }}>
          <span style={{
            fontSize: 24, color: '#d4a028', fontWeight: 600,
            fontVariantNumeric: 'tabular-nums', lineHeight: 1,
          }}>{pss}</span>
          <span style={{ fontSize: 8, color: '#854f0b', letterSpacing: '0.06em' }}>
            / 100 · {tier}
          </span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 12, color: 'var(--fg-0)', fontWeight: 600,
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {latest.kind}
          </div>
          <div style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 2, lineHeight: 1.45 }}>
            {oneLiner}
          </div>
          <div style={{ fontSize: 8, color: 'var(--fg-4)', marginTop: 2 }}>
            {regime ?? '?'} · {bars} bars
          </div>
        </div>
      </div>
      <div style={{
        height: 3, background: 'var(--bg-2)',
        borderRadius: 2, marginTop: 8, overflow: 'hidden',
      }}>
        <div style={{
          width: `${pss}%`, height: '100%',
          background: '#d4a028', borderRadius: 2,
        }} />
      </div>
    </div>
  );
}

function NewsRow({ item }: { item: NewsItem }) {
  const date    = new Date(item.publishedAt);
  const now     = new Date();
  const yest    = new Date(now);
  yest.setDate(yest.getDate() - 1);

  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const isToday     = sameDay(date, now);
  const isYesterday = sameDay(date, yest);

  const timeStr  = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayLabel = isToday ? '' : isYesterday ? 'YEST'
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });

  const titleColor =
    item.regime === 'F' ? '#e24b4a' :
    item.regime === 'D' || item.regime === 'E' ? '#d4a028' :
    'var(--fg-1)';

  return (
    <a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'grid',
        gridTemplateColumns: '58px 1fr',
        gap: 10,
        padding: '9px 16px',
        borderBottom: '1px solid var(--bg-0)',
        textDecoration: 'none',
      }}
    >
      <div style={{ paddingTop: 1 }}>
        <div style={{
          fontSize: 11,
          color: 'var(--fg-2)',
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.02em',
        }}>
          {timeStr}
        </div>
        {dayLabel && (
          <div style={{ fontSize: 8, color: 'var(--fg-4)', letterSpacing: '0.08em', marginTop: 1 }}>
            {dayLabel}
          </div>
        )}
      </div>
      <div>
        <div style={{ fontSize: 10, color: titleColor, lineHeight: 1.45, letterSpacing: '0.01em' }}>
          {item.title}
          {item.regime && <RegimeTag regime={item.regime} />}
        </div>
        <div style={{ fontSize: 8, color: 'var(--fg-4)', marginTop: 2, letterSpacing: '0.06em' }}>
          {item.source.toUpperCase()}
          {item.nv != null && ` · NV ${item.nv}`}
        </div>
      </div>
    </a>
  );
}

interface DashboardProps {
  gcpData:     GCPDataState;
  series:      DataPoint[];
  patterns:    Pattern[];
  symbol:      MarketSymbol;
  symbolPrice: number | null;
  pssFlash?:   boolean;
  aiState:     GcpStateResponse | null;
  aiEnabled:   boolean;
}

export default function Dashboard({
  gcpData, series, patterns, pssFlash = false,
  aiState, aiEnabled,
}: DashboardProps) {
  const { items: newsItems, loading: newsLoading } = useNewsData(series);

  const [nextRefresh, setNextRefresh] = useState(180);
  useEffect(() => {
    const id = setInterval(() => {
      setNextRefresh(s => (s <= 1 ? 180 : s - 1));
    }, 1_000);
    return () => clearInterval(id);
  }, []);
  const refreshLabel = nextRefresh >= 60
    ? `${Math.floor(nextRefresh / 60)}m ${String(nextRefresh % 60).padStart(2, '0')}s`
    : `${nextRefresh}s`;

  // v11.16: compact horizontal stat row used in the right column of the
  // primary-focus area. Replaces the bulky NV / Regime / PSS cards in
  // the old 4-column top grid with a slim stack so the AI state block
  // can dominate. The full NVCard / RegimeCard widgets are no longer
  // mounted on the dashboard.
  const liveNV = gcpData.liveNetvar;
  const live15 = series.slice(-15);
  const prev24 = series.length > 24 ? series[series.length - 24] : null;
  const nvDelta = liveNV != null && prev24 ? liveNV - prev24.v : null;

  const liveRegime = gcpData.liveRegime;
  const regimeMeta = liveRegime ? REGIME_META[liveRegime] : null;

  const activePattern = patterns[patterns.length - 1] ?? null;
  const activePss     = activePattern ? pssOf(activePattern) : 0;
  const activeTier    = activePss >= 80 ? 'STRONG' : activePss >= 60 ? 'FORMING' : 'WEAK';

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Primary focus: AI block (left) + compact stats stack (right) */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1.4fr 1fr',
          borderBottom: '1px solid var(--line-0)',
          flexShrink: 0,
        }}>
          <AiStateCard
            state={aiState}
            enabled={aiEnabled}
            flash={pssFlash}
            latestPattern={activePattern}
          />
          <div style={{
            background: 'var(--bg-1)', borderLeft: '1px solid var(--line-0)',
            padding: '10px 16px',
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
            gap: 6,
          }}>
            <StatRow
              label="NV"
              valueColor="var(--cyan)"
              value={liveNV != null ? liveNV.toFixed(1) : '—'}
              meta={nvDelta != null ? `${nvDelta >= 0 ? '+' : ''}${nvDelta.toFixed(1)} vs 24m` : 'live network coherence'}
            >
              <NVSparkline series={live15} />
            </StatRow>
            <StatRow
              label="REGIME"
              valueColor={regimeMeta?.color ?? 'var(--fg-3)'}
              value={liveRegime ? `${liveRegime}` : '—'}
              meta={regimeMeta ? `${regimeMeta.label.toUpperCase()} · ${regimeMeta.range} NV` : 'awaiting first sample'}
            />
            {/* v11.17.1: stats column shows the PSS value + tier
                only. The progress bar lives inside the PatternCard
                below (full-width with tier labels), so the mini bar
                here was pure duplication. */}
            <StatRow
              label="PSS"
              valueColor={activePattern ? '#d4a028' : 'var(--fg-3)'}
              value={activePattern ? `${activePss}` : '—'}
              meta={activePattern ? `${activeTier} · ${activePattern.kind}` : 'no active pattern'}
            />
          </div>
        </div>

        {/* Helper: short note distinguishing the two layers */}
        <div style={{
          padding: '6px 16px', borderBottom: '1px solid var(--line-0)',
          background: 'var(--bg-0)',
          fontSize: 8, letterSpacing: '0.06em', color: 'var(--fg-4)',
          display: 'flex', flexWrap: 'wrap', gap: 14,
        }}>
          <span><span style={{ color: 'var(--fg-3)' }}>AI State</span> = Environment (GCP + Gold)</span>
          <span><span style={{ color: 'var(--fg-3)' }}>Pattern</span> = Event (GCP only)</span>
        </div>

        {/* Pattern (secondary): full-width below AI */}
        <div style={{ flexShrink: 0, borderBottom: '1px solid var(--line-0)' }}>
          <PatternCard patterns={patterns} series={series} flash={pssFlash} />
        </div>

        {/* News feed (lower visual weight) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          <div style={{
            padding: '6px 16px',
            borderBottom: '1px solid var(--line-0)',
            fontSize: 8, letterSpacing: '0.1em', color: 'var(--fg-4)',
            display: 'flex', alignItems: 'center', gap: 8,
            flexShrink: 0,
          }}>
            <div style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--fg-3)' }} />
            GLOBAL EVENTS · COHERENCE-TAGGED
            <span style={{ marginLeft: 'auto', color: 'var(--fg-4)' }}>
              next refresh{' '}
              <span style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                {refreshLabel}
              </span>
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }}>
            {newsLoading && (
              <div style={{
                padding: 24, textAlign: 'center',
                fontSize: 10, color: 'var(--fg-4)', letterSpacing: '0.08em',
              }}>
                LOADING FEED…
              </div>
            )}
            {!newsLoading && newsItems.length === 0 && (
              <div style={{
                padding: 24, textAlign: 'center',
                fontSize: 10, color: 'var(--fg-4)',
              }}>
                No recent items — feed may be temporarily unavailable
              </div>
            )}
            {newsItems.map((item, i) => (
              <NewsRow key={i} item={item} />
            ))}
          </div>
        </div>
      </div>

      <div style={{
        width: 220, borderLeft: '1px solid var(--line-0)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: 'var(--bg-1)',
      }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-0)', flex: 1, overflowY: 'auto' }}>
          <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)', marginBottom: 8 }}>
            PATTERN FEED · {patterns.length} DETECTED
          </div>
          {patterns.slice().reverse().map((p, i) => {
            const dotColor   = p.kind === 'Failed Alignment' ? '#d946ef' : 'var(--cyan)';
            const regime     = regimeOfPattern(p, series) ?? '?';
            const regimeMeta = REGIME_META[regime];
            const regimeTag  = REGIME_TAG_LABEL[regime] ?? regime;
            const time       = p.tStart > 0
              ? new Date(p.tStart).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
              : '—';
            return (
              <div key={i} style={{
                padding: '8px 0', borderBottom: '1px solid var(--bg-0)', fontSize: 9,
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
                    <div style={{
                      width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                      background: dotColor,
                    }} />
                    <span style={{
                      color: 'var(--fg-1)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{p.kind}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                    <span style={{
                      color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>{time}</span>
                    {regimeMeta && (
                      <span style={{
                        padding: '1px 4px', borderRadius: 2,
                        fontSize: 7, letterSpacing: '0.08em',
                        background: regimeMeta.color + '22',
                        color:      regimeMeta.color,
                        border:    `1px solid ${regimeMeta.color}44`,
                      }}>{regimeTag}</span>
                    )}
                  </div>
                </div>
                <div style={{
                  fontSize: 9, color: 'var(--fg-3)', lineHeight: 1.45,
                  marginTop: 2, paddingLeft: 10,
                }}>
                  {PATTERN_ONELINER[p.kind] ?? '—'}
                </div>
              </div>
            );
          })}
          {!patterns.length && (
            <div style={{ fontSize: 9, color: 'var(--fg-4)' }}>No patterns detected</div>
          )}
        </div>
      </div>
    </div>
  );
}
