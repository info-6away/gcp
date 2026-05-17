'use client';

// v14.2 — Phase 14.2: News / Events tab.
//
// News moved out of the Dashboard into its own surface. This is NOT
// a headline feed — it answers "what happened in the world, and did
// coherence react?". Every item carries TWO independent reads:
//
//   NEWS IMPORTANCE   — editorial significance (classifyNews)
//   COHERENCE REACTION — did the GCP field actually move around the
//                        event (deriveNewsReactionScore)
//
// Pure presentation over the existing news feed + GCP series. No
// Engine, no Radar, no Trade, no pattern-detection changes.

import { useMemo, useState } from 'react';
import type { DataPoint, Pattern } from '@/types/gcp';
import { useNewsData, type NewsItem } from '@/lib/useNewsData';
import {
  classifyNews, deriveNewsReactionScore,
  type NewsCategory, type NewsImportance,
  type NewsReaction, type ReactionLabel,
} from '@/lib/newsAnalysis';
import { PageHeader } from '@/components/gcp/Chrome';

// ── palette ─────────────────────────────────────────────────────────

const REACTION_COLOR: Record<ReactionLabel, string> = {
  none:     'var(--fg-4)',
  low:      'var(--fg-3)',
  moderate: '#d4a028',
  high:     'var(--cyan)',
  extreme:  'var(--magenta)',
};

const IMPORTANCE_COLOR: Record<NewsImportance, string> = {
  high:   '#d4a028',
  medium: 'var(--fg-2)',
  low:    'var(--fg-3)',
};

const CATEGORY_LABEL: Record<NewsCategory, string> = {
  macro: 'MACRO', geopolitics: 'GEOPOLITICS', markets: 'MARKETS',
  crypto: 'CRYPTO', gold: 'GOLD', fx: 'FX', general: 'GENERAL',
};

type Filter =
  'all' | 'major' | 'reaction'
  | 'macro' | 'geopolitics' | 'markets' | 'crypto' | 'gold' | 'fx';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all',         label: 'All' },
  { id: 'major',       label: 'Major' },
  { id: 'reaction',    label: 'Coherence reaction' },
  { id: 'macro',       label: 'Macro' },
  { id: 'geopolitics', label: 'Geopolitics' },
  { id: 'markets',     label: 'Markets' },
  { id: 'crypto',      label: 'Crypto' },
  { id: 'gold',        label: 'Gold' },
  { id: 'fx',          label: 'FX' },
];

// ── time helpers ────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function relAge(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 60)  return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface EnrichedNews {
  item:       NewsItem;
  category:   NewsCategory;
  importance: NewsImportance;
  reaction:   NewsReaction;
}

// ════════════════════════════════════════════════════════════════════

export default function NewsView({
  series, patterns,
}: {
  series:   DataPoint[];
  patterns: Pattern[];
}) {
  const { items, loading, error } = useNewsData(series);
  const [filter, setFilter]     = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  // Enrich every headline with editorial + coherence reads. Memoised
  // on (items, series) — the reaction scan walks ~120 series points
  // per item, trivial for ~30 items but no reason to redo per render.
  const enriched = useMemo<EnrichedNews[]>(() => {
    return items.map(item => {
      const { category, importance } = classifyNews(item.title);
      const reaction = deriveNewsReactionScore({
        newsTimestamp: item.publishedAt,
        gcpSeries:     series,
        patterns,
      });
      return { item, category, importance, reaction };
    });
  }, [items, series, patterns]);

  // Summary metrics.
  const summary = useMemo(() => {
    const total      = enriched.length;
    const major      = enriched.filter(e => e.importance === 'high').length;
    const reactions  = enriched.filter(
      e => e.reaction.label === 'moderate'
        || e.reaction.label === 'high'
        || e.reaction.label === 'extreme',
    ).length;
    // Most reactive category — highest total reaction score.
    const catScore: Partial<Record<NewsCategory, number>> = {};
    for (const e of enriched) {
      catScore[e.category] = (catScore[e.category] ?? 0) + e.reaction.score;
    }
    let topCat: NewsCategory | null = null, topVal = 0;
    for (const [c, v] of Object.entries(catScore)) {
      if (v > topVal) { topVal = v; topCat = c as NewsCategory; }
    }
    const latestMajor = enriched
      .filter(e => e.importance === 'high')
      .sort((a, b) => b.item.publishedAt - a.item.publishedAt)[0] ?? null;
    return { total, major, reactions, topCat, latestMajor };
  }, [enriched]);

  // Filtered + sorted (newest first).
  const list = useMemo(() => {
    const f = enriched.filter(e => {
      switch (filter) {
        case 'all':      return true;
        case 'major':    return e.importance === 'high';
        case 'reaction': return e.reaction.label === 'moderate'
                              || e.reaction.label === 'high'
                              || e.reaction.label === 'extreme';
        default:         return e.category === filter;
      }
    });
    return f.sort((a, b) => b.item.publishedAt - a.item.publishedAt);
  }, [enriched, filter]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
    }}>
      <PageHeader crumbs={[{ label: 'News / Events' }]} />

      <div style={{
        flex: 1, overflow: 'auto', padding: 18,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{
            fontSize: 9, letterSpacing: '0.2em', color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
          }}>
            NEWS / EVENTS
          </span>
          <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>
            Global events and coherence reaction.
          </span>
        </div>

        {/* Summary cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 10,
        }}>
          <SummaryCard label="Total headlines" value={String(summary.total)} />
          <SummaryCard label="Major news" value={String(summary.major)}
            accent="#d4a028" />
          <SummaryCard label="High coherence reactions" value={String(summary.reactions)}
            accent="var(--cyan)" />
          <SummaryCard label="Most reactive category"
            value={summary.topCat ? CATEGORY_LABEL[summary.topCat] : '—'} />
          <SummaryCard label="Latest major event"
            value={summary.latestMajor
              ? truncate(summary.latestMajor.item.title, 60)
              : '—'}
            wide />
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FILTERS.map(f => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                style={{
                  minHeight: 36, padding: '7px 12px',
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                  fontFamily: 'var(--font-mono)',
                  background: active ? 'rgba(77,217,232,0.12)' : 'transparent',
                  border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-2)'}`,
                  color: active ? 'var(--cyan)' : 'var(--fg-3)',
                  borderRadius: 3, cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.label.toUpperCase()}
              </button>
            );
          })}
        </div>

        {/* List */}
        {loading && enriched.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>Loading headlines…</div>
        )}
        {error && (
          <div style={{ fontSize: 11, color: 'var(--red)' }}>
            News feed unavailable — {error}
          </div>
        )}
        {!loading && list.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            No headlines match this filter.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map(e => (
            <NewsRow
              key={e.item.link + e.item.publishedAt}
              data={e}
              expanded={expanded === e.item.link}
              onToggle={() => setExpanded(prev =>
                prev === e.item.link ? null : e.item.link)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── summary card ────────────────────────────────────────────────────

function SummaryCard({
  label, value, accent, wide,
}: {
  label: string; value: string; accent?: string; wide?: boolean;
}) {
  return (
    <div style={{
      gridColumn: wide ? '1 / -1' : undefined,
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)',
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <span style={{
        fontSize: 8, letterSpacing: '0.14em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        {label.toUpperCase()}
      </span>
      <span style={{
        fontSize: wide ? 12 : 18, fontWeight: wide ? 500 : 800,
        color: accent ?? 'var(--fg-0)', lineHeight: 1.2,
      }}>
        {value}
      </span>
    </div>
  );
}

// ── news row ────────────────────────────────────────────────────────

function NewsRow({
  data, expanded, onToggle,
}: {
  data:     EnrichedNews;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { item, category, importance, reaction } = data;
  const reactColor = REACTION_COLOR[reaction.label];

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: `3px solid ${reactColor}`,
      borderRadius: 'var(--r-md)',
      overflow: 'hidden',
    }}>
      {/* Header — tap to expand */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
        }}
        style={{
          padding: '11px 13px', cursor: 'pointer', userSelect: 'none',
          display: 'flex', flexDirection: 'column', gap: 7,
        }}
      >
        <div style={{
          fontSize: 12, color: 'var(--fg-0)', lineHeight: 1.45, fontWeight: 500,
        }}>
          {item.title}
        </div>

        {/* meta line */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
          fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--fg-3)',
          letterSpacing: '0.04em',
        }}>
          <span>{item.source}</span>
          <span>{fmtTime(item.publishedAt)} · {relAge(item.publishedAt)}</span>
          <span style={{ color: 'var(--fg-4)' }}>{CATEGORY_LABEL[category]}</span>
          {/* v14.3: candidate source — RSS feed vs Brave search. */}
          <span style={{
            color: 'var(--fg-4)',
            border: '1px solid var(--line-2)', borderRadius: 2,
            padding: '0 4px', fontSize: 8, letterSpacing: '0.1em',
          }}>
            {(item.provider ?? 'rss').toUpperCase()}
          </span>
        </div>

        {/* the two distinct reads */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Metric label="News importance"
            value={importance.toUpperCase()}
            color={IMPORTANCE_COLOR[importance]} />
          <Metric label="Coherence reaction"
            value={reaction.label === 'none'
              ? 'NONE'
              : `${reaction.label.toUpperCase()} · ${reaction.timing} · ${reaction.score}`}
            color={reactColor} />
        </div>
      </div>

      {/* Expansion */}
      {expanded && (
        <div style={{
          borderTop: '1px solid var(--line-1)',
          padding: '11px 13px',
          display: 'flex', flexDirection: 'column', gap: 9,
        }}>
          <div style={{
            fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.5,
          }}>
            {reaction.explanation}
          </div>

          {/* reaction detail rows */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 3,
            fontSize: 10, fontFamily: 'var(--font-mono)',
          }}>
            <DetailRow label="Reaction score"
              value={`${reaction.score} / 100 · ${reaction.label}`} />
            <DetailRow label="Reaction window"
              value={reaction.timing === 'none' ? '—'
                : reaction.timing === 'delayed'
                  ? `delayed (+${reaction.peakOffsetMin}m)`
                  : reaction.timing} />
            <DetailRow label="Dominant signal" value={reaction.dominantSignal} />
            {reaction.baselineNV != null && reaction.peakNV != null && (
              <DetailRow label="NV baseline → peak"
                value={`${reaction.baselineNV} → ${reaction.peakNV}`
                  + (reaction.peakOffsetMin != null
                    ? ` (${reaction.peakOffsetMin >= 0 ? '+' : ''}${reaction.peakOffsetMin}m)`
                    : '')} />
            )}
            {reaction.regimeShift && (
              <DetailRow label="Regime transition"
                value={`${reaction.regimeShift.from} → ${reaction.regimeShift.to}`} />
            )}
          </div>

          {/* mini timeline */}
          {reaction.spark && (
            <ReactionSpark
              spark={reaction.spark}
              color={reactColor}
              regimeShift={!!reaction.regimeShift}
            />
          )}

          <a
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              alignSelf: 'flex-start',
              fontSize: 9, letterSpacing: '0.1em', fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              color: 'var(--cyan)', textDecoration: 'none',
              border: '1px solid var(--cyan)', borderRadius: 3,
              padding: '7px 12px', minHeight: 36,
              display: 'inline-flex', alignItems: 'center',
            }}
          >
            READ SOURCE →
          </a>
        </div>
      )}
    </div>
  );
}

function Metric({
  label, value, color,
}: {
  label: string; value: string; color: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{
        fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        {label.toUpperCase()}
      </span>
      <span style={{
        fontSize: 11, fontWeight: 700, color,
        fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
      }}>
        {value}
      </span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '130px 1fr', gap: 8,
      alignItems: 'baseline',
    }}>
      <span style={{ color: 'var(--fg-4)', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ color: 'var(--fg-1)' }}>{value}</span>
    </div>
  );
}

// ── mini reaction timeline ──────────────────────────────────────────
// A compact NV sparkline across T-60 .. T+60 with the event marked.
// Deliberately bar-based — no charting library, no axes.

function ReactionSpark({
  spark, color, regimeShift,
}: {
  spark:       { nv: number[]; eventIdx: number };
  color:       string;
  regimeShift: boolean;
}) {
  const { nv, eventIdx } = spark;
  const max = Math.max(...nv, 1);
  const min = Math.min(...nv);
  const range = Math.max(max - min, 1);
  const peakIdx = nv.indexOf(max);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontSize: 8, letterSpacing: '0.12em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        NV TIMELINE · −60m → EVENT → +60m
      </span>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 1,
        height: 44,
        background: 'var(--bg-2)',
        border: '1px solid var(--line-1)',
        borderRadius: 3, padding: '3px 4px',
      }}>
        {nv.map((v, i) => {
          const h = 6 + ((v - min) / range) * 32;
          const isEvent = i === eventIdx;
          const isPeak  = i === peakIdx;
          return (
            <div key={i} style={{
              flex: 1,
              height: h,
              background: isEvent ? 'var(--fg-1)'
                : isPeak ? color
                : 'var(--line-3)',
              borderRadius: 0.5,
              minWidth: 1,
            }} />
          );
        })}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 8, color: 'var(--fg-4)', fontFamily: 'var(--font-mono)',
      }}>
        <span>−60m</span>
        <span style={{ color: 'var(--fg-2)' }}>EVENT</span>
        <span>+60m</span>
      </div>
      <div style={{ fontSize: 8, color: 'var(--fg-3)', display: 'flex', gap: 12 }}>
        <span><span style={{ color: 'var(--fg-1)' }}>▮</span> event</span>
        <span><span style={{ color }}>▮</span> NV peak</span>
        {regimeShift && <span style={{ color: 'var(--fg-3)' }}>regime shifted</span>}
      </div>
    </div>
  );
}
