'use client';

// v11.33: TRADE module — Guru-aware execution layer.
// v13.0:  TRADE rebuilt as pure execution intelligence. The chart is
//         gone (charts live on Chart / Patterns / Research). The
//         module is now an AI execution console:
//
//   ┌───────────────────────────────────────────────────────────────┐
//   │ Header  TRADE · SYMBOL · balance · reset                       │
//   ├───────────────────────────────────────────────────────────────┤
//   │ ┌─────────────────────┐  ┌──────────────────────────────────┐ │
//   │ │ THESIS (hero)        │  │ DIRECTIONAL PRESSURE             │ │
//   │ │   state · phase      │  │   ▓▓▓▓░░░░░░░░░░░░               │ │
//   │ │   regime · NV        │  │   LONG % / SHORT %               │ │
//   │ │   interp + gold      │  │   band + drift                   │ │
//   │ │   invalidators       │  │ STANCE / MODE / EXECUTION        │ │
//   │ └─────────────────────┘  └──────────────────────────────────┘ │
//   ├───────────────────────────────────────────────────────────────┤
//   │ ENVIRONMENT RISK  |  STATE FLOW  |  HISTORICAL ANALOG          │
//   ├───────────────────────────────────────────────────────────────┤
//   │ ┌─────────────────────┐  ┌──────────────────────────────────┐ │
//   │ │ TRADE ACTION         │  │ POSITION MONITOR                  │ │
//   │ │ (entry panel)        │  │ (active position + thesis status) │ │
//   │ └─────────────────────┘  └──────────────────────────────────┘ │
//   ├───────────────────────────────────────────────────────────────┤
//   │ HISTORY TABLE                                                   │
//   └───────────────────────────────────────────────────────────────┘
//
// Reuses lib/demoAccount.ts for persistence + PnL math, lib/guruStance
// for the stance block, lib/guruAlignment for the alignment chip,
// lib/stateTransition for the NEXT overlay, and the new
// lib/executionIntelligence for environment-risk / historical-analog /
// thesis-integrity derivations. No new Engine calls. No chart.

import { memo, useEffect, useMemo, useState } from 'react';
import type { MarketSymbol, Pattern, Timeframe } from '@/types/gcp';
import { formatPrice } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { Posture } from '@/lib/aiAction';
import type { TradePlan } from '@/lib/tradePlan';
import {
  loadDemoAccount, saveDemoAccount, resetDemoAccount,
  openPosition, closePosition, evaluateAutoClose,
  computePnl, computeEquity,
  alignmentLabel as alignAlignmentLabel,
  alignmentColor as alignAlignmentColor,
  classifyAlignment,
  STARTING_BALANCE, DEFAULT_NOTIONAL, QUICK_SIZES, DEMO_LS_KEY,
  type DemoAccount, type Side, type TradeContext,
} from '@/lib/demoAccount';
import {
  deriveTradeAlignment, alignmentLabel as guruAlignmentLabel,
  alignmentColor as guruAlignmentColor, type Alignment,
} from '@/lib/guruAlignment';
import { stateColor, directionArrow, DEFAULT_INTERPRETATION } from '@/lib/aiState';
import { deriveStance } from '@/lib/guruStance';
import { ladderColor, ladderLabel, type LadderState } from '@/lib/stateTransition';
import {
  deriveEnvironmentRisk, deriveHistoricalAnalog, deriveThesisIntegrity,
} from '@/lib/executionIntelligence';
import {
  dominanceColor, dominanceLabel,
  type StructuralDominance,
} from '@/lib/structuralDominance';
import {
  AI_HISTORY_LS_KEY, loadAiStateHistory,
  type AiStateHistoryRecord,
} from '@/lib/aiStateHistory';

interface Props {
  symbol:        MarketSymbol;
  timeframe:     Timeframe;
  currentPrice:  number | null;
  aiState:       GcpStateResponse | null;
  posture:       Posture | null;
  latestPattern: Pattern | null;
  tradePlan:     TradePlan | null;
  regime:        string | null;
  netVariance:   number | null;
  // v13.0: gold trend label used by the THESIS hero for the
  // "gold confirmation / divergence" line. Optional so existing call
  // sites that don't have it threaded keep type-checking; falls back
  // to "unknown" inside the panel.
  goldTrend?:    'up' | 'down' | 'sideways' | 'unknown';
}

// ─────────────────────────────────────────────────────────────────
// Small formatters
// ─────────────────────────────────────────────────────────────────

function fmtMoney(n: number, signed = false): string {
  const abs = Math.abs(n);
  const s = `$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n < 0)         return `-${s}`;
  if (signed && n > 0) return `+${s}`;
  return s;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function buildContext(
  symbol:        MarketSymbol,
  timeframe:     Timeframe,
  aiState:       GcpStateResponse | null,
  posture:       Posture | null,
  latestPattern: Pattern | null,
  tradePlan:     TradePlan | null,
  regime:        string | null,
  netVariance:   number | null,
): TradeContext {
  return {
    symbol, timeframe,
    aiState:           aiState?.state          ?? null,
    aiStateCode:       aiState?.stateCode      ?? null,
    phase:             aiState?.phase          ?? null,
    direction:         aiState?.direction      ?? null,
    confidence:        aiState?.confidence     ?? null,
    actionText:        posture?.action.text    ?? null,
    actionTone:        posture?.action.tone    ?? null,
    marketMode:        posture?.mode           ?? null,
    sizeGuidance:      posture?.size           ?? null,
    tradePlanHeadline: tradePlan?.headline     ?? null,
    patternCode:       latestPattern?.patternCode ?? null,
    patternName:       latestPattern?.patternName ?? latestPattern?.kind ?? null,
    pss:               latestPattern ? Math.round(latestPattern.strength * 100) : null,
    regime,
    netVariance,
  };
}

// ─────────────────────────────────────────────────────────────────
// LEFT — Entry Panel
// ─────────────────────────────────────────────────────────────────

type EntryType = 'market' | 'limit' | 'guru';

function EntryPanel({
  symbol, currentPrice,
  side, setSide,
  size, setSize,
  entryType, setEntryType,
  limitPrice, setLimitPrice,
  stopLoss, setStopLoss,
  takeProfit, setTakeProfit,
  onOpen, hasOpen, alignment,
}: {
  symbol:        MarketSymbol;
  currentPrice:  number | null;
  side:          Side;
  setSide:       (s: Side) => void;
  size:          number;
  setSize:       (n: number) => void;
  entryType:     EntryType;
  setEntryType:  (t: EntryType) => void;
  limitPrice:    string;
  setLimitPrice: (s: string) => void;
  stopLoss:      string;
  setStopLoss:   (s: string) => void;
  takeProfit:    string;
  setTakeProfit: (s: string) => void;
  onOpen:        () => void;
  hasOpen:       boolean;
  alignment:     Alignment;
}) {
  const disabled = hasOpen || currentPrice == null;
  const sideAccent = side === 'long' ? 'var(--green)' : 'var(--red)';
  // Warn-color CTA when opening into a contradiction with Guru.
  const ctaAccent = alignment === 'contradiction' ? '#ef4444'
                  : alignment === 'partial'       ? '#d4a028'
                  : sideAccent;

  return (
    <SectionShell title="NEW POSITION">
      {/* LONG / SHORT toggle */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['long', 'short'] as Side[]).map(s => (
          <button key={s}
            onClick={() => setSide(s)}
            disabled={hasOpen}
            style={{
              flex: 1,
              padding: '8px 0',
              fontSize: 11, letterSpacing: '0.14em', fontWeight: 700,
              fontFamily: 'inherit',
              background: side === s
                ? (s === 'long' ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)')
                : 'transparent',
              border: `1px solid ${
                side === s
                  ? (s === 'long' ? 'var(--green)' : 'var(--red)')
                  : 'var(--line-2)'
              }`,
              color: side === s
                ? (s === 'long' ? 'var(--green)' : 'var(--red)')
                : 'var(--fg-3)',
              borderRadius: 3,
              cursor: hasOpen ? 'default' : 'pointer',
            }}
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Size selector */}
      <FieldLabel>Position size</FieldLabel>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {QUICK_SIZES.map(n => (
          <button key={n}
            onClick={() => setSize(n)}
            disabled={hasOpen}
            style={{
              flex: 1, padding: '5px 0',
              fontSize: 9, letterSpacing: '0.06em',
              fontFamily: 'inherit',
              background: size === n ? 'var(--bg-3)' : 'transparent',
              border: `1px solid ${size === n ? 'var(--line-2)' : 'var(--line-1)'}`,
              borderRadius: 2,
              color: hasOpen ? 'var(--fg-4)'
                   : size === n ? 'var(--fg-0)'
                   : 'var(--fg-3)',
              cursor: hasOpen ? 'default' : 'pointer',
            }}
          >
            ${n.toLocaleString()}
          </button>
        ))}
      </div>

      {/* Entry type */}
      <FieldLabel>Entry type</FieldLabel>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['market', 'limit', 'guru'] as EntryType[]).map(t => {
          const isGuru = t === 'guru';
          return (
            <button key={t}
              onClick={() => !isGuru && setEntryType(t)}
              disabled={hasOpen || isGuru}
              title={isGuru ? 'Guru-assisted entries — coming soon' : undefined}
              style={{
                flex: 1, padding: '4px 0',
                fontSize: 9, letterSpacing: '0.06em',
                fontFamily: 'inherit',
                background: entryType === t ? 'var(--bg-3)' : 'transparent',
                border: `1px solid ${entryType === t ? 'var(--line-2)' : 'var(--line-1)'}`,
                borderRadius: 2,
                color: isGuru ? 'var(--fg-4)'
                     : entryType === t ? 'var(--fg-0)'
                     : 'var(--fg-3)',
                cursor: (hasOpen || isGuru) ? 'default' : 'pointer',
              }}
            >
              {t === 'guru' ? 'GURU*' : t.toUpperCase()}
            </button>
          );
        })}
      </div>

      {entryType === 'limit' && (
        <NumberField
          label="Limit price"
          placeholder={currentPrice != null ? formatPrice(currentPrice, symbol) : '—'}
          value={limitPrice}
          onChange={setLimitPrice}
          disabled={hasOpen}
        />
      )}

      {/* Risk */}
      <FieldLabel>Risk (optional)</FieldLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
        <NumberField
          label="STOP"
          placeholder="—"
          value={stopLoss}
          onChange={setStopLoss}
          disabled={hasOpen}
          compact
        />
        <NumberField
          label="TP"
          placeholder="—"
          value={takeProfit}
          onChange={setTakeProfit}
          disabled={hasOpen}
          compact
        />
      </div>

      <button
        onClick={onOpen}
        disabled={disabled}
        style={{
          width: '100%',
          padding: '10px 0',
          marginTop: 6,
          fontSize: 12, letterSpacing: '0.16em', fontWeight: 700,
          fontFamily: 'inherit',
          background: disabled ? 'transparent' : `${ctaAccent}1f`,
          border: `1px solid ${disabled ? 'var(--line-2)' : ctaAccent}`,
          color: disabled ? 'var(--fg-4)' : ctaAccent,
          borderRadius: 3,
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {hasOpen ? 'POSITION OPEN' : 'OPEN TRADE'}
      </button>

      {hasOpen && (
        <div style={{
          marginTop: 6, fontSize: 9, color: 'var(--fg-4)', lineHeight: 1.4,
        }}>
          Close the active position to open a new one.
        </div>
      )}
    </SectionShell>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 8, letterSpacing: '0.16em',
      color: 'var(--fg-4)', fontFamily: 'var(--font-mono)',
      fontWeight: 600, marginBottom: 4,
    }}>
      {children}
    </div>
  );
}

function NumberField({
  label, placeholder, value, onChange, disabled, compact,
}: {
  label:       string;
  placeholder: string;
  value:       string;
  onChange:    (s: string) => void;
  disabled?:   boolean;
  compact?:    boolean;
}) {
  return (
    <label style={{ display: 'block', marginBottom: compact ? 0 : 8 }}>
      <span style={{
        display: 'block',
        fontSize: 8, letterSpacing: '0.14em',
        color: 'var(--fg-4)', fontFamily: 'var(--font-mono)',
        fontWeight: 600, marginBottom: 3,
      }}>{label}</span>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={{
          width: '100%',
          padding: '5px 8px',
          fontSize: 11, fontFamily: 'var(--font-mono)',
          background: 'var(--bg-2)',
          border: '1px solid var(--line-1)',
          color: 'var(--fg-1)',
          borderRadius: 2,
        }}
      />
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────
// CENTER — Active position + history
// ─────────────────────────────────────────────────────────────────

function ActivePositionCard({
  acct, symbol, currentPrice, alignment, onClose,
}: {
  acct:         DemoAccount;
  symbol:       MarketSymbol;
  currentPrice: number | null;
  alignment:    Alignment;
  onClose:      () => void;
}) {
  const open = acct.open;
  const positionSymbolMismatch = !!open && open.context.symbol !== symbol;

  if (!open) {
    return (
      <SectionShell title="OPEN POSITION">
        <div style={{
          padding: '32px 16px', textAlign: 'center',
          color: 'var(--fg-3)', fontSize: 12,
        }}>
          <div style={{
            fontSize: 14, color: 'var(--fg-2)', fontWeight: 600,
            letterSpacing: '0.04em', marginBottom: 6,
          }}>
            FLAT
          </div>
          No open position · realized PnL{' '}
          <span style={{
            color: acct.realizedPnl > 0 ? 'var(--green)'
                 : acct.realizedPnl < 0 ? 'var(--red)'
                 : 'var(--fg-3)',
          }}>
            {fmtMoney(acct.realizedPnl, true)}
          </span>
        </div>
      </SectionShell>
    );
  }

  const openPnl = currentPrice != null && !positionSymbolMismatch
    ? computePnl(open.side, open.entryPrice, currentPrice, open.size)
    : 0;
  const equity = positionSymbolMismatch ? acct.balance : computeEquity(acct, currentPrice);
  const pnlPct = open.entryPrice > 0
    ? ((openPnl / open.size) * 100)
    : 0;
  const sideColor = open.side === 'long' ? 'var(--green)' : 'var(--red)';
  const pnlColor  = positionSymbolMismatch ? 'var(--fg-3)'
                  : openPnl > 0 ? 'var(--green)'
                  : openPnl < 0 ? 'var(--red)'
                  : 'var(--fg-3)';

  const subtitle = positionSymbolMismatch
    ? `Open on ${open.context.symbol} — switch to manage`
    : `${open.context.symbol} · ${open.context.timeframe}`;

  return (
    <SectionShell
      title="OPEN POSITION"
      subtitle={subtitle}
      accent={sideColor}
    >
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
        marginBottom: 12,
      }}>
        <div>
          <FieldLabel>SIDE</FieldLabel>
          <div style={{
            fontSize: 22, color: sideColor, fontWeight: 700,
            letterSpacing: '0.04em',
          }}>
            {open.side === 'long' ? 'LONG' : 'SHORT'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <FieldLabel>UNREALIZED PnL</FieldLabel>
          <div style={{
            fontSize: 22, color: pnlColor, fontWeight: 700,
            fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
          }}>
            {positionSymbolMismatch ? '—' : fmtMoney(openPnl, true)}
          </div>
          {!positionSymbolMismatch && (
            <div style={{ fontSize: 10, color: pnlColor, marginTop: 2 }}>
              {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
            </div>
          )}
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10,
        fontSize: 10, marginBottom: 12,
      }}>
        <Cell label="ENTRY" value={formatPrice(open.entryPrice, open.context.symbol)} />
        <Cell label="CURRENT" value={
          positionSymbolMismatch
            ? '—'
            : currentPrice != null ? formatPrice(currentPrice, open.context.symbol) : '—'
        } />
        <Cell label="EXPOSURE" value={fmtMoney(open.size)} />
        <Cell label="DURATION" value={fmtDuration(Date.now() - open.entryTime)} />
        {open.stopLoss != null && (
          <Cell label="STOP" value={formatPrice(open.stopLoss, open.context.symbol)} color="var(--red)" />
        )}
        {open.takeProfit != null && (
          <Cell label="TP" value={formatPrice(open.takeProfit, open.context.symbol)} color="var(--green)" />
        )}
      </div>

      {/* GURU ALIGNMENT chip */}
      <AlignmentChip alignment={alignment} />

      <div style={{
        marginTop: 10,
        fontSize: 9, color: 'var(--fg-4)', lineHeight: 1.55,
      }}>
        Equity <span style={{ color: 'var(--fg-2)', fontFamily: 'var(--font-mono)' }}>
          {fmtMoney(equity)}
        </span>
        {' '}· Realized{' '}
        <span style={{
          color: acct.realizedPnl > 0 ? 'var(--green)'
               : acct.realizedPnl < 0 ? 'var(--red)'
               : 'var(--fg-3)',
          fontFamily: 'var(--font-mono)',
        }}>
          {fmtMoney(acct.realizedPnl, true)}
        </span>
      </div>

      <button
        onClick={onClose}
        disabled={positionSymbolMismatch || currentPrice == null}
        style={{
          width: '100%', marginTop: 12,
          padding: '8px 0',
          fontSize: 11, letterSpacing: '0.14em', fontWeight: 700,
          fontFamily: 'inherit',
          background: 'rgba(77,217,232,0.10)',
          border: `1px solid ${positionSymbolMismatch ? 'var(--line-2)' : 'var(--cyan)'}`,
          color: positionSymbolMismatch ? 'var(--fg-4)' : 'var(--cyan)',
          borderRadius: 3,
          cursor: positionSymbolMismatch ? 'default' : 'pointer',
        }}
      >
        CLOSE POSITION
      </button>
    </SectionShell>
  );
}

function Cell({
  label, value, color,
}: {
  label:  string;
  value:  string;
  color?: string;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div style={{
        fontSize: 13, color: color ?? 'var(--fg-1)',
        fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
      }}>
        {value}
      </div>
    </div>
  );
}

function AlignmentChip({ alignment }: { alignment: Alignment }) {
  const c = guruAlignmentColor(alignment);
  const label = guruAlignmentLabel(alignment).toUpperCase();
  return (
    <div style={{
      padding: '6px 10px',
      background: `${c}10`,
      border: `1px solid ${c}55`,
      borderLeft: `3px solid ${c}`,
      borderRadius: 3,
      display: 'grid', gridTemplateColumns: '78px 1fr', gap: 10,
      alignItems: 'baseline',
    }}>
      <span style={{
        fontSize: 8, color: 'var(--fg-4)', letterSpacing: '0.18em',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        ALIGNMENT
      </span>
      <span style={{
        fontSize: 12, color: c, fontWeight: 700, letterSpacing: '0.04em',
      }}>
        {label}
      </span>
    </div>
  );
}

function HistoryTable({ acct, symbol }: { acct: DemoAccount; symbol: MarketSymbol }) {
  const trades = acct.trades.slice(0, 20);
  return (
    <SectionShell title={`TRADE HISTORY (${acct.trades.length})`}>
      {trades.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--fg-3)', padding: '4px 0' }}>
          No trades yet.
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '90px 70px 90px 90px 70px 60px 100px',
          gap: 6,
          fontSize: 9,
          fontFamily: 'var(--font-mono)',
        }}>
          {/* Header */}
          {['TIME', 'SIDE', 'ENTRY', 'EXIT', 'PnL', 'STATE', 'ALIGNMENT'].map(h => (
            <div key={h} style={{
              fontSize: 8, color: 'var(--fg-4)', letterSpacing: '0.14em',
              borderBottom: '1px solid var(--line-1)', paddingBottom: 4, marginBottom: 4,
            }}>
              {h}
            </div>
          ))}
          {trades.map(t => {
            const pnlColor = t.pnl > 0 ? 'var(--green)'
                           : t.pnl < 0 ? 'var(--red)'
                           : 'var(--fg-3)';
            const sideColor = t.side === 'long' ? 'var(--green)' : 'var(--red)';
            return (
              <Row key={t.id}>
                <span style={{ color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtTime(t.exitTime)}
                </span>
                <span style={{ color: sideColor, fontWeight: 600 }}>
                  {t.side === 'long' ? 'LONG' : 'SHORT'}
                </span>
                <span style={{ color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatPrice(t.entryPrice, t.symbol)}
                </span>
                <span style={{ color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatPrice(t.exitPrice, t.symbol)}
                </span>
                <span style={{ color: pnlColor, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {fmtMoney(t.pnl, true)}
                </span>
                <span style={{ color: 'var(--fg-2)' }}>
                  {t.context.aiStateCode ?? '—'}
                </span>
                <span style={{ color: alignAlignmentColor(t.alignment) }}>
                  {alignAlignmentLabel(t.alignment).toUpperCase()}
                </span>
              </Row>
            );
          })}
        </div>
      )}
      {symbol && trades.length > 0 && (
        <div style={{ fontSize: 9, color: 'var(--fg-4)', marginTop: 6 }}>
          Showing last 20 of {acct.trades.length} closed trades.
        </div>
      )}
    </SectionShell>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ─────────────────────────────────────────────────────────────────
// RIGHT — Guru context
// ─────────────────────────────────────────────────────────────────

function GuruContextColumn({
  aiState, posture,
}: {
  aiState: GcpStateResponse | null;
  posture: Posture | null;
}) {
  if (!aiState) {
    return (
      <SectionShell title="GURU CONTEXT">
        <div style={{ fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.5 }}>
          No Guru analysis yet. Open the Guru tab and click <span style={{ color: 'var(--cyan)' }}>Ask Guru</span> to capture one.
        </div>
      </SectionShell>
    );
  }
  const accent = stateColor(aiState);
  const arrow  = directionArrow(aiState.direction);
  const conf   = Math.round(aiState.confidence * 100);
  const oneLiner = (aiState.reasoningShort?.trim() && aiState.reasoningShort.length <= 90)
    ? aiState.reasoningShort.trim()
    : (DEFAULT_INTERPRETATION[aiState.stateCode] || '—');
  const stance = deriveStance(aiState);

  return (
    <SectionShell title="GURU CONTEXT" accent={accent}>
      {/* STATE */}
      <FieldLabel>STATE</FieldLabel>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4,
      }}>
        <span style={{
          fontSize: 18, color: accent, fontWeight: 700, letterSpacing: '0.01em',
        }}>
          {aiState.state.toUpperCase()}
        </span>
        <span style={{ fontSize: 14, color: accent, fontWeight: 600 }}>{arrow}</span>
      </div>
      <div style={{
        fontSize: 9, color: 'var(--fg-3)',
        fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
        marginBottom: 10,
      }}>
        {aiState.phase} · {aiState.direction}
      </div>
      <div style={{
        fontSize: 11, color: '#B8D1DA', lineHeight: 1.5, marginBottom: 12,
      }}>
        {oneLiner}
      </div>

      {/* STANCE */}
      {stance && (
        <>
          <FieldLabel>STANCE</FieldLabel>
          <div style={{
            padding: '6px 10px',
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid var(--line-1)',
            borderLeft: '2px solid var(--fg-0)',
            borderRadius: 3,
            marginBottom: 10,
            display: 'flex', flexDirection: 'column', gap: 3,
          }}>
            <div style={{ fontSize: 13, color: 'var(--fg-0)', fontWeight: 700 }}>
              {stance.stance}
            </div>
            <div style={{ fontSize: 10, color: '#d4a028' }}>
              {stance.mode}
            </div>
            <div style={{ fontSize: 10, color: 'var(--cyan)' }}>
              {stance.execution}
            </div>
          </div>
        </>
      )}

      {/* NEXT */}
      {aiState.nextLikelyState && (
        <>
          <FieldLabel>NEXT</FieldLabel>
          <NextChip
            nextState={aiState.nextLikelyState as LadderState}
            confidence={aiState.transitionConfidence ?? 0.5}
            reason={aiState.transitionReason}
          />
        </>
      )}

      {/* CONFIDENCE */}
      <div style={{
        marginTop: 10,
        fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
      }}>
        <span style={{ color: 'var(--fg-4)', letterSpacing: '0.14em' }}>CONFIDENCE</span>
        <span style={{
          color: 'var(--fg-1)', marginLeft: 6,
          fontVariantNumeric: 'tabular-nums', fontWeight: 600,
        }}>
          {conf}%
        </span>
      </div>

      {/* Posture pattern context line (mode + size) */}
      {posture && (
        <div style={{
          marginTop: 8, fontSize: 9, color: 'var(--fg-4)', lineHeight: 1.5,
        }}>
          mode <span style={{ color: 'var(--fg-2)' }}>{posture.mode}</span>
          {' · '}
          size <span style={{ color: 'var(--fg-2)' }}>{posture.size}</span>
        </div>
      )}
    </SectionShell>
  );
}

function NextChip({
  nextState, confidence, reason,
}: {
  nextState:  LadderState;
  confidence: number;
  reason?:    string;
}) {
  const color = ladderColor(nextState);
  const label = ladderLabel(nextState);
  const conf  = Math.round(confidence * 100);
  return (
    <div style={{
      padding: '5px 10px',
      background: `${color}0d`,
      border: `1px solid ${color}40`,
      borderRadius: 3,
      display: 'flex', flexDirection: 'column', gap: 2,
      marginBottom: 4,
    }}>
      <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          fontSize: 9, letterSpacing: '0.18em',
          color: 'var(--fg-4)', fontFamily: 'var(--font-mono)',
          fontWeight: 600,
        }}>NEXT →</span>
        <span style={{
          color, fontWeight: 600, fontSize: 12, letterSpacing: '0.02em',
        }}>{label}</span>
      </div>
      <div style={{
        fontSize: 9, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
      }}>
        <span style={{ letterSpacing: '0.14em', color: 'var(--fg-4)' }}>LIKELIHOOD</span>
        <span style={{
          color: 'var(--fg-2)', marginLeft: 6,
          fontVariantNumeric: 'tabular-nums', fontWeight: 600,
        }}>{conf}%</span>
        {reason && (
          <span style={{ color: 'var(--fg-3)', marginLeft: 4, fontStyle: 'italic' }}>
            · {reason}
          </span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Section shell shared by all three columns
// ─────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════
// v13.0: EXECUTION INTELLIGENCE — section components.
// Replace the technical chart. Density swap: candles → coherence.
// ═════════════════════════════════════════════════════════════════

// ── 1. THESIS (hero) ─────────────────────────────────────────────
//
// Single dominant panel: state · phase · certainty · regime · NV ·
// interpretation · gold confirmation/divergence · invalidators ·
// execution warning. Anchors the whole module.

function ThesisHero({
  aiState, regime, netVariance, goldTrend,
}: {
  aiState:     GcpStateResponse | null;
  regime:      string | null;
  netVariance: number | null;
  goldTrend:   'up' | 'down' | 'sideways' | 'unknown';
}) {
  const accent  = aiState ? stateColor(aiState) : 'var(--fg-3)';
  const conf    = aiState ? Math.round(aiState.confidence * 100) : null;
  const interp  = aiState ? (aiState.reasoningShort?.trim()
                          || DEFAULT_INTERPRETATION[aiState.stateCode]
                          || aiState.goldInterpretation
                          || '—')
                          : 'Awaiting first Guru classification.';

  // Gold confirmation / divergence line. Mixed with state direction —
  // when direction is Up and gold is up that's confirmation; up vs
  // down is divergence; sideways / unknown is neutral.
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
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        GURU EXECUTION THESIS
      </div>

      {/* state · phase headline */}
      <div style={{
        fontSize: 22, color: accent, fontWeight: 700,
        letterSpacing: '0.01em', lineHeight: 1.15,
      }}>
        {aiState
          ? `${aiState.state.toUpperCase()} · ${aiState.phase}`
          : 'NO READ YET'}
      </div>

      {/* meta row: certainty · regime · NV */}
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

      {/* interpretation */}
      <div style={{
        fontSize: 12, color: 'var(--fg-1)', lineHeight: 1.55,
        marginTop: 2,
      }}>
        {interp}
      </div>

      {/* gold confirmation / divergence */}
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

      {/* invalidators */}
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

      {/* execution warning — surfaced when the response carries one
          (FA, Late/Exhausted state, stale fallback). */}
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

// ── 2. DIRECTIONAL PRESSURE (large gauge) ────────────────────────

function PressureGauge({ aiState }: { aiState: GcpStateResponse | null }) {
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

      {/* Large split bar — taller than the Guru-view variant to read
          as "gauge" rather than "chip". */}
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

      {/* Number row */}
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

      {/* v13.1: STRUCTURE line — local structural dominance read
          surfaced as a small muted row. Distinct from pressure: pressure
          is the coherence-level tendency, structure is the actual price
          control. When the two disagree the dominance label tells the
          user "the chart is bearish even though pressure leans long".
          Hidden when no dominance has been derived yet (first render
          before any classification). */}
      {aiState?.structureDominance && (
        <div style={{
          marginTop: 4, display: 'flex', alignItems: 'baseline', gap: 8,
          fontSize: 10, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em', color: 'var(--fg-4)',
        }}>
          <span style={{ letterSpacing: '0.16em' }}>STRUCTURE</span>
          <span style={{
            color: dominanceColor(aiState.structureDominance as StructuralDominance),
            fontWeight: 600, letterSpacing: '0.04em',
          }}>
            {dominanceLabel(aiState.structureDominance as StructuralDominance)}
          </span>
          {typeof aiState.structureScore === 'number' && (
            <span style={{
              color: 'var(--fg-4)', fontVariantNumeric: 'tabular-nums',
              fontSize: 9,
            }}>
              · score {aiState.structureScore >= 0 ? '+' : ''}{aiState.structureScore}
            </span>
          )}
        </div>
      )}

      {/* Stance — Sections 3 from the spec folded into the same panel
          so STANCE / MODE / EXECUTION sit visually next to the gauge
          that justifies them. */}
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

// ── 4. ENVIRONMENT RISK ──────────────────────────────────────────

function EnvironmentRiskCard({ aiState }: { aiState: GcpStateResponse | null }) {
  const risk = deriveEnvironmentRisk(aiState);
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: `2px solid ${risk.color}`,
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
      }}>
        ENVIRONMENT RISK
      </div>
      <div style={{
        fontSize: 18, fontWeight: 700, color: risk.color,
        letterSpacing: '0.02em',
      }}>
        {risk.label.toUpperCase()}
      </div>
      <div style={{
        fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.5,
      }}>
        {risk.hint}
      </div>
    </div>
  );
}

// ── 8. STATE FLOW ribbon (last 5 anchored states) ────────────────

function StateFlowRibbon({
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

// ── 7. HISTORICAL ANALOG ─────────────────────────────────────────

function HistoricalAnalogCard({
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

// ── 6. POSITION MONITOR — thesis integrity for open positions ────

function PositionMonitorBlock({
  acct, aiState,
}: {
  acct:    DemoAccount;
  aiState: GcpStateResponse | null;
}) {
  const open = acct.open;
  const integrity = deriveThesisIntegrity(
    open?.side ?? null,
    open?.context.aiStateCode ?? null,
    open?.context.phase ?? null,
    open?.context.confidence ?? null,
    aiState,
  );
  if (!open) {
    return (
      <div style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--line-1)',
        borderRadius: 'var(--r-md)',
        padding: '12px 14px',
      }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
          fontFamily: 'var(--font-mono)', fontWeight: 600, marginBottom: 6,
        }}>
          POSITION MONITOR
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.5 }}>
          No open position. Thesis integrity tracking activates on entry.
        </div>
      </div>
    );
  }
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: `2px solid ${integrity.color}`,
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 8,
      }}>
        <span style={{
          fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
          fontFamily: 'var(--font-mono)', fontWeight: 600,
        }}>
          POSITION MONITOR
        </span>
        <span style={{
          fontSize: 9, letterSpacing: '0.14em', color: integrity.color,
          fontWeight: 700, fontFamily: 'var(--font-mono)',
        }}>
          THESIS {integrity.status.toUpperCase()}
        </span>
      </div>
      <div style={{
        fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.55,
      }}>
        {integrity.hint}
      </div>
      <div style={{
        fontSize: 9, color: 'var(--fg-4)', letterSpacing: '0.06em',
        fontFamily: 'var(--font-mono)',
      }}>
        Open: <span style={{ color: 'var(--fg-2)' }}>
          {open.side.toUpperCase()} {open.context.symbol} @ {formatPrice(open.entryPrice, open.context.symbol)}
        </span>
        {open.context.aiStateCode && (
          <>
            {' · '}
            <span style={{ color: 'var(--fg-3)' }}>
              entry context: {open.context.aiStateCode}
              {open.context.phase ? ` ${open.context.phase}` : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function SectionShell({
  title, subtitle, accent, children,
}: {
  title:     string;
  subtitle?: string;
  accent?:   string;
  children:  React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderLeft: accent ? `2px solid ${accent}` : undefined,
      borderRadius: 'var(--r-md)',
      padding: '12px 14px',
      marginBottom: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 8, marginBottom: 8,
      }}>
        <span style={{
          fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-4)',
          fontFamily: 'var(--font-mono)', fontWeight: 600,
        }}>
          {title}
        </span>
        {subtitle && (
          <span style={{
            fontSize: 8, letterSpacing: '0.08em', color: 'var(--fg-4)',
            fontFamily: 'var(--font-mono)',
          }}>
            {subtitle}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Main panel
// ─────────────────────────────────────────────────────────────────

function TradePanelImpl({
  symbol, timeframe, currentPrice,
  aiState, posture, latestPattern, tradePlan, regime, netVariance,
  goldTrend = 'unknown',
}: Props) {
  const [acct, setAcct]                 = useState<DemoAccount>(() => loadDemoAccount());
  const [side, setSide]                 = useState<Side>('long');
  const [size, setSize]                 = useState<number>(DEFAULT_NOTIONAL);
  const [entryType, setEntryType]       = useState<EntryType>('market');
  const [limitPrice, setLimitPrice]     = useState<string>('');
  const [stopLoss, setStopLoss]         = useState<string>('');
  const [takeProfit, setTakeProfit]     = useState<string>('');
  const [, setTick]                     = useState(0);
  // v13.0: AI state history for State Flow ribbon + Historical Analog.
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
    () => records
      .filter(r => r.symbol === symbol)
      .sort((a, b) => b.timestamp - a.timestamp),
    [records, symbol],
  );

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DEMO_LS_KEY) return;
      setAcct(loadDemoAccount());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 1 Hz tick so the active card's PnL + duration update in place.
  useEffect(() => {
    if (!acct.open) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [acct.open]);

  // SL / TP auto-close on every price tick.
  useEffect(() => {
    if (!acct.open || currentPrice == null) return;
    if (acct.open.context.symbol !== symbol) return; // cross-symbol — leave alone
    const trigger = evaluateAutoClose(acct.open, currentPrice);
    if (!trigger) return;
    const next = closePosition(acct, trigger.price);
    setAcct(next);
    saveDemoAccount(next);
  }, [acct, currentPrice, symbol]);

  const ctx = useMemo(
    () => buildContext(symbol, timeframe, aiState, posture, latestPattern, tradePlan, regime, netVariance),
    [symbol, timeframe, aiState, posture, latestPattern, tradePlan, regime, netVariance],
  );

  const alignmentForSide   = useMemo(() => deriveTradeAlignment(side, aiState), [side, aiState]);
  const alignmentForActive = useMemo(
    () => acct.open ? deriveTradeAlignment(acct.open.side, aiState) : 'unknown' as Alignment,
    [acct.open, aiState],
  );

  const handleOpen = () => {
    if (acct.open) return;
    if (currentPrice == null) return;

    // Resolve entry price.
    let entryPx = currentPrice;
    if (entryType === 'limit') {
      const v = parseFloat(limitPrice);
      if (!Number.isFinite(v) || v <= 0) return;
      entryPx = v;
    }
    const sl = parseFloat(stopLoss);
    const tp = parseFloat(takeProfit);

    // Caution confirmation when alignment is contradiction OR the
    // existing classifyAlignment(...) flags an "against" trade.
    const localAlignment = classifyAlignment(side, ctx);
    const isContradiction = alignmentForSide === 'contradiction' || localAlignment === 'against';
    if (isContradiction) {
      const ok = window.confirm(
        `This trade contradicts the current Guru read. Open ${side.toUpperCase()} anyway?`,
      );
      if (!ok) return;
    }

    const next = openPosition(acct, {
      side, size, price: entryPx, context: ctx,
      stopLoss:   Number.isFinite(sl) && sl > 0 ? sl : undefined,
      takeProfit: Number.isFinite(tp) && tp > 0 ? tp : undefined,
    });
    setAcct(next);
    saveDemoAccount(next);
    // Clear risk inputs after open so they don't bleed into the next setup.
    setStopLoss('');
    setTakeProfit('');
  };

  const handleClose = () => {
    if (!acct.open || currentPrice == null) return;
    if (acct.open.context.symbol !== symbol) return;
    const next = closePosition(acct, currentPrice);
    setAcct(next);
    saveDemoAccount(next);
  };

  const handleReset = () => {
    const ok = window.confirm('Reset account to $10,000 and clear all trade history?');
    if (!ok) return;
    setAcct(resetDemoAccount());
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
      fontFamily: 'var(--font-mono)',
      background: 'var(--bg-0)',
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 14px',
        borderBottom: '1px solid var(--line-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-3)',
        }}>
          TRADE · {symbol}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 9, color: 'var(--fg-4)' }}>
            Balance{' '}
            <span style={{ color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtMoney(acct.balance)}
            </span>
          </span>
          <button
            onClick={handleReset}
            title="Reset account"
            style={{
              background: 'transparent', border: '1px solid var(--line-2)',
              color: 'var(--fg-3)', fontSize: 8, letterSpacing: '0.12em',
              padding: '2px 6px', borderRadius: 2, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >RESET</button>
        </div>
      </div>

      {/* v13.0: vertical execution intelligence stack, then a 2-col
          action+monitor block, then history. The wrapper class is
          read by the mobile SettingsScreen wrapper to collapse the
          two-column row into a single column on phones. */}
      <div className="trade-intelligence" style={{
        flex: 1, overflow: 'auto', padding: 14,
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <style>{`
          @media (max-width: 720px) {
            .trade-intelligence .ti-hero-row,
            .trade-intelligence .ti-meso-row,
            .trade-intelligence .ti-action-row {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>

        {/* Hero row: Thesis (60%) + Pressure gauge (40%). */}
        <div className="ti-hero-row" style={{
          display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 12,
        }}>
          <ThesisHero
            aiState={aiState}
            regime={regime}
            netVariance={netVariance}
            goldTrend={goldTrend}
          />
          <PressureGauge aiState={aiState} />
        </div>

        {/* Meso row: Environment Risk · State Flow · Historical Analog. */}
        <div className="ti-meso-row" style={{
          display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr', gap: 12,
        }}>
          <EnvironmentRiskCard aiState={aiState} />
          <StateFlowRibbon records={symbolRecords} currentState={aiState} />
          <HistoricalAnalogCard records={records} symbol={symbol} aiState={aiState} />
        </div>

        {/* Action + Monitor row. Pre-v13 these were stacked inside a
            three-column grid alongside a Guru context column; that
            column has been folded into ThesisHero / PressureGauge /
            EnvironmentRiskCard above. */}
        <div className="ti-action-row" style={{
          display: 'grid', gridTemplateColumns: '300px 1fr', gap: 12,
        }}>
          <div>
            <EntryPanel
              symbol={symbol}
              currentPrice={currentPrice}
              side={side}              setSide={setSide}
              size={size}              setSize={setSize}
              entryType={entryType}    setEntryType={setEntryType}
              limitPrice={limitPrice}  setLimitPrice={setLimitPrice}
              stopLoss={stopLoss}      setStopLoss={setStopLoss}
              takeProfit={takeProfit}  setTakeProfit={setTakeProfit}
              onOpen={handleOpen}
              hasOpen={!!acct.open}
              alignment={alignmentForSide}
            />
            {currentPrice == null && (
              <div style={{
                fontSize: 9, color: 'var(--fg-4)', marginTop: 6,
              }}>
                Waiting for live price…
              </div>
            )}
          </div>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <PositionMonitorBlock acct={acct} aiState={aiState} />
            <ActivePositionCard
              acct={acct}
              symbol={symbol}
              currentPrice={currentPrice}
              alignment={alignmentForActive}
              onClose={handleClose}
            />
          </div>
        </div>

        {/* History table — full width at the bottom. */}
        <HistoryTable acct={acct} symbol={symbol} />
      </div>
    </div>
  );
}

export default memo(TradePanelImpl);
