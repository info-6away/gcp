'use client';

// v11.27: Guru tab — dedicated AI analysis surface.
//
// Hosts the full AI State analysis that previously dominated the
// Dashboard: state name, posture, ANALYSIS AT, trade plan, plan
// status, mode/action/trigger/size, refresh button. All of that
// already lives inside <AiStateCard>; this component just provides
// the page chrome around it plus a "Guru History" list pulled from
// the local aiStateHistory ledger.

import { useEffect, useState } from 'react';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import type { Pattern, MarketSymbol } from '@/types/gcp';
import type { StructureRead } from '@/lib/priceStructure';
import type { Candle } from '@/lib/fetchCandles';
import {
  AI_HISTORY_LS_KEY, loadAiStateHistory,
  type AiStateHistoryRecord,
} from '@/lib/aiStateHistory';
import { stateColor } from '@/lib/aiState';
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
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatPriceLabel(symbol: MarketSymbol, price: number | null): string {
  if (price == null || !Number.isFinite(price) || price <= 0) return '—';
  if (symbol === 'BTC')    return Math.round(price).toLocaleString();
  if (symbol === 'XAGUSD') return price.toFixed(3);
  return price.toFixed(2);
}

function GuruHistory({ symbol }: { symbol: MarketSymbol }) {
  const [records, setRecords] = useState<AiStateHistoryRecord[]>([]);
  useEffect(() => {
    setRecords(loadAiStateHistory());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AI_HISTORY_LS_KEY) setRecords(loadAiStateHistory());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Filter to current symbol; show newest first, cap at 25.
  const list = records
    .filter(r => r.symbol === symbol)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 25);

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--r-md)',
      padding: '14px 16px',
    }}>
      <div className="hairline" style={{ marginBottom: 10 }}>
        Guru history · {symbol} ({list.length})
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--fg-3)', padding: '8px 0' }}>
          No prior Guru analyses for {symbol} yet. Click "Ask Guru" above to capture one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map(r => {
            const accent = stateColor({
              stateCode: r.stateCode,
              direction: r.direction,
            } as GcpStateResponse);
            const conf = Math.round(r.confidence * 100);
            return (
              <div key={r.id} style={{
                padding: '7px 10px',
                background: 'var(--bg-2)',
                border: '1px solid var(--line-1)',
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
                </div>
                <div>
                  <div style={{
                    color: accent, fontWeight: 600, letterSpacing: '0.04em',
                  }}>
                    {r.stateCode} · {r.state}
                  </div>
                  <div style={{
                    color: 'var(--fg-3)', marginTop: 2,
                  }}>
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
                    @ {formatPriceLabel(symbol, r.priceAtAnalysis)}
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

export default function GuruView(props: GuruViewProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
    }}>
      <PageHeader crumbs={[{ label: 'Guru' }]} />

      <div style={{
        flex: 1, overflow: 'auto',
        padding: 18,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {/* Full AI State analysis card. Already includes posture,
            trade plan, plan status, refresh button, etc. */}
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

        {/* Guru history ledger (local). */}
        <GuruHistory symbol={props.symbol} />
      </div>
    </div>
  );
}
