'use client';

import { useMemo, useState, useEffect } from 'react';
import type { DataPoint, Pattern, MarketSymbol } from '@/types/gcp';
import type { GCPDataState } from '@/lib/useGCPData';
import { useNewsData, type NewsItem } from '@/lib/useNewsData';

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
  'Alignment Ladder':    'Stepwise sync building. Strongest continuation setup.',
  'Compression Coil':    'Energy coiling in A/B. Watching for release trigger.',
  'Compression Release': 'Coil released into alignment. Catalyst likely in play.',
  'Failed Alignment':    'Sync attempt failed. Mean-reversion / fade setup.',
  'Coherence Volcano':   'Single spike, fast return. Sharp move then reversal.',
  'Ignition Drift':      'Sustained ignition, no escalation. Slow drift likely.',
  'Shock Jump':          'Shock jump detected. Extreme volatility — both directions.',
};

const PATTERN_INTERPRETATIONS: Record<string, string> = {
  'Compression Coil':    'Energy accumulating. Range-building. Expansion likely if PSS > 70.',
  'Alignment Ladder':    'Trend environment forming. Highest continuation probability.',
  'Failed Alignment':    'Fake breakout. Low continuation probability. Fade or stand aside.',
  'Shock Jump':          'Extreme coherence event. News/geopolitical reaction. Expect volatility.',
  'Coherence Volcano':   'Single-peak spike into C that mean-reverts immediately.',
  'Compression Release': 'Coil energy releasing upward into C alignment.',
  'Ignition Drift':      'Oscillation within the ignition band; no decisive direction.',
};

const REGIME_ORDER = ['A', 'B', 'C', 'D', 'E', 'F'];

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
      height: 28, marginTop: 10,
    }}>
      {last15.map((p, i) => (
        <div key={i} style={{
          width: 5, borderRadius: 1,
          background: '#4dd9e8',
          opacity: 0.4 + (i / last15.length) * 0.6,
          height: `${Math.max(10, (p.v / (max || 1)) * 100)}%`,
        }} />
      ))}
    </div>
  );
}

function formatSymbolPrice(symbol: MarketSymbol, price: number): string {
  if (symbol === 'BTC')    return `$${Math.round(price).toLocaleString()}`;
  if (symbol === 'XAGUSD') return `$${price.toFixed(3)}`;
  return `$${price.toFixed(2)}`;
}

function NVCard({
  series, liveNV, symbol, symbolPrice,
}: {
  series:      DataPoint[];
  liveNV:      number | null;
  symbol:      MarketSymbol;
  symbolPrice: number | null;
}) {
  const prev = series.length > 24 ? series[series.length - 24] : null;
  const delta = liveNV != null && prev ? liveNV - prev.v : null;

  return (
    <div style={{ background: 'var(--bg-1)', padding: 16, borderRight: '1px solid var(--line-0)' }}>
      <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)', marginBottom: 8 }}>
        NET VARIANCE · LIVE
      </div>
      <div style={{
        fontSize: 44, color: 'var(--cyan)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 1,
        letterSpacing: '-0.02em',
      }}>
        {liveNV?.toFixed(1) ?? '—'}
      </div>
      {delta !== null && (
        <div style={{ fontSize: 9, color: delta > 0 ? 'var(--green)' : 'var(--fg-4)', marginTop: 4 }}>
          {delta > 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(1)} from 24m ago
        </div>
      )}
      <NVSparkline series={series} />
      <div style={{ fontSize: 7, color: 'var(--fg-4)', marginTop: 3 }}>last 15 readings</div>

      {symbolPrice != null && (
        <div style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid var(--line-0)',
          display: 'flex', justifyContent: 'space-between',
          fontSize: 9, color: 'var(--fg-3)',
        }}>
          <span style={{ color: 'var(--fg-4)', letterSpacing: '0.06em' }}>{symbol}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatSymbolPrice(symbol, symbolPrice)}
          </span>
        </div>
      )}
    </div>
  );
}

function RegimeCard({ regime }: { regime: string | null }) {
  const meta = regime ? REGIME_META[regime] : null;

  return (
    <div style={{ background: 'var(--bg-1)', padding: 16, borderRight: '1px solid var(--line-0)' }}>
      <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)', marginBottom: 8 }}>
        REGIME
      </div>
      {meta && regime ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color }} />
            <span style={{ fontSize: 22, color: meta.color }}>{regime}</span>
            <span style={{ fontSize: 11, color: meta.color, opacity: 0.7, letterSpacing: '0.04em' }}>
              {meta.label.toUpperCase()}
            </span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--fg-4)', marginBottom: 10 }}>
            {meta.range} NV range
          </div>
          <div style={{ display: 'flex', gap: 2 }}>
            {REGIME_ORDER.map(r => (
              <div key={r} style={{
                flex: 1, height: 3, borderRadius: 1,
                background: REGIME_META[r].color,
                opacity: r === regime ? 1 : 0.2,
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
            {REGIME_ORDER.map(r => (
              <div key={r} style={{
                flex: 1, fontSize: 7, textAlign: 'center',
                color: r === regime ? REGIME_META[r].color : 'var(--fg-4)',
              }}>
                {r}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 22, color: 'var(--fg-4)' }}>—</div>
      )}
    </div>
  );
}

function PatternCard({ patterns, series, flash }: { patterns: Pattern[]; series: DataPoint[]; flash: boolean }) {
  const latest = patterns[patterns.length - 1] ?? null;

  const flashStyle: React.CSSProperties = flash ? {
    outline:    '1px solid #d4a028',
    animation:  'pssPulse 0.5s ease-in-out 3',
    transition: 'outline 0.3s ease',
  } : {
    outline:    '1px solid transparent',
    transition: 'outline 0.3s ease',
  };

  if (!latest) {
    return (
      <div style={{ background: 'var(--bg-1)', padding: 16, ...flashStyle }}>
        <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)', marginBottom: 8 }}>
          ACTIVE PATTERN · PSS
        </div>
        <div style={{ fontSize: 14, color: 'var(--fg-4)' }}>No pattern detected</div>
      </div>
    );
  }

  const pss    = pssOf(latest);
  const regime = regimeOfPattern(latest, series);
  const bars   = barsOfPattern(latest);
  const tier   = pss >= 80 ? 'STRONG' : pss >= 60 ? 'FORMING' : 'WEAK';

  return (
    <div style={{ background: 'var(--bg-1)', padding: 16, ...flashStyle }}>
      <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)', marginBottom: 8 }}>
        ACTIVE PATTERN · PSS
      </div>
      <div style={{
        fontSize: 38, color: '#d4a028',
        fontVariantNumeric: 'tabular-nums', lineHeight: 1,
      }}>
        {pss}
      </div>
      <div style={{ fontSize: 9, color: '#854f0b', marginTop: 2 }}>
        / 100 · {tier}
      </div>
      <div style={{ fontSize: 10, color: 'var(--fg-1)', marginTop: 6, letterSpacing: '0.02em' }}>
        {latest.kind}
      </div>
      <div style={{ fontSize: 8, color: 'var(--fg-4)', marginTop: 2 }}>
        {regime ?? '?'} · {bars} bars
      </div>
      <div style={{
        height: 4, background: 'var(--bg-2)',
        borderRadius: 2, marginTop: 8, overflow: 'hidden',
      }}>
        <div style={{
          width: `${pss}%`, height: '100%',
          background: '#d4a028', borderRadius: 2,
        }} />
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 7, color: 'var(--fg-4)', marginTop: 2,
      }}>
        <span>WEAK</span><span>FORMING</span><span>STRONG</span><span>EXPLOSIVE</span>
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
}

export default function Dashboard({
  gcpData, series, patterns, symbol, symbolPrice, pssFlash = false,
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
  const latestPattern = patterns[patterns.length - 1] ?? null;

  // For the sparkline / 24m delta we want the last 15 minute-resolution points.
  // baseSeries already supplies this — no further trimming needed.
  // useMemo just keeps the slice stable for the sparkline.
  useMemo(() => series.slice(-15), [series]);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
          borderBottom: '1px solid var(--line-0)',
          flexShrink: 0,
        }}>
          <NVCard
            series={series}
            liveNV={gcpData.liveNetvar}
            symbol={symbol}
            symbolPrice={symbolPrice}
          />
          <RegimeCard regime={gcpData.liveRegime} />
          <PatternCard patterns={patterns} series={series} flash={pssFlash} />
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          <div style={{
            padding: '7px 16px',
            borderBottom: '1px solid var(--line-0)',
            fontSize: 8, letterSpacing: '0.1em', color: 'var(--fg-4)',
            display: 'flex', alignItems: 'center', gap: 8,
            flexShrink: 0,
          }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)' }} />
            GLOBAL EVENTS FEED · Reuters · AP · BBC
            <span style={{ marginLeft: 'auto', color: 'var(--fg-4)' }}>
              tagged by GCP regime at publish time · next refresh{' '}
              <span style={{ color: 'var(--fg-2)', fontFamily: 'var(--font-mono)' }}>
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

        {latestPattern && (
          <div style={{ padding: '10px 14px' }}>
            <div style={{ fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)', marginBottom: 6 }}>
              LATEST
            </div>
            <div style={{ fontSize: 9, color: 'var(--cyan)', letterSpacing: '0.04em', marginBottom: 4 }}>
              {latestPattern.kind}
            </div>
            <div style={{ fontSize: 9, color: 'var(--fg-3)', lineHeight: 1.55 }}>
              {PATTERN_INTERPRETATIONS[latestPattern.kind] ?? '—'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
