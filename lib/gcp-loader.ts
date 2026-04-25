import type { GCPEntry, DataPoint } from '@/types/gcp';
import { regimeFor } from '@/lib/gcp-data';

let _cache: GCPEntry[] | null = null;

export async function loadGCPEntries(): Promise<GCPEntry[]> {
  if (_cache) return _cache;

  try {
    const res = await fetch('/data/gcp_2026.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _cache = await res.json();
    return _cache!;
  } catch (err) {
    console.warn('[gcp-loader] Failed to load real GCP data:', err);
    return [];
  }
}

export function entriesToSeries(entries: GCPEntry[]): DataPoint[] {
  return entries.map((e, i) => ({
    i,
    t: e.t,
    v: e.v,
    r: regimeFor(e.v),
    g: 0,
    gReal: false,
  }));
}

export function getRecentEntries(entries: GCPEntry[], minutes: number): GCPEntry[] {
  return entries.slice(-minutes);
}
