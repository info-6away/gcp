// v18.0 — Phase 18.0 IA split.
//
// Guru intelligence cards — extracted from TradePanel so the Guru
// view becomes the AI / environment intelligence center while Trade
// becomes a clean execution terminal. Pure presentation relocation:
// the cards' behavior, calculations, and prop contracts are
// unchanged from their inline TradePanel originals.
//
// What moved here:
//   • EnvironmentThesisCard   (renamed from ThesisHero — title changed
//                              from "GURU EXECUTION THESIS" to
//                              "ENVIRONMENT THESIS"; same internals)
//   • DirectionalPressureCard (renamed from PressureGauge)
//   • MarketContextCard
//   • ActionStateBanner
//   • EnvVsThesisBanner
//   • DirectionalEdgeCard
//   • ThesisStabilityCard
//   • StateFlowRibbon
//   • HistoricalAnalogCard
//   • AiReadStrip             (NEW: compact one-line summary for Trade)

'use client';

import { useMemo } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';
import type { MarketSymbol } from '@/types/gcp';
import type { PriceStructureRead } from '@/lib/priceStructureConfirmation';
import {
  stateColor, DEFAULT_INTERPRETATION, directionArrow,
} from '@/lib/aiState';
import { deriveStance } from '@/lib/guruStance';
import {
  derivePressureDriver, deriveAlignment, deriveTrendIntegrity,
} from '@/lib/pressureSemantics';
import {
  dominanceColor, dominanceLabel, type StructuralDominance,
} from '@/lib/structuralDominance';
import {
  momentumColor, momentumLabel,
  type InheritedTrend, type MomentumState,
} from '@/lib/temporalPressure';
import { deriveDirectionalEdge } from '@/lib/directionalEdge';
import { deriveThesisStability } from '@/lib/thesisStability';
import { deriveActionState } from '@/lib/actionState';
import { deriveHistoricalAnalog } from '@/lib/executionIntelligence';
import {
  deriveTemporalDrift, driftFrameFromHistoryRecord,
  deriveEnvVsThesis, THESIS_COLOR,
} from '@/lib/temporalDrift';

const COLOR_GO_GLOW = '#22c55e';

// Short relative-time helper (e.g. "12m ago") used in the RADAR READ
// badge on the Environment Thesis card.
export function radarScanAge(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// ── 1. ENVIRONMENT THESIS (renamed v18.0; was GURU EXECUTION THESIS)
//
// State · phase headline, certainty / regime / NV meta, AI interpretation,
// gold confirmation/divergence, invalidators, stale + late-phase warnings.

export function EnvironmentThesisCard({
  aiState, regime, netVariance, goldTrend,
  hydratedFromRadar = false, radarScannedAt = null,
}: {
  aiState:     GcpStateResponse | null;
  regime:      string | null;
  netVariance: number | null;
  goldTrend:   'up' | 'down' | 'sideways' | 'unknown';
  hydratedFromRadar?: boolean;
  radarScannedAt?:    number | null;
}) {
  const accent  = aiState ? stateColor(aiState) : 'var(--fg-3)';
  const conf    = aiState ? Math.round(aiState.confidence * 100) : null;
  const interp  = aiState ? (aiState.reasoningShort?.trim()
                          || DEFAULT_INTERPRETATION[aiState.stateCode]
                          || aiState.goldInterpretation
                          || '—')
                          : 'Awaiting first Guru classification.';

  const goldLine = (() => {
    if (!aiState) return null;
    const dir = aiState.direction;
    if (dir === 'Up') {
      if (goldTrend === 'up')   return { text: 'Gold confirms (trend up)', tone: 'good' as const };
      if (goldTrend === 'down') return { text: 'Gold diverges (trend down)', tone: 'warn' as const };
      return { text: `Gold ${goldTrend} — no confirmation`, tone: 'neutral' as const };
    }
    if (dir === 'Down') {
      if (goldTrend === 'down') return { text: 'Gold confirms (trend down)', tone: 'good' as const };
      if (goldTrend === 'up')   return { text: 'Gold diverges (trend up)', tone: 'warn' as const };
      return { text: `Gold ${goldTrend} — no confirmation`, tone: 'neutral' as const };
    }
    return { text: `Gold ${goldTrend}`, tone: 'neutral' as const };
  })();
  const goldColor =
    goldLine?.tone === 'good' ? 'var(--green)'
  : goldLine?.tone === 'warn' ? 'var(--red)'
  :                              'var(--fg-3)';

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 'var(--r-md)',
      padding: '14px 18px',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{
          fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
          fontFamily: 'var(--font-mono)', fontWeight: 600,
        }}>
          ENVIRONMENT THESIS
        </span>
        {hydratedFromRadar && (
          <span style={{
            fontSize: 8, fontWeight: 700, letterSpacing: '0.12em',
            fontFamily: 'var(--font-mono)',
            color: 'var(--cyan)',
            border: '1px solid rgba(77,217,232,0.45)',
            background: 'rgba(77,217,232,0.10)',
            borderRadius: 2, padding: '2px 6px',
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            RADAR READ
            {radarScannedAt != null && (
              <span style={{ color: 'var(--fg-3)', fontWeight: 500 }}>
                · hydrated from scan {radarScanAge(radarScannedAt)}
              </span>
            )}
          </span>
        )}
      </div>

      <div style={{
        fontSize: 22, color: accent, fontWeight: 700,
        letterSpacing: '0.01em', lineHeight: 1.15,
      }}>
        {aiState
          ? `${aiState.state.toUpperCase()} · ${aiState.phase}`
          : 'NO READ YET'}
      </div>

      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 18,
        fontSize: 10, color: 'var(--fg-3)',
        fontFamily: 'var(--font-mono)',
      }}>
        {conf != null && (
          <span>
            <span style={{ letterSpacing: '0.14em', color: 'var(--fg-4)' }}>CLARITY </span>
            <span style={{
              color: 'var(--fg-1)', fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
            }}>{conf}%</span>
          </span>
        )}
        {regime && (
          <span>
            <span style={{ letterSpacing: '0.14em', color: 'var(--fg-4)' }}>REGIME </span>
            <span style={{ color: 'var(--fg-1)' }}>{regime}</span>
          </span>
        )}
        {netVariance != null && (
          <span>
            <span style={{ letterSpacing: '0.14em', color: 'var(--fg-4)' }}>NV </span>
            <span style={{ color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
              {netVariance.toFixed(1)}
            </span>
          </span>
        )}
        {aiState?.direction && (
          <span>
            <span style={{ letterSpacing: '0.14em', color: 'var(--fg-4)' }}>BIAS </span>
            <span style={{ color: 'var(--fg-1)' }}>
              {aiState.direction} {directionArrow(aiState.direction)}
            </span>
          </span>
        )}
      </div>

      <div style={{
        fontSize: 12, color: 'var(--fg-1)', lineHeight: 1.55,
        marginTop: 2,
      }}>
        {interp}
      </div>

      {goldLine && (
        <div style={{
          fontSize: 11, color: goldColor, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: goldColor,
          }} />
          {goldLine.text}
        </div>
      )}

      {aiState && aiState.invalidators?.length > 0 && (
        <div style={{
          marginTop: 4, padding: '8px 10px',
          background: 'rgba(196,90,90,0.06)',
          border: '1px solid #c45a5a44',
          borderRadius: 3,
        }}>
          <div style={{
            fontSize: 9, letterSpacing: '0.18em', color: '#c45a5a',
            fontWeight: 600, marginBottom: 4,
          }}>
            INVALIDATORS
          </div>
          <ul style={{
            margin: 0, padding: 0, listStyle: 'none',
            display: 'flex', flexDirection: 'column', gap: 3,
          }}>
            {aiState.invalidators.slice(0, 3).map((inv, i) => (
              <li key={i} style={{
                fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.5,
                position: 'relative', paddingLeft: 12,
              }}>
                <span style={{
                  position: 'absolute', left: 0, top: 8,
                  width: 4, height: 4, borderRadius: '50%',
                  background: '#c45a5a',
                }} />
                {inv}
              </li>
            ))}
          </ul>
        </div>
      )}

      {aiState && (aiState.stale || aiState.stateCode === 'FA'
                || aiState.phase === 'Exhausted') && (
        <div style={{
          marginTop: 2, fontSize: 10, color: '#d4a028',
          fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
        }}>
          ⚠ {aiState.stale ? `STALE READ (${aiState.staleReason ?? 'engine offline'})`
            : aiState.stateCode === 'FA' ? 'FAILED ALIGNMENT — fade/reversal risk'
            : 'EXHAUSTED PHASE — manage exposure'}
        </div>
      )}
    </div>
  );
}

// ── 2. DIRECTIONAL PRESSURE (large gauge, was PressureGauge) ──────

export function DirectionalPressureCard({
  aiState,
}: {
  aiState: GcpStateResponse | null;
}) {
  const long  = aiState?.longPressure  ?? 50;
  const short = aiState?.shortPressure ?? 50;
  const band  = aiState?.pressureBand  ?? 'weak';
  const longColor  = '#4dd9e8';
  const shortColor = '#c45a5a';
  const bandColor  =
    band === 'strong'   ? 'var(--cyan)'
  : band === 'moderate' ? '#d4a028'
  :                        'var(--fg-3)';

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)',
      padding: '14px 18px',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', gap: 8,
      }}>
        <span style={{
          fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
          fontFamily: 'var(--font-mono)', fontWeight: 600,
        }}>
          DIRECTIONAL PRESSURE
        </span>
        <span style={{
          fontSize: 9, letterSpacing: '0.14em', fontWeight: 700,
          color: bandColor, fontFamily: 'var(--font-mono)',
        }}>
          {band.toUpperCase()}
        </span>
      </div>

      <div style={{
        display: 'flex', height: 18, borderRadius: 3, overflow: 'hidden',
        border: '1px solid var(--line-2)', background: 'var(--bg-2)',
      }}>
        <div style={{
          width: `${long}%`, background: longColor,
          transition: 'width 0.4s ease',
        }} />
        <div style={{
          width: `${short}%`, background: shortColor,
          transition: 'width 0.4s ease',
        }} />
      </div>

      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 18, fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums', fontWeight: 700,
        letterSpacing: '0.02em',
      }}>
        <span style={{ color: longColor }}>
          LONG <span style={{ color: 'var(--fg-0)' }}>{long}%</span>
        </span>
        <span style={{ color: shortColor }}>
          <span style={{ color: 'var(--fg-0)' }}>{short}%</span> SHORT
        </span>
      </div>

      {aiState?.pressureExplanation && (
        <div style={{
          fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.5,
          fontStyle: 'italic', marginTop: 2,
        }}>
          {aiState.pressureExplanation}
        </div>
      )}

      {(() => {
        const driver = derivePressureDriver(aiState);
        if (!driver || driver === aiState?.pressureExplanation) return null;
        return (
          <div style={{
            marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2,
            fontSize: 10, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em',
          }}>
            <span style={{ letterSpacing: '0.16em', color: 'var(--fg-4)' }}>
              PRESSURE DRIVER
            </span>
            <span style={{
              color: 'var(--fg-2)', letterSpacing: '0.02em',
              fontFamily: 'inherit', lineHeight: 1.45,
            }}>
              {driver}
            </span>
          </div>
        );
      })()}

      {(() => {
        const align = deriveAlignment(aiState);
        if (align.status === 'unclear' && !aiState?.structureDominance) return null;
        const icon = align.status === 'aligned'   ? '✓'
                   : align.status === 'diverging' ? '⚠'
                   :                                 '·';
        return (
          <div style={{
            marginTop: 2, display: 'flex', alignItems: 'baseline', gap: 8,
            fontSize: 10, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em', color: 'var(--fg-4)',
          }}>
            <span style={{ letterSpacing: '0.16em' }}>ALIGNMENT</span>
            <span style={{
              color: align.color,
              fontWeight: 600, letterSpacing: '0.02em',
              fontFamily: 'inherit',
            }}>
              {icon} {align.label}
            </span>
          </div>
        );
      })()}

      {(() => {
        const stance = aiState ? deriveStance(aiState) : null;
        if (!stance) return null;
        return (
          <div style={{
            marginTop: 4, padding: '10px 12px',
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--line-1)',
            borderLeft: '2px solid var(--fg-0)',
            borderRadius: 3,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            {[
              { l: 'STANCE',    v: stance.stance,    c: 'var(--fg-0)',  big: true },
              { l: 'MODE',      v: stance.mode,      c: '#d4a028',      big: false },
              { l: 'EXECUTION', v: stance.execution, c: 'var(--cyan)',  big: false },
            ].map(row => (
              <div key={row.l} style={{
                display: 'grid', gridTemplateColumns: '82px 1fr',
                gap: 12, alignItems: 'baseline',
              }}>
                <span style={{
                  fontSize: 8, letterSpacing: '0.18em', color: 'var(--fg-4)',
                  fontWeight: 600, fontFamily: 'var(--font-mono)',
                }}>
                  {row.l}
                </span>
                <span style={{
                  color: row.c,
                  fontSize: row.big ? 13 : 11,
                  fontWeight: row.big ? 700 : 500,
                  lineHeight: 1.4,
                }}>
                  {row.v}
                </span>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// ── 3. MARKET CONTEXT ────────────────────────────────────────────

export function MarketContextCard({
  aiState,
}: {
  aiState: GcpStateResponse | null;
}) {
  if (!aiState) return null;
  const dom            = aiState.structureDominance;
  const momentumState  = aiState.momentumState;
  const inheritedTrend = aiState.inheritedTrend;
  const trendIntegrity = deriveTrendIntegrity(aiState);

  if (!dom && !momentumState) return null;

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: '2px solid var(--fg-3)',
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        MARKET CONTEXT
      </div>
      {dom && (
        <div style={{
          display: 'grid', gridTemplateColumns: '128px 1fr', gap: 10,
          alignItems: 'baseline',
          fontSize: 11, fontFamily: 'var(--font-mono)',
        }}>
          <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em', fontSize: 9 }}>
            MARKET STRUCTURE
          </span>
          <span style={{
            color: dominanceColor(dom as StructuralDominance),
            fontWeight: 600, letterSpacing: '0.02em',
          }}>
            {dominanceLabel(dom as StructuralDominance)}
            {typeof aiState.structureScore === 'number' && (
              <span style={{
                color: 'var(--fg-4)', fontVariantNumeric: 'tabular-nums',
                fontSize: 9, marginLeft: 6,
              }}>
                · score {aiState.structureScore >= 0 ? '+' : ''}{aiState.structureScore}
              </span>
            )}
          </span>
        </div>
      )}
      {momentumState && (
        <div style={{
          display: 'grid', gridTemplateColumns: '128px 1fr', gap: 10,
          alignItems: 'baseline',
          fontSize: 11, fontFamily: 'var(--font-mono)',
        }}>
          <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em', fontSize: 9 }}>
            MOMENTUM
          </span>
          <span style={{
            color: momentumColor(momentumState as MomentumState),
            fontWeight: 600, letterSpacing: '0.02em',
          }}>
            {momentumLabel(
              momentumState as MomentumState,
              (inheritedTrend ?? 'neutral') as InheritedTrend,
            )}
          </span>
        </div>
      )}
      <div style={{
        display: 'grid', gridTemplateColumns: '128px 1fr', gap: 10,
        alignItems: 'baseline',
        fontSize: 11, fontFamily: 'var(--font-mono)',
      }}>
        <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em', fontSize: 9 }}>
          TREND INTEGRITY
        </span>
        <span style={{
          color: trendIntegrity.color,
          fontWeight: 600, letterSpacing: '0.02em',
        }}>
          {trendIntegrity.label}
        </span>
      </div>
    </div>
  );
}

// ── 4. ACTION STATE banner (v13.9.1 ladder + price-structure layer) ─

export function ActionStateBanner({
  aiState, hasOpenPosition, history, priceStructure,
}: {
  aiState:         GcpStateResponse | null;
  hasOpenPosition: boolean;
  history:         AiStateHistoryRecord[];
  priceStructure:  PriceStructureRead | null;
}) {
  const action = deriveActionState({
    aiState, hasOpenPosition, history, priceStructure,
  });
  const isGo = action.actionState === 'GO';
  const showConfirmations =
    isGo || action.actionState === 'READY' || action.actionState === 'MANAGE';
  const showBlockers =
    !isGo && action.actionState !== 'MANAGE' && action.blockers.length > 0;
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: `1px solid ${isGo ? `${action.color}88` : 'var(--line-1)'}`,
      borderLeft: `${isGo ? 4 : 3}px solid ${action.color}`,
      borderRadius: 'var(--r-md)',
      padding: '12px 16px',
      display: 'flex', alignItems: 'flex-start', gap: 16,
      flexWrap: 'wrap',
      boxShadow: isGo ? `0 0 18px ${action.color}33` : 'none',
      animation: isGo ? 'gcpro-action-go-pulse 2.6s ease-in-out infinite' : undefined,
      transition: 'box-shadow 0.4s ease, border-color 0.4s ease',
    }}>
      <style>{`
        @keyframes gcpro-action-go-pulse {
          0%, 100% { box-shadow: 0 0 14px ${COLOR_GO_GLOW}33; }
          50%      { box-shadow: 0 0 22px ${COLOR_GO_GLOW}55; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-action-banner="GO"] { animation: none !important; }
        }
      `}</style>
      <div data-action-banner={action.actionState}
           style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{
          fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
          fontFamily: 'var(--font-mono)', fontWeight: 600,
        }}>
          ACTION STATE
        </span>
        <span style={{
          fontSize: 24, fontWeight: 800, letterSpacing: '0.06em',
          color: action.color, lineHeight: 1.1,
        }}>
          {action.actionState}
        </span>
        <span style={{
          fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.04em',
          fontFamily: 'var(--font-mono)', marginTop: 2,
        }}>
          {action.label}
        </span>
      </div>
      <div style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <span style={{
          fontSize: 12, color: 'var(--fg-1)', lineHeight: 1.45,
        }}>
          <span style={{
            color: 'var(--fg-4)', letterSpacing: '0.04em',
            fontFamily: 'var(--font-mono)',
          }}>Reason · </span>
          {action.reason}
        </span>
        {isGo && (
          <span style={{
            fontSize: 10, color: 'var(--fg-3)', lineHeight: 1.4,
            letterSpacing: '0.02em', fontStyle: 'italic',
          }}>
            Respect invalidation. No certainty implied — Guru read.
          </span>
        )}
        {showConfirmations && action.confirmations.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2,
          }}>
            {action.confirmations.slice(0, 6).map((c, i) => (
              <span key={i} style={{
                fontSize: 10, color: action.color,
                fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
              }}>
                ✓ {c}
              </span>
            ))}
          </div>
        )}
        {showBlockers && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2,
          }}>
            {action.blockers.slice(0, 4).map((b, i) => (
              <span key={i} style={{
                fontSize: 10, color: 'var(--fg-3)',
                fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
              }}>
                · {b}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 5. ENV vs POSITION THESIS banner (v16.1) ─────────────────────

export function EnvVsThesisBanner({
  aiState, hasOpenPosition, history, priceStructure,
}: {
  aiState:         GcpStateResponse | null;
  hasOpenPosition: boolean;
  history:         AiStateHistoryRecord[];
  priceStructure:  PriceStructureRead | null;
}) {
  if (!aiState || !hasOpenPosition) return null;

  const envAction = deriveActionState({
    aiState, history, priceStructure,
    hasOpenPosition: false,
  });
  const positionAction = deriveActionState({
    aiState, history, priceStructure,
    hasOpenPosition: true,
  });

  const drift =
    history.length >= 2
      ? deriveTemporalDrift(
          driftFrameFromHistoryRecord(history[0]),
          driftFrameFromHistoryRecord(history[1]),
        )
      : null;

  const evt = deriveEnvVsThesis({
    envAction:       envAction.actionState,
    positionAction:  positionAction.actionState,
    hasOpenPosition,
    fieldDrift:      drift?.fieldDrift,
  });
  if (!evt.conflict || !evt.banner || !evt.thesisState) return null;

  const envColor =
      evt.envState === 'GO'    ? '#22c55e'
    : evt.envState === 'READY' ? '#4dd9e8'
    : evt.envState === 'WATCH' ? '#d4a028'
    :                            'var(--fg-3)';
  const thesisColor = THESIS_COLOR[evt.thesisState];

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: `3px solid ${thesisColor}`,
      borderRadius: 'var(--r-md)',
      padding: '10px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'baseline',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{
            fontSize: 8, letterSpacing: '0.18em', color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
          }}>
            ENVIRONMENT READ
          </span>
          <span style={{
            fontSize: 14, fontWeight: 700, letterSpacing: '0.05em',
            color: envColor,
          }}>
            {evt.envState}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{
            fontSize: 8, letterSpacing: '0.18em', color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
          }}>
            POSITION THESIS
          </span>
          <span style={{
            fontSize: 14, fontWeight: 700, letterSpacing: '0.05em',
            color: thesisColor,
          }}>
            {evt.thesisState}
          </span>
        </div>
        {drift && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{
              fontSize: 8, letterSpacing: '0.18em', color: 'var(--fg-4)',
              fontFamily: 'var(--font-mono)', fontWeight: 600,
            }}>
              TREND
            </span>
            <span style={{
              fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
              color: drift.color,
            }}>
              {drift.arrow} {drift.tag}
            </span>
          </div>
        )}
      </div>
      <span style={{
        fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.45,
      }}>
        {evt.banner}
      </span>
    </div>
  );
}

// ── 6. DIRECTIONAL EDGE ──────────────────────────────────────────

export function DirectionalEdgeCard({
  aiState,
}: {
  aiState: GcpStateResponse | null;
}) {
  const edge = deriveDirectionalEdge(aiState);
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: `2px solid ${edge.color}`,
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        DIRECTIONAL EDGE
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700, letterSpacing: '0.04em',
        color: edge.color, lineHeight: 1.1,
      }}>
        {edge.label}
      </div>
      <div style={{
        height: 4, borderRadius: 2, overflow: 'hidden',
        background: 'var(--bg-2)', border: '1px solid var(--line-2)',
      }}>
        <div style={{
          width: `${Math.round(edge.bar * 100)}%`, height: '100%',
          background: edge.color, transition: 'width 0.4s ease',
        }} />
      </div>
      <div style={{
        fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.45,
      }}>
        {edge.detail}
      </div>
    </div>
  );
}

// ── 7. THESIS STABILITY ──────────────────────────────────────────

export function ThesisStabilityCard({
  aiState,
}: {
  aiState: GcpStateResponse | null;
}) {
  const stab = deriveThesisStability(aiState);
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: `2px solid ${stab.color}`,
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        THESIS STABILITY
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700, letterSpacing: '0.04em',
        color: stab.color, lineHeight: 1.1,
      }}>
        {stab.level}
      </div>
      <div style={{
        height: 4, borderRadius: 2, overflow: 'hidden',
        background: 'var(--bg-2)', border: '1px solid var(--line-2)',
      }}>
        <div style={{
          width: `${Math.round(stab.bar * 100)}%`, height: '100%',
          background: stab.color, transition: 'width 0.4s ease',
        }} />
      </div>
      <div style={{
        fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.45,
      }}>
        {stab.hint}
      </div>
    </div>
  );
}

// ── 8. STATE FLOW RIBBON (last 5 anchored states) ───────────────

export function StateFlowRibbon({
  records, currentState,
}: {
  records:      AiStateHistoryRecord[];
  currentState: GcpStateResponse | null;
}) {
  const tail = records.slice(0, 5).reverse();
  const items: { code: string; label: string; isCurrent: boolean }[] =
    tail.map((r, i) => ({
      code:      r.stateCode,
      label:     r.state,
      isCurrent: i === tail.length - 1,
    }));
  if (currentState
      && (items.length === 0 || items[items.length - 1].code !== currentState.stateCode)) {
    items.push({ code: currentState.stateCode, label: currentState.state, isCurrent: true });
  } else if (currentState && items.length > 0) {
    items[items.length - 1].isCurrent = true;
  }
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        STATE FLOW
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          No prior states yet — flow starts after the first analysis.
        </div>
      ) : (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}>
          {items.map((it, i) => {
            const isLast = i === items.length - 1;
            const accent = stateColor({
              stateCode: it.code, direction: 'Neutral',
            } as GcpStateResponse);
            const opacity = it.isCurrent ? 1 : (0.45 + (i / items.length) * 0.35);
            return (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{
                  display: 'inline-flex', flexDirection: 'column',
                  alignItems: 'center', padding: '3px 8px',
                  background: it.isCurrent ? `${accent}1f` : `${accent}0d`,
                  border: `1px solid ${accent}${it.isCurrent ? '99' : '44'}`,
                  borderRadius: 3, opacity,
                }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: accent,
                    fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
                  }}>{it.code}</span>
                </span>
                {!isLast && <span style={{ color: 'var(--fg-4)', fontSize: 11 }}>→</span>}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 9. HISTORICAL ANALOG ─────────────────────────────────────────

export function HistoricalAnalogCard({
  records, symbol, aiState,
}: {
  records: AiStateHistoryRecord[];
  symbol:  MarketSymbol;
  aiState: GcpStateResponse | null;
}) {
  const analog = useMemo(
    () => deriveHistoricalAnalog(records, symbol, aiState),
    [records, symbol, aiState],
  );
  const arrow =
    analog.forwardMovePct == null ? '—'
  : analog.forwardMovePct >= 0.05 ? '↑'
  : analog.forwardMovePct <= -0.05 ? '↓'
  :                                  '→';
  const arrowColor =
    analog.forwardMovePct == null ? 'var(--fg-3)'
  : analog.forwardMovePct >= 0.05 ? 'var(--green)'
  : analog.forwardMovePct <= -0.05 ? 'var(--red)'
  :                                  'var(--fg-3)';
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        HISTORICAL ANALOG
      </div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        fontFamily: 'var(--font-mono)',
      }}>
        <span style={{
          fontSize: 22, fontWeight: 700, color: arrowColor,
          lineHeight: 1,
        }}>{arrow}</span>
        <span style={{
          fontSize: 16, color: 'var(--fg-1)', fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {analog.forwardMovePct != null
            ? `${analog.forwardMovePct >= 0 ? '+' : ''}${analog.forwardMovePct.toFixed(2)}%`
            : '—'}
        </span>
        <span style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.08em' }}>
          avg 4h move
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--fg-3)', lineHeight: 1.5 }}>
        {analog.summary}
      </div>
    </div>
  );
}

// ── 10. AI READ STRIP (v18.0) — compact one-liner for Trade ──────
//
// Trade no longer carries the full Environment Thesis card. Instead
// a one-line strip surfaces the headline read so the operator stays
// aware of the AI context without parsing a multi-line interpretation.
// Example: "FA · Mid · Short bias · Thesis broken".

export function AiReadStrip({
  aiState, hasOpenPosition, history, priceStructure,
}: {
  aiState:         GcpStateResponse | null;
  hasOpenPosition: boolean;
  history:         AiStateHistoryRecord[];
  priceStructure:  PriceStructureRead | null;
}) {
  if (!aiState) {
    return (
      <div style={{
        padding: '6px 12px',
        background: 'var(--bg-1)', border: '1px solid var(--line-1)',
        borderRadius: 'var(--r-md)',
        fontSize: 10, color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
      }}>
        <b style={{ color: 'var(--fg-3)', letterSpacing: '0.18em' }}>AI READ · </b>
        no classification yet
      </div>
    );
  }
  const accent = stateColor(aiState);
  const action = deriveActionState({
    aiState, hasOpenPosition, history, priceStructure,
  });
  const conf = Math.round(aiState.confidence * 100);
  const biasArrow = directionArrow(aiState.direction);
  // One-line summary, compact and execution-relevant.
  return (
    <div style={{
      padding: '8px 14px',
      background: 'var(--bg-1)', border: '1px solid var(--line-1)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 'var(--r-md)',
      display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap',
      fontFamily: 'var(--font-mono)',
    }}>
      <span style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)', fontWeight: 600,
      }}>
        AI READ
      </span>
      <span style={{ fontSize: 12, color: accent, fontWeight: 700, letterSpacing: '0.04em' }}>
        {aiState.stateCode} · {aiState.phase}
      </span>
      <span style={{ fontSize: 11, color: 'var(--fg-2)' }}>
        {aiState.direction} {biasArrow}
      </span>
      <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>
        {conf}% clarity
      </span>
      <span style={{
        fontSize: 11, color: action.color, fontWeight: 700,
        letterSpacing: '0.04em',
        marginLeft: 'auto',
      }}>
        {action.actionState}
      </span>
      <span style={{ fontSize: 10, color: 'var(--fg-3)', lineHeight: 1.4 }}>
        {action.reason}
      </span>
    </div>
  );
}
