'use client';

// v11.33: TRADE module — Guru-aware execution layer.
//
// Three-column layout:
//
//   LEFT   ── Entry Panel
//             LONG / SHORT toggle, position size, entry type,
//             stop-loss / take-profit, OPEN TRADE primary CTA.
//
//   CENTER ── Active Position
//             Live PnL, entry, current, size, duration, GURU
//             ALIGNMENT chip (full / partial / contradiction).
//             Trade history table sits below.
//
//   RIGHT  ── Guru Context
//             STATE / STANCE / NEXT / CONFIDENCE — always visible
//             so the user is executing inside a living environment.
//
// Reuses lib/demoAccount.ts for persistence + PnL math, lib/guruStance
// for the stance block, lib/guruAlignment for the alignment chip,
// lib/stateTransition for the NEXT overlay. No new Engine calls.

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
    <SectionShell title="ENTRY">
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
      <FieldLabel>Size</FieldLabel>
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
      <SectionShell title="ACTIVE POSITION">
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
      title="ACTIVE POSITION"
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
          <FieldLabel>PnL</FieldLabel>
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
        <Cell label="SIZE"     value={fmtMoney(open.size)} />
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
    <SectionShell title={`HISTORY (${acct.trades.length})`}>
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
}: Props) {
  const [acct, setAcct]                 = useState<DemoAccount>(() => loadDemoAccount());
  const [side, setSide]                 = useState<Side>('long');
  const [size, setSize]                 = useState<number>(DEFAULT_NOTIONAL);
  const [entryType, setEntryType]       = useState<EntryType>('market');
  const [limitPrice, setLimitPrice]     = useState<string>('');
  const [stopLoss, setStopLoss]         = useState<string>('');
  const [takeProfit, setTakeProfit]     = useState<string>('');
  const [, setTick]                     = useState(0);

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
    const ok = window.confirm('Reset demo account to $10,000 and clear all paper-trade history?');
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
          TRADE · PAPER · {symbol}
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
            title="Reset demo account"
            style={{
              background: 'transparent', border: '1px solid var(--line-2)',
              color: 'var(--fg-3)', fontSize: 8, letterSpacing: '0.12em',
              padding: '2px 6px', borderRadius: 2, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >RESET</button>
        </div>
      </div>

      {/* Three columns */}
      <div style={{
        flex: 1, overflow: 'auto',
        display: 'grid',
        gridTemplateColumns: '260px 1fr 280px',
        gap: 12,
        padding: 12,
      }}>
        {/* LEFT — Entry Panel */}
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

        {/* CENTER — Active position + history */}
        <div style={{ minWidth: 0 }}>
          <ActivePositionCard
            acct={acct}
            symbol={symbol}
            currentPrice={currentPrice}
            alignment={alignmentForActive}
            onClose={handleClose}
          />
          <HistoryTable acct={acct} symbol={symbol} />
        </div>

        {/* RIGHT — Guru context */}
        <div>
          <GuruContextColumn aiState={aiState} posture={posture} />
        </div>
      </div>
    </div>
  );
}

export default memo(TradePanelImpl);
