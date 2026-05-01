// v11.21: AI State timeframe context. Engine analyses operate on a
// fixed aggregation (15m for now) and a fixed forward horizon (1h),
// regardless of the chart timeframe the user is looking at. Without
// surfacing this, a user on a 1m chart misreads AI signals as "late"
// because they're applied to a different time scale than the chart.
//
// Constants live here so payload + UI + future timeframe switcher all
// reference the same source of truth.

export type AiTimeframe = '5m' | '15m' | '1h';

export const AI_ANALYSIS_TF: AiTimeframe = '15m';
export const AI_FORWARD_HORIZON          = '1h';

export interface TimeframeContext {
  chartTf:        string;        // whatever the user has on the chart
  analysisTf:     AiTimeframe;
  forwardHorizon: string;
}

export function buildTimeframeContext(chartTf: string): TimeframeContext {
  return {
    chartTf,
    analysisTf:     AI_ANALYSIS_TF,
    forwardHorizon: AI_FORWARD_HORIZON,
  };
}
