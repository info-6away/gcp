'use client';

import { MobileStatus, SymbolBar } from '../MobileChrome';
import ChartView from '@/components/gcp/ChartView';
import type { DataPoint, Pattern, MarketSymbol } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';

export function ChartScreen({
  series, patterns, liveNV, liveRegime, connected,
  symbol, price, onSymbolPress,
  aiState, aiEnabled, aiStatus,
}: {
  series: DataPoint[]; patterns: Pattern[];
  liveNV: number | null; liveRegime: string | null; connected: boolean;
  symbol: MarketSymbol; price: number | null; onSymbolPress?: () => void;
  aiState:   GcpStateResponse | null;
  aiEnabled: boolean;
  aiStatus:  AiStatus;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus nv={liveNV} regime={liveRegime} connected={connected}
        aiState={aiState} aiEnabled={aiEnabled} aiStatus={aiStatus} symbol={symbol} />
      <SymbolBar symbol={symbol} price={price} onSymbolPress={onSymbolPress} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ChartView
          series={series}
          patterns={patterns}
          symbol={symbol}
          timeframe="15m"
        />
      </div>
    </div>
  );
}
