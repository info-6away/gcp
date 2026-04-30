'use client';

import { useState } from 'react';
import { C, regimeColor } from '../colors';
import { MobileStatus, SymbolBar } from '../MobileChrome';
import type { DataPoint, Pattern, MarketSymbol } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import { useNewsData } from '@/lib/useNewsData';
import {
  directionArrow, stateColor, DEFAULT_INTERPRETATION,
} from '@/lib/aiState';
import { deriveAction, actionToneColor } from '@/lib/aiAction';
import AiStateExplainer from '../../AiStateExplainer';

const REGIME_NAMES: Record<string, string> = {
  A: 'Silence', B: 'Ignition', C: 'Alignment',
  D: 'Synchronization', E: 'Climax', F: 'Shock',
};

const INTERP: Record<string, string> = {
  'Alignment Ladder':    'Trend environment forming. Highest continuation probability.',
  'Compression Coil':    'Energy accumulating. Range-building. Expansion likely if PSS > 70.',
  'Compression Release': 'Coil energy releasing into alignment.',
  'Failed Alignment':    'False breakout. Low continuation. Fade or stand aside.',
  'Shock Jump':          'Extreme event. Expect high volatility in either direction.',
  'Coherence Volcano':   'Single spike into C, mean-reverts immediately.',
  'Ignition Drift':      'Sustained B oscillation — no decisive direction.',
};

const pssOf = (p: Pattern) => Math.round(p.strength * 100);

export function DashboardScreen({
  series, patterns, liveNV, liveRegime, connected,
  symbol, price, onSymbolPress,
  aiState, aiEnabled,
}: {
  series: DataPoint[]; patterns: Pattern[];
  liveNV: number | null; liveRegime: string | null; connected: boolean;
  symbol: MarketSymbol; price: number | null; onSymbolPress?: () => void;
  aiState:   GcpStateResponse | null;
  aiEnabled: boolean;
}) {
  const last15   = series.slice(-15);
  const sparkMax = Math.max(...last15.map(p => p.v), 50);
  const activePat = patterns[patterns.length - 1] ?? null;
  const pss      = activePat ? pssOf(activePat) : 0;

  const { items: newsItems } = useNewsData(series);

  const [showExplainer, setShowExplainer] = useState(false);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus nv={liveNV} regime={liveRegime} connected={connected}
        aiState={aiState} aiEnabled={aiEnabled} />
      <SymbolBar symbol={symbol} price={price} onSymbolPress={onSymbolPress} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 16px' }}>

        {aiEnabled && (() => {
          if (!aiState) {
            return (
              <div style={{
                background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3,
                padding: '10px 12px', marginBottom: 8,
                borderLeft: `2px solid ${C.fg3}`,
              }}>
                <div style={{ fontSize: 8, letterSpacing: '0.15em', color: C.fg3, marginBottom: 4 }}>AI STATE</div>
                <div style={{
                  fontSize: 16, color: C.fg3, fontWeight: 600,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', background: C.fg3,
                  }} />
                  Analyzing…
                </div>
                <div style={{ fontSize: 9, color: C.fg3, marginTop: 4 }}>
                  Waiting for first Engine classification
                </div>
              </div>
            );
          }
          const accent = stateColor(aiState);
          const arrow  = directionArrow(aiState.direction);
          const conf   = Math.round(aiState.confidence * 100);
          // Mobile dashboard mirrors the desktop AI card: prefer the
          // Engine's short copy only if it actually fits on one line.
          // Long paragraphs collapse to the per-state default so the
          // dashboard never grows a wall of text.
          const candidate = aiState.reasoningShort?.trim() || aiState.goldInterpretation?.trim() || '';
          const interp = candidate && candidate.length <= 90
            ? candidate
            : (DEFAULT_INTERPRETATION[aiState.stateCode] || '—');
          return (
            <div style={{
              background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3,
              padding: '10px 12px', marginBottom: 8,
              borderLeft: `2px solid ${accent}`,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: 4, gap: 8,
              }}>
                <div style={{
                  fontSize: 8, letterSpacing: '0.15em', color: C.fg3,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span>AI STATE</span>
                  <button
                    onClick={() => setShowExplainer(true)}
                    aria-label="What does this mean?"
                    style={{
                      background: 'transparent', border: `1px solid ${C.line2}`,
                      borderRadius: '50%', width: 14, height: 14, padding: 0,
                      fontSize: 9, color: C.fg2, cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >ⓘ</button>
                </div>
                <div style={{ fontSize: 8, letterSpacing: '0.08em', color: accent }}>
                  {aiState.coherenceType.toUpperCase()}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 18, color: accent, fontWeight: 600, lineHeight: 1.05 }}>
                  {aiState.state.toUpperCase()}
                </span>
                <span style={{ fontSize: 16, color: accent, fontWeight: 600 }}>{arrow}</span>
              </div>
              <div style={{
                display: 'flex', gap: 10, marginTop: 6,
                fontSize: 9, color: C.fg3, letterSpacing: '0.04em',
              }}>
                <span><span style={{ color: C.fg3 }}>PHASE </span><span style={{ color: C.fg1 }}>{aiState.phase}</span></span>
                <span><span style={{ color: C.fg3 }}>BIAS </span><span style={{ color: C.fg1 }}>{aiState.direction}</span></span>
                <span><span style={{ color: C.fg3 }}>CONF </span><span style={{ color: C.fg1 }}>{conf}%</span></span>
              </div>
              {/* v11.16.5: AI explanation styled as a key insight,
                  not secondary text. Larger font (14px on mobile), a
                  brighter blue-grey foreground with a subtle cyan
                  glow, and a left-border container. The state name
                  above stays the largest element so hierarchy is
                  preserved. */}
              <div style={{
                marginTop: 8,
                padding: '8px 10px',
                background: 'rgba(56, 189, 248, 0.03)',
                borderLeft: '2px solid rgba(56, 189, 248, 0.25)',
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 500,
                lineHeight: 1.5,
                letterSpacing: '0.2px',
                color: '#B8D1DA',
                textShadow: '0 0 6px rgba(56, 189, 248, 0.15)',
              }}>
                {interp}
              </div>

              {/* v11.17: action posture row. Same deterministic
                  mapping as desktop, scaled down for mobile. */}
              {(() => {
                const action = deriveAction(aiState, activePat);
                if (!action) return null;
                const accent = actionToneColor(action.tone);
                return (
                  <div style={{
                    marginTop: 6,
                    padding: '5px 8px',
                    display: 'flex', alignItems: 'baseline', gap: 6,
                    background: `${accent}0d`,
                    border: `1px solid ${accent}55`,
                    borderRadius: 4,
                    fontSize: 11,
                    lineHeight: 1.35,
                  }}>
                    <span style={{
                      fontSize: 8, letterSpacing: '0.18em',
                      color: accent, fontWeight: 600,
                      flexShrink: 0,
                    }}>ACTION</span>
                    <span style={{ color: accent, fontWeight: 500 }}>
                      {action.text}
                    </span>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {aiEnabled && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 12,
            fontSize: 8, color: C.fg4, letterSpacing: '0.06em',
            padding: '0 2px', marginBottom: 8,
          }}>
            <span><span style={{ color: C.fg3 }}>AI State</span> = Environment (GCP + Gold)</span>
            <span><span style={{ color: C.fg3 }}>Pattern</span> = Event (GCP only)</span>
          </div>
        )}

        <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3, padding: '10px 12px', marginBottom: 8 }}>
          <div style={{ fontSize: 8, letterSpacing: '0.15em', color: C.fg3, marginBottom: 4 }}>NET VARIANCE</div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 30, color: C.fg0, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
              {liveNV?.toFixed(1) ?? '—'}
            </div>
            <div style={{ fontSize: 9, color: C.fg2 }}>15m window</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 24, marginTop: 8 }}>
            {last15.map((p, i) => (
              <div key={i} style={{
                flex: 1, borderRadius: 1, background: C.cyan,
                opacity: 0.4 + (i / Math.max(1, last15.length)) * 0.6,
                height: `${Math.max(10, (p.v / sparkMax) * 100)}%`,
              }} />
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3, padding: '10px 12px' }}>
            <div style={{ fontSize: 8, letterSpacing: '0.15em', color: C.fg3, marginBottom: 4 }}>REGIME</div>
            {liveRegime && (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 28, color: regimeColor(liveRegime), fontWeight: 600, lineHeight: 1 }}>
                    {liveRegime}
                  </span>
                  <span style={{ fontSize: 9, color: C.fg2, letterSpacing: '0.08em' }}>
                    {REGIME_NAMES[liveRegime]}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 2, marginTop: 10, height: 6 }}>
                  {['A','B','C','D','E','F'].map(r => (
                    <div key={r} style={{
                      flex: 1,
                      background: r === liveRegime ? regimeColor(r) : `${regimeColor(r)}33`,
                      borderRadius: 1,
                    }} />
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3, padding: '10px 12px' }}>
            <div style={{
              fontSize: 8, letterSpacing: '0.15em', color: C.fg3, marginBottom: 4,
              display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap',
            }}>
              <span>ACTIVE PSS</span>
              <span style={{
                padding: '0 4px', borderRadius: 2,
                border: `1px solid ${C.line2}`,
                color: C.fg3, fontSize: 7,
              }}>GCP EVENT</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span style={{ fontSize: 28, color: C.amber, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{pss}</span>
              <span style={{ fontSize: 10, color: C.fg3 }}>/100</span>
            </div>
            <div style={{ height: 5, background: C.bg3, borderRadius: 1, marginTop: 10, overflow: 'hidden' }}>
              <div style={{ width: `${pss}%`, height: '100%', background: C.amber }} />
            </div>
            <div style={{ fontSize: 9, color: C.fg2, marginTop: 5, letterSpacing: '0.04em' }}>
              {activePat?.kind ?? 'Baseline'}
            </div>
          </div>
        </div>

        {activePat && (
          <div style={{
            background: C.bg1, border: `1px solid ${C.line1}`,
            borderLeft: `2px solid ${C.amber}`, borderRadius: 3,
            padding: '10px 12px', marginBottom: 10,
          }}>
            <div style={{
              fontSize: 8, letterSpacing: '0.15em', color: C.fg3, marginBottom: 4,
              display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap',
            }}>
              <span>PATTERN INTERPRETATION</span>
              <span style={{
                padding: '0 4px', borderRadius: 2,
                border: `1px solid ${C.line2}`,
                color: C.fg3, fontSize: 7,
              }}>GCP EVENT</span>
            </div>
            <div style={{ fontSize: 13, color: C.fg0, fontWeight: 600, letterSpacing: '0.02em' }}>{activePat.kind}</div>
            <div style={{ fontSize: 10, color: C.fg2, lineHeight: 1.5, marginTop: 4 }}>
              {INTERP[activePat.kind] ?? 'Pattern under observation.'}
            </div>
          </div>
        )}

        <div style={{ fontSize: 8, letterSpacing: '0.15em', color: C.fg3, marginBottom: 6 }}>NEWS · COHERENCE TAGGED</div>
        <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3 }}>
          {newsItems.slice(0, 8).map((item, i, arr) => {
            const tagColor = item.regime ? regimeColor(item.regime) : C.fg3;
            return (
              <div key={i} style={{
                padding: '10px 12px',
                borderBottom: i < arr.length - 1 ? `1px solid ${C.line0}` : 'none',
                display: 'flex', gap: 10, alignItems: 'flex-start',
              }}>
                <div style={{ fontSize: 10, color: C.fg3, fontVariantNumeric: 'tabular-nums', minWidth: 36 }}>
                  {new Date(item.publishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: C.fg1, lineHeight: 1.4 }}>
                    {item.title.slice(0, 80)}{item.title.length > 80 ? '…' : ''}
                    {item.regime && (
                      <span style={{
                        display: 'inline-block', padding: '1px 4px', borderRadius: 2,
                        fontSize: 7, letterSpacing: '0.08em', marginLeft: 5, verticalAlign: 'middle',
                        background: `${tagColor}22`, color: tagColor, border: `1px solid ${tagColor}44`,
                      }}>
                        {item.regime}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 8, color: C.fg4, marginTop: 2 }}>{item.source.toUpperCase()}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <AiStateExplainer
        open={showExplainer}
        state={aiState}
        onClose={() => setShowExplainer(false)}
      />
    </div>
  );
}
