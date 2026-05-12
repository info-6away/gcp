'use client';

// v12.0.0 — Engine diagnostics panel.
//
// Renders the EngineDiagnosticsPanel shape produced by the vendored
// SDK's buildEngineDiagnostics() helper (called server-side in
// /api/engine-status). Tucked into Settings → Advanced — additive UI,
// no impact on Guru / Chart / Dashboard / Mobile behavior.
//
// Visual contract:
//   - Reachability dot (green / red) at the top.
//   - "Engine vX.Y.Z" + workspace slug when reachable.
//   - Rows for: route configured, provider available, budget OK,
//     memory active, degraded flags.
//   - Last classification echo: model, provider, route source,
//     latency, fallback flag, deploymentId, age.
//   - Stale-cache age (separate from lastSuccessAgeMs which is the
//     ENGINE-side counter).
//   - Refresh button so the user can re-poll without waiting for
//     the 60s background tick.

import { useEngineDiagnostics } from '@/lib/useEngineDiagnostics';
import type { ClassifyErrorEnvelope } from '@/lib/engine-gcp';

function formatAge(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1_000)        return `${Math.round(ms)}ms`;
  if (ms < 60_000)       return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000)    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function StatusDot({ ok, neutral }: { ok: boolean; neutral?: boolean }) {
  const color = neutral
    ? 'var(--fg-4)'
    : ok ? 'var(--green)' : 'var(--red)';
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: color, verticalAlign: 'middle',
    }} />
  );
}

function Row({ label, value, tone = 'default' }: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'warn' | 'good' | 'muted';
}) {
  const color = tone === 'warn' ? '#d4a028'
              : tone === 'good' ? 'var(--green)'
              : tone === 'muted' ? 'var(--fg-3)'
              :                    'var(--fg-1)';
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '5px 0', gap: 10,
      borderBottom: '1px solid var(--line-0)',
      fontSize: 11,
    }}>
      <span style={{ color: 'var(--fg-3)', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{
        color,
        fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
      }}>
        {value}
      </span>
    </div>
  );
}

export default function EngineDiagnostics({
  aiLastError = null,
}: {
  /** v12.0.3: structured proxy error from the most recent
   *  /api/gcp-state call. When present, the diagnostics panel
   *  surfaces an ENGINE STATUS row at the top — distinct from the
   *  /v1/status reachability check, this is the last failed
   *  classification call. */
  aiLastError?: ClassifyErrorEnvelope | null;
} = {}) {
  const { envelope, loading, fetchError, lastFetchedAt, refresh } =
    useEngineDiagnostics({ pollIntervalMs: 60_000, fetchOnMount: true });

  // Skeleton view — first paint before /api/engine-status resolves.
  if (!envelope && !fetchError) {
    return (
      <div style={{
        padding: '10px 12px',
        background: 'var(--bg-2)',
        border: '1px solid var(--line-1)',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 11, color: 'var(--fg-3)',
      }}>
        {loading ? 'Querying engine…' : 'Engine diagnostics will load on mount.'}
      </div>
    );
  }

  // Hard fetch error — the route itself didn't respond.
  if (!envelope && fetchError) {
    return (
      <div style={{
        padding: '10px 12px',
        background: 'var(--bg-2)',
        border: '1px solid var(--red)',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 11, color: 'var(--fg-1)',
      }}>
        <div style={{ marginBottom: 4 }}>
          <StatusDot ok={false} /> <strong>Diagnostics unreachable</strong>
        </div>
        <div style={{ color: 'var(--fg-3)', fontSize: 10 }}>
          /api/engine-status returned: {fetchError}
        </div>
      </div>
    );
  }

  const env = envelope!;
  const p = env.panel;

  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--bg-2)',
      border: '1px solid var(--line-1)',
      borderRadius: 4,
      fontFamily: 'var(--font-mono)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 8, gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot ok={p.reachable} />
          <span style={{
            fontSize: 12, color: 'var(--fg-1)', fontWeight: 600,
          }}>
            {p.reachable ? 'Engine reachable' : 'Engine unreachable'}
          </span>
          {p.engineVersion && (
            <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>
              v{p.engineVersion}
            </span>
          )}
          {p.workspaceSlug && (
            <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>
              · {p.workspaceSlug}
            </span>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          style={{
            padding: '3px 9px',
            fontSize: 9, letterSpacing: '0.1em', fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            background: 'transparent',
            border: '1px solid var(--line-2)',
            color: loading ? 'var(--fg-3)' : 'var(--fg-2)',
            borderRadius: 2,
            cursor: loading ? 'default' : 'pointer',
          }}
        >
          {loading ? 'REFRESHING…' : 'REFRESH'}
        </button>
      </div>

      {/* v12.0.3: ENGINE STATUS row — last /api/gcp-state proxy outcome.
          Distinct from the /v1/status panel above; this is the last
          actual classification call's success/failure. Pulled from
          useGcpState.lastError when the parent passes it in. */}
      {aiLastError && (
        <div style={{
          marginBottom: 8, padding: '8px 10px',
          background: 'rgba(196,90,90,0.08)',
          border: '1px solid #c45a5a55',
          borderLeft: '2px solid #c45a5a',
          borderRadius: 3,
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'baseline', marginBottom: 4, gap: 8,
          }}>
            <span style={{
              fontSize: 9, letterSpacing: '0.18em',
              color: 'var(--fg-4)', fontWeight: 600,
              textTransform: 'uppercase',
            }}>
              Engine status
            </span>
            <span style={{
              fontSize: 11, color: '#c45a5a',
              fontFamily: 'var(--font-mono)',
              fontWeight: 700, fontVariantNumeric: 'tabular-nums',
            }}>
              {aiLastError.error.status != null
                ? `${aiLastError.error.status}`
                : aiLastError.httpStatus}
              {' · '}
              {aiLastError.error.type.replace(/_/g, ' ')}
            </span>
          </div>
          <div style={{
            fontSize: 10, color: 'var(--fg-2)', lineHeight: 1.45,
          }}>
            {aiLastError.error.message}
          </div>
          {/* Operator hints keyed off the typed error class. */}
          {aiLastError.error.type === 'manual_required' && (
            <div style={{ marginTop: 4, fontSize: 9, color: 'var(--fg-3)' }}>
              Background auto-loop calls are blocked by design. Click RUN AI ANALYSIS to fire a deliberate Engine call.
            </div>
          )}
          {aiLastError.error.type === 'engine_forbidden' && (
            <div style={{ marginTop: 4, fontSize: 9, color: 'var(--fg-3)' }}>
              Auth / config issue — check ENGINE_API_KEY value, header name (X-API-Key), and Engine route auth.
            </div>
          )}
          {aiLastError.error.type === 'config_missing' && (
            <div style={{ marginTop: 4, fontSize: 9, color: 'var(--fg-3)' }}>
              Server-side env missing — set ENGINE_BASE_URL + ENGINE_API_KEY in the Vercel project.
            </div>
          )}
          {aiLastError.error.type === 'budget_exceeded' && (
            <div style={{ marginTop: 4, fontSize: 9, color: 'var(--fg-3)' }}>
              Workspace budget cap reached. Top up or adjust on the Engine admin.
            </div>
          )}
          {aiLastError.error.type === 'route_missing' && (
            <div style={{ marginTop: 4, fontSize: 9, color: 'var(--fg-3)' }}>
              No active routing rule for gcp_state on this workspace. Configure one on the Engine.
            </div>
          )}
          {aiLastError.error.type === 'invalid_classification_shape' && (
            <div style={{ marginTop: 4, fontSize: 9, color: 'var(--fg-3)' }}>
              Engine returned a body the proxy could not normalize into a classification. Check the `[ENGINE PROXY] raw response` server log for the actual shape.
            </div>
          )}
        </div>
      )}

      {/* Config / capability rows */}
      <Row
        label="Configured"
        value={env.configured ? 'yes' : 'no — env missing'}
        tone={env.configured ? 'good' : 'warn'}
      />
      <Row
        label="Route configured"
        value={p.routeConfigured ? 'yes' : 'no'}
        tone={p.routeConfigured ? 'good' : 'warn'}
      />
      <Row
        label="Provider available"
        value={p.providerAvailable ? 'yes' : 'no'}
        tone={p.providerAvailable ? 'good' : 'warn'}
      />
      <Row
        label="Budget OK"
        value={p.budgetOk ? 'yes' : 'no'}
        tone={p.budgetOk ? 'good' : 'warn'}
      />
      <Row
        label="Memory active"
        value={p.memoryActive == null ? '—' : (p.memoryActive ? 'yes (recent row)' : 'idle')}
        tone={p.memoryActive ? 'good' : 'muted'}
      />
      <Row
        label="Engine last success age"
        value={formatAge(p.lastSuccessAgeMs)}
      />

      {/* Degraded flags */}
      {p.degraded.length > 0 && (
        <div style={{
          marginTop: 8, padding: '6px 8px',
          background: 'rgba(212,160,40,0.10)',
          border: '1px solid #d4a02855',
          borderRadius: 3,
          fontSize: 10, color: '#d4a028',
        }}>
          <strong>Degraded:</strong> {p.degraded.join(', ')}
        </div>
      )}

      {/* Last classification echo */}
      <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--line-1)' }}>
        <div style={{
          fontSize: 9, letterSpacing: '0.16em', color: 'var(--fg-4)',
          textTransform: 'uppercase', marginBottom: 4,
        }}>
          Last classification (this instance)
        </div>
        <Row label="Model"          value={p.lastModel        ?? '—'} />
        <Row label="Provider"       value={p.lastProvider     ?? '—'} />
        <Row label="Route source"   value={p.lastRouteSource  ?? '—'} />
        <Row label="Latency"        value={p.lastLatencyMs != null ? `${p.lastLatencyMs}ms` : '—'} />
        <Row
          label="Fallback used"
          value={p.lastFallback == null ? '—' : (p.lastFallback ? 'yes' : 'no')}
          tone={p.lastFallback ? 'warn' : 'default'}
        />
        <Row label="Deployment id"  value={p.lastDeploymentId ?? '—'} />
        <Row
          label="Cached age (proxy)"
          value={formatAge(env.lastClassificationAgeMs)}
        />
      </div>

      {/* Last fetch + per-instance error */}
      <div style={{
        marginTop: 8, fontSize: 9, color: 'var(--fg-4)',
        display: 'flex', justifyContent: 'space-between', gap: 8,
      }}>
        <span>
          Polled {lastFetchedAt ? lastFetchedAt.toLocaleTimeString() : '—'}
        </span>
        {env.lastError && (
          <span style={{ color: '#d4a028' }}>{env.lastError}</span>
        )}
      </div>
    </div>
  );
}
