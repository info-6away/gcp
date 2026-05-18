// v14.0 — Phase 14A: Guru Radar symbol universe.
//
// The set of assets the multi-asset coherence scanner sweeps. Kept as
// a thin standalone module so the list is trivial to extend later
// without touching scan logic or UI.
//
// Values are MarketSymbol ids so a radar result can switch the active
// app symbol directly (Radar → Trade workflow).

import type { MarketSymbol } from '@/types/gcp';

// v14.4: expanded 5 → 10. A wider universe is needed to tell true
// field synchronization apart from a too-narrow asset set — see
// lib/fieldDispersion.ts. Scan stays manual + sequential.
export const RADAR_SYMBOLS: MarketSymbol[] = [
  'XAUUSD',
  'XAGUSD',
  'BTC',
  'ETH',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
];
