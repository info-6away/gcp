'use client';

import { useState } from 'react';
import { C, regimeColor } from '../colors';
import { MobileStatus, SymbolBar } from '../MobileChrome';
import type { DataPoint, Pattern, MarketSymbol } from '@/types/gcp';
import { symbolEnvLabel } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import { useNewsData } from '@/lib/useNewsData';
import {
  directionArrow, stateColor, DEFAULT_INTERPRETATION,
} from '@/lib/aiState';
import { derivePosture, actionToneColor } from '@/lib/aiAction';
import { AI_ANALYSIS_TF, AI_FORWARD_HORIZON } from '@/lib/aiTimeframe';
import { deriveTradePlan, formatPriceAnchor } from '@/lib/tradePlan';
import type { StructureRead } from '@/lib/priceStructure';
import type { Candle } from '@/lib/fetchCandles';
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
  aiState, aiEnabled, aiStatus = 'idle',
  aiRunNow, aiLastSuccess = null,
  planStructure, planAnalysisCandle = null,
}: {
  series: DataPoint[]; patterns: Pattern[];
  liveNV: number | null; liveRegime: string | null; connected: boolean;
  symbol: MarketSymbol; price: number | null; onSymbolPress?: () => void;
  aiState:        GcpStateResponse | null;
  aiEnabled:      boolean;
  aiStatus?:      AiStatus;
  aiRunNow?:      (options?: { force?: boolean; source?: string }) => void;
  aiLastSuccess?: Date | null;
  planStructure?: StructureRead;
  planAnalysisCandle?: Candle | null;
}) {
  // v11.23.2: 'running' is the only status that should surface
  // analyzing copy. Manual mode rests in 'idle' until the user clicks.
  const isRunning = aiStatus === 'running';
  const isError   = aiStatus === 'error';
  const last15   = series.slice(-15);
  const sparkMax = Math.max(...last15.map(p => p.v), 50);
  const activePat = patterns[patterns.length - 1] ?? null;
  const pss      = activePat ? pssOf(activePat) : 0;

  const { items: newsItems } = useNewsData(series);

  const [showExplainer, setShowExplainer] = useState(false);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus nv={liveNV} regime={liveRegime} connected={connected}
        aiState={aiState} aiEnabled={aiEnabled} aiStatus={aiStatus} symbol={symbol} />
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
                  fontSize: 14,
                  color: isError ? '#e24b4a' : C.fg2,
                  fontWeight: 600,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  {isRunning ? (
                    <>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', background: C.cyan,
                        animation: 'livepulse 1.6s ease-in-out infinite',
                      }} />
                      Analyzing…
                    </>
                  ) : isError ? 'AI analysis failed — retry'
                    : 'AI State not run yet'}
                </div>
                <div style={{ fontSize: 10, color: '#7F98A3', marginTop: 6, lineHeight: 1.5 }}>
                  AI analysis uses LLM tokens. Run manually to control cost.
                </div>
                <button
                  onClick={() => {
                    if (process.env.NODE_ENV !== 'production') {
                      console.log('[ASK GURU CLICK]', {
                        aiStatus, force: true, source: 'mobile_dashboard_idle',
                        hasRunNow: typeof aiRunNow === 'function', reason: 'ok',
                      });
                    }
                    aiRunNow?.({ force: true, source: 'mobile_dashboard_idle' });
                  }}
                  disabled={!aiRunNow || isRunning}
                  style={{
                    marginTop: 10,
                    padding: '8px 12px',
                    background: isRunning ? `${C.cyan}1f` : 'transparent',
                    border: `1px solid ${(!aiRunNow || isRunning) ? C.line2 : C.cyan}`,
                    borderRadius: 3,
                    color: (!aiRunNow || isRunning) ? C.fg3 : C.cyan,
                    fontFamily: 'inherit',
                    fontSize: 11, letterSpacing: '0.1em', fontWeight: 600,
                    cursor: (!aiRunNow || isRunning) ? 'default' : 'pointer',
                    width: '100%',
                  }}
                >
                  {isRunning ? 'RUNNING…' : isError ? 'RETRY AI ANALYSIS' : 'RUN AI ANALYSIS'}
                </button>
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

              {/* v11.21: timeframe context */}
              <div style={{
                marginTop: 4,
                fontSize: 9,
                color: '#7F98A3',
                letterSpacing: '0.04em',
              }}>
                Context: {AI_ANALYSIS_TF} environment · {AI_FORWARD_HORIZON} horizon
              </div>

              {/* v11.18 + v11.22 + v11.22.1: posture block — MODE /
                  ACTION / ANALYSIS AT / TRADE PLAN / TRIGGER / SIZE.
                  Mobile uses 50px label width to fit phone widths. */}
              {(() => {
                const posture = derivePosture(aiState, activePat);
                if (!posture) return null;
                const actionAccent = actionToneColor(posture.action.tone);
                const sizeAccent   = actionToneColor(posture.sizeTone);
                const plan = planStructure
                  ? deriveTradePlan({
                      state:           aiState,
                      structure:       planStructure,
                      latestPattern:   activePat,
                      symbol,
                      analysisCandle:  planAnalysisCandle,
                      analysisTf:      AI_ANALYSIS_TF,
                      currentPrice:    price,
                    })
                  : null;
                const planAccent = plan ? actionToneColor(plan.tone) : actionAccent;
                const anchor = plan ? formatPriceAnchor(plan, symbol) : null;
                const Row = (label: string, value: string, accent: string, emphasised: boolean) => (
                  <div key={label} style={{
                    display: 'flex', alignItems: 'baseline', gap: 8,
                    padding: '4px 8px',
                    background: `${accent}0d`,
                    borderLeft: `2px solid ${accent}55`,
                    borderRadius: 3,
                    fontSize: 11,
                    lineHeight: 1.35,
                  }}>
                    <span style={{
                      fontSize: 8, letterSpacing: '0.18em',
                      color: accent, fontWeight: 600,
                      flexShrink: 0, minWidth: 50,
                    }}>{label}</span>
                    <span style={{
                      color: emphasised ? accent : C.fg1,
                      fontWeight: emphasised ? 600 : 500,
                    }}>{value}</span>
                  </div>
                );
                return (
                  <div style={{
                    marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3,
                  }}>
                    {Row('MODE',    posture.mode,        actionAccent, false)}
                    {Row('ACTION',  posture.action.text, actionAccent, true)}

                    {anchor && anchor.anchorLabel && (
                      <div style={{
                        padding: '5px 8px',
                        background: 'rgba(127, 152, 163, 0.08)',
                        borderLeft: '2px solid rgba(127, 152, 163, 0.35)',
                        borderRadius: 3,
                        fontSize: 11,
                        lineHeight: 1.35,
                        display: 'flex', flexDirection: 'column', gap: 1,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{
                            fontSize: 8, letterSpacing: '0.18em',
                            color: '#7F98A3', fontWeight: 600,
                            flexShrink: 0, minWidth: 50,
                          }}>AT</span>
                          <span style={{ color: C.fg1, fontFamily: 'var(--font-mono)' }}>
                            {anchor.anchorLabel}
                          </span>
                        </div>
                        {anchor.currentLabel && (
                          <div style={{
                            fontSize: 9, marginLeft: 58, fontFamily: 'var(--font-mono)',
                            color: plan && plan.distance != null
                              ? plan.distance > 0 ? '#22c55e' : plan.distance < 0 ? '#ef4444' : '#7F98A3'
                              : '#7F98A3',
                          }}>
                            {anchor.currentLabel}
                          </div>
                        )}
                      </div>
                    )}

                    {plan && (
                      <div style={{
                        padding: '5px 8px',
                        background: `${planAccent}0d`,
                        borderLeft: `2px solid ${planAccent}55`,
                        borderRadius: 3,
                        fontSize: 11,
                        lineHeight: 1.35,
                        display: 'flex', flexDirection: 'column', gap: 2,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{
                            fontSize: 8, letterSpacing: '0.18em',
                            color: planAccent, fontWeight: 600,
                            flexShrink: 0, minWidth: 50,
                          }}>PLAN</span>
                          <span style={{ color: planAccent, fontWeight: 600 }}>
                            {plan.headline}
                          </span>
                        </div>
                        {plan.entryType !== 'No entry' ? (
                          <>
                            {plan.triggers.map((line, i) => (
                              <div key={i} style={{ fontSize: 10, color: C.fg1, marginLeft: 58, lineHeight: 1.4 }}>
                                <span style={{ color: '#7F98A3' }}>{i === 0 ? 'Trigger: ' : ''}</span>
                                {line}
                              </div>
                            ))}
                            <div style={{ fontSize: 10, color: C.fg1, marginLeft: 58, lineHeight: 1.4 }}>
                              <span style={{ color: '#7F98A3' }}>Invalidation: </span>{plan.invalidation}
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 10, color: C.fg2, marginLeft: 58, lineHeight: 1.4 }}>
                            <span style={{ color: '#7F98A3' }}>Reason: </span>{plan.reason ?? '—'}
                          </div>
                        )}
                      </div>
                    )}

                    {Row('TRIGGER', posture.trigger,     actionAccent, false)}
                    {Row('SIZE',    posture.size,        sizeAccent,   false)}
                  </div>
                );
              })()}

              {/* v11.18.3: refresh row — manual-first cost control */}
              <div style={{
                marginTop: 10,
                paddingTop: 8,
                borderTop: `1px solid ${C.line1}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              }}>
                <div style={{ fontSize: 9, color: '#7F98A3' }}>
                  Last AI analysis: <span style={{ color: C.fg1 }}>{
                    aiLastSuccess
                      ? (() => {
                          const secs = Math.max(0, Math.round((Date.now() - aiLastSuccess.getTime()) / 1000));
                          if (secs < 60)    return `${secs}s ago`;
                          if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
                          if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
                          return `${Math.floor(secs / 86400)}d ago`;
                        })()
                      : 'never'
                  }</span>
                </div>
                <button
                  onClick={() => {
                    if (process.env.NODE_ENV !== 'production') {
                      console.log('[ASK GURU CLICK]', {
                        aiStatus, force: true, source: 'mobile_dashboard_again',
                        hasRunNow: typeof aiRunNow === 'function', reason: 'ok',
                      });
                    }
                    aiRunNow?.({ force: true, source: 'mobile_dashboard_again' });
                  }}
                  disabled={!aiRunNow || isRunning}
                  style={{
                    padding: '4px 8px',
                    background: isRunning ? `${C.cyan}1f` : 'transparent',
                    border: `1px solid ${(!aiRunNow || isRunning) ? C.line2 : C.cyan}`,
                    borderRadius: 3,
                    color: (!aiRunNow || isRunning) ? C.fg3 : C.cyan,
                    fontFamily: 'inherit',
                    fontSize: 9, letterSpacing: '0.1em', fontWeight: 600,
                    cursor: (!aiRunNow || isRunning) ? 'default' : 'pointer',
                  }}
                >
                  {isRunning ? 'RUNNING…' : 'REFRESH'}
                </button>
              </div>
            </div>
          );
        })()}

        {aiEnabled && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 12,
            fontSize: 8, color: C.fg4, letterSpacing: '0.06em',
            padding: '0 2px', marginBottom: 8,
          }}>
            <span><span style={{ color: C.fg3 }}>AI State</span> = Environment (GCP + {symbolEnvLabel(symbol)})</span>
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
        symbol={symbol}
      />
    </div>
  );
}
