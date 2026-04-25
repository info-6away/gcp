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

const _lastFetchTime: Record<string, number> = {};
const MIN_FETCH_INTERVAL = 55_000;

async function gcpFetch(endpoint: string): Promise<unknown> {
  const now = Date.now();
  const last = _lastFetchTime[endpoint] ?? 0;
  if (now - last < MIN_FETCH_INTERVAL) {
    throw new Error('Fetch throttled — too soon since last request');
  }
  _lastFetchTime[endpoint] = now;

  const res = await fetch(`${GCP2_BASE}${endpoint}`, {
    headers: {
      'Authorization': GCP2_BEARER,
      'Content-Type':  'application/json',
    },
  });

  if (res.status === 429) {
    throw new Error('Rate limited — will retry at next poll interval');
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

export function useGCPData(): GCPDataState {
  const [state, setState] = useState<GCPDataState>({
    series: [], liveNetvar: null, liveRegime: null,
    gcpLoading: true, gcpError: null, isLive: false, lastUpdate: null,
  });

  const historicalRef = useRef<DataPoint[]>([]);
  const livePointsRef = useRef<GCPPoint[]>([]);
  const fetchingRef   = useRef(false);
  const fetchingCurrentRef = useRef(false);

  useEffect(() => {
    loadHistoricalSeries().then(hist => {
      historicalRef.current = hist;
      const merged = mergeSeries(hist, livePointsRef.current);
      setState(s => ({ ...s, series: merged }));
    });
  }, []);

  const fetchSeries = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const data = await gcpFetch('/api/getNetVarAggregate24H') as { aggregates?: RawAggregate[] };
      const aggregates: RawAggregate[] = data.aggregates ?? [];

      if (!aggregates.length) throw new Error('Empty aggregates');

      const points: GCPPoint[] = aggregates.map(pt => {
        const v = parseFloat(String(pt.netvar_aggregate));
        return { t: pt.end_epoch * 1000, v: +v.toFixed(1), r: regimeFor(v) };
      });

      livePointsRef.current = points;
      const merged = mergeSeries(historicalRef.current, points);

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
    fetchingCurrentRef.current = true;
    try {
      const data   = await gcpFetch('/api/getcurrentnetvar') as { netvar: { netvar: string }[] };
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
