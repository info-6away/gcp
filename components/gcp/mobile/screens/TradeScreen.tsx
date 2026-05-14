'use client';

// v11.35: mobile Trade screen — same execution surface as desktop,
// just rendered inside the mobile chrome.
// v13.0: TradePanel is now the execution intelligence console (chart
// removed). The internal grids it renders already collapse to single
// columns on narrow viewports via inline @media rules; the wrapper
// here exists to hand it scroll + the mobile status bar above.

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
  // v13.0: gold trend label for the Thesis hero's gold confirmation
  // / divergence line. Optional — defaults to 'unknown' inside the
  // panel when callers don't have it threaded yet.
  goldTrend?:    'up' | 'down' | 'sideways' | 'unknown';
  // v13.7: ASK GURU button needs to fire runNow from the Trade
  // header. lastSuccess + status drive the button label + age.
  aiRunNow?:     (options?: { force?: boolean; source?: string }) => void;
  aiLastSuccess?: Date | null;
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
      {/* v13.0: TradePanel owns its own internal layout + responsive
          collapse to single column on phones via @media (max-width:
          720px). The wrapper here just gives it scroll. */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        background: C.bg,
      }}>
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
          goldTrend={props.goldTrend ?? 'unknown'}
          aiRunNow={props.aiRunNow}
          aiStatus={props.aiStatus}
          aiLastSuccess={props.aiLastSuccess}
          aiEnabled={props.aiEnabled}
        />
      </div>
    </div>
  );
}
