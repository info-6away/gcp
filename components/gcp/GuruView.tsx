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
import { deriveStateStory, deriveEvolutionTag } from '@/lib/stateStory';
import {
  deriveReadEvolution, derivePersistenceSummary,
  type PersistenceSummary,
} from '@/lib/readEvolution';
import { stateColor, DEFAULT_INTERPRETATION } from '@/lib/aiState';
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
                Low read clarity — structure still forming.
              </div>
            )}
          </>
        )}

        {/* v11.34: relabelled CONFIDENCE → STATE CERTAINTY so it
            stops competing semantically with TRANSITION LIKELIHOOD.
            v13.1.1: relabelled again → ENVIRONMENT CLARITY. Reads as
            v13.7: relabelled once more → READ CLARITY. Tighter, less
            redundant with the Environment meter on Trade. Same value
            (aiState.confidence × 100). Reads as
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
              READ CLARITY
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
  // v13.8.1: rail extended from 5 → 8 nodes per spec. Each node now
  // carries timestamp + phase + clarity + pattern + regime + price so
  // the hover tooltip can render the full row context without
  // re-querying. State changes get a thicker arrow; repeats stay subtle.
  const tail = records.slice(0, 8).reverse();
  type RailItem = {
    code:      string;
    label:     string;
    isCurrent: boolean;
    timestamp: number | null;
    rec?:      AiStateHistoryRecord;
  };
  const items: RailItem[] = tail.map((r, i) => ({
    code:      r.stateCode,
    label:     r.state,
    isCurrent: i === tail.length - 1,
    timestamp: r.timestamp,
    rec:       r,
  }));
  if (currentState
      && (items.length === 0 || items[items.length - 1].code !== currentState.stateCode)) {
    items.push({
      code:      currentState.stateCode,
      label:     currentState.state,
      isCurrent: true,
      timestamp: null,
    });
  } else if (currentState && items.length > 0) {
    items[items.length - 1].isCurrent = true;
  }
  if (!items.length) {
    return (
      <Section title="STATE EVOLUTION">
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          No prior states yet — click Ask Guru to seed the timeline.
        </div>
      </Section>
    );
  }

  const fmtRelative = (ts: number): string => relativeTime(ts, Date.now());
  // v13.8.3: one-line interpretation tag derived from the segment
  // chain — "Recovery sequence", "Shock fading", "Compression
  // stabilizing", etc. No AI call; pure helper on existing history.
  const evolutionTag = deriveEvolutionTag(records);

  return (
    <Section title="STATE EVOLUTION">
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 6,
        flexWrap: 'wrap',
      }}>
        {items.map((it, i) => {
          const isLast    = i === items.length - 1;
          const accent    = stateColor({ stateCode: it.code, direction: 'Neutral' } as GcpStateResponse);
          const opacity   = it.isCurrent ? 1 : (0.45 + (i / items.length) * 0.35);
          const prevCode  = i > 0 ? items[i - 1].code : null;
          const isChange  = prevCode != null && prevCode !== it.code;
          // Native HTML title attribute carries the hover detail —
          // lightweight, accessible, no separate tooltip state needed.
          const tipParts: string[] = [
            `${it.code} · ${it.label}`,
          ];
          if (it.rec) {
            tipParts.push(`${it.rec.phase} · ${it.rec.direction}`);
            tipParts.push(`clarity ${Math.round((it.rec.confidence ?? 0) * 100)}%`);
            if (it.rec.patternCode) tipParts.push(`pattern ${it.rec.patternCode}`);
            if (it.rec.regime)      tipParts.push(`regime ${it.rec.regime}`);
            if (it.rec.priceAtAnalysis != null) {
              tipParts.push(`@ ${it.rec.priceAtAnalysis.toFixed(2)}`);
            }
            if (it.timestamp) tipParts.push(fmtRelative(it.timestamp));
          } else {
            tipParts.push('current read');
          }
          return (
            <span key={i} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <span
                title={tipParts.join(' · ')}
                style={{
                  display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
                  padding: '6px 10px',
                  background: it.isCurrent ? `${accent}1f` : `${accent}0d`,
                  border: `1px solid ${accent}${it.isCurrent ? '99' : '44'}`,
                  borderRadius: 3,
                  opacity,
                  cursor: 'help',
                  transition: 'opacity 0.3s ease',
                  minWidth: 56,
                }}
              >
                <span style={{
                  fontSize: 11, fontWeight: 700, color: accent,
                  fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
                }}>{it.code}</span>
                <span style={{
                  fontSize: 8, color: 'var(--fg-3)', letterSpacing: '0.06em',
                  marginTop: 1,
                }}>
                  {it.rec ? it.rec.phase.slice(0, 4).toUpperCase()
                          : it.label.split(' ')[0].toUpperCase()}
                </span>
                {it.timestamp && (
                  <span style={{
                    fontSize: 8, color: 'var(--fg-4)', letterSpacing: '0.04em',
                    marginTop: 2, fontFamily: 'var(--font-mono)',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {fmtRelative(it.timestamp)}
                  </span>
                )}
                {!it.timestamp && it.isCurrent && (
                  <span style={{
                    fontSize: 8, color: accent, letterSpacing: '0.14em',
                    marginTop: 2, fontWeight: 700,
                  }}>NOW</span>
                )}
              </span>
              {!isLast && (
                <span style={{
                  color: 'var(--fg-4)',
                  fontSize: isChange ? 14 : 12,
                  opacity: isChange ? 1 : 0.55,
                  // Visually stronger arrow on state changes;
                  // subtle on same-state repeats.
                }}>→</span>
              )}
            </span>
          );
        })}
      </div>
      {/* v13.8.3: pure-derivation interpretation of the rail. Reads
          one of: Recovery sequence / Shock fading / Compression
          stabilizing / Failed progression / Momentum deteriorating /
          Ignition building / Saturation hold / Trend in progress /
          Synchronizing. No AI call. */}
      {evolutionTag && (
        <div style={{
          marginTop: 10, fontSize: 11, color: 'var(--fg-2)',
          letterSpacing: '0.06em', fontStyle: 'italic',
        }}>
          {evolutionTag}
        </div>
      )}
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

// ════════════════════════════════════════════════════════════════════
// v13.8: Guru becomes the COHERENCE MEMORY + STATE EVOLUTION surface.
// Trade owns execution; Guru owns "what is the machine seeing, what
// changed, how did we get here?".
//
// New components below:
//   - CurrentReadCard   — slim hero (state · stance label · transition
//                          · one-line interp · metadata)
//   - StateStoryBanner  — deterministic narrative from recent history
//   - REPLAY button     — placeholder, "coming soon" toast
// Plus filter controls added to GuruHistory and a Machine Thinking
// collapsible inside ExpandedHistoryRow.
// ════════════════════════════════════════════════════════════════════

// v13.8.1: top-right page metrics — reads today, state changes,
// average read clarity. Pure derivation from already-stored history;
// hides when no records exist for the symbol.

function PageHeaderRow({
  symbol, records,
}: {
  symbol:  MarketSymbol;
  records: AiStateHistoryRecord[];
}) {
  const metrics = useMemo(() => {
    if (records.length === 0) return null;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    let readsToday = 0;
    let stateChanges = 0;
    let confSum = 0;
    let confCount = 0;
    // History is newest-first. Iterate once.
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r.timestamp >= startMs) readsToday++;
      if (typeof r.confidence === 'number' && r.confidence > 0) {
        confSum   += r.confidence;
        confCount += 1;
      }
      const older = records[i + 1];
      if (older && older.stateCode !== r.stateCode) stateChanges++;
    }
    const avgClarity = confCount > 0 ? Math.round((confSum / confCount) * 100) : null;
    return { readsToday, stateChanges, avgClarity };
  }, [records]);

  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: 16, flexWrap: 'wrap',
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
      }}>
        Coherence intelligence history · {symbol}
      </div>
      {metrics && (
        <div style={{
          display: 'flex', gap: 18, flexWrap: 'wrap',
          fontSize: 9, color: 'var(--fg-4)',
          fontFamily: 'var(--font-mono)', letterSpacing: '0.10em',
        }}>
          <span>reads today{' '}
            <b style={{ color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
              {metrics.readsToday}
            </b>
          </span>
          <span>state changes{' '}
            <b style={{ color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
              {metrics.stateChanges}
            </b>
          </span>
          {metrics.avgClarity != null && (
            <span>avg clarity{' '}
              <b style={{ color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
                {metrics.avgClarity}%
              </b>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// v13.8.2: hero-side persistence summary. Renders a multi-line block
// when the current state has held for ≥3 reads — replaces the static
// reasoningShort interp so a long WAIT no longer reads as dead.
//
// Prose variant of PersistenceDeltaBlock — same data, different
// emphasis. The banner shows it as a structured table; the hero
// shows it as a sentence stack closer to natural language.

function HeroPersistenceSummary({ p }: { p: PersistenceSummary }) {
  const lines: React.ReactNode[] = [];
  // Opening — "X has persisted across N reads."
  lines.push(
    <div key="open" style={{
      fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55,
    }}>
      {p.state} has persisted across <b style={{ color: 'var(--fg-0)' }}>
        {p.segmentLength}
      </b> reads.
    </div>
  );
  // Clarity — only when delta is meaningful or both values present.
  if (p.clarityFirst != null && p.clarityNow != null
      && p.clarityFirst !== p.clarityNow) {
    const rose = p.clarityNow > p.clarityFirst;
    const verb = rose ? 'improved' : 'slipped';
    lines.push(
      <div key="clarity" style={{
        fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5,
      }}>
        Clarity {verb}: <b style={{
          color: 'var(--fg-1)', fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {p.clarityFirst}% → {p.clarityNow}%
        </b>
      </div>
    );
  }
  // Pressure — flag the side that's losing/gaining.
  if (p.pressureFirst && p.pressureNow
      && (p.pressureFirst.long !== p.pressureNow.long
         || p.pressureFirst.short !== p.pressureNow.short)) {
    const skewFirst = p.pressureFirst.long - p.pressureFirst.short;
    const skewNow   = p.pressureNow.long   - p.pressureNow.short;
    const verb =
      Math.abs(skewNow) < Math.abs(skewFirst) ? 'shifted neutral'
    : skewNow > skewFirst                      ? 'tilted long'
    : skewNow < skewFirst                      ? 'tilted short'
    :                                            'shifted';
    lines.push(
      <div key="pressure" style={{
        fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5,
      }}>
        Pressure {verb}: <b style={{
          color: 'var(--fg-1)', fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {p.pressureFirst.long}L / {p.pressureFirst.short}S
          {' → '}
          {p.pressureNow.long}L / {p.pressureNow.short}S
        </b>
      </div>
    );
  }
  // Transition probability.
  if (p.transFirst != null && p.transNow != null
      && p.transFirst !== p.transNow) {
    const verb = p.transNow > p.transFirst ? 'increased' : 'fell';
    const target = p.transTarget ? ` toward ${p.transTarget}` : '';
    lines.push(
      <div key="trans" style={{
        fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5,
      }}>
        Transition pressure{target} {verb}: <b style={{
          color: 'var(--fg-1)', fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {p.transFirst}% → {p.transNow}%
        </b>
      </div>
    );
  }
  // Temperament — final sentence echoing the banner's classification.
  const temperamentCopy =
    p.temperament === 'stabilizing' ? 'Environment is stabilizing.'
  : p.temperament === 'unresolved'  ? 'Environment remains unresolved.'
  : p.temperament === 'drifting'    ? 'Environment is drifting.'
  :                                    'Environment is stable.';
  lines.push(
    <div key="temp" style={{
      fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.5,
      fontStyle: 'italic',
    }}>
      {temperamentCopy}
    </div>
  );

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      {lines}
    </div>
  );
}

// v13.8.3: STATE AVATAR — the figure is now a living, state-aware
// presence rather than a static silhouette. The watcher silhouette
// (head + robe + third-eye dot + horizon) stays as the constant
// identity; the energy AROUND the silhouette varies per state code,
// using pure CSS/SVG (no Lottie, no canvas):
//
//   CS / PS / DD          — calm cyan pulse
//   IS                    — quickened pulse (breath sharpens)
//   AT                    — upward energy motion (rising chevrons)
//   SS                    — coherent concentric pulse rings
//   FA                    — split halo (two arcs drift apart)
//   SH                    — fractured red glow (jitter + broken arcs)
//   CL                    — climax burst (strong outward ring)
//   DS / DC               — directional decay (lower-half dim)
//
// `presence` (live / normal / stale) still modulates intensity:
// stale dims everything; live amplifies the glow.

type AvatarBehavior =
  | 'calm' | 'ignite' | 'rising' | 'coherent'
  | 'split' | 'fractured' | 'climax' | 'decay';

function behaviorForState(code: string | null): AvatarBehavior {
  switch (code) {
    case 'SH':                       return 'fractured';
    case 'FA':                       return 'split';
    case 'SS':                       return 'coherent';
    case 'AT':                       return 'rising';
    case 'CL':                       return 'climax';
    case 'DS': case 'DC':            return 'decay';
    case 'IS':                       return 'ignite';
    // CS, PS, DD, unknown
    default:                         return 'calm';
  }
}

function StateAvatar({
  stateCode, presence, accent,
}: {
  stateCode: string | null;
  presence:  'live' | 'normal' | 'stale';
  accent:    string;
}) {
  const behavior = behaviorForState(stateCode);
  const color =
    presence === 'stale' ? 'var(--fg-4)'
  :                        accent;

  const haloIntensity =
    presence === 'live'   ? 1
  : presence === 'normal' ? 0.55
  :                          0.15;

  const halo = behavior === 'fractured'
    ? `0 0 ${28 * haloIntensity}px ${accent}66, inset 0 0 ${14 * haloIntensity}px ${accent}33`
    : `0 0 ${24 * haloIntensity}px ${accent}55, inset 0 0 ${14 * haloIntensity}px ${accent}1f`;

  // The shell breath rate / motion is behavior-specific. The shell
  // itself does the breathing for calm/ignite, jitters for fractured,
  // and stays still for the others (ring/chevron layers do the work).
  const shellAnimation: string | undefined =
    presence === 'stale' ? undefined
  : behavior === 'calm'      ? 'gcpro-avatar-breathe 4.6s ease-in-out infinite'
  : behavior === 'ignite'    ? 'gcpro-avatar-breathe-quick 2.4s ease-in-out infinite'
  : behavior === 'fractured' ? 'gcpro-avatar-jitter 0.4s ease-in-out infinite'
  :                            undefined;

  return (
    <div
      aria-hidden="true"
      style={{
        width: 84, height: 84, flexShrink: 0,
        borderRadius: '50%',
        border: `1px solid ${presence === 'stale' ? 'var(--line-2)' : `${accent}44`}`,
        boxShadow: halo,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'radial-gradient(circle, rgba(13,15,18,0.6), rgba(7,8,10,0.95))',
        opacity: presence === 'stale' ? 0.55 : 1,
        animation: shellAnimation,
        position: 'relative',
        transition: 'opacity 0.4s ease, box-shadow 0.4s ease, border-color 0.4s ease',
        overflow: 'hidden',
      }}
    >
      {/* Behavior-specific decorative layers — sit behind the figure. */}
      {presence !== 'stale' && (
        <AvatarDecoration behavior={behavior} accent={accent} />
      )}

      {/* The watcher silhouette — kept constant across states so the
          figure has continuity. Only its stroke color shifts (via the
          accent prop passed down from CurrentReadCard). */}
      <svg width={54} height={54} viewBox="0 0 54 54" fill="none"
           style={{ position: 'relative', zIndex: 1 }}>
        <ellipse cx={27} cy={18} rx={6.2} ry={7}
          stroke={color} strokeWidth={1.4} fill="none" />
        <path
          d="M11 44 C 13 30 19 24 27 24 C 35 24 41 30 43 44 Z"
          stroke={color} strokeWidth={1.4} strokeLinejoin="round"
          fill={presence === 'live' ? `${accent}11` : 'transparent'}
        />
        <circle cx={27} cy={17} r={1.2} fill={color} />
        <path d="M9 46 H45" stroke={color} strokeWidth={0.6} opacity={0.5} />
      </svg>
    </div>
  );
}

// Behavior decoration layer — purely visual atmosphere around the
// watcher silhouette. Picks the right SVG/CSS treatment per behavior.
function AvatarDecoration({
  behavior, accent,
}: {
  behavior: AvatarBehavior;
  accent:   string;
}) {
  // Coherent pulse rings (SS) — three concentric circles expanding outward.
  if (behavior === 'coherent') {
    return (
      <>
        {[0, 1.2, 2.4].map((delay, i) => (
          <span key={i} style={{
            position: 'absolute', inset: 0, margin: 'auto',
            width: 30, height: 30, borderRadius: '50%',
            border: `1px solid ${accent}66`,
            animation: `gcpro-avatar-ring 3.6s ease-out ${delay}s infinite`,
            opacity: 0,
          }} />
        ))}
      </>
    );
  }
  // Split halo (FA) — two semicircle arcs that drift apart.
  if (behavior === 'split') {
    return (
      <svg width={84} height={84} viewBox="0 0 84 84"
           style={{ position: 'absolute', inset: 0 }}>
        <path d="M 14 42 A 28 28 0 0 1 42 14"
              stroke={accent} strokeWidth={1.2} fill="none"
              strokeLinecap="round" opacity={0.7}
              style={{
                transformOrigin: '42px 42px',
                animation: 'gcpro-avatar-split-a 3.2s ease-in-out infinite',
              }} />
        <path d="M 42 70 A 28 28 0 0 1 70 42"
              stroke={accent} strokeWidth={1.2} fill="none"
              strokeLinecap="round" opacity={0.7}
              style={{
                transformOrigin: '42px 42px',
                animation: 'gcpro-avatar-split-b 3.2s ease-in-out infinite',
              }} />
      </svg>
    );
  }
  // Fractured glow (SH) — four broken arc segments with jittered offset.
  if (behavior === 'fractured') {
    const arcs = [
      'M 14 42 A 28 28 0 0 1 30 18',
      'M 42 14 A 28 28 0 0 1 58 22',
      'M 70 42 A 28 28 0 0 1 60 64',
      'M 28 68 A 28 28 0 0 1 16 52',
    ];
    return (
      <svg width={84} height={84} viewBox="0 0 84 84"
           style={{ position: 'absolute', inset: 0 }}>
        {arcs.map((d, i) => (
          <path key={i} d={d}
            stroke={accent} strokeWidth={1.2} fill="none"
            strokeLinecap="round" opacity={0.65}
            style={{
              animation: `gcpro-avatar-fracture 0.9s ease-in-out ${i * 0.2}s infinite`,
            }} />
        ))}
      </svg>
    );
  }
  // Rising energy (AT) — upward chevrons drifting up through the shell.
  if (behavior === 'rising') {
    return (
      <>
        {[0, 0.6, 1.2].map((delay, i) => (
          <span key={i} style={{
            position: 'absolute', left: '50%', bottom: 6,
            width: 12, height: 6,
            transform: 'translateX(-50%)',
            borderTop: `1.2px solid ${accent}aa`,
            borderRight: `1.2px solid transparent`,
            borderLeft: `1.2px solid transparent`,
            borderTopLeftRadius: 2, borderTopRightRadius: 2,
            opacity: 0,
            animation: `gcpro-avatar-rise 2.2s ease-out ${delay}s infinite`,
          }} />
        ))}
      </>
    );
  }
  // Climax burst (CL) — single large ring expanding aggressively.
  if (behavior === 'climax') {
    return (
      <span style={{
        position: 'absolute', inset: 0, margin: 'auto',
        width: 36, height: 36, borderRadius: '50%',
        border: `1.4px solid ${accent}aa`,
        animation: 'gcpro-avatar-climax 1.8s ease-out infinite',
        opacity: 0,
      }} />
    );
  }
  // Decay (DS / DC) — drooping radial gradient overlay on the lower
  // half, pulsing slowly.
  if (behavior === 'decay') {
    return (
      <span style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(circle at 50% 70%, ${accent}22, transparent 55%)`,
        animation: 'gcpro-avatar-decay 4s ease-in-out infinite',
      }} />
    );
  }
  // calm / ignite — no decoration beyond the shell breath.
  return null;
}

function CurrentReadCard({
  aiState, aiLastSuccess, aiStatus, aiEnabled, aiRunNow, regime, netVariance,
  persistence,
}: {
  aiState:       GcpStateResponse | null;
  aiLastSuccess: Date | null;
  aiStatus:      AiStatus;
  aiEnabled:     boolean;
  aiRunNow:      (options?: { force?: boolean; source?: string }) => void;
  regime?:       string | null;
  netVariance?:  number | null;
  // v13.8.2: when the current state has held for several reads, the
  // hero swaps the static reasoningShort interp for a dynamic
  // multi-line persistence summary so a long WAIT no longer reads
  // as "nothing's happening".
  persistence?:  PersistenceSummary | null;
}) {
  const now = useTick(1000);
  const accent  = aiState ? stateColor(aiState) : 'var(--fg-3)';
  const interp  = aiState
    ? (aiState.reasoningShort?.trim()
       || DEFAULT_INTERPRETATION[aiState.stateCode]
       || aiState.goldInterpretation?.trim()
       || 'No interpretation available.')
    : 'No Guru read yet — click Ask Guru to capture one.';

  const stance = aiState ? deriveStance(aiState) : null;
  const nextState = aiState?.nextLikelyState ?? null;
  const nextConf = aiState?.transitionConfidence;
  const stateConfPct = aiState ? Math.round(aiState.confidence * 100) : null;

  const ageMs = aiLastSuccess ? now - aiLastSuccess.getTime() : null;
  const isFresh = ageMs != null && ageMs < 30_000;
  const isStale = aiState?.stale === true;
  const lastUpdate = aiLastSuccess
    ? relativeTime(aiLastSuccess.getTime(), now)
    : '—';

  // v13.8.1: monk presence state drives the figure animation + the
  // hero's outer halo. Live (< 30s fresh) → breathing pulse + glow;
  // stale (proxy fallback) → dimmed + muted; otherwise neutral.
  const monkState: 'live' | 'normal' | 'stale' =
    isStale ? 'stale'
  : isFresh ? 'live'
  :           'normal';

  // Ask Guru button state machine.
  const isRunning = aiStatus === 'running';
  const buttonLabel =
    isRunning             ? 'ASKING…'
  : aiStatus === 'error'  ? 'TRY AGAIN'
  : aiLastSuccess         ? 'ASK GURU AGAIN'
  :                          'ASK GURU';
  const buttonAccent =
    aiStatus === 'error'  ? 'var(--red)'
  : isStale               ? '#d4a028'         // amber when stale to draw attention
  :                          'var(--cyan)';
  const buttonDisabled = !aiEnabled || isRunning;
  const onAskClick = () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[ASK GURU CLICK]', {
        aiStatus,
        aiEnabled,
        hasRunNow: typeof aiRunNow === 'function',
        force: true,
        source: 'guru_timeline_button',
        reason: buttonDisabled ? 'disabled' : 'ok',
      });
    }
    if (buttonDisabled || typeof aiRunNow !== 'function') return;
    aiRunNow({ force: true, source: 'guru_timeline_button' });
  };

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: `1px solid ${isFresh ? `${accent}55` : 'var(--line-1)'}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 'var(--r-md)',
      padding: '18px 22px',
      display: 'flex', alignItems: 'flex-start', gap: 20,
      boxShadow: isFresh ? `0 0 22px ${accent}22` : 'none',
      transition: 'box-shadow 0.6s ease, border-color 0.6s ease',
    }}>
      {/* v13.8.3: state-avatar keyframes. The avatar reuses the
          watcher silhouette but layers state-specific atmosphere
          (rings / arcs / chevrons / glow) on top of it via these
          animations. All pure CSS — no Lottie, no JS tickers. */}
      <style>{`
        @keyframes gcpro-monk-breathe {
          0%, 100% { transform: scale(1);    opacity: 0.95; }
          50%      { transform: scale(1.04); opacity: 1; }
        }
        @keyframes gcpro-avatar-breathe {
          0%, 100% { transform: scale(1);    opacity: 0.94; }
          50%      { transform: scale(1.035); opacity: 1; }
        }
        @keyframes gcpro-avatar-breathe-quick {
          0%, 100% { transform: scale(1);    opacity: 0.9; }
          50%      { transform: scale(1.055); opacity: 1; }
        }
        @keyframes gcpro-avatar-jitter {
          0%, 100% { transform: translate(0px, 0px); }
          25%      { transform: translate(0.6px, -0.4px); }
          50%      { transform: translate(-0.5px, 0.4px); }
          75%      { transform: translate(0.4px, 0.5px); }
        }
        @keyframes gcpro-avatar-ring {
          0%   { transform: scale(0.55); opacity: 0.65; }
          80%  { opacity: 0.04; }
          100% { transform: scale(1.9);  opacity: 0; }
        }
        @keyframes gcpro-avatar-rise {
          0%   { transform: translate(-50%, 0)    scale(0.85); opacity: 0; }
          15%  { opacity: 0.85; }
          100% { transform: translate(-50%, -42px) scale(1.05); opacity: 0; }
        }
        @keyframes gcpro-avatar-split-a {
          0%, 100% { transform: rotate(-4deg); opacity: 0.7; }
          50%      { transform: rotate(-14deg); opacity: 1; }
        }
        @keyframes gcpro-avatar-split-b {
          0%, 100% { transform: rotate(4deg);  opacity: 0.7; }
          50%      { transform: rotate(14deg); opacity: 1; }
        }
        @keyframes gcpro-avatar-climax {
          0%   { transform: scale(0.7); opacity: 0.95; }
          100% { transform: scale(2.4); opacity: 0; }
        }
        @keyframes gcpro-avatar-decay {
          0%, 100% { opacity: 0.45; }
          50%      { opacity: 0.85; }
        }
        @keyframes gcpro-avatar-fracture {
          0%, 100% { opacity: 0.55; transform: translate(0, 0); }
          50%      { opacity: 1;    transform: translate(0.3px, -0.2px); }
        }
        @media (prefers-reduced-motion: reduce) {
          [aria-hidden="true"], [aria-hidden="true"] * { animation: none !important; }
        }
      `}</style>

      <StateAvatar
        stateCode={aiState?.stateCode ?? null}
        presence={monkState}
        accent={accent}
      />

      <div style={{
        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {/* Eyebrow row with section label + live/stale badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
          }}>
            CURRENT READ
          </span>
          {isStale && (
            <span style={{
              padding: '2px 6px', fontSize: 8, fontWeight: 700,
              letterSpacing: '0.18em', color: '#d4a028',
              background: 'rgba(212,160,40,0.10)',
              border: '1px solid #d4a02855',
              borderRadius: 2,
            }}>
              STALE READ{aiState?.staleReason ? ` · ${aiState.staleReason}` : ''}
            </span>
          )}
          {!isStale && isFresh && (
            <span style={{
              padding: '2px 6px', fontSize: 8, fontWeight: 700,
              letterSpacing: '0.18em', color: 'var(--cyan)',
              background: 'rgba(77,217,232,0.10)',
              border: `1px solid ${accent}55`,
              borderRadius: 2,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: accent,
                animation: 'gcpro-monk-breathe 1.6s ease-in-out infinite',
              }} />
              WATCHING · LIVE
            </span>
          )}
        </div>

        {/* v13.8.3: HIERARCHY PROMOTION. Action (stance) is now the
            largest, most prominent element. The state + phase becomes
            a small context strip above it, the mode reads as a
            descriptor line below, and the execution gate is the
            quietest line. Reading order:
              COMPRESSION · LATE              ← context (small caps)
              WAIT                            ← action  (BIG)
              Build-up phase                  ← mode    (medium)
              No entry until ignition trigger ← gate    (small italic) */}
        <div style={{
          fontSize: 11, fontWeight: 700, color: accent,
          fontFamily: 'var(--font-mono)', letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}>
          {aiState ? aiState.state.toUpperCase() : 'NO READ'}
          {aiState && (
            <span style={{ color: 'var(--fg-3)' }}> · {aiState.phase}</span>
          )}
        </div>

        {stance && (
          <div style={{
            fontSize: 30, fontWeight: 800, color: 'var(--fg-0)',
            letterSpacing: '0.04em', lineHeight: 1.05,
            textTransform: 'uppercase',
          }}>
            {stance.stance}
          </div>
        )}

        {stance && (
          <div style={{
            fontSize: 13, color: 'var(--fg-2)', letterSpacing: '0.02em',
            lineHeight: 1.3,
          }}>
            {stance.mode}
          </div>
        )}

        {stance && (
          <div style={{
            fontSize: 11, color: 'var(--fg-3)', fontStyle: 'italic',
            letterSpacing: '0.02em', lineHeight: 1.4,
          }}>
            {stance.execution}
          </div>
        )}

        {/* Transition forecast */}
        {nextState && nextConf != null && (
          <div style={{
            fontSize: 12, color: 'var(--fg-3)',
            fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
          }}>
            Transition likely → <span style={{
              color: ladderColor(nextState as LadderState),
              fontWeight: 600,
            }}>
              {ladderLabel(nextState as LadderState)}
            </span> · {Math.round(nextConf * 100)}%
          </div>
        )}

        {/* v13.8.2: when the current state has held ≥3 reads, swap
            the static reasoningShort interp for a dynamic persistence
            summary showing what's actually MOVED across the segment.
            "WAIT" no longer reads as a dead label — clarity, pressure,
            and transition probability shifts surface inline. */}
        {persistence && persistence.segmentLength >= 3
          ? <HeroPersistenceSummary p={persistence} />
          : (
            <div style={{
              fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55,
            }}>
              {interp}
            </div>
          )
        }

        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 14,
          fontSize: 9, color: 'var(--fg-4)',
          fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        }}>
          {aiLastSuccess && (
            <span>updated <b style={{ color: 'var(--fg-2)' }}>{lastUpdate}</b></span>
          )}
          {stateConfPct != null && (
            <span>read clarity <b style={{ color: 'var(--fg-2)' }}>{stateConfPct}%</b></span>
          )}
          {regime && (
            <span>regime <b style={{ color: 'var(--fg-2)' }}>{regime}</b></span>
          )}
          {netVariance != null && (
            <span>NV <b style={{ color: 'var(--fg-2)' }}>{netVariance.toFixed(1)}</b></span>
          )}
          {/* Even-dimmer model/provider/latency strip per spec. */}
          {aiState?._meta?.model && (
            <span style={{ opacity: 0.6 }}>
              model <b style={{ color: 'var(--fg-3)' }}>{aiState._meta.model}</b>
            </span>
          )}
          {aiState?._meta?.latencyMs != null && (
            <span style={{ opacity: 0.6 }}>
              latency <b style={{ color: 'var(--fg-3)' }}>{aiState._meta.latencyMs}ms</b>
            </span>
          )}
        </div>
      </div>

      {/* Ask Guru button — right side of hero. v13.8.1 promotes it
          back into the Guru surface because Ask Guru is fundamentally
          a memory/observer action, not just a Trade action. Same
          handler signature as the Trade button (force: true, distinct
          source label so the audit log can tell them apart). */}
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={onAskClick}
          aria-disabled={buttonDisabled || undefined}
          title={!aiEnabled ? 'Guru is disabled in Settings' : undefined}
          style={{
            padding: '10px 16px',
            fontSize: 11, letterSpacing: '0.14em', fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            background: isRunning ? `${buttonAccent}1f` : 'transparent',
            border: `1px solid ${buttonDisabled ? 'var(--line-2)' : buttonAccent}`,
            color: buttonDisabled ? 'var(--fg-3)' : buttonAccent,
            borderRadius: 4,
            cursor: buttonDisabled ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
            transition: 'background 0.2s ease, border-color 0.2s ease, color 0.2s ease',
            // Stale promotion: thicker shadow when stale to draw the
            // user's attention back to the action.
            boxShadow: isStale && !buttonDisabled
              ? `0 0 14px ${buttonAccent}55`
              : 'none',
          }}
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}

// State story banner — deterministic narrative ("CS persisted for 4
// reads → SH event → recovery into CS …"). Pure helper; no Engine.

function StateStoryBanner({ records }: { records: AiStateHistoryRecord[] }) {
  const story  = useMemo(() => deriveStateStory(records, { window: 8 }), [records]);
  // v13.8.2: when the current state has held ≥3 reads, surface a
  // structured "what's moved in this segment" block underneath the
  // narrative sentence. Walks the head segment and reports first →
  // latest deltas for clarity, pressure, transition probability.
  const persistence = useMemo(() => derivePersistenceSummary(records), [records]);
  if (!story && !persistence) return null;
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      {story && (
        <>
          <div style={{
            fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
          }}>
            STATE STORY · last {story.samples} reads
          </div>
          <div style={{
            fontSize: 12, color: 'var(--fg-1)', lineHeight: 1.55,
            fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
          }}>
            {story.text}
          </div>
        </>
      )}
      {persistence && persistence.segmentLength >= 3 && (
        <PersistenceDeltaBlock p={persistence} />
      )}
    </div>
  );
}

// v13.8.2: structured first → latest delta block for a persistence
// stretch. Reads existing aiStateHistory only; row hides itself when
// the underlying field wasn't persisted on the older records.

function PersistenceDeltaBlock({ p }: { p: PersistenceSummary }) {
  const clarityRow =
    p.clarityFirst != null && p.clarityNow != null && p.clarityFirst !== p.clarityNow
      ? `${p.clarityFirst}% → ${p.clarityNow}%`
      : null;
  const pressureRow =
    p.pressureFirst && p.pressureNow
    && (p.pressureFirst.long !== p.pressureNow.long
       || p.pressureFirst.short !== p.pressureNow.short)
      ? `${p.pressureFirst.long}L / ${p.pressureFirst.short}S → ${p.pressureNow.long}L / ${p.pressureNow.short}S`
      : null;
  const transRow =
    p.transFirst != null && p.transNow != null && p.transFirst !== p.transNow
      ? `${p.transFirst}% → ${p.transNow}%`
      : null;
  const temperamentCopy =
    p.temperament === 'stabilizing' ? 'Environment stabilizing.'
  : p.temperament === 'unresolved'  ? 'Environment stable but unresolved.'
  : p.temperament === 'drifting'    ? 'Environment drifting.'
  :                                    'Environment stable.';

  // Tail target — show the transition target if known so the
  // transition row reads "toward IS" instead of just %.
  const transLabel = p.transTarget
    ? `Transition probability (→ ${p.transTarget})`
    : 'Transition probability';

  return (
    <div style={{
      borderTop: '1px solid var(--line-1)',
      paddingTop: 10,
      display: 'flex', flexDirection: 'column', gap: 4,
      fontFamily: 'var(--font-mono)',
    }}>
      <div style={{
        fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.45,
      }}>
        {p.state} has held for <b style={{ color: 'var(--fg-0)' }}>{p.segmentLength}</b> reads.
      </div>
      {clarityRow && (
        <PersistenceDelta label="Read clarity" value={clarityRow} />
      )}
      {pressureRow && (
        <PersistenceDelta label="Directional pressure" value={pressureRow} />
      )}
      {transRow && (
        <PersistenceDelta label={transLabel} value={transRow} />
      )}
      <div style={{
        marginTop: 4, fontSize: 10, color: 'var(--fg-3)',
        fontStyle: 'italic', letterSpacing: '0.04em',
      }}>
        {temperamentCopy}
      </div>
    </div>
  );
}

function PersistenceDelta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '170px 1fr',
      gap: 10, alignItems: 'baseline',
      fontSize: 10,
    }}>
      <span style={{
        color: 'var(--fg-4)', letterSpacing: '0.06em',
      }}>
        {label}:
      </span>
      <span style={{
        color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.02em',
      }}>
        {value}
      </span>
    </div>
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

  // v13.8: Machine Thinking — the AI's own narrative copy.
  // Collapsible, default collapsed. Surfaces patternStory, reasoning,
  // gold interpretation, watchNext, invalidators. Reads as
  // "what the machine actually thought at the time". Older entries
  // written before v13.8 won't have these fields and the section
  // hides itself entirely.
  const hasMachineThinking =
       !!r.reasoningShort
    || !!r.goldInterpretation
    || (r.watchNext && r.watchNext.length > 0)
    || (r.invalidatorsSnap && r.invalidatorsSnap.length > 0)
    || (r.patternStorySnap?.posture);

  return (
    <div style={{
      marginTop: 6,
      padding: '10px 12px',
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: '2px solid var(--cyan)',
      borderRadius: 3,
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap: 14,
    }}>
      {sections}
    </div>
    {hasMachineThinking && <MachineThinkingSection r={r} />}
    </div>
  );
}

// v13.8: collapsible "Machine Thinking" block inside the expanded
// history row. Surfaces the AI's own narrative copy without
// rerunning anything — pure history rendering.

function MachineThinkingSection({ r }: { r: AiStateHistoryRecord }) {
  const [open, setOpen] = useState(false);
  const story = r.patternStorySnap;
  return (
    <div style={{
      borderTop: '1px solid var(--line-1)',
      paddingTop: 10,
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          background: 'transparent', border: 0, padding: 0,
          color: 'var(--fg-3)', cursor: 'pointer',
          fontSize: 9, letterSpacing: '0.18em', fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
        }}
      >
        <span>Machine Thinking</span>
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{
          marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10,
          fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.6,
        }}>
          {r.reasoningShort && (
            <div>
              <div style={{
                fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.14em',
                marginBottom: 3, textTransform: 'uppercase',
              }}>Reasoning</div>
              <div style={{ fontStyle: 'italic', color: 'var(--fg-2)' }}>
                {r.reasoningShort}
              </div>
            </div>
          )}
          {r.goldInterpretation && (
            <div>
              <div style={{
                fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.14em',
                marginBottom: 3, textTransform: 'uppercase',
              }}>Market Interpretation</div>
              <div>{r.goldInterpretation}</div>
            </div>
          )}
          {story?.posture && (
            <div>
              <div style={{
                fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.14em',
                marginBottom: 3, textTransform: 'uppercase',
              }}>Pattern Story Posture</div>
              <div>{story.posture}</div>
            </div>
          )}
          {r.watchNext && r.watchNext.length > 0 && (
            <div>
              <div style={{
                fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.14em',
                marginBottom: 3, textTransform: 'uppercase',
              }}>Watch Next</div>
              <ul style={{
                margin: 0, padding: 0, listStyle: 'none',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                {r.watchNext.slice(0, 4).map((w, i) => (
                  <li key={i} style={{
                    paddingLeft: 12, position: 'relative',
                  }}>
                    <span style={{
                      position: 'absolute', left: 0, top: 8,
                      width: 4, height: 4, borderRadius: '50%',
                      background: 'var(--cyan)',
                    }} />
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.invalidatorsSnap && r.invalidatorsSnap.length > 0 && (
            <div>
              <div style={{
                fontSize: 9, color: '#c45a5a', letterSpacing: '0.14em',
                marginBottom: 3, textTransform: 'uppercase',
              }}>Invalidators</div>
              <ul style={{
                margin: 0, padding: 0, listStyle: 'none',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                {r.invalidatorsSnap.slice(0, 4).map((inv, i) => (
                  <li key={i} style={{
                    paddingLeft: 12, position: 'relative', color: 'var(--fg-1)',
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
        </div>
      )}
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
  // v13.8: filter set widened. ALL / STATE CHANGES retained;
  // HIGH CLARITY shows reads with confidence ≥ 60%; FAILED STATES
  // surfaces FA / SH / CL / DC entries. Pure local filtering of
  // already-stored history — no Engine calls.
  type Filter = 'all' | 'changes' | 'clarity' | 'failed';
  const [filter, setFilter] = useState<Filter>('all');
  const [showReplay, setShowReplay] = useState(false);
  // Failed / risk state set used by the FAILED STATES filter.
  const FAILED_STATES = new Set(['FA', 'SH', 'CL', 'DC']);
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
  const filtered =
    filter === 'all'      ? annotated
  : filter === 'changes'  ? annotated.filter(x => x.isTransition)
  : filter === 'clarity'  ? annotated.filter(x => (x.r.confidence ?? 0) >= 0.60)
  : filter === 'failed'   ? annotated.filter(x => FAILED_STATES.has(x.r.stateCode))
  :                          annotated;

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
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(['all', 'changes', 'clarity', 'failed'] as Filter[]).map(f => (
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
              {f === 'all'      ? 'ALL'
             : f === 'changes'  ? 'STATE CHANGES'
             : f === 'clarity'  ? 'HIGH CLARITY'
             :                    'FAILED STATES'}
            </button>
          ))}
          {/* v13.8: REPLAY placeholder. Future: state playback over
              the chart. For now, surfaces a "coming soon" inline
              notice without firing any backend calls. */}
          <button
            onClick={() => setShowReplay(s => !s)}
            title="Timeline replay (coming soon)"
            style={{
              padding: '2px 8px',
              fontSize: 8, letterSpacing: '0.12em', fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              background: showReplay ? 'var(--bg-3)' : 'transparent',
              border: `1px solid ${showReplay ? 'var(--cyan)' : 'var(--line-1)'}`,
              color:  showReplay ? 'var(--cyan)' : 'var(--fg-3)',
              borderRadius: 2,
              cursor: 'pointer',
              marginLeft: 6,
            }}
          >
            ▶ REPLAY
          </button>
        </div>
      </div>
      {showReplay && (
        <div style={{
          padding: '8px 10px', marginBottom: 10,
          background: 'rgba(77,217,232,0.05)',
          border: '1px solid #4dd9e833',
          borderLeft: '2px solid var(--cyan)',
          borderRadius: 3,
          fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.5,
        }}>
          <strong style={{ color: 'var(--cyan)', letterSpacing: '0.06em' }}>
            Timeline replay
          </strong> coming in a future release. The plan is to scrub
          this history list and re-render the Chart pane to the
          selected moment so you can compare what Guru saw vs how
          price subsequently moved.
        </div>
      )}
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
            // v13.8.2: Read Evolution badge replaces the v13.8.1
            // change marker. Reads richer than CURRENT/HELD/etc. — when
            // state code stays the same but underlying signals move,
            // the badge surfaces STRENGTHENING / WEAKENING / PRESSURE
            // BUILDING / TRANSITION RISK / AGING / IGNITION BUILDING
            // / LATE DECAY / EDGE LOST / STABLE with a brief data tail.
            // History list is newest-first; pass annotated.records as
            // the comparison context. liveStale only fires for the
            // newest row when the proxy served from cache.
            const evolution = deriveReadEvolution({
              records:      annotated.map(a => a.r),
              index:        i,
              isCurrent,
              isTransition,
              liveStale:    isCurrent && (r.stale === true),
            });
            const changeLabel = evolution.status;
            const changeColor = evolution.color;
            const changeTail  = evolution.tail;
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
                    display: 'flex', flexDirection: 'column', gap: 2,
                  }}>
                    <span>{fmtTime(r.timestamp)}</span>
                    {/* v13.8.2: Read Evolution badge. Status + optional
                        data tail. The tail makes a long stretch of CS
                        readable — "IS prob 38%" or "skew +24" or "held
                        7 reads" — instead of being an empty wall of
                        the same label. */}
                    {changeLabel && (
                      <span style={{
                        fontSize: 8, fontWeight: 700,
                        letterSpacing: '0.14em', color: changeColor,
                        padding: '1px 5px',
                        border: `1px solid ${changeColor === 'var(--fg-3)'
                          ? 'var(--line-2)' : changeColor}55`,
                        borderRadius: 2,
                        background: changeColor === 'var(--fg-3)'
                          ? 'transparent' : `${changeColor}11`,
                        alignSelf: 'flex-start',
                        whiteSpace: 'nowrap',
                      }}>
                        {changeLabel}
                      </span>
                    )}
                    {changeTail && (
                      <span style={{
                        fontSize: 8, color: 'var(--fg-3)',
                        letterSpacing: '0.06em',
                        fontFamily: 'var(--font-mono)',
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}>
                        {changeTail}
                      </span>
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

  // v13.8: Guru is now the COHERENCE MEMORY + STATE EVOLUTION surface.
  // Trade plan derivation moved out (Trade page owns execution); the
  // tradePlan helper imports stay for backwards compatibility but are
  // not consumed in this render. priorRecord stays for the WhatChanged
  // section (memory-of-deltas), which is still a Guru concern.
  void priorRecord;

  // v13.8.2: derive the current-segment persistence summary from the
  // symbol's history. CurrentReadCard uses it to swap the static
  // reasoningShort interp for a dynamic multi-line description of
  // what's been changing across a long-held state.
  const persistence = useMemo(
    () => derivePersistenceSummary(symbolRecords),
    [symbolRecords],
  );

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
    }}>
      <PageHeader crumbs={[
        { label: 'Guru Timeline' },
      ]} />

      <div style={{
        flex: 1, overflow: 'auto',
        padding: 18,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {/* v13.8.1: eyebrow + top-right page metrics. The summary
            is derived purely from already-stored aiStateHistory rows
            for this symbol — reads today (current local day boundary),
            state changes in window, and average read clarity. No
            fake values — when there are no rows yet, the metrics
            block hides itself. */}
        <PageHeaderRow symbol={props.symbol} records={symbolRecords} />

        {/* v13.8 SECTION A — Current Read.
            v13.8.1: hero now hosts a monk/watcher SVG, a live/stale
            badge, and the ASK GURU button. Source label is
            'guru_timeline_button' so the audit log can tell it apart
            from the Trade-side button. */}
        <CurrentReadCard
          aiState={props.aiState}
          aiLastSuccess={props.aiLastSuccess}
          aiStatus={props.aiStatus}
          aiEnabled={props.aiEnabled}
          aiRunNow={props.aiRunNow}
          regime={props.regime ?? null}
          netVariance={props.netVariance ?? null}
          persistence={persistence}
        />

        {/* v13.8 SECTION B — State Evolution. Last 5 anchored states
            as horizontal chips with arrows + current highlighted. */}
        <StateEvolution records={symbolRecords} currentState={props.aiState} />

        {/* v13.8 — State Story banner. Deterministic narrative from
            the last 8 anchored records ("CS persisted for 4 reads →
            SH event → recovery into CS …"). Pure local helper. */}
        <StateStoryBanner records={symbolRecords} />

        {/* v13.8 SECTION C — Guru History list, now with HIGH CLARITY
            and FAILED STATES filters, a REPLAY placeholder, and the
            Machine Thinking expansion baked into each expanded row. */}
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
