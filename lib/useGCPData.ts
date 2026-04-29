'use client';

import { useState, useEffect } from 'react';
import { regimeFor } from '@/lib/gcp-data';
import { isValidNV, isValidNumber } from '@/lib/sanity';
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
  // Returning null from this helper is the signal to _runFetchSeries
  // that "this poll yielded no usable data -- keep prior state, do
  // NOT broadcast or cache". The system's last-known values stay in
  // place. v11.13.1 sanity layer downstream rejects any per-aggregate
  // bad values that survive this layer.
  const res = await fetch(`${GCP2_BASE}${endpoint}`, {
    headers: {
      'Authorization': GCP2_BEARER,
      'Content-Type':  'application/json',
    },
  });

  if (res.status === 429) {
    console.warn('[GCP] 429 rate limited -- using last-known state');
    return null;
  }
  if (!res.ok) throw new Error(`GCP2 returned ${res.status}`);

  try {
    return await res.json();
  } catch (e) {
    console.warn('[GCP] JSON parse failed:', e);
    return null;
  }
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

// ── localStorage warm-start (v11.12.1) ─────────────────────────────────────
// Persist the live tail of the GCP series + scale factor + last NV/regime
// after every successful poll, then hydrate from cache on _loadHistoricalOnce
// so an offline reload shows last-known terminal state rather than a blank
// dashboard. Historical comes from /data/gcp_2026.json which the v11.11 SW
// caches as a static asset; only the live-API portion needs LS persistence.

const LS_GCP_KEY = 'gcpro-cache-gcp';

interface CachedGCP {
  livePoints:  GCPPoint[];
  liveNetvar:  number    | null;
  liveRegime:  RegimeId  | null;
  scaleFactor: number    | null;
  lastUpdate:  number;     // Date.now() when the cache was written
}

function loadCachedGCP(): CachedGCP | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LS_GCP_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.livePoints)) return null;
    return obj as CachedGCP;
  } catch {
    return null;
  }
}

function saveCachedGCP(c: CachedGCP): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_GCP_KEY, JSON.stringify(c));
  } catch {
    /* quota / serialization failure -- not worth surfacing */
  }
}

function mergeSeries(historical: DataPoint[], live: GCPPoint[]): DataPoint[] {
  if (!live.length) return historical;
  const liveStart = live[0].t;
  const base = historical.filter(p => p.t < liveStart);
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
let _pollLoopPromise:   Promise<void> | null = null;
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

    // Warm-start: hydrate live tail + scale factor from localStorage (if any
    // previous session left them) BEFORE the first live poll lands. Historical
    // alone gives the chart its full backbone; the cached live points fill the
    // last 24 h gap so NV / regime / pattern feed all show real values
    // immediately on reload, online or offline.
    const cached = loadCachedGCP();
    if (cached && cached.livePoints.length) {
      _livePoints = cached.livePoints;
      if (cached.scaleFactor !== null) {
        _scale            = cached.scaleFactor;
        _scaledHistorical = rescaleHistorical(_historical, _scale);
      }
    }

    const merged = mergeSeries(_scaledHistorical, _livePoints);
    const last   = merged[merged.length - 1];
    _setState(s => ({
      ...s,
      series:     merged,
      // Keep gcpLoading=false once we have something to render — historical
      // alone is a reasonable fallback while live retries in the background.
      gcpLoading: hist.length === 0 && s.series.length === 0,
      // Cached values take precedence over the historical-tail seed so a
      // reload mid-session shows the most recent live NV / regime, not the
      // last historical bar. isLive is intentionally NOT set here -- only a
      // live API success in _runFetchSeries flips it true. Stale cached
      // values must not look live (per spec).
      liveNetvar:  cached?.liveNetvar ?? s.liveNetvar ?? (last ? last.v : null),
      liveRegime:  cached?.liveRegime ?? s.liveRegime ?? (last ? last.r : null),
      scaleFactor: _scale,
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

    // v11.13.1 sanity gate: reject NaN, <=0, non-finite, or non-numeric
    // aggregates BEFORE they reach _livePoints / merged series / chart /
    // detector. One bad value used to spike the chart vertically and
    // poison Compression Coil detection (NaN passed regimeFor() and
    // landed as 'F').
    let rejected = 0;
    const points: GCPPoint[] = [];
    for (const pt of aggregates) {
      const raw = parseFloat(String(pt.netvar_aggregate));
      if (!isValidNV(raw)) {
        rejected++;
        continue;
      }
      const v = +raw.toFixed(1);
      points.push({ t: pt.end_epoch * 1000, v, r: regimeFor(v) });
    }
    if (rejected > 0) {
      console.warn(`[GCP] invalid value rejected (${rejected} of ${aggregates.length} aggregates)`);
    }
    if (!points.length) {
      // Every aggregate was bad -- treat as a failed poll, keep
      // last-known state, don't overwrite cache.
      console.warn('[GCP] all aggregates rejected, keeping last-known state');
      return;
    }

    _livePoints = points;

    if (_scale === null && _historical.length) {
      const candidate = computeHistoricalScale(_historical, points);
      // computeHistoricalScale already clamps implausible ratios to 1
      // and warns; this extra guard catches any future code path that
      // returns NaN / <=0 / non-finite.
      if (isValidNumber(candidate) && candidate > 0) {
        _scale            = candidate;
        _scaledHistorical = rescaleHistorical(_historical, _scale);
      } else {
        console.warn('[SCALE] invalid scale rejected:', candidate);
      }
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

    // v11.12.1 + v11.13.1: persist live tail for offline / reload
    // warm-start. Skip the write if the last point is invalid -- the
    // cache must only ever hold values that survived the sanity gate.
    if (last && isValidNV(last.v)) {
      saveCachedGCP({
        livePoints:  points,
        liveNetvar:  last.v,
        liveRegime:  last.r,
        scaleFactor: isValidNumber(scale) && scale !== null && scale > 0 ? scale : null,
        lastUpdate:  Date.now(),
      });
    }
  } catch (e) {
    console.warn('[GCP] _runFetchSeries error:', e);
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

function _ensurePolling(): void {
  if (_pollLoopPromise) return;
  _pollLoopPromise = (async () => {
    // try/finally guarantees the lock clears no matter how the loop exits
    // (uncaught throw, listeners drain, etc.). Without this, a single
    // unhandled rejection could deadlock _ensurePolling forever.
    try {
      await new Promise(r => setTimeout(r, 3_000));
      while (_listeners.size > 0) {
        try { await _runFetchSeries(); }
        catch (e) { console.warn('[GCP] poll iter threw:', e); }
        if (_listeners.size === 0) break;
        await new Promise(r => setTimeout(r, 120_000));
      }
    } finally {
      _pollLoopPromise = null;
    }
  })();
}

export function useGCPData(): GCPDataState {
  const [state, setLocalState] = useState<GCPDataState>(_state);

  useEffect(() => {
    _listeners.add(setLocalState);
    _loadHistoricalOnce();
    _ensurePolling();
    setLocalState(_state);
    return () => {
      _listeners.delete(setLocalState);
      // Don't tear down polling on unmount — other subscribers may exist
      // and StrictMode unmounts/remounts immediately. The loop self-exits
      // when _listeners.size === 0 between cycles.
    };
  }, []);

  return state;
}
