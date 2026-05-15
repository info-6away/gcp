'use client';

// v14.0 — Phase 14A: Guru Radar.
//
// Multi-asset coherence scanner. Answers "where should I look?" by
// running the full classify + action-state pipeline across the radar
// symbol universe and ranking the results by action state.
//
// Manual only. One Engine call per symbol, fired sequentially when
// the user clicks SCAN MARKETS. No background loops, no auto-polling.

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { MarketSymbol } from '@/types/gcp';
import { getSymbolMeta } from '@/types/gcp';
import type { GcpStateInputs } from '@/lib/gcp-state-payload';
import { stateColor } from '@/lib/aiState';
import { RADAR_SYMBOLS } from '@/lib/radarSymbols';
import {
  scanRadar, type RadarResult, type RadarScanProgress,
} from '@/lib/radarScan';
import { setRadarResult } from '@/lib/radarResultStore';
import type { ActionState } from '@/lib/actionState';
import { PageHeader } from '@/components/gcp/Chrome';

// ── Action-state palette + sort priority ────────────────────────────

const ACTION_COLOR: Record<ActionState, string> = {
  GO:      '#22c55e',
  READY:   '#4dd9e8',
  WATCH:   '#d4a028',
  BLOCKED: '#c45a5a',
  MANAGE:  '#5a8fc4',
  EXIT:    '#c45a5a',
};

// Sort buckets — lower wins. Mirrors the spec's GO→EXIT order.
const ACTION_RANK: Record<ActionState, number> = {
  GO: 1, READY: 2, WATCH: 3, BLOCKED: 4, MANAGE: 5, EXIT: 6,
};

const BAND_RANK: Record<string, number> = { strong: 3, moderate: 2, weak: 1 };

// ── Time helpers ────────────────────────────────────────────────────

function scanAge(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60)   return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

// ── Display derivations ─────────────────────────────────────────────

function edgeLabel(r: RadarResult): { text: string; color: string } {
  if (!r.ok || !r.aiState) return { text: '—', color: 'var(--fg-4)' };
  const dir  = r.aiState.direction;
  const band = r.aiState.pressureBand;
  const dirTxt =
      dir === 'Up'   ? 'UP'
    : dir === 'Down' ? 'DOWN'
    : dir === 'Mixed' ? 'MIXED'
    :                   'NEUTRAL';
  const bandTxt =
      band === 'strong'   ? 'STRONG'
    : band === 'moderate' ? 'MOD'
    : band === 'weak'     ? 'WEAK'
    :                       '—';
  const color =
      dir === 'Up'   ? '#22c55e'
    : dir === 'Down' ? '#c45a5a'
    :                   'var(--fg-3)';
  return { text: `${dirTxt} · ${bandTxt}`, color };
}

function structureLabel(r: RadarResult): string {
  if (!r.ok) return '—';
  const ps = r.priceStructure;
  if (ps) {
    return ps.structure.charAt(0).toUpperCase() + ps.structure.slice(1);
  }
  const dom = r.aiState?.structureDominance;
  if (!dom || dom === 'neutral') return 'Neutral';
  return dom.includes('bull') ? 'Bullish' : 'Bearish';
}

// ── Result sorting ──────────────────────────────────────────────────

function sortResults(results: RadarResult[]): RadarResult[] {
  return results.slice().sort((a, b) => {
    // Failed scans sink to the bottom.
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (!a.ok || !b.ok) return 0;
    const ra = ACTION_RANK[a.action?.actionState ?? 'BLOCKED'];
    const rb = ACTION_RANK[b.action?.actionState ?? 'BLOCKED'];
    if (ra !== rb) return ra - rb;
    // Within a bucket: clarity desc.
    const ca = a.aiState?.confidence ?? 0;
    const cb = b.aiState?.confidence ?? 0;
    if (cb !== ca) return cb - ca;
    // Then edge strength.
    const ba = BAND_RANK[a.aiState?.pressureBand ?? 'weak'] ?? 0;
    const bb = BAND_RANK[b.aiState?.pressureBand ?? 'weak'] ?? 0;
    if (bb !== ba) return bb - ba;
    // Then freshness.
    return b.scannedAt - a.scannedAt;
  });
}

// ════════════════════════════════════════════════════════════════════

export default function GuruRadar({
  aiStateInputs, currentSymbol, onPick,
}: {
  aiStateInputs: GcpStateInputs | null;
  currentSymbol: MarketSymbol;
  /** Switch the active app symbol and navigate to Trade. */
  onPick:        (symbol: MarketSymbol) => void;
}) {
  const [results,   setResults]   = useState<RadarResult[]>([]);
  const [scanning,  setScanning]  = useState(false);
  const [progress,  setProgress]  = useState<RadarScanProgress | null>(null);
  const [expanded,  setExpanded]  = useState<MarketSymbol | null>(null);
  const [now,       setNow]       = useState(() => Date.now());

  // 20s tick so "last scan age" stays current. Cheap; no Engine cost.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  const handleScan = useCallback(async () => {
    if (scanning || !aiStateInputs) return;
    setScanning(true);
    setResults([]);
    setExpanded(null);
    setProgress(null);
    try {
      await scanRadar(
        aiStateInputs,
        (p) => setProgress(p),
        (r) => {
          setResults(prev => [...prev, r]);
          // v14.0.1: cache each result so opening it in Trade
          // hydrates instantly instead of showing NO READ YET.
          setRadarResult(r.symbol, r);
        },
      );
    } finally {
      setScanning(false);
      setProgress(null);
      setNow(Date.now());
    }
  }, [scanning, aiStateInputs]);

  const sorted = useMemo(() => sortResults(results), [results]);

  // Summary chip counts by action state.
  const counts = useMemo(() => {
    const c: Partial<Record<ActionState, number>> = {};
    for (const r of results) {
      if (r.ok && r.action) {
        c[r.action.actionState] = (c[r.action.actionState] ?? 0) + 1;
      }
    }
    return c;
  }, [results]);

  const scannedCount = progress
    ? Math.min(progress.index + (progress.step === 'done' ? 1 : 0), progress.total)
    : results.length;
  const total = RADAR_SYMBOLS.length;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
    }}>
      <PageHeader crumbs={[{ label: 'Guru Radar' }]} />

      <div style={{
        flex: 1, overflow: 'auto', padding: 18,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {/* Header block */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{
            fontSize: 9, letterSpacing: '0.2em', color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
          }}>
            GURU RADAR
          </span>
          <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>
            Scan markets for coherence expression.
          </span>
        </div>

        {/* Action row — SCAN MARKETS button + meta */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        }}>
          <button
            onClick={handleScan}
            disabled={scanning || !aiStateInputs}
            style={{
              padding: '10px 18px',
              fontSize: 11, letterSpacing: '0.14em', fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              background: scanning ? 'rgba(77,217,232,0.10)' : 'transparent',
              border: `1px solid ${
                scanning || !aiStateInputs ? 'var(--line-2)' : 'var(--cyan)'
              }`,
              color: scanning || !aiStateInputs ? 'var(--fg-3)' : 'var(--cyan)',
              borderRadius: 4,
              cursor: scanning || !aiStateInputs ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
              transition: 'border-color 0.2s ease, color 0.2s ease',
            }}
          >
            {scanning ? 'SCANNING…' : 'SCAN MARKETS'}
          </button>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 1,
            fontSize: 9, color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
          }}>
            <span>manual only</span>
            <span>{total} symbols</span>
          </div>
          {!aiStateInputs && (
            <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>
              Coherence field not ready — wait for the GCP feed.
            </span>
          )}
        </div>

        {/* Progress bar — only while scanning */}
        {scanning && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{
              fontSize: 10, color: 'var(--fg-3)',
              fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
            }}>
              Scanning {Math.min(scannedCount + 1, total)}/{total}
              {progress ? ` · ${getSymbolMeta(progress.symbol).id}` : ''}
            </span>
            <div style={{
              height: 4, borderRadius: 2, overflow: 'hidden',
              background: 'var(--bg-2)', border: '1px solid var(--line-2)',
            }}>
              <div style={{
                width: `${(scannedCount / total) * 100}%`, height: '100%',
                background: 'var(--cyan)', transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        )}

        {/* Summary chips */}
        {results.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['GO', 'READY', 'WATCH', 'BLOCKED', 'MANAGE', 'EXIT'] as ActionState[])
              .filter(s => (counts[s] ?? 0) > 0)
              .map(s => (
                <span key={s} style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
                  fontFamily: 'var(--font-mono)',
                  color: ACTION_COLOR[s],
                  border: `1px solid ${ACTION_COLOR[s]}55`,
                  background: `${ACTION_COLOR[s]}11`,
                  borderRadius: 3, padding: '3px 8px',
                }}>
                  {s}: {counts[s]}
                </span>
              ))}
          </div>
        )}

        {/* Empty state */}
        {results.length === 0 && !scanning && (
          <div style={{
            fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.6,
            padding: '20px 0',
          }}>
            No scan yet. Click <b style={{ color: 'var(--fg-2)' }}>SCAN MARKETS</b> to
            sweep all {total} symbols for coherence expression. Each symbol costs
            one Engine call — the same as a manual Ask Guru.
          </div>
        )}

        {/* Result grid */}
        {sorted.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: 10,
          }}>
            {sorted.map(r => (
              <RadarCard
                key={r.symbol}
                result={r}
                now={now}
                isCurrent={r.symbol === currentSymbol}
                expanded={expanded === r.symbol}
                onToggle={() =>
                  setExpanded(prev => prev === r.symbol ? null : r.symbol)
                }
                onOpenTrade={() => onPick(r.symbol)}
                patternSeq={aiStateInputs?.patternStory?.seq ?? null}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Result card ─────────────────────────────────────────────────────

function RadarCard({
  result, now, isCurrent, expanded, onToggle, onOpenTrade, patternSeq,
}: {
  result:      RadarResult;
  now:         number;
  isCurrent:   boolean;
  expanded:    boolean;
  onToggle:    () => void;
  onOpenTrade: () => void;
  patternSeq:  string[] | null;
}) {
  const meta = getSymbolMeta(result.symbol);

  if (!result.ok) {
    return (
      <div style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--line-1)',
        borderLeft: '2px solid var(--fg-4)',
        borderRadius: 4, padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <span style={{
          fontSize: 12, fontWeight: 700, color: 'var(--fg-2)',
        }}>{meta.id}</span>
        <span style={{ fontSize: 9, color: 'var(--fg-4)' }}>
          scan failed — {result.error}
        </span>
      </div>
    );
  }

  const ai     = result.aiState!;
  const action = result.action!;
  const accent = ACTION_COLOR[action.actionState];
  const stColor = stateColor(ai);
  const edge   = edgeLabel(result);
  const clarity = Math.round((ai.confidence ?? 0) * 100);
  const isGo   = action.actionState === 'GO';

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: `1px solid ${isGo ? `${accent}77` : isCurrent ? 'var(--line-2)' : 'var(--line-1)'}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 4,
      boxShadow: isGo ? `0 0 14px ${accent}33` : 'none',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Clickable header — toggles expansion */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
        }}
        style={{
          padding: '10px 12px', cursor: 'pointer', userSelect: 'none',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}
      >
        {/* Symbol row */}
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: 8,
        }}>
          <span style={{
            fontSize: 13, fontWeight: 700, color: 'var(--fg-0)',
            letterSpacing: '0.03em',
          }}>
            {meta.id}
            {isCurrent && (
              <span style={{
                fontSize: 8, color: 'var(--fg-4)', marginLeft: 6,
                letterSpacing: '0.1em',
              }}>ACTIVE</span>
            )}
          </span>
          <span style={{
            fontSize: 8, color: 'var(--fg-4)', fontFamily: 'var(--font-mono)',
          }}>
            {scanAge(result.scannedAt, now)}
          </span>
        </div>

        {/* State · phase */}
        <div style={{
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: stColor, letterSpacing: '0.04em', fontWeight: 600,
        }}>
          {ai.stateCode} · {ai.phase}
        </div>

        {/* Action state — the headline */}
        <div style={{
          fontSize: 18, fontWeight: 800, color: accent,
          letterSpacing: '0.05em', lineHeight: 1.1,
        }}>
          {action.actionState}
        </div>

        {/* Edge · clarity · structure strip */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 10,
          fontSize: 9, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em', color: 'var(--fg-3)',
        }}>
          <span style={{ color: edge.color }}>{edge.text}</span>
          <span>{clarity}% clarity</span>
          <span>{structureLabel(result)}</span>
        </div>
      </div>

      {/* Expansion */}
      {expanded && (
        <div style={{
          borderTop: '1px solid var(--line-1)',
          padding: '10px 12px',
          display: 'flex', flexDirection: 'column', gap: 5,
          fontSize: 10, fontFamily: 'var(--font-mono)',
        }}>
          <DetailRow label="State"      value={`${ai.stateCode} · ${ai.state}`} />
          <DetailRow label="Phase"      value={ai.phase} />
          <DetailRow
            label="Transition"
            value={ai.nextLikelyState
              ? `→ ${ai.nextLikelyState} · ${Math.round((ai.transitionConfidence ?? 0) * 100)}%`
              : '—'}
          />
          <DetailRow
            label="Pressure"
            value={`${ai.longPressure ?? 50}L / ${ai.shortPressure ?? 50}S · ${ai.pressureBand ?? '—'}`}
          />
          <DetailRow
            label="Pattern story"
            value={patternSeq && patternSeq.length > 0 ? patternSeq.join(' → ') : '—'}
          />
          <DetailRow
            label="Price structure"
            value={result.priceStructure
              ? `${result.priceStructure.structure} · ${result.priceStructure.confirmation}`
              : '—'}
          />
          <DetailRow
            label="Invalidators"
            value={ai.invalidators && ai.invalidators.length > 0
              ? `${ai.invalidators.length} active`
              : 'none'}
          />
          <div style={{
            marginTop: 2, fontSize: 10, color: 'var(--fg-2)',
            lineHeight: 1.5, fontFamily: 'var(--font-sans, inherit)',
          }}>
            <span style={{ color: 'var(--fg-4)' }}>Reason · </span>
            {action.reason}
          </div>

          {/* Open Trade — switches the active symbol + navigates */}
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTrade(); }}
            style={{
              marginTop: 6,
              padding: '7px 12px',
              fontSize: 10, letterSpacing: '0.12em', fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              background: 'transparent',
              border: `1px solid ${accent}`,
              color: accent,
              borderRadius: 3, cursor: 'pointer',
            }}
          >
            OPEN IN TRADE →
          </button>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8,
      alignItems: 'baseline',
    }}>
      <span style={{ color: 'var(--fg-4)', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--fg-1)' }}>{value}</span>
    </div>
  );
}
