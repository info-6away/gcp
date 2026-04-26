'use client';

import { useState, useEffect } from 'react';
import { regimeFor } from '@/lib/gcp-data';
import type { DataPoint, RegimeId } from '@/types/gcp';

const GCP2_BEARER = 'Bearer 5|M1bz2cXL3YLdmuArrI2KaySF0Cl8UxtiDznzK7Mk';
const GCP2_BASE   = 'https://gcp2.net';

const MIN_FETCH_GAP = 55_000;

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
  series:      DataPoint[];
  liveNetvar:  number | null;
  liveRegime:  RegimeId | null;
  gcpLoading:  boolean;
  gcpError:    string | null;
  isLive:      boolean;
  lastUpdate:  Date | null;
  scaleFactor: number | null;
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
  const base   = historical.filter(p => p.t < liveStart - 7_200_000);
  const liveDP = livePointsToSeries(live, base.length);
  return [...base, ...liveDP]
    .sort((a, b) => a.t - b.t)
    .map((p, i) => ({ ...p, i }));
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function computeHistoricalScale(historical: DataPoint[], live: GCPPoint[]): number {
  if (!historical.length || !live.length) return 1;
  const histMed = median(historical.map(p => p.v));
  const liveMed = median(live.map(p => p.v));
  if (histMed <= 0 || liveMed <= 0) return 1;

  const ratio = liveMed / histMed;
  if (!isFinite(ratio) || ratio < 0.2 || ratio > 10) {
    console.warn('[GCP] Implausible scale ratio:', ratio, '— using 1.0');
    return 1;
  }
  console.debug(
    `[GCP] Historical rescaled by x${ratio.toFixed(3)} ` +
    `(histMed=${histMed.toFixed(1)}, liveMed=${liveMed.toFixed(1)})`,
  );
  return ratio;
}

function rescaleHistorical(historical: DataPoint[], scale: number): DataPoint[] {
  if (scale === 1) return historical;
  return historical.map(p => {
    const v = p.v * scale;
    return { ...p, v: +v.toFixed(2), r: regimeFor(v) };
  });
}

// ── Module-level singleton ─────────────────────────────────────────────────
// Keeps polling and cached data outside React's lifecycle so that StrictMode
// double-mounts and remounts don't re-trigger fetches and overwhelm the API.

const INITIAL_STATE: GCPDataState = {
  series: [], liveNetvar: null, liveRegime: null,
  gcpLoading: true, gcpError: null, isLive: false, lastUpdate: null,
  scaleFactor: null,
};

let _state: GCPDataState = INITIAL_STATE;
const _listeners = new Set<(s: GCPDataState) => void>();

function _setState(updater: (s: GCPDataState) => GCPDataState) {
  _state = updater(_state);
  _listeners.forEach(fn => fn(_state));
}

let _historical:        DataPoint[]       = [];
let _scaledHistorical:  DataPoint[]       = [];
let _scale:             number | null     = null;
let _livePoints:        GCPPoint[]        = [];
let _historicalLoaded   = false;
let _historicalLoading  = false;
let _intervalsInstalled = false;
let _fetchingSeries     = false;
let _lastSeriesFetch    = 0;

async function _loadHistoricalOnce(): Promise<void> {
  if (_historicalLoaded || _historicalLoading) return;
  _historicalLoading = true;
  try {
    const hist = await loadHistoricalSeries();
    _historical       = hist;
    _scaledHistorical = hist;
    _historicalLoaded = true;

    const merged = mergeSeries(_scaledHistorical, _livePoints);
    _setState(s => ({
      ...s,
      series:     merged,
      gcpLoading: hist.length === 0 && s.series.length === 0,
    }));
  } finally {
    _historicalLoading = false;
  }
}

async function _runFetchSeries(): Promise<void> {
  if (_fetchingSeries) return;
  if (Date.now() - _lastSeriesFetch < MIN_FETCH_GAP && _lastSeriesFetch !== 0) return;
  _fetchingSeries = true;
  try {
    const data = await gcpFetch('/api/getNetVarAggregate24H') as
      | { aggregates?: RawAggregate[] }
      | null;
    if (!data) {
      _setState(s => ({ ...s, gcpLoading: false }));
      return;
    }
    _lastSeriesFetch = Date.now();

    const aggregates: RawAggregate[] = data.aggregates ?? [];
    if (!aggregates.length) throw new Error('Empty aggregates');

    const points: GCPPoint[] = aggregates.map(pt => {
      const v = parseFloat(String(pt.netvar_aggregate));
      return { t: pt.end_epoch * 1000, v: +v.toFixed(1), r: regimeFor(v) };
    });

    _livePoints = points;

    if (_scale === null && _historical.length) {
      _scale            = computeHistoricalScale(_historical, points);
      _scaledHistorical = rescaleHistorical(_historical, _scale);
    }

    const merged = mergeSeries(_scaledHistorical, points);
    const scale  = _scale;
    // The last point of the 24h series IS the current value — no need
    // to hit /api/getcurrentnetvar separately.
    const last   = points[points.length - 1];

    setTimeout(() => {
      _setState(s => ({
        ...s,
        series:      merged,
        gcpLoading:  false,
        gcpError:    null,
        isLive:      true,
        lastUpdate:  new Date(),
        scaleFactor: scale,
        liveNetvar:  last ? last.v : s.liveNetvar,
        liveRegime:  last ? last.r : s.liveRegime,
      }));
    }, 0);
  } catch (e) {
    _setState(s => ({
      ...s,
      gcpLoading: false,
      gcpError:   String(e),
      isLive:     false,
    }));
  } finally {
    _fetchingSeries = false;
  }
}

async function _pollLoop(): Promise<void> {
  // Brief startup delay — lets StrictMode finish double-mounting and the
  // historical JSON load before we hit the live API.
  await new Promise(r => setTimeout(r, 2_000));
  if (!_intervalsInstalled) return;

  await _runFetchSeries();

  while (_intervalsInstalled && _listeners.size > 0) {
    await new Promise(r => setTimeout(r, 120_000));
    if (!_intervalsInstalled) break;
    await _runFetchSeries();
  }
}

function _ensurePolling(): void {
  if (_intervalsInstalled) return;
  _intervalsInstalled = true;
  _loadHistoricalOnce();
  _pollLoop();
}

export function useGCPData(): GCPDataState {
  const [state, setLocalState] = useState<GCPDataState>(_state);

  useEffect(() => {
    _listeners.add(setLocalState);
    _ensurePolling();
    setLocalState(_state);
    return () => {
      _listeners.delete(setLocalState);
      // The page is gone — stop the loop so it doesn't keep firing.
      // _ensurePolling() will restart it the next time a subscriber mounts.
      if (_listeners.size === 0) {
        _intervalsInstalled = false;
      }
    };
  }, []);

  return state;
}
