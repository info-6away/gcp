'use client';

// v11.21.1: mobile parity. Pre-this-version, Research only showed
// regime distribution and pointed the user at desktop for everything
// else. Now: three-mode toggle (BY REGIME / BY PATTERN / BY AI STATE)
// matching the desktop modes. Mobile doesn't fetch candles, so the
// pattern & AI-state views are stats lists rather than scatter plots —
// per the spec rule "scatter chart readable or has mobile fallback".

import { useEffect, useMemo, useState } from 'react';
import { C, regimeColor } from '../colors';
import { MobileStatus } from '../MobileChrome';
import type { DataPoint, Pattern } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import {
  AI_HISTORY_LS_KEY, loadAiStateHistory,
  type AiStateHistoryRecord,
} from '@/lib/aiStateHistory';

type ResearchMode = 'regime' | 'pattern' | 'aistate';

const REGIME_NAMES: Record<string, string> = {
  A: 'Silence', B: 'Ignition', C: 'Alignment',
  D: 'Synchronization', E: 'Climax', F: 'Shock',
};

const REGIME_RANGE: Record<string, string> = {
  A: '0–50', B: '50–100', C: '100–140',
  D: '140–170', E: '170–220', F: '220+',
};

const AI_STATE_META: Record<string, { label: string; abbr: string; color: string }> = {
  DD: { label: 'Dead Drift',         abbr: 'DD', color: '#6b7280' },
  CS: { label: 'Compression',        abbr: 'CS', color: '#4dd9e8' },
  IS: { label: 'Ignition',           abbr: 'IS', color: '#22c55e' },
  AT: { label: 'Alignment Trend',    abbr: 'AT', color: '#2db8b4' },
  SS: { label: 'Synchronization',    abbr: 'SS', color: '#d4a028' },
  CL: { label: 'Climax',             abbr: 'CL', color: '#d46428' },
  DS: { label: 'Discharge',          abbr: 'DS', color: '#fb923c' },
  FA: { label: 'Failed Alignment',   abbr: 'FA', color: '#d946ef' },
  SH: { label: 'Shock',              abbr: 'SH', color: '#e24b4a' },
};

function regimeFor(v: number): string {
  if (v < 50)  return 'A';
  if (v < 100) return 'B';
  if (v < 140) return 'C';
  if (v < 170) return 'D';
  if (v < 220) return 'E';
  return 'F';
}

function formatRelative(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function ResearchScreen({
  series, patterns, liveNV, liveRegime, connected, aiState, aiEnabled,
}: {
  series:    DataPoint[];
  patterns:  Pattern[];
  liveNV:    number | null;
  liveRegime: string | null;
  connected: boolean;
  aiState:   GcpStateResponse | null;
  aiEnabled: boolean;
}) {
  const [mode, setMode] = useState<ResearchMode>('regime');

  // ── Regime stats (existing) ────────────────────────────────────────────────
  const regimeStats = useMemo(() => {
    const map: Record<string, number[]> = { A: [], B: [], C: [], D: [], E: [], F: [] };
    series.forEach(p => {
      const r = p.r ?? regimeFor(p.v);
      map[r]?.push(p.v);
    });
    return map;
  }, [series]);

  // ── Pattern stats: tally kinds across the recent pattern list ──────────────
  const patternStats = useMemo(() => {
    const map: Record<string, { count: number; avgPss: number; lastTs: number }> = {};
    for (const p of patterns) {
      const kind = p.kind;
      if (!map[kind]) map[kind] = { count: 0, avgPss: 0, lastTs: 0 };
      map[kind].count++;
      map[kind].avgPss += Math.round(p.strength * 100);
      if (p.tStart > map[kind].lastTs) map[kind].lastTs = p.tStart;
    }
    for (const k of Object.keys(map)) {
      map[k].avgPss = Math.round(map[k].avgPss / map[k].count);
    }
    return map;
  }, [patterns]);

  // ── AI history: subscribe to localStorage + dispatched events ──────────────
  const [aiHistory, setAiHistory] = useState<AiStateHistoryRecord[]>([]);
  useEffect(() => {
    setAiHistory(loadAiStateHistory());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AI_HISTORY_LS_KEY) setAiHistory(loadAiStateHistory());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Group AI records by stateCode. Mobile doesn't fetch candles, so we
  // only count records + show last run + avg confidence per group; the
  // forward-return scatter is desktop-only.
  const aiStateStats = useMemo(() => {
    const map: Record<string, { count: number; avgConf: number; lastTs: number }> = {};
    for (const rec of aiHistory) {
      if (!map[rec.stateCode]) map[rec.stateCode] = { count: 0, avgConf: 0, lastTs: 0 };
      map[rec.stateCode].count++;
      map[rec.stateCode].avgConf += rec.confidence;
      if (rec.timestamp > map[rec.stateCode].lastTs) map[rec.stateCode].lastTs = rec.timestamp;
    }
    for (const k of Object.keys(map)) {
      map[k].avgConf = map[k].avgConf / map[k].count;
    }
    return map;
  }, [aiHistory]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus nv={liveNV} regime={liveRegime} connected={connected}
        aiState={aiState} aiEnabled={aiEnabled} />

      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${C.line1}`,
        background: C.bg, flexShrink: 0,
      }}>
        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3 }}>RESEARCH</div>
        <div style={{ fontSize: 18, color: C.fg0, fontWeight: 600, marginTop: 2 }}>
          {mode === 'regime'  ? 'REGIME OVERVIEW'  :
           mode === 'pattern' ? 'PATTERN OVERVIEW' :
                                'AI STATE HISTORY'}
        </div>

        {/* v11.21.1 mode toggle */}
        <div style={{
          display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap',
        }}>
          {(['regime', 'pattern', 'aistate'] as ResearchMode[]).map(m => (
            <button key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '5px 10px',
                fontSize: 9, letterSpacing: '0.08em', fontWeight: 600,
                background: mode === m ? C.bg3 : 'transparent',
                border: `1px solid ${mode === m ? C.cyan : C.line2}`,
                borderRadius: 2,
                color: mode === m ? C.cyan : C.fg2,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {m === 'regime'  ? 'BY REGIME'   :
               m === 'pattern' ? 'BY PATTERN'  :
                                 'BY AI STATE'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>

        {/* ── REGIME ────────────────────────────────────────────────────────── */}
        {mode === 'regime' && (
          <>
            <div style={{ fontSize: 9, color: '#7F98A3', lineHeight: 1.5, marginBottom: 10 }}>
              Distribution across {series.length.toLocaleString()} data points · Jan–Apr 2026.
              Open desktop for full scatter analysis.
            </div>
            {Object.entries(REGIME_NAMES).map(([r, name]) => {
              const pts = regimeStats[r] ?? [];
              const pct = series.length ? (pts.length / series.length * 100) : 0;
              const col = regimeColor(r);
              const isActive = r === liveRegime;
              return (
                <div key={r} style={{
                  background: isActive ? `${col}11` : C.bg1,
                  border: `1px solid ${isActive ? col + '44' : C.line1}`,
                  borderRadius: 3, padding: 12, marginBottom: 8,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 22, color: col, fontWeight: 600, lineHeight: 1 }}>{r}</span>
                      <span style={{ fontSize: 11, color: C.fg1, letterSpacing: '0.06em' }}>{name}</span>
                      {isActive && <span style={{ fontSize: 8, color: col, letterSpacing: '0.1em' }}>● NOW</span>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 18, color: col, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                        {pct.toFixed(1)}%
                      </div>
                      <div style={{ fontSize: 8, color: C.fg3, letterSpacing: '0.1em', marginTop: 3 }}>
                        of time
                      </div>
                    </div>
                  </div>
                  <div style={{ height: 6, background: C.bg3, borderRadius: 1, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(pct * 2, 100)}%`, height: '100%', background: col }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: C.fg3, marginTop: 4 }}>
                    <span>{pts.length.toLocaleString()} bars</span>
                    <span>{REGIME_RANGE[r]} NV</span>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* ── PATTERN ───────────────────────────────────────────────────────── */}
        {mode === 'pattern' && (
          <>
            <div style={{ fontSize: 9, color: '#7F98A3', lineHeight: 1.5, marginBottom: 10 }}>
              Pattern occurrences in the live detection window.
              Open desktop for forward-return analysis.
            </div>
            {Object.keys(patternStats).length === 0 ? (
              <div style={{
                padding: '14px 12px',
                background: C.bg1, border: `1px solid ${C.line1}`,
                borderRadius: 3,
                fontSize: 10, color: '#7F98A3', lineHeight: 1.55,
              }}>
                No patterns detected in the current window.
              </div>
            ) : Object.entries(patternStats)
                .sort((a, b) => b[1].count - a[1].count)
                .map(([kind, s]) => (
                  <div key={kind} style={{
                    background: C.bg1, border: `1px solid ${C.line1}`,
                    borderRadius: 3, padding: 12, marginBottom: 8,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: C.fg0, fontWeight: 600 }}>{kind}</span>
                      <span style={{ fontSize: 16, color: C.amber, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {s.count}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 10, fontSize: 9, color: '#7F98A3' }}>
                      <span>avg PSS {s.avgPss}</span>
                      {s.lastTs > 0 && <span>· last {formatRelative(s.lastTs)}</span>}
                    </div>
                  </div>
                ))}
          </>
        )}

        {/* ── AI STATE ──────────────────────────────────────────────────────── */}
        {mode === 'aistate' && (
          <>
            {aiHistory.length === 0 ? (
              <div style={{
                padding: '14px 12px',
                background: C.bg1, border: `1px solid ${C.line1}`,
                borderRadius: 3,
                fontSize: 10, color: '#7F98A3', lineHeight: 1.55,
              }}>
                <div style={{ color: C.fg1, fontWeight: 600, marginBottom: 6, fontSize: 11 }}>
                  No AI State history yet.
                </div>
                Run AI Analysis from the Dashboard to start collecting outcomes.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 9, color: '#7F98A3', lineHeight: 1.5, marginBottom: 10 }}>
                  {aiHistory.length} analyses logged. Open desktop for forward-return scatter.
                </div>
                {Object.entries(AI_STATE_META).map(([code, meta]) => {
                  const s = aiStateStats[code];
                  if (!s) {
                    return (
                      <div key={code} style={{
                        background: C.bg1, border: `1px solid ${C.line1}`,
                        borderRadius: 3, padding: 10, marginBottom: 6,
                        opacity: 0.45,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>{meta.abbr}</span>
                          <span style={{ fontSize: 9, color: C.fg4 }}>no data</span>
                        </div>
                        <div style={{ fontSize: 9, color: C.fg4, marginTop: 2 }}>{meta.label}</div>
                      </div>
                    );
                  }
                  return (
                    <div key={code} style={{
                      background: C.bg1, border: `1px solid ${C.line1}`,
                      borderLeft: `2px solid ${meta.color}`,
                      borderRadius: 3, padding: 10, marginBottom: 6,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                        <span style={{ color: meta.color, fontSize: 11, fontWeight: 600 }}>{meta.abbr} · {meta.label}</span>
                        <span style={{ fontSize: 16, color: C.fg0, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                          {s.count}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 10, fontSize: 9, color: '#7F98A3', flexWrap: 'wrap' }}>
                        <span>conf {(s.avgConf * 100).toFixed(0)}%</span>
                        <span>· last {formatRelative(s.lastTs)}</span>
                      </div>
                    </div>
                  );
                })}
                <div style={{
                  fontSize: 9, color: C.fg3, lineHeight: 1.5,
                  marginTop: 12, padding: '8px 10px',
                  background: 'rgba(56, 189, 248, 0.04)',
                  border: '1px solid rgba(56, 189, 248, 0.18)',
                  borderRadius: 3,
                }}>
                  Forward-return outcomes are computed when candle data overlaps with the analysis
                  timestamp — open desktop Research for the full scatter and avg-return view.
                </div>
              </>
            )}
          </>
        )}

      </div>
    </div>
  );
}
