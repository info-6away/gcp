'use client';

// v11.27: Guru tab — dedicated AI analysis surface.
// v11.28: Guru v2 — make it feel alive.
//
// Page sections (top → bottom):
//   1. Header (LIVE)        — title, current state, status pulse,
//                             ticking "Xs ago" timestamp.
//   2. Current State Block  — existing AiStateCard (full posture,
//                             trade plan, plan status, refresh).
//   3. Micro-change chip    — strengthening / weakening / stable
//                             derived from confidence delta vs prior
//                             analysis.
//   4. State Evolution      — last 5 Guru states as horizontal chips,
//                             with → between them.
//   5. What Changed         — bullets explaining how prior analysis
//                             evolved into current.
//   6. Watch Next           — derived from tradePlan.triggerLevels +
//                             invalidationLevels.
//   7. Guru History         — local aiStateHistory ledger, with
//                             transition arrows on state changes and
//                             an All / State changes only filter.
//
// All deterministic, all local. No new Engine calls; no new payload
// fields. Reuses aiState / aiStateHistory / patternStory / tradePlan /
// planMemory.

import { useEffect, useMemo, useState } from 'react';
import type { GcpStateResponse, ClassifyErrorEnvelope } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import type { Pattern, MarketSymbol } from '@/types/gcp';
import { formatPrice } from '@/types/gcp';
import type { StructureRead } from '@/lib/priceStructure';
import type { Candle } from '@/lib/fetchCandles';
import {
  AI_HISTORY_LS_KEY, loadAiStateHistory,
  type AiStateHistoryRecord,
} from '@/lib/aiStateHistory';
import { stateColor } from '@/lib/aiState';
import { deriveTradePlan, type TradePlan } from '@/lib/tradePlan';
import { AI_ANALYSIS_TF } from '@/lib/aiTimeframe';
import { ladderColor, ladderLabel, type LadderState } from '@/lib/stateTransition';
import { deriveStance, type GuruStance } from '@/lib/guruStance';
import {
  dominanceColor, dominanceLabel,
  type StructuralDominance,
} from '@/lib/structuralDominance';
import {
  momentumLabel, momentumColor,
  type InheritedTrend, type MomentumState,
} from '@/lib/temporalPressure';
import {
  derivePressureDriver, deriveAlignment, deriveTrendIntegrity,
} from '@/lib/pressureSemantics';
import AiStateCard from './AiStateCard';
import { PageHeader } from './Chrome';

interface GuruViewProps {
  symbol:             MarketSymbol;
  symbolPrice:        number | null;
  aiState:            GcpStateResponse | null;
  aiEnabled:          boolean;
  aiStatus:           AiStatus;
  // v12.0.4: structured options. Manual button call sites must pass
  // `{ force: true, source: '<name>' }` to bypass the cost gate.
  aiRunNow:           (options?: { force?: boolean; source?: string }) => void;
  aiLastSuccess:      Date | null;
  // v12.0.3: typed proxy error envelope (null on success). When the
  // last classification failed, the header shows a meaningful copy:
  //   - "ENGINE OFFLINE — Using last known Guru state" (we still have
  //     a prior aiState to render)
  //   - "Guru request failed" (no prior state to fall back to)
  aiLastError?:       ClassifyErrorEnvelope | null;
  latestPattern:      Pattern | null;
  planStructure:      StructureRead;
  planAnalysisCandle: Candle | null;
  // v11.34: regime context. Surfaces under the STATE title as
  // "Regime B · NV 91" so transitions / ladder reads have the
  // background metadata they assume.
  regime?:            string | null;
  netVariance?:       number | null;
}

// ────────────────────────────────────────────────────────────────────
// Tiny helpers
// ────────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relativeTime(ts: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// 1 Hz tick used by the header timestamp + status dot animation.
function useTick(intervalMs: number = 1000): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

// ────────────────────────────────────────────────────────────────────
// Section: Guru Header (LIVE)
// ────────────────────────────────────────────────────────────────────

function GuruHeader({
  aiState, aiStatus, aiLastSuccess, aiEnabled, aiRunNow,
  aiLastError = null,
  regime = null, netVariance = null,
}: {
  aiState:        GcpStateResponse | null;
  aiStatus:       AiStatus;
  aiLastSuccess:  Date | null;
  aiEnabled:      boolean;
  aiRunNow:       (options?: { force?: boolean; source?: string }) => void;
  aiLastError?:   ClassifyErrorEnvelope | null;
  regime?:        string | null;
  netVariance?:   number | null;
}) {
  const now      = useTick(1000);
  const accent   = aiState ? stateColor(aiState) : 'var(--fg-3)';
  // v11.29.1: split the state line into two clear dimensions.
  // Headline = "COMPRESSION STATE · Late" so the user reads the
  // category + phase as one thought; the % moves to its own
  // "Confidence: 13%" sub-line so it can't be visually confused with
  // the transition Likelihood.
  const stateHeadline = aiState
    ? `${aiState.state.toUpperCase()} · ${aiState.phase}`
    : 'Guru has not analyzed this symbol yet.';
  const stateConfPct  = aiState ? Math.round(aiState.confidence * 100) : null;

  // Status verb maps to the state machine but with friendlier wording
  // for a "thinking out loud" feel.
  // v12.0.2/3: error copy distinguishes:
  //   • ENGINE OFFLINE — typed proxy error AND we still have a prior
  //     classification on screen (aiState present). Communicates that
  //     the displayed read is held-over, not freshly classified.
  //   • Guru request failed — typed proxy error and no prior state to
  //     fall back to, or unknown failure shape.
  // Pre-v12.0.3 every error showed the same label.
  const errorVerb = aiState
    ? 'ENGINE OFFLINE — Using last known Guru state'
    : 'Guru request failed';
  const statusVerb =
    aiStatus === 'running' ? 'Asking…'
  : aiStatus === 'error'   ? errorVerb
  : aiState                 ? 'Watching'
  :                            'Idle';
  const statusColor =
    aiStatus === 'running' ? 'var(--cyan)'
  : aiStatus === 'error'   ? 'var(--red)'
  :                            'var(--fg-3)';

  const lastUpdateLabel = aiLastSuccess
    ? relativeTime(aiLastSuccess.getTime(), now)
    : '—';

  // v11.28.1: primary Ask Guru CTA in the header. Always visible at
  // top-right so the user can re-trigger analysis without scrolling
  // into the AiStateCard. Label adapts to the aiStatus machine:
  //   running → ASKING…
  //   error   → TRY AGAIN
  //   success → ASK GURU AGAIN  (aiState present)
  //   idle    → ASK GURU
  const isRunning = aiStatus === 'running';
  const buttonLabel =
    isRunning              ? 'ASKING…'
  : aiStatus === 'error'   ? 'TRY AGAIN'
  : aiState                 ? 'ASK GURU AGAIN'
  :                            'ASK GURU';
  const buttonDisabled = !aiEnabled || isRunning;
  const buttonAccent = aiStatus === 'error' ? 'var(--red)' : 'var(--cyan)';

  // v12.0.2: click handler with mandatory dev trace. Pre-v12.0.2 the
  // button used the HTML `disabled` attribute, which swallows clicks
  // silently — so an aiEnabled=false / isRunning=true click produced
  // NOTHING in the console. We now drive the visual disabled style
  // ourselves (border/color/cursor) and use aria-disabled so the
  // click handler always fires; the handler logs + returns when the
  // button should be inert.
  // v12.0.4: aiRunNow now takes `{ force, source }`. A manual click
  // MUST pass `{ force: true, source: 'guru_button' }` to bypass the
  // server-side cost gate. Bare aiRunNow() defaults to force=false
  // (auto/heartbeat) and is silently skipped at the hook layer.
  const onAskGuruClick = () => {
    if (process.env.NODE_ENV !== 'production') {
      let reason: string;
      if (typeof aiRunNow !== 'function')   reason = 'missing_runNow';
      else if (isRunning)                   reason = 'already_running';
      else if (!aiEnabled)                  reason = 'aiEnabled_false';
      else                                  reason = 'ok';
      console.log('[ASK GURU CLICK]', {
        aiStatus,
        aiEnabled,
        hasRunNow: typeof aiRunNow === 'function',
        disabled:  buttonDisabled,
        force:     true,
        source:    'guru_button',
        reason,
      });
    }
    if (buttonDisabled || typeof aiRunNow !== 'function') return;
    aiRunNow({ force: true, source: 'guru_button' });
  };

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 'var(--r-md)',
      padding: '12px 16px',
      display: 'flex', alignItems: 'center', gap: 14,
      // Subtle breathing glow when an analysis is fresh (< 30s).
      boxShadow: aiState && aiLastSuccess && (now - aiLastSuccess.getTime() < 30_000)
        ? `0 0 18px ${accent}22`
        : 'none',
      transition: 'box-shadow 1s ease',
    }}>
      <div style={{
        fontSize: 22, color: accent, lineHeight: 1,
      }}>🧘</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.18em',
        }}>
          <span>GURU</span>
          <span style={{ color: 'var(--fg-4)' }}>·</span>
          <span style={{ color: statusColor, letterSpacing: '0.12em' }}>
            <span style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
              background: statusColor,
              marginRight: 6, verticalAlign: 'middle',
              animation: aiStatus === 'running' ? 'livepulse 1.4s ease-in-out infinite' : undefined,
            }} />
            {statusVerb.toUpperCase()}
          </span>
        </div>
        {/* v11.29.1: STATE = primary (bigger, stronger). The
            classification + phase live alone on this line so the
            eye reads "COMPRESSION STATE · LATE" as one thought.
            v11.34: when stateCode === 'IS', wrap the headline in a
            subtle breathing cyan ring — "ignition is anticipation"
            so the chip reads as alive, not static. */}
        <style>{`
          @keyframes guru-is-breathe {
            0%, 100% { box-shadow: 0 0 0 0 rgba(77,217,232,0); }
            50%      { box-shadow: 0 0 14px 0 rgba(77,217,232,0.30); }
          }
        `}</style>
        <div style={{
          marginTop: 4,
          fontSize: aiState ? 16 : 12,
          color: aiState ? accent : 'var(--fg-2)',
          fontWeight: 700,
          letterSpacing: '0.01em', lineHeight: 1.25,
          display: 'inline-block',
          padding: aiState?.stateCode === 'IS' ? '2px 8px' : 0,
          borderRadius: aiState?.stateCode === 'IS' ? 3 : 0,
          border: aiState?.stateCode === 'IS'
            ? '1px solid rgba(77,217,232,0.45)'
            : 'none',
          animation: aiState?.stateCode === 'IS'
            ? 'guru-is-breathe 4.5s ease-in-out infinite'
            : undefined,
        }}>
          {stateHeadline}
        </div>
        {/* v11.34: regime context line. "Regime B · NV 91" sits
            directly under the STATE so transitions / ladder reads
            have the background metadata immediately visible. */}
        {aiState && (regime || netVariance != null) && (
          <div style={{
            marginTop: 3,
            fontSize: 10, color: 'var(--fg-3)',
            fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
          }}>
            {regime && (
              <span>
                <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em' }}>REGIME </span>
                <span style={{ color: 'var(--fg-1)' }}>{regime}</span>
              </span>
            )}
            {regime && netVariance != null && (
              <span style={{ color: 'var(--fg-4)' }}>{' · '}</span>
            )}
            {netVariance != null && (
              <span>
                <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em' }}>NV </span>
                <span style={{
                  color: 'var(--fg-1)',
                  fontVariantNumeric: 'tabular-nums',
                }}>{netVariance.toFixed(1)}</span>
              </span>
            )}
          </div>
        )}

        {/* v11.30: STANCE block — execution layer, highest visual
            weight after STATE. Sits BEFORE the transition overlay
            and CONFIDENCE row so the user can answer
            "do I trade or not?" in <2s. */}
        {aiState && (() => {
          const stance = deriveStance(aiState);
          return stance ? <StanceBlock stance={stance} /> : null;
        })()}

        {/* v11.36: DIRECTIONAL PRESSURE block — environment bias %
            (NOT entry certainty). Sits directly under STANCE so the
            user reads "what to do" then "which way the environment
            is leaning" before the forward-looking transition chip.
            Pure synthesis layer; renders only when the engine layer
            has attached pressure values. */}
        {aiState?.longPressure != null && aiState?.shortPressure != null && (
          <DirectionalPressureBlock
            aiStateForSemantics={aiState}
            longPct={aiState.longPressure}
            shortPct={aiState.shortPressure}
            band={aiState.pressureBand ?? 'weak'}
            explanation={aiState.pressureExplanation ?? ''}
          />
        )}

        {/* v13.4: MARKET CONTEXT — structure / momentum / trend
            integrity. Pulled out of the pressure block so the two
            categories never visually fuse. */}
        <MarketContextBlock aiState={aiState} />

        {/* v11.29: state-transition ladder overlay — SECONDARY (lighter).
            Sits below the state block so the user sees both "what is"
            and "what's going next" without scrolling. Hidden when the
            engine layer hasn't attached a transition (deriveNextState
            returns empty for SS / CL / DD or when no clear rule
            fires). v11.29.1: also surface a "low state certainty"
            hint when the user might otherwise weight the transition
            number too heavily. */}
        {aiState?.nextLikelyState && (
          <>
            <NextStateOverlay
              nextState={aiState.nextLikelyState as LadderState}
              confidence={aiState.transitionConfidence ?? 0.5}
              reason={aiState.transitionReason}
            />
            {stateConfPct != null
              && aiState.confidence < 0.25
              && (aiState.transitionConfidence ?? 0) > 0.50 && (
              <div style={{
                marginTop: 6, fontSize: 10, color: '#d4a028',
                letterSpacing: '0.04em', lineHeight: 1.4,
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{
                  width: 4, height: 4, borderRadius: '50%',
                  background: '#d4a028',
                }} />
                Low environment clarity — structure still forming.
              </div>
            )}
          </>
        )}

        {/* v11.34: relabelled CONFIDENCE → STATE CERTAINTY so it
            stops competing semantically with TRANSITION LIKELIHOOD.
            v13.1.1: relabelled again → ENVIRONMENT CLARITY. Reads as
            "how clearly the current environment is resolving" which
            matches what the metric actually communicates better than
            the prior "state certainty" framing. Same value
            (aiState.confidence × 100). */}
        {stateConfPct != null && (
          <div
            title="How clearly the current environment is resolving"
            style={{
              marginTop: 8,
              fontSize: 10, color: 'var(--fg-3)',
              letterSpacing: '0.06em',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span style={{ letterSpacing: '0.14em', color: 'var(--fg-4)' }}>
              ENVIRONMENT CLARITY
            </span>
            <span style={{
              color: 'var(--fg-1)', marginLeft: 6,
              fontVariantNumeric: 'tabular-nums', fontWeight: 600,
            }}>
              {stateConfPct}%
            </span>
          </div>
        )}

        {aiLastSuccess && (
          <div style={{
            marginTop: 4,
            fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.06em',
          }}>
            Last update <span style={{
              color: 'var(--fg-2)',
              fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
            }}>{lastUpdateLabel}</span>
          </div>
        )}

        {/* v12.0.3: structured proxy error chip. When aiLastError is
            present, show the typed error class + HTTP status so the
            user can distinguish "engine_forbidden 403" from
            "engine_unavailable 502" without opening the console.
            Hidden when the last call succeeded (lastError cleared). */}
        {aiLastError && (
          <div style={{
            marginTop: 4,
            display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
            fontSize: 9, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em', color: 'var(--red)',
          }}>
            <span style={{
              padding: '1px 6px',
              background: 'rgba(196,90,90,0.12)',
              border: '1px solid #c45a5a55',
              color: '#c45a5a',
              borderRadius: 2,
              fontWeight: 700, letterSpacing: '0.12em',
            }}>
              {aiLastError.error.type.toUpperCase()}
              {aiLastError.error.status != null ? ` · ${aiLastError.error.status}` : ''}
            </span>
            <span style={{
              color: 'var(--fg-3)', letterSpacing: 0,
              fontStyle: 'italic',
            }}>
              {aiLastError.error.message}
            </span>
          </div>
        )}

        {/* v12.0.0: Engine _meta diagnostic chip + stale badge. Tiny,
            terminal-flat, sits below "Last update" so power users can
            see which model/provider produced the current read. Hidden
            entirely when the Engine didn't return _meta (older Engine
            versions / pre-fallback responses). */}
        {aiState && (aiState._meta || aiState.stale) && (
          <div style={{
            marginTop: 4,
            display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
            fontSize: 9, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em', color: 'var(--fg-4)',
          }}>
            {aiState.stale && (
              <span style={{
                padding: '1px 6px',
                background: 'rgba(212,160,40,0.12)',
                border: '1px solid #d4a02855',
                color: '#d4a028',
                borderRadius: 2,
                fontWeight: 700, letterSpacing: '0.12em',
              }}>
                STALE{aiState.staleReason ? ` · ${aiState.staleReason}` : ''}
              </span>
            )}
            {aiState._meta?.model && (
              <span>
                <span style={{ letterSpacing: '0.14em' }}>MODEL </span>
                <span style={{ color: 'var(--fg-2)' }}>{aiState._meta.model}</span>
              </span>
            )}
            {aiState._meta?.provider && (
              <span>
                <span style={{ letterSpacing: '0.14em' }}>· PROVIDER </span>
                <span style={{ color: 'var(--fg-2)' }}>{aiState._meta.provider}</span>
              </span>
            )}
            {aiState._meta?.fallback && (
              <span style={{ color: '#d4a028' }}>· fallback</span>
            )}
            {aiState._meta?.latencyMs != null && (
              <span>
                <span style={{ letterSpacing: '0.14em' }}>· {aiState._meta.latencyMs}ms</span>
              </span>
            )}
          </div>
        )}
      </div>
      <button
        onClick={onAskGuruClick}
        // v12.0.2: aria-disabled + handler-side gate instead of HTML
        // `disabled`, so click always reaches the handler and the
        // [ASK GURU CLICK] trace fires even when the button is inert.
        aria-disabled={buttonDisabled || undefined}
        title={!aiEnabled ? 'Guru is disabled in Settings' : undefined}
        style={{
          padding: '8px 14px',
          fontSize: 11, letterSpacing: '0.14em', fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          background: isRunning ? `${buttonAccent}1f` : 'transparent',
          border: `1px solid ${buttonDisabled ? 'var(--line-2)' : buttonAccent}`,
          color: buttonDisabled ? 'var(--fg-3)' : buttonAccent,
          borderRadius: 4,
          cursor: buttonDisabled ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          // Pulse the border very subtly when fresh data is in.
          transition: 'background 0.2s ease, border-color 0.2s ease, color 0.2s ease',
        }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// v11.30: GURU STANCE — execution layer.
// Sits directly under STATE so the user can answer
// "do I trade or not?" in under two seconds.
//   STANCE     — bold white  (action verb)
//   MODE       — amber       (phase descriptor)
//   EXECUTION  — cyan        (how to act)
// ────────────────────────────────────────────────────────────────────

function StanceBlock({ stance }: { stance: GuruStance }) {
  return (
    <div style={{
      marginTop: 8,
      padding: '8px 10px',
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid var(--line-1)',
      borderLeft: '2px solid var(--fg-0)',
      borderRadius: 3,
      display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      <StanceRow
        label="STANCE"
        value={stance.stance}
        color="var(--fg-0)"
        emphasis
      />
      <StanceRow
        label="MODE"
        value={stance.mode}
        color="#d4a028"
      />
      <StanceRow
        label="EXECUTION"
        value={stance.execution}
        color="var(--cyan)"
      />
    </div>
  );
}

function StanceRow({
  label, value, color, emphasis = false,
}: {
  label:     string;
  value:     string;
  color:     string;
  emphasis?: boolean;
}) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '78px 1fr',
      gap: 10,
      alignItems: 'baseline',
    }}>
      <span style={{
        fontSize: 8, letterSpacing: '0.18em',
        color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        {label}
      </span>
      <span style={{
        color,
        fontSize: emphasis ? 14 : 11,
        fontWeight: emphasis ? 700 : 500,
        letterSpacing: emphasis ? '0.01em' : '0.02em',
        lineHeight: 1.35,
      }}>
        {value}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// v11.36: DIRECTIONAL PRESSURE — environment bias synthesis.
//
// Pure derived block. Reads longPressure / shortPressure / pressureBand
// / pressureExplanation already attached to aiState by the
// deriveDirectionalPressure() pass in useGcpState. Renders:
//   header        — "DIRECTIONAL PRESSURE · weak | moderate | strong"
//   split bar     — horizontal cyan/green long fill vs muted red short
//   row           — LONG xx%   SHORT yy%
//   explanation   — single-line why
//
// IMPORTANT: this is environment bias %, NOT entry certainty. The
// label and the explanation copy both reinforce that.
// ────────────────────────────────────────────────────────────────────

function DirectionalPressureBlock({
  longPct, shortPct, band, explanation,
  // v13.4: pressure block now CARRIES pressure semantics only —
  // pressure driver + alignment. Structure / momentum live in the
  // separate MarketContextBlock below this. The aiState reference is
  // passed in so the helpers can read the structureDominance /
  // momentumState / pressureExplanation fields already attached.
  aiStateForSemantics,
}: {
  longPct:     number;
  shortPct:    number;
  band:        'weak' | 'moderate' | 'strong';
  explanation: string;
  aiStateForSemantics?: GcpStateResponse | null;
}) {
  const longColor   = '#4dd9e8';        // cyan, matches existing accent
  const shortColor  = '#c45a5a';        // muted red, not screaming
  const bandColor   = band === 'strong'   ? 'var(--cyan)'
                    : band === 'moderate' ? '#d4a028'
                    :                        'var(--fg-3)';
  return (
    <div
      title="Environment bias pressure — NOT entry certainty"
      style={{
        marginTop: 8,
        padding: '8px 10px',
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid var(--line-1)',
        borderRadius: 3,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 8,
      }}>
        <span style={{
          fontSize: 9, letterSpacing: '0.18em',
          color: 'var(--fg-4)', fontFamily: 'var(--font-mono)', fontWeight: 600,
        }}>
          DIRECTIONAL PRESSURE
        </span>
        <span style={{
          fontSize: 8, letterSpacing: '0.14em',
          color: bandColor,
          fontFamily: 'var(--font-mono)', fontWeight: 700,
        }}>
          {band.toUpperCase()}
        </span>
      </div>

      {/* Split bar — single rounded track, two flex children. */}
      <div style={{
        display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden',
        border: '1px solid var(--line-2)',
        background: 'var(--bg-2)',
      }}>
        <div style={{
          width: `${longPct}%`,
          background: longColor,
          transition: 'width 0.4s ease',
        }} />
        <div style={{
          width: `${shortPct}%`,
          background: shortColor,
          transition: 'width 0.4s ease',
        }} />
      </div>

      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 10, fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.04em',
      }}>
        <span style={{ color: longColor, fontWeight: 600 }}>
          LONG <span style={{ color: 'var(--fg-1)' }}>{longPct}%</span>
        </span>
        <span style={{ color: shortColor, fontWeight: 600 }}>
          SHORT <span style={{ color: 'var(--fg-1)' }}>{shortPct}%</span>
        </span>
      </div>

      {explanation && (
        <div style={{
          fontSize: 10, color: 'var(--fg-3)',
          fontStyle: 'italic', lineHeight: 1.45,
        }}>
          {explanation}
        </div>
      )}

      {/* v13.4: PRESSURE DRIVER — one-line "why pressure is what it
          is" derived from state + dominance + momentum + the existing
          pressureExplanation. Sits inside the pressure block (this
          block) because it's pressure-side semantics, not structure. */}
      {(() => {
        const driver = derivePressureDriver(aiStateForSemantics ?? null);
        if (!driver || driver === explanation) return null;
        return (
          <div style={{
            marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2,
            fontSize: 9, fontFamily: 'var(--font-mono)',
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

      {/* v13.4: ALIGNMENT — whether structure and pressure point the
          same way. Critical because structure ≠ pressure: divergence
          is intentional, not a bug, and the user needs to see it
          framed as such. */}
      {(() => {
        const align = deriveAlignment(aiStateForSemantics ?? null);
        if (align.status === 'unclear'
            && !aiStateForSemantics?.structureDominance) return null;
        const icon = align.status === 'aligned'   ? '✓'
                   : align.status === 'diverging' ? '⚠'
                   :                                 '·';
        return (
          <div style={{
            marginTop: 2, display: 'flex', alignItems: 'baseline', gap: 6,
            fontSize: 9, fontFamily: 'var(--font-mono)',
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
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// v13.4: MARKET CONTEXT block — structure / momentum / trend integrity.
//
// Pulled OUT of the pressure block so the two categories never visually
// fuse. Structure communicates "is the trend skeleton intact?"; pressure
// communicates "which side is the environment leaning right now?".
// These are different questions and the new block makes that explicit.
// ────────────────────────────────────────────────────────────────────

function MarketContextBlock({ aiState }: { aiState: GcpStateResponse | null }) {
  if (!aiState) return null;
  const dom            = aiState.structureDominance;
  const momentumState  = aiState.momentumState;
  const inheritedTrend = aiState.inheritedTrend;
  const trendIntegrity = deriveTrendIntegrity(aiState);

  // Nothing to show — keep the layout from rendering an empty box.
  if (!dom && !momentumState) return null;

  return (
    <div style={{
      marginTop: 8,
      padding: '8px 10px',
      background: 'rgba(255,255,255,0.018)',
      border: '1px solid var(--line-1)',
      borderLeft: '2px solid var(--fg-3)',
      borderRadius: 3,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        MARKET CONTEXT
      </div>
      {dom && (
        <div style={{
          display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10,
          alignItems: 'baseline',
          fontSize: 10, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
        }}>
          <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em', fontSize: 9 }}>
            MARKET STRUCTURE
          </span>
          <span style={{
            color: dominanceColor(dom as StructuralDominance),
            fontWeight: 600,
          }}>
            {dominanceLabel(dom as StructuralDominance)}
          </span>
        </div>
      )}
      {momentumState && (
        <div style={{
          display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10,
          alignItems: 'baseline',
          fontSize: 10, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
        }}>
          <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em', fontSize: 9 }}>
            MOMENTUM
          </span>
          <span style={{
            color: momentumColor(momentumState as MomentumState),
            fontWeight: 600,
          }}>
            {momentumLabel(
              momentumState as MomentumState,
              (inheritedTrend ?? 'neutral') as InheritedTrend,
            )}
          </span>
        </div>
      )}
      <div style={{
        display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10,
        alignItems: 'baseline',
        fontSize: 10, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.04em',
      }}>
        <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em', fontSize: 9 }}>
          TREND INTEGRITY
        </span>
        <span style={{
          color: trendIntegrity.color,
          fontWeight: 600,
        }}>
          {trendIntegrity.label}
        </span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// v11.29: NEXT → overlay for the state transition ladder.
// ────────────────────────────────────────────────────────────────────

function NextStateOverlay({
  nextState, confidence, reason,
}: {
  nextState:  LadderState;
  confidence: number;
  reason?:    string;
}) {
  const color = ladderColor(nextState);
  const label = ladderLabel(nextState);
  const conf  = Math.round(confidence * 100);
  // v11.34: chip relabelled and restructured. Header reads
  // "TRANSITION LIKELIHOOD" so it can never be confused with
  // STATE CERTAINTY; the value renders as "Ignition · 55%" with
  // the reason on its own subdued italic line.
  return (
    <div
      title="How likely the system is to move into this next state"
      style={{
        marginTop: 8,
        padding: '6px 10px',
        background: `${color}0d`,
        border: `1px solid ${color}40`,
        borderLeft: `2px solid ${color}`,
        borderRadius: 3,
        display: 'flex', flexDirection: 'column', gap: 3,
        maxWidth: 'fit-content',
      }}
    >
      <div style={{
        fontSize: 9, letterSpacing: '0.18em',
        color: 'var(--fg-4)', fontFamily: 'var(--font-mono)',
        fontWeight: 600,
      }}>
        TRANSITION LIKELIHOOD
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          color, fontWeight: 700, letterSpacing: '0.02em', fontSize: 13,
        }}>
          {label}
        </span>
        <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>·</span>
        <span style={{
          color: 'var(--fg-1)', fontSize: 12,
          fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
          fontWeight: 600,
        }}>
          {conf}%
        </span>
      </div>
      {reason && (
        <div style={{
          color: 'var(--fg-3)', fontSize: 10,
          fontStyle: 'italic', lineHeight: 1.45,
        }}>
          {reason}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Section: Micro-change indicator
// ────────────────────────────────────────────────────────────────────

function MicroChange({
  current, prior,
}: {
  current: GcpStateResponse | null;
  prior:   AiStateHistoryRecord | null;
}) {
  if (!current || !prior) return null;
  const dConf = current.confidence - prior.confidence;
  const stateChanged = current.stateCode !== prior.stateCode;
  let arrow = '→';
  let label = 'Stable';
  let color = 'var(--fg-3)';
  if (stateChanged) {
    arrow = '↗'; label = 'New state'; color = 'var(--cyan)';
  } else if (dConf >= 0.05) {
    arrow = '↗'; label = 'Strengthening'; color = 'var(--green)';
  } else if (dConf <= -0.05) {
    arrow = '↘'; label = 'Weakening'; color = 'var(--red)';
  }
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 6,
      padding: '3px 10px',
      background: `${color}10`, border: `1px solid ${color}55`,
      borderRadius: 3,
      fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
      color,
    }}>
      <span style={{ fontSize: 12 }}>{arrow}</span>
      <span style={{ fontWeight: 600 }}>{label.toUpperCase()}</span>
      {!stateChanged && Math.abs(dConf) >= 0.01 && (
        <span style={{ color: 'var(--fg-3)', marginLeft: 4 }}>
          {(prior.confidence * 100).toFixed(0)}% → {(current.confidence * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Section: State Evolution
// ────────────────────────────────────────────────────────────────────

function StateEvolution({
  records, currentState,
}: {
  records:      AiStateHistoryRecord[];
  currentState: GcpStateResponse | null;
}) {
  // Last 5 entries oldest → newest. If currentState matches the most
  // recent record, we don't dupe — the latest record IS the current.
  const tail = records.slice(0, 5).reverse();
  const items: { code: string; label: string; isCurrent: boolean }[] = tail.map((r, i) => ({
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
  if (!items.length) {
    return (
      <Section title="STATE EVOLUTION">
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          No prior states yet — Guru history starts after your first analysis.
        </div>
      </Section>
    );
  }
  return (
    <Section title="STATE EVOLUTION">
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        flexWrap: 'wrap',
      }}>
        {items.map((it, i) => {
          const isLast    = i === items.length - 1;
          const accent    = stateColor({ stateCode: it.code, direction: 'Neutral' } as GcpStateResponse);
          const opacity   = it.isCurrent ? 1 : (0.45 + (i / items.length) * 0.35);
          return (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
                padding: '4px 10px',
                background: it.isCurrent ? `${accent}1f` : `${accent}0d`,
                border: `1px solid ${accent}${it.isCurrent ? '99' : '44'}`,
                borderRadius: 3,
                opacity,
                transition: 'opacity 0.3s ease',
              }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: accent,
                  fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
                }}>{it.code}</span>
                <span style={{
                  fontSize: 8, color: 'var(--fg-3)', letterSpacing: '0.06em',
                  marginTop: 1,
                }}>{it.label.split(' ')[0].toUpperCase()}</span>
              </span>
              {!isLast && <span style={{ color: 'var(--fg-4)', fontSize: 12 }}>→</span>}
            </span>
          );
        })}
      </div>
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────────
// Section: What Changed
// ────────────────────────────────────────────────────────────────────

function WhatChanged({
  current, prior,
}: {
  current: GcpStateResponse | null;
  prior:   AiStateHistoryRecord | null;
}) {
  if (!current) return null;
  const bullets: string[] = [];
  if (!prior) {
    bullets.push('First Guru analysis for this symbol — establishing baseline.');
  } else {
    if (current.stateCode !== prior.stateCode) {
      bullets.push(`State shifted from ${prior.state} (${prior.stateCode}) to ${current.state} (${current.stateCode})`);
    }
    if (current.direction !== prior.direction) {
      bullets.push(`Bias rotated from ${prior.direction} to ${current.direction}`);
    }
    if (current.phase !== prior.phase) {
      bullets.push(`Phase moved from ${prior.phase} to ${current.phase}`);
    }
    const dConf = current.confidence - prior.confidence;
    if (Math.abs(dConf) >= 0.10) {
      const dir = dConf > 0 ? 'rose' : 'fell';
      bullets.push(`Confidence ${dir} from ${(prior.confidence * 100).toFixed(0)}% to ${(current.confidence * 100).toFixed(0)}%`);
    }
    // (Pattern delta intentionally omitted — GcpStateResponse doesn't
    // carry patternCode; the prior bullet stack already covers state /
    // bias / phase / confidence which are the headline transitions.)
  }
  if (!bullets.length) {
    bullets.push('No material change — state, bias, and confidence held steady.');
  }
  return (
    <Section title="WHAT CHANGED">
      <ul style={{
        margin: 0, padding: 0, listStyle: 'none',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {bullets.slice(0, 4).map((b, i) => (
          <li key={i} style={{
            position: 'relative', paddingLeft: 14,
            fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.55,
          }}>
            <span style={{
              position: 'absolute', left: 0, top: 6,
              width: 4, height: 4, borderRadius: '50%',
              background: 'var(--cyan)',
            }} />
            {b}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────────
// Section: Watch Next
// ────────────────────────────────────────────────────────────────────

function fmtLevel(symbol: MarketSymbol, n: number | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (symbol === 'BTC')    return Math.round(n).toLocaleString();
  if (symbol === 'XAGUSD') return n.toFixed(3);
  return n.toFixed(2);
}

function WatchNext({
  plan, symbol,
}: {
  plan:   TradePlan | null;
  symbol: MarketSymbol;
}) {
  if (!plan || !plan.triggerLevels) {
    return (
      <Section title="WATCH NEXT">
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          No actionable triggers yet — wait for Guru to identify a setup.
        </div>
      </Section>
    );
  }
  const t = plan.triggerLevels;
  const inv = plan.invalidationLevels ?? {};
  const items: { sign: '↑' | '↓' | '·'; text: string; tone: 'green' | 'red' | 'neutral' }[] = [];
  const buyAbove   = fmtLevel(symbol, t.buyAbove);
  const sellBelow  = fmtLevel(symbol, t.sellBelow);
  const resistance = fmtLevel(symbol, t.resistance);
  const support    = fmtLevel(symbol, t.support);
  const above      = fmtLevel(symbol, inv.above);
  const below      = fmtLevel(symbol, inv.below);

  if (buyAbove)   items.push({ sign: '↑', text: `Break above ${buyAbove} → trend attempt`,    tone: 'green' });
  if (sellBelow)  items.push({ sign: '↓', text: `Break below ${sellBelow} → continuation down`, tone: 'red'   });
  if (!buyAbove && resistance) items.push({ sign: '↑', text: `Reject at ${resistance} → fade extreme`, tone: 'red' });
  if (!sellBelow && support)   items.push({ sign: '↓', text: `Reject at ${support} → fade extreme`,    tone: 'green' });
  if (above && !buyAbove)      items.push({ sign: '·', text: `Reclaim above ${above} invalidates the read`, tone: 'neutral' });
  if (below && !sellBelow)     items.push({ sign: '·', text: `Lose ${below} invalidates the read`,        tone: 'neutral' });
  if (plan.entryType === 'No entry') {
    items.length = 0;
    items.push({ sign: '·', text: 'Failure inside range → no trade — wait for clean acceptance', tone: 'neutral' });
  }

  if (!items.length) {
    return (
      <Section title="WATCH NEXT">
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          No explicit levels — current plan: {plan.headline}
        </div>
      </Section>
    );
  }
  return (
    <Section title="WATCH NEXT">
      <ul style={{
        margin: 0, padding: 0, listStyle: 'none',
        display: 'flex', flexDirection: 'column', gap: 5,
      }}>
        {items.slice(0, 4).map((it, i) => {
          const color = it.tone === 'green' ? 'var(--green)'
                      : it.tone === 'red'   ? 'var(--red)'
                      :                        'var(--fg-3)';
          return (
            <li key={i} style={{
              display: 'grid', gridTemplateColumns: '14px 1fr',
              gap: 8, fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.5,
            }}>
              <span style={{ color, fontWeight: 600, textAlign: 'center' }}>{it.sign}</span>
              <span>{it.text}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────────
// v13.3: Expandable Guru History snapshot.
//
// Each row in the history list now toggles into a black-box style
// detail block on click. Only ONE row stays expanded at a time so
// the user can scan vertically without losing focus. Every section
// renders only when its data is present — older entries written
// before v13.3 simply show fewer panels.
// ────────────────────────────────────────────────────────────────────

function SnapSection({ title, children }: {
  title:    string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      minWidth: 0,
    }}>
      <div style={{
        fontSize: 8, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
        textTransform: 'uppercase',
      }}>
        {title}
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 2,
        fontSize: 10, fontFamily: 'var(--font-mono)',
        color: 'var(--fg-1)', lineHeight: 1.45,
      }}>
        {children}
      </div>
    </div>
  );
}

function SnapRow({ label, value, accent }: {
  label:   string;
  value:   React.ReactNode;
  accent?: string;
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'minmax(70px, auto) 1fr',
      gap: 8, alignItems: 'baseline',
    }}>
      <span style={{ color: 'var(--fg-4)', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{
        color: accent ?? 'var(--fg-1)',
        fontVariantNumeric: 'tabular-nums',
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {value}
      </span>
    </div>
  );
}

function ExpandedHistoryRow({
  r, symbol,
}: {
  r:      AiStateHistoryRecord;
  symbol: MarketSymbol;
}) {
  const sections: React.ReactNode[] = [];
  const stateAccent = stateColor({
    stateCode: r.stateCode, direction: r.direction,
  } as unknown as GcpStateResponse);

  // A) Environment ─────────────────────────────────────────────────
  sections.push(
    <SnapSection key="env" title="Environment">
      <SnapRow label="state"        value={`${r.stateCode} · ${r.state}`}             accent={stateAccent} />
      <SnapRow label="phase / bias" value={`${r.phase} · ${r.direction}`} />
      {typeof r.confidence === 'number' && (
        <SnapRow label="clarity"    value={`${Math.round(r.confidence * 100)}%`} />
      )}
      {r.marketBias && (
        <SnapRow label="market bias" value={r.marketBias} />
      )}
      <SnapRow label="regime · NV"  value={`${r.regime ?? '—'} · ${r.netVariance?.toFixed(1) ?? '—'}`} />
      <SnapRow label="symbol · tf"  value={`${r.symbol} · ${r.timeframe}`} />
      <SnapRow
        label="price"
        value={fmtLevel(symbol, r.priceAtAnalysis ?? undefined) ?? '—'}
      />
    </SnapSection>,
  );

  // B) Guru Stance — DERIVED at view time from the stored stateCode
  // / phase / direction. v13.3 doesn't persist stance separately; the
  // derivation is deterministic from the fields already in the record.
  const stance = deriveStance({
    stateCode: r.stateCode, phase: r.phase, direction: r.direction,
  } as unknown as GcpStateResponse);
  if (stance) {
    sections.push(
      <SnapSection key="stance" title="Guru Stance">
        <SnapRow label="stance"    value={stance.stance}    accent="var(--fg-0)" />
        <SnapRow label="mode"      value={stance.mode}      accent="#d4a028" />
        <SnapRow label="execution" value={stance.execution} accent="var(--cyan)" />
      </SnapSection>,
    );
  }

  // C) Directional Pressure ────────────────────────────────────────
  if (typeof r.longPressure === 'number' && typeof r.shortPressure === 'number') {
    sections.push(
      <SnapSection key="pressure" title="Directional Pressure">
        <SnapRow label="long"  value={`${r.longPressure}%`}  accent="#4dd9e8" />
        <SnapRow label="short" value={`${r.shortPressure}%`} accent="#c45a5a" />
        {r.pressureBand && (
          <SnapRow label="band" value={r.pressureBand.toUpperCase()} />
        )}
        {r.pressureExplanation && (
          <SnapRow label="why" value={
            <span style={{ fontStyle: 'italic', color: 'var(--fg-3)' }}>
              {r.pressureExplanation}
            </span>
          } />
        )}
      </SnapSection>,
    );
  }

  // D) Structure / Momentum ────────────────────────────────────────
  if (r.structureDominance || r.momentumState || r.inheritedTrend) {
    sections.push(
      <SnapSection key="struct" title="Structure / Momentum">
        {r.structureDominance && (
          <SnapRow label="dominance" value={r.structureDominance.replace('_', ' ')} />
        )}
        {typeof r.structureScore === 'number' && (
          <SnapRow label="score" value={`${r.structureScore >= 0 ? '+' : ''}${r.structureScore}`} />
        )}
        {r.inheritedTrend && (
          <SnapRow label="inherited" value={r.inheritedTrend} />
        )}
        {r.momentumState && (
          <SnapRow label="momentum" value={r.momentumState} />
        )}
        {r.structureReasons && r.structureReasons.length > 0 && (
          <SnapRow label="reasons" value={
            <span style={{ color: 'var(--fg-3)', fontSize: 9, lineHeight: 1.4 }}>
              {r.structureReasons.slice(0, 4).join(' · ')}
            </span>
          } />
        )}
      </SnapSection>,
    );
  }

  // E) Pattern Story ───────────────────────────────────────────────
  const ps = r.patternStorySnap;
  if (ps && (ps.state || ps.dom || (ps.seq && ps.seq.length))) {
    sections.push(
      <SnapSection key="story" title="Pattern Story">
        {ps.state && <SnapRow label="state" value={ps.state} />}
        {ps.dom   && <SnapRow label="dominant" value={ps.dom} />}
        {ps.bias  && <SnapRow label="bias" value={ps.bias} />}
        {ps.cycle && <SnapRow label="cycle" value={ps.cycle} />}
        {ps.seq && ps.seq.length > 0 && (
          <SnapRow label="sequence" value={ps.seq.join(' → ')} />
        )}
        {ps.posture && (
          <SnapRow label="posture" value={
            <span style={{ color: 'var(--fg-3)' }}>{ps.posture}</span>
          } />
        )}
      </SnapSection>,
    );
  }
  // Fallback to the simple top-level pattern fields if no snapshot
  // pattern-story was persisted (older rows).
  else if (r.patternCode || r.patternName) {
    sections.push(
      <SnapSection key="pattern-lite" title="Pattern">
        {r.patternCode && <SnapRow label="code" value={r.patternCode} />}
        {r.patternName && <SnapRow label="name" value={r.patternName} />}
        {typeof r.pss === 'number' && (
          <SnapRow label="pss" value={`${Math.round(r.pss * 100)}%`} />
        )}
      </SnapSection>,
    );
  }

  // F) Transition ──────────────────────────────────────────────────
  if (r.nextLikelyState || r.transitionReason) {
    sections.push(
      <SnapSection key="transition" title="Transition">
        {r.nextLikelyState && (
          <SnapRow label="next →" value={r.nextLikelyState} />
        )}
        {typeof r.transitionConfidence === 'number' && (
          <SnapRow label="confidence" value={`${Math.round(r.transitionConfidence * 100)}%`} />
        )}
        {r.transitionReason && (
          <SnapRow label="reason" value={
            <span style={{ color: 'var(--fg-3)', fontStyle: 'italic' }}>
              {r.transitionReason}
            </span>
          } />
        )}
      </SnapSection>,
    );
  }

  // G) Overlays / Corrections ──────────────────────────────────────
  const overlayAny =
    r.originalStateCode || r.localOverlay
    || (r.overlayReasons && r.overlayReasons.length > 0)
    || r.anchorOverridden
    || r.stale;
  if (overlayAny) {
    sections.push(
      <SnapSection key="overlay" title="Overlays / Corrections">
        {r.anchorOverridden && r.anchorFromCode && (
          <SnapRow label="anchor"     value={`${r.anchorFromCode} → ${r.stateCode}`} accent="#d4a028" />
        )}
        {r.anchorReasons && r.anchorReasons.length > 0 && (
          <SnapRow label="anchor why" value={
            <span style={{ color: 'var(--fg-3)', fontSize: 9 }}>
              {r.anchorReasons.slice(0, 3).join('; ')}
            </span>
          } />
        )}
        {r.localOverlay && (
          <SnapRow label="overlay"
            value={r.localOverlay}
            accent={r.localOverlay === 'plateau' ? '#8a8fb8' : '#b06b58'} />
        )}
        {r.originalStateCode && r.originalStateCode !== r.stateCode && (
          <SnapRow label="from" value={`${r.originalStateCode} → ${r.stateCode}`} />
        )}
        {r.overlayReasons && r.overlayReasons.length > 0 && (
          <SnapRow label="overlay why" value={
            <span style={{ color: 'var(--fg-3)', fontSize: 9 }}>
              {r.overlayReasons.slice(0, 3).join('; ')}
            </span>
          } />
        )}
        {r.stale && (
          <SnapRow label="stale" value={r.staleReason ?? 'true'} accent="#d4a028" />
        )}
      </SnapSection>,
    );
  }

  // H) Diagnostics ─────────────────────────────────────────────────
  const m = r.modelMeta;
  if (m && (m.model || m.provider || m.latencyMs != null
        || m.routeSource || m.deploymentId)) {
    sections.push(
      <SnapSection key="meta" title="Diagnostics">
        {m.model       && <SnapRow label="model"       value={m.model} />}
        {m.provider    && <SnapRow label="provider"    value={m.provider} />}
        {m.latencyMs != null && (
          <SnapRow label="latency"    value={`${m.latencyMs}ms`} />
        )}
        {m.routeSource && <SnapRow label="route"       value={m.routeSource} />}
        {m.fallback != null && (
          <SnapRow label="fallback"   value={m.fallback ? 'yes' : 'no'} />
        )}
        {m.deploymentId && <SnapRow label="deployment" value={m.deploymentId} />}
      </SnapSection>,
    );
  }

  return (
    <div style={{
      marginTop: 6,
      padding: '10px 12px',
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: '2px solid var(--cyan)',
      borderRadius: 3,
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap: 14,
    }}>
      {sections}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Section: Guru History (with transitions + filter)
// ────────────────────────────────────────────────────────────────────

function GuruHistory({
  symbol, records,
}: {
  symbol:  MarketSymbol;
  records: AiStateHistoryRecord[];
}) {
  type Filter = 'all' | 'changes';
  const [filter, setFilter] = useState<Filter>('all');
  // v13.3: single-expand row state. null when no row is expanded.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Mark transition rows: a record is a "change" when the prior
  // entry (older) had a different stateCode.
  const annotated = records.map((r, i) => {
    const older = records[i + 1];
    const isTransition = !!older && older.stateCode !== r.stateCode;
    const fromState    = older ? older.state : null;
    return { r, isTransition, fromState };
  });
  const filtered = filter === 'all'
    ? annotated
    : annotated.filter(x => x.isTransition);

  const list = filtered.slice(0, 25);

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)',
      padding: '14px 16px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 10, gap: 12,
      }}>
        <div className="hairline">
          Guru history · {symbol} ({list.length})
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'changes'] as Filter[]).map(f => (
            <button key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '2px 8px',
                fontSize: 8, letterSpacing: '0.12em', fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                background: filter === f ? 'var(--bg-3)' : 'transparent',
                border: `1px solid ${filter === f ? 'var(--line-2)' : 'var(--line-1)'}`,
                color: filter === f ? 'var(--fg-1)' : 'var(--fg-3)',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >
              {f === 'all' ? 'ALL' : 'STATE CHANGES'}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--fg-3)', padding: '8px 0' }}>
          {records.length === 0
            ? `No prior Guru analyses for ${symbol} yet. Click "Ask Guru" above to capture one.`
            : 'No state changes in the recent history — Guru has held the same state.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((entry, i) => {
            const { r, isTransition, fromState } = entry;
            const accent = stateColor(r as unknown as GcpStateResponse);
            const conf = Math.round(r.confidence * 100);
            const isCurrent  = i === 0;
            const isExpanded = expandedId === r.id;
            return (
              <div key={r.id} style={{ display: 'flex', flexDirection: 'column' }}>
                {/* v13.3: each row is now a button-styled clickable.
                    Native <button> would inherit the default browser
                    chrome on some platforms; we use a div + role to
                    keep the terminal aesthetic but stay accessible. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    setExpandedId(prev => prev === r.id ? null : r.id)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedId(prev => prev === r.id ? null : r.id);
                    }
                  }}
                  style={{
                    padding: '7px 10px',
                    background: isCurrent ? 'var(--bg-3)' : 'var(--bg-2)',
                    border: `1px solid ${
                      isExpanded ? 'var(--cyan)'
                      : isCurrent ? accent + '99'
                      :              'var(--line-1)'
                    }`,
                    borderLeft: `2px solid ${isExpanded ? 'var(--cyan)' : accent}`,
                    borderRadius: 3,
                    fontSize: 10,
                    lineHeight: 1.5,
                    display: 'grid',
                    gridTemplateColumns: '110px 1fr auto 12px',
                    gap: 12,
                    alignItems: 'baseline',
                    cursor: 'pointer',
                    userSelect: 'none',
                    transition: 'border-color 0.15s ease',
                  }}
                >
                  <div style={{
                    color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {fmtTime(r.timestamp)}
                    {isCurrent && (
                      <span style={{
                        marginLeft: 6, fontSize: 8, color: accent, letterSpacing: '0.14em',
                      }}>· CURRENT</span>
                    )}
                  </div>
                  <div>
                    <div style={{
                      color: accent, fontWeight: 600, letterSpacing: '0.04em',
                    }}>
                      {isTransition && fromState && (
                        <span style={{ color: 'var(--fg-3)', fontWeight: 500 }}>
                          {fromState} → {' '}
                        </span>
                      )}
                      {r.stateCode} · {r.state}
                    </div>
                    <div style={{ color: 'var(--fg-3)', marginTop: 2 }}>
                      {r.phase} · {r.direction}
                      {r.patternCode ? ` · pattern ${r.patternCode}` : ''}
                      {r.regime ? ` · regime ${r.regime}` : ''}
                    </div>
                  </div>
                  <div style={{
                    textAlign: 'right',
                    color: 'var(--fg-2)',
                    fontFamily: 'var(--font-mono)',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    <div>{conf}% conf</div>
                    <div style={{ color: 'var(--fg-4)', fontSize: 9, marginTop: 2 }}>
                      @ {fmtLevel(symbol, r.priceAtAnalysis ?? undefined) ?? '—'}
                    </div>
                  </div>
                  {/* Chevron indicator — rotates 90° when expanded. */}
                  <span style={{
                    color: isExpanded ? 'var(--cyan)' : 'var(--fg-4)',
                    fontSize: 10,
                    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s ease, color 0.15s ease',
                    display: 'inline-block',
                    transformOrigin: '50% 50%',
                  }}>
                    ▸
                  </span>
                </div>

                {isExpanded && (
                  <ExpandedHistoryRow r={r} symbol={symbol} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Section shell + main view
// ────────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)',
      padding: '12px 16px',
    }}>
      <div className="hairline" style={{ marginBottom: 8 }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

export default function GuruView(props: GuruViewProps) {
  // History (filtered to current symbol, newest first).
  const [records, setRecords] = useState<AiStateHistoryRecord[]>([]);
  useEffect(() => {
    setRecords(loadAiStateHistory());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AI_HISTORY_LS_KEY) setRecords(loadAiStateHistory());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const symbolRecords = useMemo(
    () => records.filter(r => r.symbol === props.symbol).sort((a, b) => b.timestamp - a.timestamp),
    [records, props.symbol],
  );

  // Prior record for "What Changed" + micro-change. Skip the most
  // recent IF it was just appended for the current state (same code +
  // very close timestamp) — otherwise the diff would be empty.
  const priorRecord: AiStateHistoryRecord | null = useMemo(() => {
    if (!props.aiState || symbolRecords.length === 0) return null;
    const newest = symbolRecords[0];
    const lastSuccessTs = props.aiLastSuccess?.getTime() ?? 0;
    const newestIsCurrent = newest.stateCode === props.aiState.stateCode
      && Math.abs(newest.timestamp - lastSuccessTs) < 60_000;
    return newestIsCurrent
      ? (symbolRecords[1] ?? null)
      : newest;
  }, [props.aiState, props.aiLastSuccess, symbolRecords]);

  // Trade plan derived from current state + structure (same inputs the
  // dashboard / GCPApp use).
  const tradePlan: TradePlan | null = useMemo(() => {
    if (!props.aiState || !props.planStructure) return null;
    return deriveTradePlan({
      state:          props.aiState,
      structure:      props.planStructure,
      latestPattern:  props.latestPattern,
      symbol:         props.symbol,
      analysisCandle: props.planAnalysisCandle,
      analysisTf:     AI_ANALYSIS_TF,
      currentPrice:   props.symbolPrice,
    });
  }, [props.aiState, props.planStructure, props.latestPattern, props.symbol, props.planAnalysisCandle, props.symbolPrice]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
    }}>
      <PageHeader crumbs={[{ label: 'Guru' }]} />

      <div style={{
        flex: 1, overflow: 'auto',
        padding: 18,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <GuruHeader
          aiState={props.aiState}
          aiStatus={props.aiStatus}
          aiLastSuccess={props.aiLastSuccess}
          aiEnabled={props.aiEnabled}
          aiRunNow={props.aiRunNow}
          aiLastError={props.aiLastError ?? null}
          regime={props.regime ?? null}
          netVariance={props.netVariance ?? null}
        />

        {/* Micro-change chip sits between header and the full state
            block so the user sees the delta without scrolling. */}
        {props.aiState && (
          <div>
            <MicroChange current={props.aiState} prior={priorRecord} />
          </div>
        )}

        {/* Current state block — existing AiStateCard. Kept whole so
            the trade plan / posture / refresh logic stays canonical. */}
        <div style={{
          background: 'var(--bg-1)',
          border: '1px solid var(--line-1)',
          borderRadius: 'var(--r-md)',
          overflow: 'hidden',
        }}>
          <AiStateCard
            state={props.aiState}
            enabled={props.aiEnabled}
            latestPattern={props.latestPattern}
            runNow={props.aiRunNow}
            aiStatus={props.aiStatus}
            lastSuccessAt={props.aiLastSuccess}
            planStructure={props.planStructure}
            planAnalysisCandle={props.planAnalysisCandle}
            currentPrice={props.symbolPrice}
            symbol={props.symbol}
          />
        </div>

        <StateEvolution records={symbolRecords} currentState={props.aiState} />
        <WhatChanged current={props.aiState} prior={priorRecord} />
        <WatchNext plan={tradePlan} symbol={props.symbol} />

        <GuruHistory symbol={props.symbol} records={symbolRecords} />

        {/* Reference price footer — useful when scanning history. */}
        {props.symbolPrice != null && (
          <div style={{
            fontSize: 9, color: 'var(--fg-4)', textAlign: 'right',
            letterSpacing: '0.08em',
          }}>
            {props.symbol} @ {formatPrice(props.symbolPrice, props.symbol)}
          </div>
        )}
      </div>
    </div>
  );
}
