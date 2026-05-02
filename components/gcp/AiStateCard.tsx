'use client';

// v11.16: Dashboard primary-focus block. The AI state is the user's
// "environment read" — the single thing they should be able to glance
// at and understand. Card now shows just:
//   - title + ⓘ button (opens AiStateExplainer)
//   - large state name + direction arrow
//   - phase / bias / confidence row
//   - one-line interpretation (DEFAULT_INTERPRETATION fallback when
//     the Engine returns long-form copy — long copy belongs in the
//     explainer modal, not on the dashboard).
//
// Invalidators, watchNext, and the Engine's reasoningShort all live in
// the explainer now. Dashboard = decision surface, modal = explanation
// surface.

import { memo, useEffect, useState } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import type { Pattern, MarketSymbol } from '@/types/gcp';
import type { StructureRead } from '@/lib/priceStructure';
import type { Candle } from '@/lib/fetchCandles';
import {
  directionArrow, stateColor, DEFAULT_INTERPRETATION,
} from '@/lib/aiState';
import { derivePosture, actionToneColor } from '@/lib/aiAction';
import { deriveTradePlan, formatPriceAnchor } from '@/lib/tradePlan';
import { AI_ANALYSIS_TF, AI_FORWARD_HORIZON } from '@/lib/aiTimeframe';
import AiStateExplainer from './AiStateExplainer';
import Heartbeat from './Heartbeat';

interface Props {
  state:          GcpStateResponse | null;
  enabled:        boolean;
  flash?:         boolean;
  latestPattern?: Pattern | null;
  // v11.18.3: manual-first cost control. The card now drives the
  // Engine call directly via runNow() — there's no automatic loop in
  // the default mode, so the user must press the button to get the
  // first classification.
  runNow?:        () => void;
  // v11.23.2: explicit state machine. 'running' is the ONLY value that
  // surfaces "Analyzing…"; every other value resolves to idle / success /
  // error copy so manual mode never shows analyzing by default.
  aiStatus?:      AiStatus;
  lastSuccessAt?: Date | null;
  // v11.22: Trade Plan layer needs price-structure context (HH/HL or
  // LH/LL) and the symbol for level formatting.
  planStructure?:      StructureRead;
  symbol?:             MarketSymbol;
  // v11.22.1: anchor the plan to the latest 15m candle's OHLC and the
  // current live price so the user sees the price the plan was based
  // on AND how far price has moved since.
  planAnalysisCandle?: Candle | null;
  currentPrice?:       number | null;
}

// v11.18: thin row used for MODE / ACTION / TRIGGER / SIZE in the
// posture block. Fixed-width label keeps the four rows visually
// aligned. emphasised = slightly brighter foreground so ACTION reads
// as the primary line in the block.
function PostureRow({
  label, value, accent, emphasised = false,
}: {
  label:        string;
  value:        string;
  accent:       string;
  emphasised?:  boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 10,
      padding: '5px 10px',
      background: `${accent}0d`,
      borderLeft: `2px solid ${accent}55`,
      borderRadius: 3,
      fontSize: 11,
      lineHeight: 1.4,
    }}>
      <span style={{
        fontSize: 8, letterSpacing: '0.18em',
        color: accent, fontWeight: 600,
        flexShrink: 0, minWidth: 56,
      }}>
        {label}
      </span>
      <span style={{
        color: emphasised ? accent : 'var(--fg-1)',
        fontWeight: emphasised ? 600 : 500,
        letterSpacing: '0.1px',
      }}>
        {value}
      </span>
    </div>
  );
}

// One-liner picker: prefer the Engine's reasoningShort only if it
// fits (<= 90 chars). Anything longer is collapsed to the default
// per-state copy so the dashboard never grows a paragraph.
function pickOneLiner(state: GcpStateResponse): string {
  const candidates = [state.reasoningShort, state.goldInterpretation];
  for (const raw of candidates) {
    const t = raw?.trim();
    if (t && t.length <= 90) return t;
  }
  return DEFAULT_INTERPRETATION[state.stateCode] || '—';
}

function formatRelative(d: Date | null | undefined): string {
  if (!d) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function Card({
  state, enabled, flash = false, latestPattern = null,
  runNow, aiStatus = 'idle', lastSuccessAt = null,
  planStructure, symbol = 'XAUUSD',
  planAnalysisCandle = null, currentPrice = null,
}: Props) {
  // v11.23.2: 'running' is the only state that should surface
  // "Analyzing…" / "RUNNING…" copy. Everything else is "not analyzing".
  const isRunning = aiStatus === 'running';
  const isError   = aiStatus === 'error';
  const [showExplainer, setShowExplainer] = useState(false);
  // v11.18.3: tick every 5 s so the "Last AI analysis: Xs ago" stamp
  // grows visibly without depending on parent re-renders. With the
  // auto-loop off (manual mode), the parent doesn't re-render
  // otherwise.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  const flashStyle: React.CSSProperties = flash ? {
    outline: '1px solid var(--cyan)',
    transition: 'outline 0.3s ease',
  } : {
    outline: '1px solid transparent',
    transition: 'outline 0.3s ease',
  };

  const InfoButton = (
    <button
      onClick={() => setShowExplainer(true)}
      title="What does this mean?"
      style={{
        background: 'transparent', border: '1px solid var(--line-2)',
        borderRadius: '50%',
        width: 16, height: 16, padding: 0,
        fontSize: 10, color: 'var(--fg-2)', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'inherit', letterSpacing: 0,
      }}
    >ⓘ</button>
  );

  if (!enabled) {
    return (
      <div style={{
        background: 'var(--bg-1)', padding: 18,
        height: '100%', display: 'flex', flexDirection: 'column',
        ...flashStyle,
      }}>
        <div style={{ fontSize: 9, letterSpacing: '0.14em', color: 'var(--fg-4)', marginBottom: 10 }}>
          AI STATE · GCP + GOLD ENVIRONMENT
        </div>
        <div style={{ fontSize: 16, color: 'var(--fg-4)' }}>Disabled</div>
        <div style={{ fontSize: 10, color: 'var(--fg-4)', marginTop: 4 }}>
          Enable in Settings → aiState
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div style={{
        background: 'var(--bg-1)', padding: 18,
        height: '100%', display: 'flex', flexDirection: 'column',
        ...flashStyle,
      }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.14em', color: 'var(--fg-4)',
          marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>AI STATE · GCP + GOLD ENVIRONMENT</span>
          {InfoButton}
        </div>
        {/* v11.18.3 + v11.23.2: no auto-call. Manual-first means the
            user must click to get a classification. The aiStatus state
            machine drives copy: running = pulsing "Analyzing…", error
            = retry hint, idle = "not run yet". */}
        <div style={{
          fontSize: 22,
          color: isError ? 'var(--red)' : 'var(--fg-2)',
          fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 10,
          letterSpacing: '0.01em',
        }}>
          {isRunning ? (
            <>
              <Heartbeat mode="init" size={9} />
              Analyzing…
            </>
          ) : isError ? (
            'AI analysis failed — retry'
          ) : (
            'AI State not run yet'
          )}
        </div>
        <div style={{ fontSize: 10, color: '#7F98A3', marginTop: 8, lineHeight: 1.5 }}>
          AI analysis uses LLM tokens. Run manually to control cost.
        </div>
        <button
          onClick={() => runNow?.()}
          disabled={!runNow || !enabled || isRunning}
          style={{
            marginTop: 14,
            padding: '8px 14px',
            fontSize: 11, letterSpacing: '0.1em', fontWeight: 600,
            background: isRunning ? 'rgba(77,217,232,0.1)' : 'transparent',
            border: `1px solid ${(!runNow || !enabled || isRunning) ? 'var(--line-2)' : 'var(--cyan)'}`,
            borderRadius: 4,
            color: (!runNow || !enabled || isRunning) ? 'var(--fg-3)' : 'var(--cyan)',
            fontFamily: 'inherit',
            cursor: (!runNow || !enabled || isRunning) ? 'default' : 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          {isRunning ? 'RUNNING…' : isError ? 'RETRY AI ANALYSIS' : 'RUN AI ANALYSIS'}
        </button>
        <AiStateExplainer
          open={showExplainer}
          state={null}
          onClose={() => setShowExplainer(false)}
        />
      </div>
    );
  }

  const accent = stateColor(state);
  const arrow  = directionArrow(state.direction);
  const conf   = Math.round(state.confidence * 100);
  const oneLiner = pickOneLiner(state);

  return (
    <div style={{
      background: 'var(--bg-1)', padding: '18px 20px',
      borderLeft: `3px solid ${accent}`,
      height: '100%', display: 'flex', flexDirection: 'column',
      ...flashStyle,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12, gap: 8,
      }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.14em', color: 'var(--fg-4)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>AI STATE · GCP + GOLD ENVIRONMENT</span>
          {InfoButton}
        </div>
        <div style={{
          fontSize: 9, letterSpacing: '0.08em',
          color: accent, fontFamily: 'var(--font-mono)',
        }}>
          {state.coherenceType.toUpperCase()}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10,
        lineHeight: 1.0,
      }}>
        <span style={{
          fontSize: 32, color: accent, fontWeight: 600,
          letterSpacing: '-0.015em',
        }}>
          {state.state.toUpperCase()}
        </span>
        <span style={{
          fontSize: 26, color: accent, fontWeight: 600,
        }}>
          {arrow}
        </span>
      </div>

      <div style={{
        display: 'flex', gap: 18, marginTop: 12,
        fontSize: 10, color: 'var(--fg-3)',
        fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
      }}>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>PHASE </span>
          <span style={{ color: 'var(--fg-0)' }}>{state.phase}</span>
        </span>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>BIAS </span>
          <span style={{ color: 'var(--fg-0)' }}>{state.direction}</span>
        </span>
        <span>
          <span style={{ color: 'var(--fg-4)' }}>CONF </span>
          <span style={{ color: 'var(--fg-0)' }}>{conf}%</span>
        </span>
      </div>

      {/* v11.16.5: explanation is the second-most-important element on
          the dashboard after the state name. Brighter foreground (not
          pure white), subtle cyan glow, and a left-border container so
          it reads as a key insight rather than secondary text. */}
      <div style={{
        marginTop: 14,
        padding: '8px 12px',
        background: 'rgba(56, 189, 248, 0.03)',
        borderLeft: '2px solid rgba(56, 189, 248, 0.25)',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
        lineHeight: 1.5,
        letterSpacing: '0.2px',
        color: '#B8D1DA',
        textShadow: '0 0 6px rgba(56, 189, 248, 0.15)',
      }}>
        {oneLiner}
      </div>

      {/* v11.21: timeframe context — tells the user what time scale
          the AI is operating on. Subtle cyan-grey, smaller than the
          explanation, always visible. */}
      <div style={{
        marginTop: 4,
        fontSize: 9,
        color: '#7F98A3',
        letterSpacing: '0.04em',
      }}>
        Context: {AI_ANALYSIS_TF} environment · {AI_FORWARD_HORIZON} horizon
      </div>

      {/* v11.18 + v11.22 + v11.22.1: posture block — MODE / ACTION /
          ANALYSIS AT / TRADE PLAN / TRIGGER / SIZE. Deterministic
          mapping in lib/aiAction.ts + lib/tradePlan.ts. */}
      {(() => {
        const posture = derivePosture(state, latestPattern);
        if (!posture) return null;
        const actionAccent = actionToneColor(posture.action.tone);
        const sizeAccent   = actionToneColor(posture.sizeTone);
        const plan = planStructure
          ? deriveTradePlan({
              state,
              structure:       planStructure,
              latestPattern,
              symbol,
              analysisCandle:  planAnalysisCandle,
              analysisTf:      AI_ANALYSIS_TF,
              currentPrice,
            })
          : null;
        const planAccent = plan ? actionToneColor(plan.tone) : actionAccent;
        const anchor = plan ? formatPriceAnchor(plan, symbol) : null;
        return (
          <div style={{
            marginTop: 8,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <PostureRow label="MODE"    value={posture.mode}        accent={actionAccent} />
            <PostureRow label="ACTION"  value={posture.action.text} accent={actionAccent} emphasised />

            {/* v11.22.1: ANALYSIS AT — anchors the plan to a specific
                price + bar so the user knows the context. */}
            {anchor && anchor.anchorLabel && (
              <div style={{
                padding: '5px 10px',
                background: 'rgba(127, 152, 163, 0.06)',
                borderLeft: '2px solid rgba(127, 152, 163, 0.35)',
                borderRadius: 3,
                fontSize: 10,
                lineHeight: 1.45,
                display: 'flex', flexDirection: 'column', gap: 1,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{
                    fontSize: 8, letterSpacing: '0.18em',
                    color: '#7F98A3', fontWeight: 600,
                    flexShrink: 0, minWidth: 56,
                  }}>ANALYSIS AT</span>
                  <span style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-mono)' }}>
                    {anchor.anchorLabel}
                  </span>
                </div>
                {anchor.ohlcLabel && (
                  <div style={{ fontSize: 9, color: '#7F98A3', marginLeft: 66, fontFamily: 'var(--font-mono)' }}>
                    {anchor.ohlcLabel}
                  </div>
                )}
                {anchor.currentLabel && (
                  <div style={{
                    fontSize: 9, marginLeft: 66, fontFamily: 'var(--font-mono)',
                    color: plan && plan.distance != null
                      ? plan.distance > 0 ? 'var(--green)' : plan.distance < 0 ? 'var(--red)' : '#7F98A3'
                      : '#7F98A3',
                  }}>
                    {anchor.currentLabel}
                  </div>
                )}
              </div>
            )}

            {plan && (
              <div style={{
                padding: '6px 10px',
                background: `${planAccent}0d`,
                borderLeft: `2px solid ${planAccent}55`,
                borderRadius: 3,
                fontSize: 11,
                lineHeight: 1.45,
                display: 'flex', flexDirection: 'column', gap: 2,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{
                    fontSize: 8, letterSpacing: '0.18em',
                    color: planAccent, fontWeight: 600,
                    flexShrink: 0, minWidth: 56,
                  }}>TRADE PLAN</span>
                  <span style={{ color: planAccent, fontWeight: 600, letterSpacing: '0.1px' }}>
                    {plan.headline}
                  </span>
                </div>
                {plan.entryType !== 'No entry' ? (
                  <>
                    {plan.triggers.map((line, i) => (
                      <div key={i} style={{ fontSize: 10, color: 'var(--fg-1)', marginLeft: 66 }}>
                        <span style={{ color: '#7F98A3' }}>{i === 0 ? 'Trigger: ' : ''}</span>
                        {line}
                      </div>
                    ))}
                    <div style={{ fontSize: 10, color: 'var(--fg-1)', marginLeft: 66 }}>
                      <span style={{ color: '#7F98A3' }}>Invalidation: </span>{plan.invalidation}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 10, color: 'var(--fg-2)', marginLeft: 66 }}>
                    <span style={{ color: '#7F98A3' }}>Reason: </span>{plan.reason ?? '—'}
                  </div>
                )}
              </div>
            )}

            <PostureRow label="TRIGGER" value={posture.trigger}     accent={actionAccent} />
            <PostureRow label="SIZE"    value={posture.size}        accent={sizeAccent} />
          </div>
        );
      })()}

      {/* v11.18.3: refresh row — manual-first cost control means the
          user is in charge of when to call the Engine. Last-analysis
          stamp animates relative to lastSuccessAt; the button bypasses
          any interval floor and respects the in-flight guard. */}
      <div style={{
        marginTop: 10,
        paddingTop: 8,
        borderTop: '1px solid var(--line-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8,
      }}>
        <div style={{ fontSize: 10, color: '#7F98A3' }}>
          Last AI analysis: <span style={{ color: 'var(--fg-1)' }}>{formatRelative(lastSuccessAt)}</span>
        </div>
        <button
          onClick={() => runNow?.()}
          disabled={!runNow || !enabled || isRunning}
          style={{
            padding: '4px 10px',
            fontSize: 9, letterSpacing: '0.1em', fontWeight: 600,
            background: isRunning ? 'rgba(77,217,232,0.1)' : 'transparent',
            border: `1px solid ${(!runNow || !enabled || isRunning) ? 'var(--line-2)' : 'var(--cyan)'}`,
            borderRadius: 3,
            color: (!runNow || !enabled || isRunning) ? 'var(--fg-3)' : 'var(--cyan)',
            fontFamily: 'inherit',
            cursor: (!runNow || !enabled || isRunning) ? 'default' : 'pointer',
          }}
        >
          {isRunning ? 'RUNNING…' : 'REFRESH AI ANALYSIS'}
        </button>
      </div>

      <AiStateExplainer
        open={showExplainer}
        state={state}
        onClose={() => setShowExplainer(false)}
      />
    </div>
  );
}

export default memo(Card);
