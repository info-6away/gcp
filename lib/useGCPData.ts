'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { regimeFor } from '@/lib/gcp-data';
import type { DataPoint, RegimeId } from '@/types/gcp';

const GCP2_BEARER = 'Bearer 5|M1bz2cXL3YLdmuArrI2KaySF0Cl8UxtiDznzK7Mk';
const GCP2_BASE   = 'https://gcp2.net';

const SERIES_POLL_MS  = 30_000;
const CURRENT_POLL_MS = 60_000;

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

async function gcpFetch(endpoint: string) {
  const res = await fetch(`${GCP2_BASE}${endpoint}`, {
    headers: {
      'Authorization': GCP2_BEARER,
      'Content-Type':  'application/json',
    },
  });
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

  useEffect(() => {
    loadHistoricalSeries().then(hist => {
      historicalRef.current = hist;
      const merged = mergeSeries(hist, livePointsRef.current);
      setState(s => ({ ...s, series: merged }));
    });
  }, []);

  const fetchSeries = useCallback(async () => {
    try {
      const data = await gcpFetch('/api/getNetVarAggregate24H');
      const aggregates: RawAggregate[] = data.aggregates ?? [];

      if (!aggregates.length) throw new Error('Empty aggregates');

      const points: GCPPoint[] = aggregates.map(pt => {
        const v = parseFloat(String(pt.netvar_aggregate));
        return { t: pt.end_epoch * 1000, v: +v.toFixed(1), r: regimeFor(v) };
      });

      livePointsRef.current = points;
      const merged = mergeSeries(historicalRef.current, points);

      setState(s => ({
        ...s,
        series:     merged,
        gcpLoading: false,
        gcpError:   null,
        isLive:     true,
        lastUpdate: new Date(),
      }));
    } catch (e) {
      setState(s => ({
        ...s,
        gcpLoading: false,
        gcpError:   String(e),
        isLive:     false,
      }));
    }
  }, []);

  const fetchCurrent = useCallback(async () => {
    try {
      const data   = await gcpFetch('/api/getcurrentnetvar');
      const netvar = parseFloat(data.netvar[0].netvar);
      if (!isNaN(netvar)) {
        setState(s => ({
          ...s,
          liveNetvar: +netvar.toFixed(1),
          liveRegime: regimeFor(netvar),
        }));
      }
    } catch { /* silent — series is primary */ }
  }, []);

  useEffect(() => {
    fetchSeries();
    fetchCurrent();
    const s = setInterval(fetchSeries,  SERIES_POLL_MS);
    const c = setInterval(fetchCurrent, CURRENT_POLL_MS);
    return () => { clearInterval(s); clearInterval(c); };
  }, [fetchSeries, fetchCurrent]);

  return state;
}
