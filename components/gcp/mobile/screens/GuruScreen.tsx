'use client';

// v11.27: mobile Guru tab. Same goal as desktop GuruView — surface
// the full AI analysis as its own page rather than packing it into
// the Dashboard. Reuses the desktop <AiStateCard> for the analysis
// block and the same aiStateHistory ledger for the history list.

import { useEffect, useState } from 'react';
import type { Pattern, MarketSymbol } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import type { StructureRead } from '@/lib/priceStructure';
import type { Candle } from '@/lib/fetchCandles';
import { stateColor } from '@/lib/aiState';
import {
  AI_HISTORY_LS_KEY, loadAiStateHistory,
  type AiStateHistoryRecord,
} from '@/lib/aiStateHistory';
import { MobileStatus } from '../MobileChrome';
import { C } from '../colors';
import AiStateCard from '../../AiStateCard';

interface GuruScreenProps {
  symbol:             MarketSymbol;
  price:              number | null;
  liveNV:             number | null;
  liveRegime:         string | null;
  connected:          boolean;
  aiState:            GcpStateResponse | null;
  aiEnabled:          boolean;
  aiStatus:           AiStatus;
  aiRunNow?:          () => void;
  aiLastSuccess?:     Date | null;
  latestPattern:      Pattern | null;
  planStructure?:     StructureRead;
  planAnalysisCandle?: Candle | null;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function GuruHistoryMobile({ symbol }: { symbol: MarketSymbol }) {
  const [records, setRecords] = useState<AiStateHistoryRecord[]>([]);
  useEffect(() => {
    setRecords(loadAiStateHistory());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AI_HISTORY_LS_KEY) setRecords(loadAiStateHistory());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const list = records
    .filter(r => r.symbol === symbol)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 25);

  return (
    <div style={{
      background: C.bg1, border: `1px solid ${C.line1}`,
      borderRadius: 4, padding: '10px 12px',
      marginTop: 12,
    }}>
      <div style={{
        fontSize: 8, letterSpacing: '0.18em', color: C.fg3, marginBottom: 8,
      }}>
        GURU HISTORY · {symbol} ({list.length})
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: 11, color: C.fg3 }}>
          No prior Guru analyses for {symbol} yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {list.map(r => {
            const accent = stateColor({
              stateCode: r.stateCode, direction: r.direction,
            } as GcpStateResponse);
            const conf = Math.round(r.confidence * 100);
            return (
              <div key={r.id} style={{
                padding: '6px 8px',
                background: C.bg2,
                borderLeft: `2px solid ${accent}`,
                borderRadius: 3,
                fontSize: 10, lineHeight: 1.45,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: accent, fontWeight: 600, letterSpacing: '0.04em' }}>
                    {r.stateCode} · {r.state}
                  </span>
                  <span style={{ color: C.fg3, fontFamily: 'var(--font-mono)' }}>
                    {conf}%
                  </span>
                </div>
                <div style={{ color: C.fg3, marginTop: 2 }}>
                  {fmtTime(r.timestamp)} · {r.phase} · {r.direction}
                  {r.regime ? ` · regime ${r.regime}` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function GuruScreen(props: GuruScreenProps) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus
        nv={props.liveNV} regime={props.liveRegime}
        connected={props.connected}
        aiState={props.aiState} aiEnabled={props.aiEnabled}
        aiStatus={props.aiStatus} symbol={props.symbol}
      />
      <div style={{
        padding: '8px 12px', borderBottom: `1px solid ${C.line1}`,
        background: C.bg, flexShrink: 0,
      }}>
        <div style={{ fontSize: 10, color: C.fg0, fontWeight: 600, letterSpacing: '0.06em' }}>
          GURU
        </div>
        <div style={{ fontSize: 9, color: C.fg3, marginTop: 2 }}>
          Ask Guru for the full coherence read · {props.symbol}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        <div style={{
          background: C.bg1, border: `1px solid ${C.line1}`,
          borderRadius: 4, overflow: 'hidden',
        }}>
          <AiStateCard
            state={props.aiState}
            enabled={props.aiEnabled}
            latestPattern={props.latestPattern}
            runNow={props.aiRunNow}
            aiStatus={props.aiStatus}
            lastSuccessAt={props.aiLastSuccess ?? null}
            planStructure={props.planStructure}
            planAnalysisCandle={props.planAnalysisCandle ?? null}
            currentPrice={props.price}
            symbol={props.symbol}
          />
        </div>
        <GuruHistoryMobile symbol={props.symbol} />
      </div>
    </div>
  );
}
