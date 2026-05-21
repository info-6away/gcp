'use client';

// v11.33: TRADE module — Guru-aware execution layer.
// v18.0:  TRADE became the execution terminal. Heavy Guru / coherence
//         intelligence cards moved to GuruView; Trade keeps only the
//         compact <AiReadStrip>, the conflict-only EnvVsThesisBanner,
//         the entry panel, the position monitor, the active-position
//         card and the trade history table.
// v18.1:  Dead inline definitions of the moved cards removed (this
//         commit). The Trade page is back to a tight execution-only
//         surface — the operator sees the read at a glance, then acts.
//
//   ┌───────────────────────────────────────────────────────────────┐
//   │ Header  TRADE · SYMBOL · balance · reset · MODE                │
//   ├───────────────────────────────────────────────────────────────┤
//   │ AI READ strip  (compact one-liner from intelligence/)          │
//   │ EnvVsThesisBanner (only when env-vs-thesis CONFLICT)           │
//   ├───────────────────────────────────────────────────────────────┤
//   │ EntryPanel              │  PositionMonitor + ActivePosition    │
//   ├───────────────────────────────────────────────────────────────┤
//   │ Trade history (ANALYST / RESEARCH modes)                       │
//   └───────────────────────────────────────────────────────────────┘
//
// Reuses lib/demoAccount.ts for persistence + PnL math, lib/guruStance
// for the stance block (still used inside EntryPanel), lib/guruAlignment
// for the alignment chip, lib/stateTransition for the NEXT overlay, and
// lib/executionIntelligence for thesis-integrity on the position
// monitor. No new Engine calls. No chart.

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
// v18.1: the v13.x execution-intelligence cards (ThesisHero,
// PressureGauge, MarketContextCard, EnvironmentRiskCard, StateFlow,
// HistoricalAnalog, ActionStateBanner, EnvVsThesisBanner,
// DirectionalEdge, ThesisStability, HeroMeterStrip, RawMetricsCard)
// all moved to components/gcp/intelligence/IntelligenceCards.tsx.
// The imports below are only what Trade itself still references after
// that cleanup — Guru carries the rest.
import { stateColor, DEFAULT_INTERPRETATION, directionArrow } from '@/lib/aiState';
import { deriveStance } from '@/lib/guruStance';
import { ladderColor, ladderLabel, type LadderState } from '@/lib/stateTransition';
import { deriveThesisIntegrity } from '@/lib/executionIntelligence';
import { useViewMode, type ViewMode } from '@/lib/viewMode';
import { deriveActionState } from '@/lib/actionState';
import { getRadarResult, clearRadarResult } from '@/lib/radarResultStore';
import {
  derivePriceStructureConfirmation,
  type PriceStructureRead,
} from '@/lib/priceStructureConfirmation';
import { tdTimeSeries, type Candle } from '@/lib/fetchCandles';
import { AI_ANALYSIS_TF } from '@/lib/aiTimeframe';
import type { AiStatus } from '@/lib/useGcpState';
import {
  AI_HISTORY_LS_KEY, loadAiStateHistory,
  type AiStateHistoryRecord,
} from '@/lib/aiStateHistory';
// v18.0: Trade no longer carries the heavy Guru intelligence cards;
// those moved to GuruView. Trade keeps a compact AI READ strip so the
// operator stays aware of the AI context without parsing a full
// narrative thesis. EnvVsThesisBanner stays inline below — it only
// renders on conflict and is execution-critical for open positions.
import {
  AiReadStrip, EnvVsThesisBanner,
} from '@/components/gcp/intelligence/IntelligenceCards';

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
  // v13.7: Ask Guru button props — threaded through from useGcpState.
  // Optional so legacy call sites that haven't been updated still
  // type-check. When absent the button hides itself.
  aiRunNow?:      (options?: { force?: boolean; source?: string }) => void;
  aiStatus?:      AiStatus;
  aiLastSuccess?: Date | null;
  aiEnabled?:     boolean;
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
// v18.1: every v13.x EXECUTION INTELLIGENCE card that used to live
// here moved to components/gcp/intelligence/IntelligenceCards.tsx
// in v18.0 (ThesisHero → EnvironmentThesisCard, PressureGauge →
// DirectionalPressureCard, MarketContextCard, EnvironmentRiskCard,
// StateFlowRibbon, HistoricalAnalogCard, ActionStateBanner,
// EnvVsThesisBanner, DirectionalEdgeCard, ThesisStabilityCard,
// HeroMeterStrip, RawMetricsCard, radarScanAge helper).
// Trade now imports only what it renders.
// ═════════════════════════════════════════════════════════════════

// ── POSITION MONITOR — thesis integrity for open positions ───────

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

// ── VIEW-MODE TOGGLE — SIMPLE / ANALYST / RESEARCH ───────────────
// Progressive disclosure rails kept around so the Trade header still
// glances in 3 s. v18.2 will repurpose these as EXECUTE / PLAN /
// JOURNAL; v18.1 keeps the existing labels to scope this commit to
// dead-code cleanup only.

function ViewModeToggle({ mode, onChange }: {
  mode:     ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const modes: ViewMode[] = ['SIMPLE', 'ANALYST', 'RESEARCH'];
  return (
    <div style={{
      display: 'inline-flex', gap: 2,
      padding: 2,
      background: 'var(--bg-2)',
      border: '1px solid var(--line-1)',
      borderRadius: 3,
    }}>
      {modes.map(m => (
        <button key={m}
          onClick={() => onChange(m)}
          style={{
            padding: '4px 12px',
            fontSize: 9, letterSpacing: '0.14em', fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            background: mode === m ? 'var(--bg-3)' : 'transparent',
            border: '1px solid ' + (mode === m ? 'var(--line-2)' : 'transparent'),
            color:  mode === m ? 'var(--fg-0)' : 'var(--fg-3)',
            borderRadius: 2,
            cursor: 'pointer',
            transition: 'color 0.15s ease, background 0.15s ease',
          }}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// ── ASK GURU button ──────────────────────────────────────────────

function AskGuruButton({
  aiStatus, aiEnabled, aiLastSuccess, onClick,
}: {
  aiStatus:      AiStatus;
  aiEnabled:     boolean;
  aiLastSuccess: Date | null;
  onClick:       () => void;
}) {
  const isRunning = aiStatus === 'running';
  const label =
    isRunning             ? 'ASKING…'
  : aiStatus === 'error'  ? 'TRY AGAIN'
  : aiLastSuccess         ? 'ASK GURU AGAIN'
  :                          'ASK GURU';
  const accent =
    aiStatus === 'error'  ? 'var(--red)'
  :                          'var(--cyan)';
  const disabled = !aiEnabled || isRunning;
  const sinceMs = aiLastSuccess ? Date.now() - aiLastSuccess.getTime() : null;
  const ageLabel = sinceMs == null ? null
    : sinceMs < 60_000   ? `${Math.round(sinceMs / 1000)}s ago`
    : sinceMs < 3_600_000 ? `${Math.floor(sinceMs / 60_000)}m ago`
    :                      `${Math.floor(sinceMs / 3_600_000)}h ago`;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {ageLabel && (
        <span style={{
          fontSize: 8, color: 'var(--fg-4)', letterSpacing: '0.12em',
          fontFamily: 'var(--font-mono)',
        }}>
          last update <span style={{ color: 'var(--fg-2)' }}>{ageLabel}</span>
        </span>
      )}
      <button
        onClick={onClick}
        aria-disabled={disabled || undefined}
        title={!aiEnabled ? 'Guru is disabled in Settings' : undefined}
        style={{
          padding: '6px 12px',
          fontSize: 10, letterSpacing: '0.14em', fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          background: isRunning ? `${accent}1f` : 'transparent',
          border: `1px solid ${disabled ? 'var(--line-2)' : accent}`,
          color: disabled ? 'var(--fg-3)' : accent,
          borderRadius: 3,
          cursor: disabled ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          transition: 'background 0.15s, border-color 0.15s, color 0.15s',
        }}
      >
        {label}
      </button>
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
  aiState: aiStateLive, posture, latestPattern, tradePlan, regime, netVariance,
  goldTrend = 'unknown',
  aiRunNow, aiStatus = 'idle', aiLastSuccess = null, aiEnabled = true,
}: Props) {
  // v14.0.1: Radar → Trade hydration. When there's no LIVE read for
  // this symbol but Radar scanned it earlier this session, hydrate
  // the whole Trade surface from the cached scan result. The user
  // continues analysis from the discovery instead of re-classifying
  // from zero. A live classification (Ask Guru) always supersedes —
  // `aiStateLive ?? …` precedence guarantees that, and the stale
  // cache entry is dropped once a live read lands.
  const radarResult = useMemo(
    () => (aiStateLive ? undefined : getRadarResult(symbol)),
    [aiStateLive, symbol],
  );
  const hydratedFromRadar = !aiStateLive && !!radarResult?.aiState;
  const aiState: GcpStateResponse | null =
    aiStateLive ?? radarResult?.aiState ?? null;
  useEffect(() => {
    if (aiStateLive) clearRadarResult(symbol);
  }, [aiStateLive, symbol]);

  const [acct, setAcct]                 = useState<DemoAccount>(() => loadDemoAccount());
  const [side, setSide]                 = useState<Side>('long');
  const [size, setSize]                 = useState<number>(DEFAULT_NOTIONAL);
  const [entryType, setEntryType]       = useState<EntryType>('market');
  const [limitPrice, setLimitPrice]     = useState<string>('');
  const [stopLoss, setStopLoss]         = useState<string>('');
  const [takeProfit, setTakeProfit]     = useState<string>('');
  const [, setTick]                     = useState(0);
  // v13.6: view mode (SIMPLE / ANALYST / RESEARCH) with localStorage
  // persistence + cross-tab sync. Default is ANALYST so existing
  // users see the same density they did pre-v13.6; SIMPLE strips the
  // meso row + market context for a calmer decision surface; RESEARCH
  // adds a raw-metrics card.
  const [viewMode, setViewMode] = useViewMode();
  const showAnalyst  = viewMode === 'ANALYST'  || viewMode === 'RESEARCH';
  const showResearch = viewMode === 'RESEARCH';
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

  // v13.9.1: slim candle window for the price-structure confirmation
  // layer. The Trade page doesn't otherwise consume candles (the
  // ChartView owns its own fetch loop), but the ACTION STATE banner
  // needs a recent OHLC window to decide whether price structure
  // confirms the engine's direction. Fetch 60 bars at the analysis
  // timeframe; refresh when the analysis cycle reports a new success
  // (every aiLastSuccess change) so this rides the same cadence as
  // the engine reads. Errors degrade silently — priceStructure stays
  // null and the GO gate treats absence as a soft pass.
  const [priceStructure, setPriceStructure] = useState<PriceStructureRead | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const candles: Candle[] = await tdTimeSeries({
          symbol,
          tf:         AI_ANALYSIS_TF,
          outputsize: 60,
          signal:     controller.signal,
        });
        if (cancelled) return;
        setPriceStructure(derivePriceStructureConfirmation(candles));
      } catch {
        if (!cancelled) setPriceStructure(null);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
    // aiLastSuccess in dep array makes a fresh classification re-pull
    // candles so the structure read tracks the same time window the
    // user just acted on. Mounting / symbol change also re-fetches.
  }, [symbol, aiLastSuccess]);

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
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span>TRADE · {symbol}</span>
          {/* v13.6: view-mode toggle. v13.7: SIMPLE is now the default
              for new users; ANALYST / RESEARCH stay one click away. */}
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {/* v13.7: ASK GURU button — Trade is now the primary Guru
              execution surface. Hidden when aiRunNow isn't wired
              through (legacy call sites). */}
          {aiRunNow && (
            <AskGuruButton
              aiStatus={aiStatus}
              aiEnabled={aiEnabled}
              aiLastSuccess={aiLastSuccess}
              onClick={() => aiRunNow({ force: true, source: 'trade_guru_button' })}
            />
          )}
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

        {/* v18.0: AI READ strip — compact one-line summary for the
            execution surface. The full Environment Thesis, Pressure
            gauge, Market Context, Action State banner, Directional
            Edge, Thesis Stability, State Flow and Historical Analog
            have all moved to GuruView; Trade now stays focused on
            execution. EnvVsThesisBanner below remains because it
            only renders during an env-vs-thesis CONFLICT on an open
            position — a critical execution alert, not a narrative. */}
        <AiReadStrip
          aiState={aiState}
          hasOpenPosition={!!acct.open}
          history={symbolRecords}
          priceStructure={priceStructure}
        />
        <EnvVsThesisBanner
          aiState={aiState}
          hasOpenPosition={!!acct.open}
          history={symbolRecords}
          priceStructure={priceStructure}
        />

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

        {/* v13.6: history table sits under Analyst / Research. SIMPLE
            keeps the surface focused on the live decision — past
            trades drop into deeper modes. */}
        {showAnalyst && <HistoryTable acct={acct} symbol={symbol} />}
      </div>
    </div>
  );
}

export default memo(TradePanelImpl);
