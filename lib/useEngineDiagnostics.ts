'use client';

// v12.0.0 — client hook for the Engine diagnostics panel.
//
// Polls /api/engine-status periodically and exposes the
// EngineDiagnosticsPanel shape (from the vendored SDK) plus a couple
// of GCP-Pro-specific extras (last-classification age, last error).
//
// Browser-safe — never reads ENGINE_API_KEY. The API key stays on the
// server inside /api/engine-status.
//
// Default cadence is conservative (60s) — diagnostics is a
// background concern, not a hot loop. Callers can pass
// pollIntervalMs: 0 to disable polling entirely (Settings page reads
// once on mount).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineDiagnosticsPanel } from '@/lib/engine-sdk';

export interface EngineStatusEnvelope {
  panel:                   EngineDiagnosticsPanel;
  lastClassificationAgeMs: number | null;
  lastError:               string | null;
  configured:              boolean;
  timestamp:               string;
}

export interface UseEngineDiagnosticsResult {
  envelope:      EngineStatusEnvelope | null;
  loading:       boolean;
  fetchError:    string | null;
  lastFetchedAt: Date | null;
  refresh:       () => void;
}

export interface UseEngineDiagnosticsOpts {
  /** Poll cadence; default 60_000. Pass 0 to disable polling. */
  pollIntervalMs?: number;
  /** Fire an immediate fetch on mount. Default true. */
  fetchOnMount?:   boolean;
}

export function useEngineDiagnostics(
  opts: UseEngineDiagnosticsOpts = {},
): UseEngineDiagnosticsResult {
  const pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  const fetchOnMount   = opts.fetchOnMount   ?? true;

  const [envelope,      setEnvelope]      = useState<EngineStatusEnvelope | null>(null);
  const [loading,       setLoading]       = useState<boolean>(false);
  const [fetchError,    setFetchError]    = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  const inflightRef = useRef<boolean>(false);

  const refresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    try {
      const res = await fetch('/api/engine-status', {
        method:  'GET',
        headers: { 'Accept': 'application/json' },
        signal:  AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setFetchError(`HTTP ${res.status}`);
        // Keep the prior envelope so the UI doesn't flash empty.
      } else {
        const data = (await res.json()) as EngineStatusEnvelope;
        setEnvelope(data);
        setFetchError(null);
      }
      setLastFetchedAt(new Date());
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      inflightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetchOnMount) void refresh();
    if (pollIntervalMs <= 0) return;
    const id = setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => clearInterval(id);
  }, [refresh, pollIntervalMs, fetchOnMount]);

  return { envelope, loading, fetchError, lastFetchedAt, refresh };
}
