// v11.23.1: timestamp-based alignment between GCP and candle data.
//
// The chart and pattern systems must never assume gcp[i] ↔ candle[i].
// Different sources, different cadences, occasional gaps. This module
// exposes:
//   - alignGcpToCandles: forward-fill the latest GCP value at-or-before
//     each candle's timestamp. Returns nulls (not zeros) for periods
//     before any GCP point exists.
//   - detectGcpGaps: returns the gap windows where consecutive GCP
//     samples are more than 2× the expected interval apart.
//   - computeGcpQuality: aggregates stale flag + age + gap count +
//     largest gap into a single struct, used by the AI payload and
//     Settings diagnostics.
//
// Pattern detection still operates on the raw GCP series (truth);
// alignment is for chart display + cross-series comparison only.

import type { DataPoint } from '@/types/gcp';
import type { Candle } from '@/lib/fetchCandles';

export interface AlignedGcpPoint {
  t: number;          // candle timestamp (anchor)
  v: number | null;   // forward-filled GCP value, or null if no prior GCP exists
}

export function alignGcpToCandles(
  candles: Candle[],
  gcpSeries: DataPoint[],
): AlignedGcpPoint[] {
  if (!candles.length) return [];
  // Sorted ascending by t in both arrays — caller's responsibility,
  // but cheap to verify the heads.
  let gcpIndex  = 0;
  let lastValue: number | null = null;
  const out: AlignedGcpPoint[] = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    while (gcpIndex < gcpSeries.length && gcpSeries[gcpIndex].t <= candle.t) {
      lastValue = gcpSeries[gcpIndex].v;
      gcpIndex++;
    }
    out[i] = { t: candle.t, v: lastValue };
  }
  return out;
}

export interface GcpGap {
  startMs:    number;
  endMs:      number;
  durationMs: number;
}

// Default expected GCP cadence — useGCPData polls /api/getNetVarAggregate24H
// every 120 s and the API itself emits 1 sample per minute.
export const DEFAULT_GCP_INTERVAL_MS = 60_000;

export function detectGcpGaps(
  gcpSeries: DataPoint[],
  expectedIntervalMs: number = DEFAULT_GCP_INTERVAL_MS,
): GcpGap[] {
  if (gcpSeries.length < 2) return [];
  const threshold = expectedIntervalMs * 2;
  const gaps: GcpGap[] = [];
  for (let i = 1; i < gcpSeries.length; i++) {
    const dt = gcpSeries[i].t - gcpSeries[i - 1].t;
    if (dt > threshold) {
      gaps.push({
        startMs:    gcpSeries[i - 1].t,
        endMs:      gcpSeries[i].t,
        durationMs: dt,
      });
    }
  }
  return gaps;
}

export interface GcpQuality {
  stale:            boolean;
  lastUpdateAgeSec: number;       // seconds since last GCP sample
  gapCount:         number;
  largestGapSec:    number;
}

// Stale threshold — if the freshest GCP sample is older than this we
// flag it. 5 min matches the spec suggestion and is well above the
// 2 min poll cadence so a single missed poll doesn't trip it.
export const STALE_THRESHOLD_MS = 5 * 60_000;

export function computeGcpQuality(
  gcpSeries:          DataPoint[],
  now:                number  = Date.now(),
  expectedIntervalMs: number  = DEFAULT_GCP_INTERVAL_MS,
  staleThresholdMs:   number  = STALE_THRESHOLD_MS,
): GcpQuality {
  if (!gcpSeries.length) {
    return { stale: true, lastUpdateAgeSec: -1, gapCount: 0, largestGapSec: 0 };
  }
  const last         = gcpSeries[gcpSeries.length - 1];
  const ageMs        = Math.max(0, now - last.t);
  const stale        = ageMs > staleThresholdMs;
  // Only consider the recent window for gaps (last 4 hours) so old
  // historical gaps don't permanently flag the feed.
  const windowMs     = 4 * 3600_000;
  const windowStart  = now - windowMs;
  const recent       = gcpSeries.filter(p => p.t >= windowStart);
  const gaps         = detectGcpGaps(recent, expectedIntervalMs);
  const largestGapMs = gaps.reduce((m, g) => Math.max(m, g.durationMs), 0);
  return {
    stale,
    lastUpdateAgeSec: Math.round(ageMs / 1000),
    gapCount:         gaps.length,
    largestGapSec:    Math.round(largestGapMs / 1000),
  };
}

// Pretty-print short duration for diagnostic strings.
export function formatDurationSec(s: number): string {
  if (s < 0)        return '—';
  if (s < 60)       return `${s}s`;
  if (s < 3600)     return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
