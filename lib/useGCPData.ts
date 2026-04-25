'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { regimeFor } from '@/lib/gcp-data';
import type { DataPoint, RegimeId } from '@/types/gcp';

const GCP2_BEARER = 'Bearer 5|M1bz2cXL3YLdmuArrI2KaySF0Cl8UxtiDznzK7Mk';
const GCP2_BASE   = 'https://gcp2.net';

const SERIES_POLL_MS  = 60_000;
const CURRENT_POLL_MS = 120_000;

interface RawAggregate {
  end_epoch:        number;
  netvar_aggregate: string | number;
}

interface GCPPoint {
  t: number;
  v: number;
  r: RegimeId;
}

export interface GCPDataState {
  series:     DataPoint[];
  liveNetvar: number | null;
  liveRegime: RegimeId | null;
  gcpLoading: boolean;
  gcpError:   string | null;
  isLive:     boolean;
  lastUpdate: Date | null;
}

const LS_KEY_SERIES  = 'gcp_last_series_fetch';
const LS_KEY_CURRENT = 'gcp_last_current_fetch';
const MIN_INTERVAL   = 55_000;

function canFetch(lsKey: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const last = parseInt(window.localStorage.getItem(lsKey) ?? '0', 10);
    return Date.now() - last > MIN_INTERVAL;
  } catch {
    return true;
  }
}

function markFetched(lsKey: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(lsKey, String(Date.now())); } catch {}
}

async function gcpFetch(endpoint: string): Promise<unknown | null> {
  const res = await fetch(`${GCP2_BASE}${endpoint}`, {
    headers: {
      'Authorization': GCP2_BEARER,
      'Content-Type':  'application/json',
    },
  });

  if (res.status === 429) {
    console.debug('[GCP] Rate limited, will retry at next interval');
    return null;
  }

  if (!res.ok) throw new Error(`GCP2 returned ${res.status}`);
  return res.json();
}

async function loadHistoricalSeries(): Promise<DataPoint[]> {
  try {
    const res = await fetch('/data/gcp_2026.json');
    if (!res.ok) return [];
    const raw: { t: number; v: number }[] = await res.json();
    return raw.map((e, i) => ({
      i, t: e.t, v: e.v, r: regimeFor(e.v), g: 0, gReal: false,
    }));
  } catch {
    return [];
  }
}

function livePointsToSeries(points: GCPPoint[], startIndex: number): DataPoint[] {
  return points.map((pt, i) => ({
    i:     startIndex + i,
    t:     pt.t,
    v:     pt.v,
    r:     pt.r,
    g:     0,
    gReal: false,
  }));
}

function mergeSeries(historical: DataPoint[], live: GCPPoint[]): DataPoint[] {
  if (!live.length) return historical;
  const liveStart = live[0].t;
  const base      = historical.filter(p => p.t < liveStart);
  const liveDP    = livePointsToSeries(live, base.length);
  return [...base, ...liveDP].map((p, i) => ({ ...p, i }));
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Compare overlapping time-window medians to derive a scale factor.
// The historical JSON was processed with sum_sq × 0.46 (Session 5.5);
// the live API serves raw netvar_aggregate. Without rescaling, regime
// classification is wrong on the historical half of the merged series.
function computeHistoricalScale(historical: DataPoint[], live: GCPPoint[]): number {
  if (!live.length || !historical.length) return 1;
  const liveStart = live[0].t;
  const liveEnd   = live[live.length - 1].t;

  const overlap: number[] = [];
  for (const p of historical) {
    if (p.t >= liveStart && p.t <= liveEnd) overlap.push(p.v);
  }
  if (overlap.length < 10) return 1;

  const histMed = median(overlap);
  const liveMed = median(live.map(p => p.v));
  if (histMed <= 0) return 1;

  const ratio = liveMed / histMed;
  if (!isFinite(ratio) || ratio <= 0) return 1;
  return ratio;
}

function rescaleHistorical(historical: DataPoint[], scale: number): DataPoint[] {
  if (scale === 1) return historical;
  return historical.map(p => {
    const v = p.v * scale;
    return { ...p, v: +v.toFixed(2), r: regimeFor(v) };
  });
}

export function useGCPData(): GCPDataState {
  const [state, setState] = useState<GCPDataState>({
    series: [], liveNetvar: null, liveRegime: null,
    gcpLoading: true, gcpError: null, isLive: false, lastUpdate: null,
  });

  const historicalRef        = useRef<DataPoint[]>([]);
  const scaledHistoricalRef  = useRef<DataPoint[]>([]);
  const scaleRef             = useRef<number | null>(null);
  const livePointsRef        = useRef<GCPPoint[]>([]);
  const fetchingRef          = useRef(false);
  const fetchingCurrentRef   = useRef(false);
  const mountedSeriesRef     = useRef(false);
  const mountedCurrentRef    = useRef(false);

  useEffect(() => {
    loadHistoricalSeries().then(hist => {
      historicalRef.current       = hist;
      scaledHistoricalRef.current = hist; // identity until scale is computed
      const merged = mergeSeries(scaledHistoricalRef.current, livePointsRef.current);
      setState(s => ({
        ...s,
        series:     merged,
        gcpLoading: hist.length === 0 && s.series.length === 0,
      }));
    });
  }, []);

  const fetchSeries = useCallback(async () => {
    if (fetchingRef.current) return;
    const isFirstMount = !mountedSeriesRef.current;
    mountedSeriesRef.current = true;
    if (!isFirstMount && !canFetch(LS_KEY_SERIES)) {
      setState(s => (s.gcpLoading ? { ...s, gcpLoading: false } : s));
      return;
    }

    fetchingRef.current = true;
    try {
      const data = await gcpFetch('/api/getNetVarAggregate24H') as
        | { aggregates?: RawAggregate[] }
        | null;
      if (!data) {
        setState(s => ({ ...s, gcpLoading: false }));
        return;
      }

      markFetched(LS_KEY_SERIES);

      const aggregates: RawAggregate[] = data.aggregates ?? [];
      if (!aggregates.length) throw new Error('Empty aggregates');

      const points: GCPPoint[] = aggregates.map(pt => {
        const v = parseFloat(String(pt.netvar_aggregate));
        return { t: pt.end_epoch * 1000, v: +v.toFixed(1), r: regimeFor(v) };
      });

      livePointsRef.current = points;

      if (scaleRef.current === null && historicalRef.current.length) {
        const scale = computeHistoricalScale(historicalRef.current, points);
        scaleRef.current = scale;
        scaledHistoricalRef.current = rescaleHistorical(historicalRef.current, scale);
        if (scale !== 1) {
          console.debug(`[GCP] Historical rescaled by x${scale.toFixed(3)}`);
        }
      }

      const merged = mergeSeries(scaledHistoricalRef.current, points);

      setTimeout(() => {
        setState(s => ({
          ...s,
          series:     merged,
          gcpLoading: false,
          gcpError:   null,
          isLive:     true,
          lastUpdate: new Date(),
        }));
      }, 0);
    } catch (e) {
      setState(s => ({
        ...s,
        gcpLoading: false,
        gcpError:   String(e),
        isLive:     false,
      }));
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  const fetchCurrent = useCallback(async () => {
    if (fetchingCurrentRef.current) return;
    const isFirstMount = !mountedCurrentRef.current;
    mountedCurrentRef.current = true;
    if (!isFirstMount && !canFetch(LS_KEY_CURRENT)) return;

    fetchingCurrentRef.current = true;
    try {
      const data = await gcpFetch('/api/getcurrentnetvar') as
        | { netvar: { netvar: string }[] }
        | null;
      if (!data) return;

      markFetched(LS_KEY_CURRENT);

      const netvar = parseFloat(data.netvar[0].netvar);
      if (!isNaN(netvar)) {
        setState(s => ({
          ...s,
          liveNetvar: +netvar.toFixed(1),
          liveRegime: regimeFor(netvar),
        }));
      }
    } catch { /* silent — series is primary */ }
    finally { fetchingCurrentRef.current = false; }
  }, []);

  useEffect(() => {
    fetchSeries();
    const initDelay = setTimeout(fetchCurrent, 5000);

    const s = setInterval(fetchSeries,  SERIES_POLL_MS);
    const c = setInterval(fetchCurrent, CURRENT_POLL_MS);
    return () => {
      clearTimeout(initDelay);
      clearInterval(s);
      clearInterval(c);
    };
  }, [fetchSeries, fetchCurrent]);

  return state;
}
