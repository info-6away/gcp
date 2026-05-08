'use client';

// v11.35: mobile Trade screen — same execution surface as desktop,
// just rendered inside the mobile chrome. The underlying TradePanel
// is already a deterministic 3-column grid, so on narrow viewports
// we override the grid to a vertical stack via a wrapper class —
// no separate component to maintain.

import type { MarketSymbol, Pattern, Timeframe } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { Posture } from '@/lib/aiAction';
import type { TradePlan } from '@/lib/tradePlan';
import type { AiStatus } from '@/lib/useGcpState';
import { MobileStatus } from '../MobileChrome';
import { C } from '../colors';
import TradePanel from '../../TradePanel';

interface TradeScreenProps {
  symbol:        MarketSymbol;
  timeframe:     Timeframe;
  price:         number | null;
  liveNV:        number | null;
  liveRegime:    string | null;
  connected:     boolean;
  aiState:       GcpStateResponse | null;
  aiEnabled:     boolean;
  aiStatus:      AiStatus;
  posture:       Posture | null;
  latestPattern: Pattern | null;
  tradePlan:     TradePlan | null;
  netVariance:   number | null;
}

export function TradeScreen(props: TradeScreenProps) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      overflow: 'hidden', position: 'relative',
    }}>
      <MobileStatus
        nv={props.liveNV} regime={props.liveRegime}
        connected={props.connected}
        aiState={props.aiState} aiEnabled={props.aiEnabled}
        aiStatus={props.aiStatus} symbol={props.symbol}
      />
      {/* Tag the wrapper so a narrow-viewport stylesheet can collapse
          the underlying TradePanel grid into a single column on
          phones. Desktop's 260 / 1fr / 280 grid stays correct on
          tablets via the inline CSS in TradePanel. */}
      <div className="mobile-trade-wrap" style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        background: C.bg,
      }}>
        <style>{`
          @media (max-width: 720px) {
            .mobile-trade-wrap > div > div:nth-child(2) {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
        <TradePanel
          symbol={props.symbol}
          timeframe={props.timeframe}
          currentPrice={props.price}
          aiState={props.aiState}
          posture={props.posture}
          latestPattern={props.latestPattern}
          tradePlan={props.tradePlan}
          regime={props.liveRegime}
          netVariance={props.netVariance}
        />
      </div>
    </div>
  );
}
