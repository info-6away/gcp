// v14.0.1 — Radar → Trade state hydration.
//
// Lightweight, in-memory cache of the most recent Guru Radar scan
// result per symbol. Lets the Trade page hydrate instantly from a
// Radar discovery instead of showing "NO READ YET" and forcing a
// fresh Ask Guru.
//
// CLIENT-SIDE ONLY. No localStorage, no server persistence. A
// module-level Map survives in-app navigation for the session and is
// dropped on reload — exactly the lifetime a "scan cache" should have.
// No background refresh, no Engine calls. The store is pure state
// handoff between two already-rendered surfaces.

import type { MarketSymbol } from '@/types/gcp';
import type { RadarResult } from '@/lib/radarScan';

const store = new Map<MarketSymbol, RadarResult>();

/** Save a completed scan result. Only successful scans are cached —
 *  a failed scan must not hydrate Trade with a broken read. */
export function setRadarResult(symbol: MarketSymbol, result: RadarResult): void {
  if (result.ok && result.aiState) {
    store.set(symbol, result);
  }
}

/** Most recent successful scan for a symbol, or undefined. */
export function getRadarResult(symbol: MarketSymbol): RadarResult | undefined {
  return store.get(symbol);
}

/** Drop a symbol's cached scan — called once a live classification
 *  supersedes it so the "RADAR READ" badge doesn't linger. */
export function clearRadarResult(symbol: MarketSymbol): void {
  store.delete(symbol);
}
