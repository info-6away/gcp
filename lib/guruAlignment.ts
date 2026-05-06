// v11.33: trade-vs-Guru alignment classifier.
//
// Pure mapping. Given a trade side (long / short) and the current
// Guru state, returns one of:
//   full          — trade direction matches Guru's directional read
//   partial       — neutral state, mid-cycle, or aligned-but-late
//   contradiction — trade direction fights Guru, or hard "no entry"
//   unknown       — no aiState available
//
// Used by the TRADE module's CENTER column to render a clear chip
// next to the active position so the user immediately sees whether
// they're trading WITH or AGAINST the environment.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { Side } from '@/lib/demoAccount';

export type Alignment = 'full' | 'partial' | 'contradiction' | 'unknown';

export function deriveTradeAlignment(
  side:    Side,
  aiState: GcpStateResponse | null | undefined,
): Alignment {
  if (!aiState) return 'unknown';

  const code  = aiState.stateCode;
  const dir   = aiState.direction;
  const phase = aiState.phase;

  // Hard "no entry" environments contradict any directional trade.
  if (code === 'SH') return 'contradiction';
  if ((code === 'DS' || code === 'CL')
      && (phase === 'Late' || phase === 'Exhausted')) {
    return 'contradiction';
  }

  // Failed Alignment — short bias by definition.
  //   short with Down direction  → full
  //   short with neutral / mixed → partial
  //   long                        → contradiction (fighting the failure)
  if (code === 'FA') {
    if (side === 'short') return dir === 'Down' ? 'full' : 'partial';
    return 'contradiction';
  }

  // Trend / continuation states — direction must match.
  if (code === 'AT' || code === 'SS' || code === 'IS') {
    if (dir === 'Up' || dir === 'Down') {
      const aligned = (side === 'long'  && dir === 'Up')
                   || (side === 'short' && dir === 'Down');
      if (phase === 'Late' || phase === 'Exhausted') {
        return aligned ? 'partial' : 'contradiction';
      }
      return aligned ? 'full' : 'contradiction';
    }
    // Direction unclear — partial only.
    return 'partial';
  }

  // Compression / Dead Drift — no directional edge yet, so any trade
  // is a partial alignment at best (user is front-running).
  if (code === 'CS' || code === 'DD') return 'partial';

  // Discharge with Early/Mid phase — directional edge is fading.
  if (code === 'DS') {
    if (side === 'short' && dir === 'Down') return 'partial';
    if (side === 'long'  && dir === 'Up')   return 'partial';
    return 'contradiction';
  }

  return 'partial';
}

export function alignmentLabel(a: Alignment): string {
  switch (a) {
    case 'full':          return 'Full alignment';
    case 'partial':       return 'Partial alignment';
    case 'contradiction': return 'Contradiction';
    case 'unknown':       return 'No Guru context';
  }
}

export function alignmentColor(a: Alignment): string {
  switch (a) {
    case 'full':          return '#22c55e';
    case 'partial':       return '#d4a028';
    case 'contradiction': return '#ef4444';
    case 'unknown':       return '#7F98A3';
  }
}
