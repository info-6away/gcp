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
import type { GcpStateResponse } from '@/lib/engine-gcp';
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
import AiStateCard from './AiStateCard';
import { PageHeader } from './Chrome';

interface GuruViewProps {
  symbol:             MarketSymbol;
  symbolPrice:        number | null;
  aiState:            GcpStateResponse | null;
  aiEnabled:          boolean;
  aiStatus:           AiStatus;
  aiRunNow:           () => void;
  aiLastSuccess:      Date | null;
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
  regime = null, netVariance = null,
}: {
  aiState:        GcpStateResponse | null;
  aiStatus:       AiStatus;
  aiLastSuccess:  Date | null;
  aiEnabled:      boolean;
  aiRunNow:       () => void;
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
  const statusVerb =
    aiStatus === 'running' ? 'Asking…'
  : aiStatus === 'error'   ? 'Error — try again'
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
                Low state certainty — structure still forming.
              </div>
            )}
          </>
        )}

        {/* v11.34: relabelled CONFIDENCE → STATE CERTAINTY so it
            stops competing semantically with TRANSITION LIKELIHOOD.
            Same value (aiState.confidence × 100), clearer name —
            "how stable / certain the current state is" vs "how
            likely we transition to the next state". */}
        {stateConfPct != null && (
          <div
            title="How stable / certain the current Guru state is"
            style={{
              marginTop: 8,
              fontSize: 10, color: 'var(--fg-3)',
              letterSpacing: '0.06em',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span style={{ letterSpacing: '0.14em', color: 'var(--fg-4)' }}>
              STATE CERTAINTY
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
      </div>
      <button
        onClick={aiRunNow}
        disabled={buttonDisabled}
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
            const isCurrent = i === 0;
            return (
              <div key={r.id} style={{
                padding: '7px 10px',
                background: isCurrent ? 'var(--bg-3)' : 'var(--bg-2)',
                border: `1px solid ${isCurrent ? accent + '99' : 'var(--line-1)'}`,
                borderLeft: `2px solid ${accent}`,
                borderRadius: 3,
                fontSize: 10,
                lineHeight: 1.5,
                display: 'grid',
                gridTemplateColumns: '110px 1fr auto',
                gap: 12,
                alignItems: 'baseline',
              }}>
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
