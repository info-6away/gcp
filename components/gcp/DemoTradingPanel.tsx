'use client';

// v11.24: paper-trading panel for the TRD page.
//
// Pure UI on top of lib/demoAccount.ts. No broker, no real orders. Reads
// the live price (passed in from TradingView's parent), opens long /
// short positions at fixed notional, snapshots the AI / Pattern / Plan
// context at entry, and writes everything to localStorage so a refresh
// preserves state.
//
// Layout (right column on the TRD page):
//   - Account block:    balance / equity / open PnL / realized PnL
//   - Position block:   side / size / entry / current / live PnL
//   - Action block:     BUY / SELL / CLOSE + size selector
//   - Context block:    AI state + posture + plan headline (entry
//                       snapshot once a position is open)
//   - History table:    last 50 trades with alignment column

import { memo, useEffect, useMemo, useState } from 'react';
import type { MarketSymbol, Pattern, Timeframe } from '@/types/gcp';
import { formatPrice } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { Posture } from '@/lib/aiAction';
import type { TradePlan } from '@/lib/tradePlan';
import {
  loadDemoAccount, saveDemoAccount, resetDemoAccount,
  openPosition, closePosition,
  computePnl, computeEquity,
  classifyAlignment, isCautionPosture,
  alignmentLabel, alignmentColor,
  computePerformanceSummary, MIN_TRADES_FOR_SUMMARY,
  STARTING_BALANCE, DEFAULT_NOTIONAL, QUICK_SIZES, DEMO_LS_KEY,
  type DemoAccount, type Side, type TradeContext,
  type Alignment, type BucketStats,
} from '@/lib/demoAccount';

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
    symbol,
    timeframe,
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

function PanelImpl({
  symbol, timeframe, currentPrice,
  aiState, posture, latestPattern, tradePlan,
  regime, netVariance,
}: Props) {
  const [acct, setAcct]     = useState<DemoAccount>(() => loadDemoAccount());
  const [size, setSize]     = useState<number>(DEFAULT_NOTIONAL);
  const [, setTick]         = useState(0);

  // Cross-tab sync: another tab placing a trade should refresh this view.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DEMO_LS_KEY) return;
      setAcct(loadDemoAccount());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Repaint the open-PnL line every second so the user can watch it
  // tick without depending on parent re-renders. Cheap — only re-runs
  // a derived calc, no fetch.
  useEffect(() => {
    if (!acct.open) return;
    const id = setInterval(() => setTick(t => t + 1), 1_000);
    return () => clearInterval(id);
  }, [acct.open]);

  const open       = acct.open;
  const openPnl    = open && currentPrice != null
    ? computePnl(open.side, open.entryPrice, currentPrice, open.size)
    : 0;
  const equity     = computeEquity(acct, currentPrice);

  const ctx = useMemo(
    () => buildContext(symbol, timeframe, aiState, posture, latestPattern, tradePlan, regime, netVariance),
    [symbol, timeframe, aiState, posture, latestPattern, tradePlan, regime, netVariance],
  );

  const handleTrade = (side: Side) => {
    if (currentPrice == null) return;
    if (open) return; // close first
    if (isCautionPosture(ctx)) {
      const ok = window.confirm('Current AI posture is caution/avoid. Place demo trade anyway?');
      if (!ok) return;
    }
    const next = openPosition(acct, { side, size, price: currentPrice, context: ctx });
    setAcct(next);
    saveDemoAccount(next);
  };

  const handleClose = () => {
    if (!open || currentPrice == null) return;
    const next = closePosition(acct, currentPrice);
    setAcct(next);
    saveDemoAccount(next);
  };

  const handleReset = () => {
    const ok = window.confirm('Reset demo account to $10,000 and clear all paper-trade history?');
    if (!ok) return;
    setAcct(resetDemoAccount());
  };

  const liveAlignment = useMemo(
    () => (open ? classifyAlignment(open.side, open.context) : null),
    [open],
  );

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      borderLeft: '1px solid var(--line-1)',
      background: 'var(--bg-1)',
      fontFamily: 'var(--font-mono)',
    }}>
      <div style={{
        padding: '8px 14px',
        borderBottom: '1px solid var(--line-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 9, letterSpacing: '0.18em', color: 'var(--fg-3)' }}>
          DEMO ACCOUNT · PAPER TRADING
        </div>
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

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* ── Account ── */}
        <Section title="ACCOUNT">
          <Row label="Balance" value={fmtMoney(acct.balance)} />
          <Row
            label="Equity"
            value={fmtMoney(equity)}
            valueColor={equity >= STARTING_BALANCE ? 'var(--green)' : 'var(--red)'}
          />
          <Row
            label="Open PnL"
            value={open ? fmtMoney(openPnl, true) : '—'}
            valueColor={openPnl > 0 ? 'var(--green)' : openPnl < 0 ? 'var(--red)' : 'var(--fg-3)'}
          />
          <Row
            label="Realized PnL"
            value={fmtMoney(acct.realizedPnl, true)}
            valueColor={acct.realizedPnl > 0 ? 'var(--green)' : acct.realizedPnl < 0 ? 'var(--red)' : 'var(--fg-3)'}
          />
        </Section>

        {/* ── Position ── */}
        <Section title="POSITION">
          {open ? (
            <>
              <Row
                label="Side"
                value={open.side === 'long' ? 'LONG' : 'SHORT'}
                valueColor={open.side === 'long' ? 'var(--green)' : 'var(--red)'}
              />
              <Row label="Symbol" value={open.context.symbol} />
              <Row label="Size"   value={fmtMoney(open.size)} />
              <Row label="Entry"  value={formatPrice(open.entryPrice, open.context.symbol)} />
              <Row
                label="Current"
                value={currentPrice != null ? formatPrice(currentPrice, open.context.symbol) : '—'}
              />
              <Row
                label="PnL"
                value={fmtMoney(openPnl, true)}
                valueColor={openPnl > 0 ? 'var(--green)' : openPnl < 0 ? 'var(--red)' : 'var(--fg-3)'}
              />
              {liveAlignment && (
                <Row
                  label="Alignment"
                  value={alignmentLabel(liveAlignment)}
                  valueColor={alignmentColor(liveAlignment)}
                />
              )}
            </>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--fg-3)', padding: '4px 0' }}>
              Flat — no open position
            </div>
          )}
        </Section>

        {/* ── Actions ── */}
        <Section title="TRADE">
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {QUICK_SIZES.map(n => (
              <button
                key={n}
                onClick={() => setSize(n)}
                disabled={!!open}
                style={{
                  flex: 1,
                  padding: '4px 0',
                  fontSize: 9, letterSpacing: '0.06em',
                  fontFamily: 'inherit',
                  background: size === n ? 'var(--bg-3)' : 'transparent',
                  border: `1px solid ${size === n ? 'var(--line-2)' : 'var(--line-1)'}`,
                  borderRadius: 2,
                  color: open ? 'var(--fg-4)' : size === n ? 'var(--fg-0)' : 'var(--fg-3)',
                  cursor: open ? 'default' : 'pointer',
                }}
              >
                ${n.toLocaleString()}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <ActionButton
              label="BUY"
              tone="green"
              disabled={!!open || currentPrice == null}
              onClick={() => handleTrade('long')}
            />
            <ActionButton
              label="SELL"
              tone="red"
              disabled={!!open || currentPrice == null}
              onClick={() => handleTrade('short')}
            />
            <ActionButton
              label="CLOSE"
              tone="cyan"
              disabled={!open || currentPrice == null}
              onClick={handleClose}
            />
          </div>
          {!open && currentPrice == null && (
            <div style={{ fontSize: 9, color: 'var(--fg-4)', marginTop: 6 }}>
              Waiting for live price…
            </div>
          )}
        </Section>

        {/* ── Context (live or snapshot) ── */}
        <Section title={open ? 'CONTEXT (AT ENTRY)' : 'CONTEXT (LIVE)'}>
          {(() => {
            const c = open ? open.context : ctx;
            return (
              <>
                <Row label="AI State" value={c.aiState ? `${c.aiStateCode} · ${c.aiState}` : '—'} />
                <Row label="Phase / Dir" value={c.phase && c.direction ? `${c.phase} · ${c.direction}` : '—'} />
                <Row
                  label="Confidence"
                  value={c.confidence != null ? `${Math.round(c.confidence * 100)}%` : '—'}
                />
                <Row label="Action" value={c.actionText ?? '—'} />
                <Row label="Mode"   value={c.marketMode ?? '—'} />
                <Row label="Size cue" value={c.sizeGuidance ?? '—'} />
                <Row label="Plan"     value={c.tradePlanHeadline ?? '—'} />
                <Row label="Pattern"  value={c.patternName ? `${c.patternName}${c.pss != null ? ` · PSS ${c.pss}` : ''}` : '—'} />
                <Row label="Regime"   value={c.regime ?? '—'} />
                <Row label="NV"       value={c.netVariance != null ? c.netVariance.toFixed(1) : '—'} />
              </>
            );
          })()}
        </Section>

        {/* ── Performance summary (v11.24.1) ── */}
        <Section title="PERFORMANCE SUMMARY">
          <PerformanceBlock trades={acct.trades} />
        </Section>

        {/* ── History ── */}
        <Section title={`HISTORY (${acct.trades.length})`}>
          {acct.trades.length === 0 ? (
            <div style={{ fontSize: 10, color: 'var(--fg-3)', padding: '4px 0' }}>
              No trades yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {acct.trades.slice(0, 50).map(t => (
                <div key={t.id} style={{
                  padding: '6px 8px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-1)',
                  borderRadius: 3,
                  fontSize: 9, lineHeight: 1.5,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{
                      color: t.side === 'long' ? 'var(--green)' : 'var(--red)',
                      fontWeight: 600, letterSpacing: '0.08em',
                    }}>
                      {t.side === 'long' ? 'LONG' : 'SHORT'} · {t.symbol}
                    </span>
                    <span style={{
                      color: t.pnl > 0 ? 'var(--green)' : t.pnl < 0 ? 'var(--red)' : 'var(--fg-3)',
                      fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                    }}>
                      {fmtMoney(t.pnl, true)}
                    </span>
                  </div>
                  <div style={{ color: 'var(--fg-3)', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                    <span>{fmtTime(t.exitTime)}</span>
                    <span>·</span>
                    <span>{formatPrice(t.entryPrice, t.symbol)} → {formatPrice(t.exitPrice, t.symbol)}</span>
                    <span>·</span>
                    <span>{fmtMoney(t.size)}</span>
                  </div>
                  <div style={{ color: 'var(--fg-4)', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ color: alignmentColor(t.alignment) }}>
                      {alignmentLabel(t.alignment)}
                    </span>
                    {t.context.aiStateCode && (
                      <>
                        <span>·</span>
                        <span>{t.context.aiStateCode}</span>
                      </>
                    )}
                    {t.context.actionText && (
                      <>
                        <span>·</span>
                        <span>{t.context.actionText}</span>
                      </>
                    )}
                    {t.context.patternName && (
                      <>
                        <span>·</span>
                        <span>{t.context.patternName}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-0)' }}>
      <div style={{
        fontSize: 8, letterSpacing: '0.18em',
        color: 'var(--fg-4)', marginBottom: 6,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {children}
      </div>
    </div>
  );
}

function Row({
  label, value, valueColor,
}: {
  label:       string;
  value:       string;
  valueColor?: string;
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 8, fontSize: 10,
    }}>
      <span style={{ color: 'var(--fg-4)' }}>{label}</span>
      <span style={{
        color: valueColor ?? 'var(--fg-1)',
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        wordBreak: 'break-word',
      }}>
        {value}
      </span>
    </div>
  );
}

function pnlColor(n: number): string {
  if (n > 0) return 'var(--green)';
  if (n < 0) return 'var(--red)';
  return 'var(--fg-3)';
}

function PerformanceBlock({ trades }: { trades: DemoAccount['trades'] }) {
  const summary = useMemo(() => computePerformanceSummary(trades), [trades]);

  // Spec guardrail: < 5 trades, win rates are noise. Render placeholder
  // until the user has accumulated enough closed trades.
  if (summary.total.count < MIN_TRADES_FOR_SUMMARY) {
    return (
      <div style={{ fontSize: 10, color: 'var(--fg-3)', padding: '4px 0', lineHeight: 1.5 }}>
        Not enough data yet — need at least {MIN_TRADES_FOR_SUMMARY} closed trades
        ({summary.total.count}/{MIN_TRADES_FOR_SUMMARY}).
      </div>
    );
  }

  const t = summary.total;
  const buckets: { key: Alignment; label: string }[] = [
    { key: 'followed', label: 'Followed AI'        },
    { key: 'against',  label: 'Against AI'         },
    { key: 'neutral',  label: 'Neutral / unclear'  },
    { key: 'unknown',  label: 'No AI context'      },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Headline overall stats */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Row label="Total Trades" value={`${t.count}`} />
        <Row label="Wins / Losses" value={`${t.wins}W · ${t.losses}L`} />
        <Row
          label="Win Rate"
          value={`${Math.round(t.winRate * 100)}%`}
          valueColor={t.winRate >= 0.5 ? 'var(--green)' : t.winRate > 0 ? 'var(--fg-3)' : 'var(--red)'}
        />
        <Row
          label="Total PnL"
          value={fmtMoney(t.totalPnl, true)}
          valueColor={pnlColor(t.totalPnl)}
        />
      </div>

      {/* Per-alignment breakdown */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {buckets.map(b => (
          <BucketRow key={b.key} label={b.label} alignment={b.key} stats={summary.byAlignment[b.key]} />
        ))}
      </div>
    </div>
  );
}

function BucketRow({
  label, alignment, stats,
}: {
  label:     string;
  alignment: Alignment;
  stats:     BucketStats;
}) {
  const accent = alignmentColor(alignment);
  if (stats.count === 0) {
    return (
      <div style={{
        padding: '6px 8px',
        background: 'var(--bg-2)',
        border: '1px solid var(--line-1)',
        borderRadius: 3,
        fontSize: 9, lineHeight: 1.5,
        opacity: 0.5,
      }}>
        <div style={{ color: accent, fontWeight: 600, letterSpacing: '0.06em' }}>
          {label}
        </div>
        <div style={{ color: 'var(--fg-4)', marginTop: 2 }}>
          0 trades
        </div>
      </div>
    );
  }
  return (
    <div style={{
      padding: '6px 8px',
      background: 'var(--bg-2)',
      border: `1px solid ${accent}33`,
      borderLeft: `2px solid ${accent}`,
      borderRadius: 3,
      fontSize: 9, lineHeight: 1.55,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      }}>
        <span style={{ color: accent, fontWeight: 600, letterSpacing: '0.06em' }}>
          {label}
        </span>
        <span style={{
          color: pnlColor(stats.totalPnl),
          fontVariantNumeric: 'tabular-nums', fontWeight: 600,
        }}>
          {fmtMoney(stats.totalPnl, true)}
        </span>
      </div>
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap',
        color: 'var(--fg-3)', marginTop: 2,
        fontVariantNumeric: 'tabular-nums',
      }}>
        <span>{stats.count} trade{stats.count === 1 ? '' : 's'}</span>
        <span>·</span>
        <span style={{
          color: stats.winRate >= 0.5 ? 'var(--green)' : stats.winRate > 0 ? 'var(--fg-3)' : 'var(--red)',
        }}>
          {Math.round(stats.winRate * 100)}% win
        </span>
        <span>·</span>
        <span style={{ color: pnlColor(stats.avgPnl) }}>
          avg {fmtMoney(stats.avgPnl, true)}
        </span>
      </div>
    </div>
  );
}

function ActionButton({
  label, tone, disabled, onClick,
}: {
  label:    string;
  tone:     'green' | 'red' | 'cyan';
  disabled: boolean;
  onClick:  () => void;
}) {
  const accent = tone === 'green' ? 'var(--green)'
              : tone === 'red'   ? 'var(--red)'
              :                    'var(--cyan)';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: '8px 0',
        fontSize: 11, letterSpacing: '0.14em', fontWeight: 700,
        fontFamily: 'inherit',
        background: disabled ? 'transparent' : `${accent}1a`,
        border: `1px solid ${disabled ? 'var(--line-2)' : accent}`,
        color: disabled ? 'var(--fg-4)' : accent,
        borderRadius: 3,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}

export default memo(PanelImpl);
