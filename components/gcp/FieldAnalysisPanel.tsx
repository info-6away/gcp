'use client';

// v15.1 — Phase 15.1: unified FIELD ANALYSIS panel.
//
// The 14.x / 15.0 diagnostics each shipped as their own bordered
// card. Individually valuable, collectively a long scroll before the
// scan results. This consolidates all of them into ONE collapsible
// surface: an always-visible summary row + pills, then an accordion
// of six sections (Overview / Families / Opportunity / Ladder Audit
// / Memory / Session) with only Overview open by default.
//
// Pure presentation. Every number here comes from the same derived
// objects the cards used — no Engine, payload, threshold, or scan
// change. The helpers (deriveFieldDispersion, deriveFieldMood, …)
// are untouched; this only re-presents their output.

import { useState } from 'react';
import type { MarketSymbol } from '@/types/gcp';
import { getSymbolMeta } from '@/types/gcp';
import type { FieldDispersion, DispersionLevel } from '@/lib/fieldDispersion';
import type { FieldMood, FieldMoodSentiment } from '@/lib/fieldMood';
import type { FieldDiagnosis, DiagnosisSeverity } from '@/lib/fieldDiagnosis';
import type {
  FamilyParticipation, FamilyMood, FamilyDivergence,
} from '@/lib/marketFamilies';
import { FAMILY_LABEL } from '@/lib/marketFamilies';
import type { FieldRecurrence } from '@/lib/fieldMemory';
import type { ActionLadderAudit } from '@/lib/actionLadderAudit';
import type { OpportunityWeather, OpportunityStatus } from '@/lib/opportunityDistance';
import type { FieldParticipation, LiquidityLevel } from '@/lib/sessionContext';
import type { SymbolIndividuality } from '@/lib/symbolIndividuality';
import type { FieldAnchoring } from '@/lib/classificationInfluence';

export interface DominanceSummary {
  avgField: number;
  highest:  { symbol: MarketSymbol; ind: SymbolIndividuality };
  lowest:   { symbol: MarketSymbol; ind: SymbolIndividuality };
}

interface FieldAnalysisPanelProps {
  participation:    FieldParticipation | null;
  dispersion:       FieldDispersion | null;
  dominance:        DominanceSummary | null;
  mood:             FieldMood | null;
  diagnosis:        FieldDiagnosis | null;
  families:         FamilyParticipation[];
  familyDivergence: FamilyDivergence;
  recurrence:       FieldRecurrence | null;
  ladderAudit:      ActionLadderAudit | null;
  oppWeather:       OpportunityWeather | null;
  anchoring:        FieldAnchoring | null;
  counts:           Partial<Record<string, number>>;
}

// ── palettes ────────────────────────────────────────────────────────

const DISPERSION_COLOR: Record<DispersionLevel, string> = {
  very_low: '#4dd9e8', low: '#4dd9e8', moderate: '#d4a028',
  high: '#d4a028', extreme: 'var(--magenta)',
};
const MOOD_COLOR: Record<FieldMoodSentiment, string> = {
  opportunity: 'var(--green)', defensive: '#c45a5a', fragmented: 'var(--magenta)',
  synchronized: 'var(--cyan)', neutral: 'var(--fg-2)',
};
const DIAGNOSIS_COLOR: Record<DiagnosisSeverity, string> = {
  calm: 'var(--green)', watch: 'var(--cyan)', warning: '#d4a028', risk: '#c45a5a',
};
const FAMILY_MOOD_COLOR: Record<FamilyMood, string> = {
  strong: 'var(--green)', improving: 'var(--cyan)', mixed: '#d4a028',
  weak: '#c45a5a', blocked: '#c45a5a',
};
const OPP_STATUS_COLOR: Record<OpportunityStatus, string> = {
  far: 'var(--fg-3)', building: '#d4a028', near: 'var(--cyan)',
  imminent: 'var(--green)', go: 'var(--green)',
};
const LIQUIDITY_COLOR: Record<LiquidityLevel, string> = {
  low: '#c45a5a', moderate: '#d4a028', high: 'var(--green)',
};

const SUBTLE = 'rgba(0,255,255,0.12)';

function argmaxKey(rec: Record<string, number>): { key: string; n: number } {
  let key = '', n = -1;
  for (const [k, v] of Object.entries(rec)) if (v > n) { n = v; key = k; }
  return { key, n };
}

// ════════════════════════════════════════════════════════════════════

type SectionId = 'overview' | 'families' | 'opportunity' | 'ladder' | 'memory' | 'session';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'overview',    label: 'Overview' },
  { id: 'families',    label: 'Families' },
  { id: 'opportunity', label: 'Opportunity' },
  { id: 'ladder',      label: 'Ladder Audit' },
  { id: 'memory',      label: 'Memory' },
  { id: 'session',     label: 'Session' },
];

export default function FieldAnalysisPanel(props: FieldAnalysisPanelProps) {
  const {
    participation, dispersion, dominance, mood, diagnosis,
    families, familyDivergence, recurrence, ladderAudit, oppWeather,
    anchoring, counts,
  } = props;

  const [open, setOpen] = useState<Set<SectionId>>(() => new Set<SectionId>(['overview']));
  const toggle = (id: SectionId) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ── summary facts ─────────────────────────────────────────────────
  const oppTop = oppWeather ? argmaxKey(oppWeather.counts) : null;
  const leadFamily = pickLeadFamily(families);
  const facts: { label: string; value: string; color?: string }[] = [
    { label: 'Mood',
      value: mood?.title ?? '—',
      color: mood ? MOOD_COLOR[mood.sentiment] : undefined },
    { label: 'Dispersion',
      value: dispersion ? dispersion.level.replace('_', ' ') : '—',
      color: dispersion ? DISPERSION_COLOR[dispersion.level] : undefined },
    { label: 'Opportunity',
      value: oppTop && oppTop.n > 0 ? cap(oppTop.key) : '—',
      color: oppTop ? OPP_STATUS_COLOR[oppTop.key as OpportunityStatus] : undefined },
    { label: 'Families',
      value: leadFamily ? `${FAMILY_LABEL[leadFamily.family]} ${leadFamily.mood}` : '—',
      color: leadFamily ? FAMILY_MOOD_COLOR[leadFamily.mood] : undefined },
    { label: 'Memory',
      value: recurrence
        ? (recurrence.matches > 0 ? `Seen ${recurrence.matches}×` : `${recurrence.totalScans} scans`)
        : '—' },
    { label: 'Anchoring',
      value: anchoring ? `${anchoring.avgFieldInfluence}% field` : '—',
      color: anchoring
        ? (anchoring.avgFieldInfluence >= 75 ? '#d4a028'
         : anchoring.avgFieldInfluence >= 58 ? 'var(--fg-1)' : 'var(--green)')
        : undefined },
  ];

  const pills: { text: string; color?: string }[] = [
    { text: `${counts.BLOCKED ?? 0} BLOCKED`, color: '#c45a5a' },
    { text: `${counts.READY ?? 0} READY`,     color: 'var(--cyan)' },
    ...(oppTop && oppTop.n > 0
      ? [{ text: `${cap(oppTop.key)}: ${oppTop.n}`,
           color: OPP_STATUS_COLOR[oppTop.key as OpportunityStatus] }]
      : []),
    { text: `Divergence: ${familyDivergence.detected ? 'detected' : 'none'}`,
      color: familyDivergence.detected ? '#d4a028' : 'var(--fg-3)' },
  ];

  return (
    <div style={{
      border: `1px solid ${SUBTLE}`,
      borderRadius: 'var(--r-md)',
      background: 'var(--bg-1)',
      maxHeight: 420,
      overflowY: 'auto',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Summary row — always visible */}
      <div style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${SUBTLE}`,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: 9, letterSpacing: '0.2em', color: 'var(--fg-3)',
            fontFamily: 'var(--font-mono)', fontWeight: 700,
          }}>
            FIELD ANALYSIS
          </span>
          {facts.map(f => (
            <span key={f.label} style={{
              fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
              color: 'var(--fg-4)',
            }}>
              {f.label}:{' '}
              <b style={{ color: f.color ?? 'var(--fg-1)', fontWeight: 600 }}>
                {f.value}
              </b>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {pills.map((p, i) => (
            <span key={i} style={{
              fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
              fontFamily: 'var(--font-mono)',
              color: p.color ?? 'var(--fg-3)',
              border: `1px solid ${SUBTLE}`,
              borderRadius: 3, padding: '2px 7px',
            }}>
              {p.text}
            </span>
          ))}
        </div>
      </div>

      {/* Accordion */}
      {SECTIONS.map(s => (
        <Section
          key={s.id}
          label={s.label}
          expanded={open.has(s.id)}
          onToggle={() => toggle(s.id)}
        >
          {s.id === 'overview'    && <OverviewBody    dispersion={dispersion} mood={mood} diagnosis={diagnosis} dominance={dominance} anchoring={anchoring} />}
          {s.id === 'families'    && <FamiliesBody    families={families} divergence={familyDivergence} />}
          {s.id === 'opportunity' && <OpportunityBody w={oppWeather} />}
          {s.id === 'ladder'      && <LadderBody      a={ladderAudit} />}
          {s.id === 'memory'      && <MemoryBody      r={recurrence} />}
          {s.id === 'session'     && <SessionBody     p={participation} />}
        </Section>
      ))}
    </div>
  );
}

// ── section shell ───────────────────────────────────────────────────

function Section({
  label, expanded, onToggle, children,
}: {
  label: string; expanded: boolean; onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: `1px solid ${SUBTLE}` }}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
        }}
        style={{
          padding: '8px 14px', cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <span style={{
          color: expanded ? 'var(--cyan)' : 'var(--fg-4)',
          fontSize: 9, transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s ease', display: 'inline-block',
        }}>▸</span>
        <span style={{
          fontSize: 9, letterSpacing: '0.16em', fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          color: expanded ? 'var(--fg-1)' : 'var(--fg-3)',
        }}>
          {label.toUpperCase()}
        </span>
      </div>
      {expanded && (
        <div style={{ padding: '2px 14px 12px 30px' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── section bodies ──────────────────────────────────────────────────

function Empty({ text }: { text: string }) {
  return <span style={{ fontSize: 10, color: 'var(--fg-4)' }}>{text}</span>;
}
const rowStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--fg-2)', fontFamily: 'var(--font-mono)',
  lineHeight: 1.5,
};

function OverviewBody({
  dispersion, mood, diagnosis, dominance, anchoring,
}: {
  dispersion: FieldDispersion | null; mood: FieldMood | null;
  diagnosis: FieldDiagnosis | null;
  dominance: DominanceSummary | null;
  anchoring: FieldAnchoring | null;
}) {
  if (!dispersion) return <Empty text="Scan to populate the field overview." />;
  const anchorColor = anchoring
    ? (anchoring.avgFieldInfluence >= 75 ? '#d4a028'
     : anchoring.avgFieldInfluence >= 58 ? 'var(--fg-1)' : 'var(--green)')
    : 'var(--fg-1)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={rowStyle}>
        <span style={{ color: 'var(--fg-4)' }}>Dispersion · </span>
        <b style={{ color: DISPERSION_COLOR[dispersion.level] }}>
          {dispersion.level.replace('_', ' ').toUpperCase()}
        </b>
        {' '}· {dispersion.agreeCount}/{dispersion.total} agree ·
        {' '}dominant {dispersion.dominantState} → {dispersion.dominantAction}
        {' '}· diversity {dispersion.diversity}
      </div>
      <div style={{ ...rowStyle, color: 'var(--fg-1)' }}>{dispersion.summary}</div>
      {diagnosis && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={rowStyle}>
            <span style={{ color: 'var(--fg-4)' }}>Diagnosis · </span>
            <b style={{ color: DIAGNOSIS_COLOR[diagnosis.severity] }}>{diagnosis.title}</b>
          </div>
          <div style={{ ...rowStyle, color: 'var(--fg-2)' }}>{diagnosis.summary}</div>
          {diagnosis.bullets.map((b, i) => (
            <div key={i} style={{ ...rowStyle, fontSize: 9, color: 'var(--fg-3)' }}>· {b}</div>
          ))}
        </div>
      )}
      {mood && (
        <div style={rowStyle}>
          <span style={{ color: 'var(--fg-4)' }}>Mood · </span>
          <b style={{ color: MOOD_COLOR[mood.sentiment] }}>{mood.title}</b>
          {' '}— {mood.description}
        </div>
      )}
      {dominance && (
        <div style={{ ...rowStyle, fontSize: 9, color: 'var(--fg-3)' }}>
          Field weight avg {dominance.avgField}% · highest{' '}
          {getSymbolMeta(dominance.highest.symbol).id} {dominance.highest.ind.individuality}%
          {' '}· lowest{' '}
          {getSymbolMeta(dominance.lowest.symbol).id} {dominance.lowest.ind.individuality}%
        </div>
      )}
      {anchoring && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 2,
          borderTop: `1px solid ${SUBTLE}`, paddingTop: 6, marginTop: 1,
        }}>
          <div style={rowStyle}>
            <span style={{ color: 'var(--fg-4)' }}>Field anchoring · </span>
            <b style={{ color: anchorColor }}>{anchoring.avgFieldInfluence}% field</b>
            {' '}/ {100 - anchoring.avgFieldInfluence}% symbol
            {' '}· est. confidence {anchoring.avgConfidence}%
          </div>
          <div style={{ ...rowStyle, color: 'var(--fg-2)', fontStyle: 'italic' }}>
            {anchoring.interpretation}
          </div>
        </div>
      )}
    </div>
  );
}

function FamiliesBody({
  families, divergence,
}: {
  families: FamilyParticipation[]; divergence: FamilyDivergence;
}) {
  if (families.length === 0) return <Empty text="Scan to populate market families." />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {families.map(f => {
        const c = [
          f.go ? `${f.go}GO` : '', f.ready ? `${f.ready}R` : '',
          f.watch ? `${f.watch}W` : '', f.blocked ? `${f.blocked}B` : '',
        ].filter(Boolean).join(' ');
        return (
          <div key={f.family} style={{
            ...rowStyle, display: 'flex', alignItems: 'baseline', gap: 8,
          }}>
            <span style={{ color: 'var(--fg-1)', fontWeight: 600, minWidth: 74 }}>
              {FAMILY_LABEL[f.family]}
            </span>
            <span style={{ color: 'var(--fg-3)', flex: 1 }}>{c}</span>
            <span style={{ color: FAMILY_MOOD_COLOR[f.mood], fontWeight: 700 }}>
              {f.mood}
            </span>
          </div>
        );
      })}
      <div style={{
        ...rowStyle, fontSize: 9, fontStyle: 'italic',
        color: divergence.detected ? '#d4a028' : 'var(--fg-4)',
      }}>
        {divergence.detected ? `⚠ ${divergence.summary}` : divergence.summary}
      </div>
    </div>
  );
}

function OpportunityBody({ w }: { w: OpportunityWeather | null }) {
  if (!w) return <Empty text="Scan to populate opportunity weather." />;
  const rows: { label: string; status: OpportunityStatus }[] = [
    ...(w.counts.go > 0 ? [{ label: 'GO', status: 'go' as OpportunityStatus }] : []),
    { label: 'Imminent', status: 'imminent' },
    { label: 'Near',     status: 'near' },
    { label: 'Building', status: 'building' },
    { label: 'Far',      status: 'far' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {rows.map(r => (
          <span key={r.status} style={{ ...rowStyle, color: 'var(--fg-3)' }}>
            {r.label}{' '}
            <b style={{ color: OPP_STATUS_COLOR[r.status] }}>{w.counts[r.status]}</b>
          </span>
        ))}
      </div>
      <div style={{ ...rowStyle, color: 'var(--fg-1)', fontStyle: 'italic' }}>
        {w.interpretation}
      </div>
    </div>
  );
}

function LadderBody({ a }: { a: ActionLadderAudit | null }) {
  if (!a) return <Empty text="Scan to populate the ladder audit." />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {a.topBlockers.length === 0 ? (
        <Empty text="No GO check failing — the field is entry-eligible." />
      ) : (
        a.topBlockers.slice(0, 6).map(b => (
          <div key={b.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{
              ...rowStyle, display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{b.label}</span>
              <span style={{ color: 'var(--fg-1)' }}>{b.count}/{a.total}</span>
            </div>
            <div style={{
              height: 3, borderRadius: 2, overflow: 'hidden', background: 'var(--bg-2)',
            }}>
              <div style={{ width: `${b.pct}%`, height: '100%', background: '#d4a028' }} />
            </div>
          </div>
        ))
      )}
      <div style={{ ...rowStyle, color: 'var(--fg-1)', fontStyle: 'italic' }}>
        {a.interpretation}
      </div>
    </div>
  );
}

function MemoryBody({ r }: { r: FieldRecurrence | null }) {
  if (!r) return <Empty text="Scan to populate field memory." />;
  if (r.totalScans === 0) {
    return <Empty text="First scan recorded — recurrence builds as you scan." />;
  }
  if (r.matches === 0) {
    return (
      <Empty text={`No close precedent yet · ${r.totalScans} scans in memory · closest ${r.similarity}% similar.`} />
    );
  }
  const cm = r.closestMatch;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ ...rowStyle, color: 'var(--cyan)', fontWeight: 700 }}>
        Seen before: {r.matches}×
      </div>
      {cm && (
        <div style={rowStyle}>
          <span style={{ color: 'var(--fg-4)' }}>Closest · </span>
          {new Date(cm.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          {' '}· {cm.blockedCount}/{cm.total} {cm.dominantAction} · Regime {cm.regime} · NV {cm.nv}
        </div>
      )}
      {r.commonTransition && (
        <div style={rowStyle}>
          <span style={{ color: 'var(--fg-4)' }}>Typical transition · </span>
          {r.commonTransition}
        </div>
      )}
      {r.averageDuration != null && (
        <div style={rowStyle}>
          <span style={{ color: 'var(--fg-4)' }}>Average resolution · </span>
          {r.averageDuration < 48
            ? `${r.averageDuration.toFixed(1)} hours`
            : `${(r.averageDuration / 24).toFixed(1)} days`}
        </div>
      )}
    </div>
  );
}

function SessionBody({ p }: { p: FieldParticipation | null }) {
  if (!p) return <Empty text="Session context unavailable." />;
  const label = p.level === 'low' ? 'Low' : p.level === 'high' ? 'High' : 'Moderate';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={rowStyle}>
        <span style={{ color: 'var(--fg-4)' }}>Liquidity · </span>
        <b style={{ color: LIQUIDITY_COLOR[p.level] }}>{label}</b>
      </div>
      {p.lines.map((line, i) => (
        <div key={i} style={{ ...rowStyle, fontSize: 9, color: 'var(--fg-3)' }}>{line}</div>
      ))}
      <div style={{ ...rowStyle, fontSize: 8, color: 'var(--fg-4)', fontStyle: 'italic' }}>
        Context only — not applied to any read.
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

const FAMILY_MOOD_RANK: Record<FamilyMood, number> = {
  strong: 5, improving: 4, mixed: 3, weak: 2, blocked: 1,
};
function pickLeadFamily(families: FamilyParticipation[]): FamilyParticipation | null {
  if (families.length === 0) return null;
  return families.slice().sort(
    (a, b) => FAMILY_MOOD_RANK[b.mood] - FAMILY_MOOD_RANK[a.mood],
  )[0];
}
