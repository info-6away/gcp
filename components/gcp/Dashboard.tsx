'use client';

import { useState, useEffect } from 'react';
import type { DataPoint, Pattern, MarketSymbol, AppPage } from '@/types/gcp';
import type { GCPDataState } from '@/lib/useGCPData';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import type { StructureRead } from '@/lib/priceStructure';
import type { Candle } from '@/lib/fetchCandles';
import { symbolEnvLabel, formatPrice } from '@/types/gcp';
import { useNewsData, type NewsItem } from '@/lib/useNewsData';
import {
  DEFAULT_INTERPRETATION, directionArrow, stateColor,
} from '@/lib/aiState';
import { derivePatternStory } from '@/lib/patternStory';
import { PATTERN_CODE } from '@/lib/patterns-meta';
import {
  loadDemoAccount, computePnl, computeEquity, alignmentLabel,
  alignmentColor, classifyAlignment, DEMO_LS_KEY, STARTING_BALANCE,
  type DemoAccount,
} from '@/lib/demoAccount';

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
  'Plateau Decay':            'Sync plateau fading without confirmed release. Watch for discharge or re-anchor.',
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

// ────────────────────────────────────────────────────────────────────
// v11.27 summary cards. Each renders a compact preview of one tab and
// exposes an Open <Tab> button so the Dashboard becomes navigation
// rather than execution.
// ────────────────────────────────────────────────────────────────────

function CardShell({
  title, subtitle, children, openLabel, onOpen, flash = false, accent,
}: {
  title:      string;
  subtitle?:  string;
  children:   React.ReactNode;
  openLabel?: string;
  onOpen?:    () => void;
  flash?:     boolean;
  accent?:    string;
}) {
  return (
    <div style={{
      background: 'var(--bg-1)',
      padding: '12px 14px',
      borderLeft: accent ? `2px solid ${accent}` : undefined,
      outline: flash ? '1px solid var(--cyan)' : '1px solid transparent',
      transition: 'outline 0.3s ease',
      display: 'flex', flexDirection: 'column',
      minHeight: 130,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 8, marginBottom: 6,
      }}>
        <span style={{ fontSize: 9, letterSpacing: '0.14em', color: 'var(--fg-4)' }}>
          {title}
        </span>
        {subtitle && (
          <span style={{
            fontSize: 8, letterSpacing: '0.08em', color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)',
          }}>
            {subtitle}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
      {openLabel && onOpen && (
        <button
          onClick={onOpen}
          style={{
            marginTop: 10, alignSelf: 'flex-start',
            padding: '3px 10px',
            fontSize: 9, letterSpacing: '0.12em', fontWeight: 600,
            background: 'transparent',
            border: '1px solid var(--line-2)',
            color: 'var(--fg-2)',
            borderRadius: 2,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          {openLabel}
        </button>
      )}
    </div>
  );
}

function GuruSummaryCard({
  aiState, aiEnabled, flash, onOpen,
}: {
  aiState:   GcpStateResponse | null;
  aiEnabled: boolean;
  flash:     boolean;
  onOpen?:   () => void;
}) {
  if (!aiEnabled) {
    return (
      <CardShell title="LATEST GURU ANALYSIS" openLabel="OPEN GURU →" onOpen={onOpen}>
        <div style={{ fontSize: 12, color: 'var(--fg-4)' }}>Guru disabled</div>
        <div style={{ fontSize: 10, color: 'var(--fg-4)', marginTop: 4 }}>
          Enable Guru in Settings to see analysis here.
        </div>
      </CardShell>
    );
  }
  if (!aiState) {
    return (
      <CardShell title="LATEST GURU ANALYSIS" openLabel="OPEN GURU →" onOpen={onOpen} flash={flash}>
        <div style={{ fontSize: 13, color: 'var(--fg-2)', fontWeight: 600 }}>
          Guru not run yet
        </div>
        <div style={{ fontSize: 10, color: '#7F98A3', marginTop: 4, lineHeight: 1.5 }}>
          Open Guru and click "Ask Guru" to capture an analysis.
        </div>
      </CardShell>
    );
  }
  const accent = stateColor(aiState);
  const arrow  = directionArrow(aiState.direction);
  const conf   = Math.round(aiState.confidence * 100);
  const oneLiner = (aiState.reasoningShort?.trim() && aiState.reasoningShort.length <= 90)
    ? aiState.reasoningShort.trim()
    : (DEFAULT_INTERPRETATION[aiState.stateCode] || '—');

  return (
    <CardShell
      title="LATEST GURU ANALYSIS"
      subtitle={aiState.coherenceType.toUpperCase()}
      flash={flash}
      accent={accent}
      openLabel="OPEN GURU →"
      onOpen={onOpen}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontSize: 22, color: accent, fontWeight: 600, letterSpacing: '-0.01em',
        }}>
          {aiState.state.toUpperCase()}
        </span>
        <span style={{ fontSize: 18, color: accent, fontWeight: 600 }}>{arrow}</span>
      </div>
      <div style={{
        display: 'flex', gap: 14, marginTop: 6,
        fontSize: 9, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
        letterSpacing: '0.04em',
      }}>
        <span><span style={{ color: 'var(--fg-4)' }}>PHASE </span>
          <span style={{ color: 'var(--fg-1)' }}>{aiState.phase}</span></span>
        <span><span style={{ color: 'var(--fg-4)' }}>BIAS </span>
          <span style={{ color: 'var(--fg-1)' }}>{aiState.direction}</span></span>
        <span><span style={{ color: 'var(--fg-4)' }}>CONF </span>
          <span style={{ color: 'var(--fg-1)' }}>{conf}%</span></span>
      </div>
      <div style={{
        marginTop: 8,
        fontSize: 11, color: '#B8D1DA', lineHeight: 1.5,
      }}>
        {oneLiner}
      </div>
    </CardShell>
  );
}

function PatternStorySummaryCard({
  patterns, onOpen,
}: {
  patterns: Pattern[];
  onOpen?:  () => void;
}) {
  const story = derivePatternStory({ patterns });
  const empty = story.sequence.length === 0;
  const dom   = story.dominantPattern
    ? PATTERN_CODE[story.dominantPattern]
    : null;
  return (
    <CardShell
      title="LATEST PATTERN STORY"
      subtitle={story.activeCycle.toUpperCase()}
      openLabel="OPEN PATTERNS →"
      onOpen={onOpen}
    >
      {empty ? (
        <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
          No patterns detected in the current window yet.
        </div>
      ) : (
        <>
          <div style={{ display: 'inline-flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
            {story.sequence.map((c, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  padding: '1px 6px',
                  fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600,
                  color: 'var(--cyan)',
                  border: '1px solid rgba(77,217,232,0.45)',
                  background: 'rgba(77,217,232,0.08)',
                  borderRadius: 2,
                }}>{c}</span>
                {i < story.sequence.length - 1 && (
                  <span style={{ color: 'var(--fg-3)', fontSize: 10 }}>→</span>
                )}
              </span>
            ))}
          </div>
          <div style={{
            marginTop: 8, fontSize: 13, color: 'var(--fg-0)',
            fontWeight: 700, letterSpacing: '0.01em',
          }}>
            {story.state}
          </div>
          <div style={{ fontSize: 10, color: 'var(--fg-2)', marginTop: 4, lineHeight: 1.45 }}>
            {story.posture}
          </div>
          {dom && (
            <div style={{ fontSize: 9, color: 'var(--fg-4)', marginTop: 4, letterSpacing: '0.08em' }}>
              DOMINANT <span style={{ color: 'var(--fg-2)' }}>{dom}</span>
            </div>
          )}
        </>
      )}
    </CardShell>
  );
}

function MarketSnapshotCard({
  symbol, symbolPrice, liveNV, nvDelta, regime, latestPattern, series,
}: {
  symbol:        MarketSymbol;
  symbolPrice:   number | null;
  liveNV:        number | null;
  nvDelta:       number | null;
  regime:        string | null;
  latestPattern: Pattern | null;
  series:        DataPoint[];
}) {
  const regimeMeta = regime ? REGIME_META[regime] : null;
  const pss = latestPattern ? Math.round(latestPattern.strength * 100) : null;
  return (
    <CardShell title="MARKET / COHERENCE">
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
        fontSize: 10,
      }}>
        <div>
          <div style={{ color: 'var(--fg-4)', fontSize: 8, letterSpacing: '0.12em' }}>NV</div>
          <div style={{
            fontSize: 17, color: 'var(--cyan)', fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums', fontWeight: 600,
          }}>
            {liveNV != null ? liveNV.toFixed(1) : '—'}
          </div>
          {nvDelta != null && (
            <div style={{ fontSize: 9, color: 'var(--fg-4)', marginTop: 2 }}>
              {nvDelta >= 0 ? '+' : ''}{nvDelta.toFixed(1)} vs 24m
            </div>
          )}
          <NVSparkline series={series} />
        </div>
        <div>
          <div style={{ color: 'var(--fg-4)', fontSize: 8, letterSpacing: '0.12em' }}>{symbol}</div>
          <div style={{
            fontSize: 17, color: 'var(--fg-0)', fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums', fontWeight: 600,
          }}>
            {symbolPrice != null ? formatPrice(symbolPrice, symbol) : '—'}
          </div>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8,
            color: 'var(--fg-4)', fontSize: 8, letterSpacing: '0.12em',
          }}>REGIME</div>
          <div style={{
            fontSize: 13,
            color: regimeMeta?.color ?? 'var(--fg-3)',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
            marginTop: 2,
          }}>
            {regime ?? '—'}
            {regimeMeta && (
              <span style={{
                marginLeft: 6, fontSize: 9, color: 'var(--fg-3)',
                letterSpacing: '0.04em',
              }}>{regimeMeta.label}</span>
            )}
          </div>
          {pss != null && latestPattern && (
            <div style={{
              fontSize: 9, color: 'var(--fg-4)', marginTop: 6,
              fontFamily: 'var(--font-mono)',
            }}>
              <span style={{ letterSpacing: '0.1em' }}>PSS </span>
              <span style={{ color: pss >= 70 ? 'var(--green)' : pss >= 50 ? 'var(--amber)' : 'var(--fg-2)' }}>
                {pss}
              </span>
              <span style={{ color: 'var(--fg-4)' }}> · {latestPattern.kind}</span>
            </div>
          )}
        </div>
      </div>
    </CardShell>
  );
}

function DemoSummaryCard({
  symbol, symbolPrice, onOpen,
}: {
  symbol:      MarketSymbol;
  symbolPrice: number | null;
  onOpen?:     () => void;
}) {
  const [acct, setAcct] = useState<DemoAccount>(() => loadDemoAccount());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DEMO_LS_KEY) return;
      setAcct(loadDemoAccount());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // Repaint open PnL once a second when there's an active position so
  // the dashboard ticks alongside the live price.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!acct.open) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [acct.open]);

  const open = acct.open;
  const positionSymbolMismatch = !!open && open.context.symbol !== symbol;
  const openPnl = open && symbolPrice != null && !positionSymbolMismatch
    ? computePnl(open.side, open.entryPrice, symbolPrice, open.size)
    : 0;
  const equity = positionSymbolMismatch ? acct.balance : computeEquity(acct, symbolPrice);
  const liveAlignment = open ? classifyAlignment(open.side, open.context) : null;
  const fmtMoney = (n: number, signed = false): string => {
    const abs = Math.abs(n);
    const s = `$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (n < 0)         return `-${s}`;
    if (signed && n > 0) return `+${s}`;
    return s;
  };
  return (
    <CardShell
      title="LATEST DEMO TRADE"
      subtitle={open ? open.context.symbol : 'FLAT'}
      openLabel="OPEN TRD →"
      onOpen={onOpen}
    >
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 10,
      }}>
        <div>
          <div style={{ color: 'var(--fg-4)', fontSize: 8, letterSpacing: '0.12em' }}>EQUITY</div>
          <div style={{
            fontSize: 14, fontFamily: 'var(--font-mono)',
            color: equity >= STARTING_BALANCE ? 'var(--green)' : 'var(--red)',
            fontVariantNumeric: 'tabular-nums', fontWeight: 600,
          }}>
            {fmtMoney(equity)}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--fg-4)', fontSize: 8, letterSpacing: '0.12em' }}>OPEN PnL</div>
          <div style={{
            fontSize: 14, fontFamily: 'var(--font-mono)',
            color: positionSymbolMismatch ? 'var(--fg-3)'
                 : openPnl > 0 ? 'var(--green)'
                 : openPnl < 0 ? 'var(--red)' : 'var(--fg-3)',
            fontVariantNumeric: 'tabular-nums', fontWeight: 600,
          }}>
            {open && !positionSymbolMismatch ? fmtMoney(openPnl, true) : '—'}
          </div>
        </div>
      </div>
      {open ? (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          <span style={{
            color: open.side === 'long' ? 'var(--green)' : 'var(--red)',
            fontWeight: 600, letterSpacing: '0.08em',
          }}>
            {open.side === 'long' ? 'LONG' : 'SHORT'}
          </span>
          <span style={{ color: 'var(--fg-4)' }}> · {fmtMoney(open.size)} @ {formatPrice(open.entryPrice, open.context.symbol)}</span>
          {liveAlignment && !positionSymbolMismatch && (
            <span style={{ color: alignmentColor(liveAlignment), marginLeft: 6, fontSize: 9 }}>
              · {alignmentLabel(liveAlignment)}
            </span>
          )}
          {positionSymbolMismatch && (
            <span style={{ color: '#d4a028', marginLeft: 6, fontSize: 9 }}>
              · switch to {open.context.symbol} to manage
            </span>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-3)' }}>
          No open position · realized PnL {fmtMoney(acct.realizedPnl, true)}
        </div>
      )}
    </CardShell>
  );
}

interface DashboardProps {
  gcpData:        GCPDataState;
  series:         DataPoint[];
  patterns:       Pattern[];
  symbol:         MarketSymbol;
  symbolPrice:    number | null;
  pssFlash?:      boolean;
  aiState:        GcpStateResponse | null;
  aiEnabled:      boolean;
  aiRunNow:       (options?: { force?: boolean; source?: string }) => void;
  aiStatus:       AiStatus;
  aiLastSuccess:  Date | null;
  planStructure:  StructureRead;
  planAnalysisCandle: Candle | null;
  // v11.27: Dashboard is now a summary surface — its cards link out
  // to Guru / Patterns / TRD via this nav callback.
  onNav?:         (page: AppPage) => void;
}

export default function Dashboard({
  gcpData, series, patterns, symbol, symbolPrice, pssFlash = false,
  aiState, aiEnabled, aiRunNow, aiStatus, aiLastSuccess,
  planStructure, planAnalysisCandle, onNav,
}: DashboardProps) {
  // Mark planStructure / planAnalysisCandle / aiRunNow / aiStatus /
  // aiLastSuccess as referenced — they're plumbed for v11.28+ but the
  // current summary view doesn't render them directly. Suppresses
  // TS6133 if the linter ever flips on it.
  void planStructure; void planAnalysisCandle;
  void aiRunNow;       void aiStatus;       void aiLastSuccess;
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

  // v11.18.1: only the latest pattern reference is needed at the
  // Dashboard level — passed into AiStateCard so derivePosture() can
  // factor PSS / kind into mode/action/trigger/size. PatternCard
  // computes its own display PSS + tier internally.
  const activePattern = patterns[patterns.length - 1] ?? null;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* v11.27: Dashboard is now a summary surface. Four compact
            cards across the top — Guru / Pattern Story / Market /
            Demo. Each links to its full-detail tab. */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 1,
          background: 'var(--line-0)',
          borderBottom: '1px solid var(--line-0)',
          flexShrink: 0,
        }}>
          <GuruSummaryCard
            aiState={aiState}
            aiEnabled={aiEnabled}
            flash={pssFlash}
            onOpen={() => onNav?.('guru')}
          />
          <PatternStorySummaryCard
            patterns={patterns}
            onOpen={() => onNav?.('pattern')}
          />
          <MarketSnapshotCard
            symbol={symbol}
            symbolPrice={symbolPrice}
            liveNV={liveNV}
            nvDelta={nvDelta}
            regime={liveRegime}
            latestPattern={activePattern}
            series={live15}
          />
          <DemoSummaryCard
            symbol={symbol}
            symbolPrice={symbolPrice}
            onOpen={() => onNav?.('trading')}
          />
        </div>

        {/* Helper: short note distinguishing the two layers */}
        <div style={{
          padding: '6px 16px', borderBottom: '1px solid var(--line-0)',
          background: 'var(--bg-0)',
          fontSize: 8, letterSpacing: '0.06em', color: 'var(--fg-4)',
          display: 'flex', flexWrap: 'wrap', gap: 14,
        }}>
          <span><span style={{ color: 'var(--fg-3)' }}>Guru</span> = Environment (GCP + {symbolEnvLabel(symbol)})</span>
          <span><span style={{ color: 'var(--fg-3)' }}>Pattern</span> = Event (GCP only)</span>
        </div>

        {/* Pattern (secondary): full-width below summaries */}
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
