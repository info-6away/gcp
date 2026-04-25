'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { regimeFor } from '@/lib/gcp-data';
import type { DataPoint } from '@/types/gcp';
import type { GCPPoint } from '@/app/api/gcp/route';
import type { GCPLiveResponse } from '@/app/api/gcp/live/route';

export interface GCPDataState {
  series:      DataPoint[];
  liveNetvar:  number | null;
  liveRegime:  string | null;
  gcpLoading:  boolean;
  gcpError:    string | null;
  isLive:      boolean;
  lastUpdate:  Date | null;
}

const SERIES_POLL_MS  = 30_000;
const CURRENT_POLL_MS = 60_000;

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

function mergeSeries(historical: DataPoint[], live: GCPPoint[]): DataPoint[] {
  if (!live.length) return historical;

  const liveStart = live[0].t;
  const base      = historical.filter(p => p.t < liveStart);

  const livePoints: DataPoint[] = live.map((pt, i) => ({
    i:     base.length + i,
    t:     pt.t,
    v:     pt.v,
    r:     pt.r,
    g:     0,
    gReal: false,
  }));

  return [...base, ...livePoints].map((p, i) => ({ ...p, i }));
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
      const res  = await fetch('/api/gcp');
      const data = await res.json();

      if (data.error || !data.points?.length) {
        setState(s => ({
          ...s,
          gcpLoading: false,
          gcpError:   data.error ?? 'No live data',
          isLive:     false,
        }));
        return;
      }

      livePointsRef.current = data.points;
      const merged = mergeSeries(historicalRef.current, data.points);

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
      const res  = await fetch('/api/gcp/live');
      const data: GCPLiveResponse & { error?: string } = await res.json();
      if (data.netvar !== null) {
        setState(s => ({ ...s, liveNetvar: data.netvar, liveRegime: data.regime }));
      }
    } catch { /* silent — series data is the primary indicator */ }
  }, []);

  useEffect(() => {
    fetchSeries();
    fetchCurrent();
    const s = setInterval(fetchSeries, SERIES_POLL_MS);
    const c = setInterval(fetchCurrent, CURRENT_POLL_MS);
    return () => { clearInterval(s); clearInterval(c); };
  }, [fetchSeries, fetchCurrent]);

  return state;
}
