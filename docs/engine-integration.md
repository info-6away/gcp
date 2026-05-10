# GCP Pro ↔ 6away Engine integration

## Phase v12 — Engine SDK integration

GCP Pro v12.0.0 wires the 6away Engine via the official Engine SDK
(`@6away/engine-client`, vendored at [`lib/engine-sdk/`](../lib/engine-sdk/))
instead of a hand-rolled fetch.

This document is the contract between GCP Pro and the Engine — what
each side owns, the on-wire shape, the env vars, the failure modes,
and how to verify the integration after a deploy.

---

## Ownership boundary

**CRITICAL: do NOT move GCP Pro logic into the Engine.**

| Layer | Owner |
| --- | --- |
| GCP ingestion (gcp2.net polling) | GCP Pro |
| Gold / BTC / Silver price sync | GCP Pro |
| Net Variance + slope + curvature + CED + PSS | GCP Pro |
| Regime classification + bands | GCP Pro |
| Pattern detection (AL / SJ / FA / …) | GCP Pro |
| Pattern story / lifecycle / dominant pattern | GCP Pro |
| Payload construction (`buildGcpStatePayload`) | GCP Pro |
| **AI state classification** | **Engine** |
| Anchor pass (`anchorAiState`) | GCP Pro |
| Shock-decay rules | GCP Pro |
| State-transition ladder (`deriveNextState`) | GCP Pro |
| Directional pressure (`deriveDirectionalPressure`) | GCP Pro |
| Guru stance (`deriveStance`) | GCP Pro |
| `aiStateHistory` ledger | GCP Pro |
| Chart rendering / alerts | GCP Pro |
| Provider routing / fallback / model selection | Engine |
| Evaluations / replay / deployments | Engine |
| Memory / governance | Engine |
| `/v1/status` capability snapshot | Engine |
| Schema-out-of-date / degraded flags | Engine |
| Classification `_meta` (model, provider, latency, …) | Engine |

The Engine receives a `GcpStateRequest` and returns a
`GcpStateResponse`. GCP Pro applies all post-processing locally —
the Engine never sees anchored / transitioned / pressure-loaded
state. This keeps the two repos independently shippable.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Browser (client component)                                     │
│                                                                │
│  useGcpState ──▶ classifyGcpState(payload)                     │
│                  POST /api/gcp-state                           │
└──────────────────────────┬─────────────────────────────────────┘
                           │  ⛔ never sees ENGINE_API_KEY
                           ▼
┌────────────────────────────────────────────────────────────────┐
│ GCP Pro server (Vercel function — app/api/gcp-state/route.ts)  │
│                                                                │
│  • Refuse non-manual requests (cost gate)                      │
│  • Strip `manual` field                                        │
│  • engine.classifyGcpState(payload)                            │
│  • On success: LastClassificationCache.put(...)                │
│  • On failure: LastClassificationCache.get(...)                │
│       → return { ...cached, stale: true, staleReason }         │
└──────────────────────────┬─────────────────────────────────────┘
                           │  ENGINE_API_KEY (X-API-Key header)
                           ▼
┌────────────────────────────────────────────────────────────────┐
│ 6away Engine — /v1/coherence/gcp-state, /v1/status             │
└────────────────────────────────────────────────────────────────┘
```

Same pattern for diagnostics: browser polls
`GET /api/engine-status` → that server route calls
`engine.getStatus("gcp_state")` and runs
`buildEngineDiagnostics({ status, lastMeta })` to project the answer
into the panel-shaped envelope.

---

## Env vars

Server-side **only**. Never expose to the browser. The proxy reads
the first value present in each pair:

| Preferred name | Legacy fallback | Required |
| --- | --- | --- |
| `ENGINE_BASE_URL` | `GCP_ENGINE_BASE_URL` | yes — e.g. `https://engine.example.com` |
| `ENGINE_API_KEY` | `GCP_ENGINE_API_KEY` | yes — workspace API key, sent as `X-API-Key` |

The legacy names are accepted so existing Vercel deployments keep
working without rotating secrets. New projects should use the
preferred names.

If either is missing, `isEngineConfigured()` returns `false` and:

- `/api/gcp-state` returns the last-good cache entry tagged
  `stale: true, staleReason: "config_missing"` — or HTTP 503 if
  nothing is cached yet.
- `/api/engine-status` returns `reachable: false, configured: false`
  with `lastError: "engine_not_configured"`.

There is **no** `NEXT_PUBLIC_ENGINE_*` variable. Never add one.

---

## Local post-processing pipeline (preserved)

The order is identical to pre-v12:

```
Engine response  (GcpStateResponse, optionally with _meta)
    │
    ▼  lib/aiStateAnchor.anchorAiState
Anchor pass (FA hard guard, compression/post-shock biases,
             discharge preference, confidence ±10-20%)
    │
    ▼  lib/stateTransition.deriveNextState
Transition ladder overlay (nextLikelyState, transitionConfidence)
    │
    ▼  lib/directionalPressure.deriveDirectionalPressure
Pressure overlay (longPressure, shortPressure, pressureBand)
    │
    ▼  lib/guruStance.deriveStance
Stance derivation (for UI)
    │
    ▼  setState + appendAiStateHistory
UI binding + research ledger
```

The Engine MUST NOT compute any of these. If a future engine wants
to ship its own version of one of these passes, GCP Pro will need
an explicit migration plan — not a silent override.

---

## Response shape additions (v12.0.0)

```ts
type GcpStateResponse = {
  // … all the v11.x fields (state, stateCode, direction, phase,
  // strength, confidence, coherenceType, marketBias,
  // goldInterpretation, reasoningShort, invalidators, watchNext)
  // remain unchanged …

  // Engine SDK — Phase 11A `_meta` diagnostics.
  _meta?: {
    model:        string | null;
    provider:     string | null;
    routeSource:  'workspace_override' | 'global' | 'default' | 'deployment_canary' | null;
    fallback:     boolean;
    latencyMs:    number | null;
    deploymentId: string | null;
  };

  // GCP Pro proxy — attached when the request was served from
  // LastClassificationCache because the Engine call failed.
  stale?:        boolean;
  staleReason?:  'engine_unavailable'
              | 'budget_exceeded'
              | 'rate_limited'
              | 'route_missing'
              | 'provider_unavailable'
              | 'config_missing'
              | 'unknown_error';
  staleAgeMs?:   number;
};
```

UI rules:

- `_meta` is best-effort; tolerate any sub-field being missing.
- When `stale === true`, render a STALE chip in Guru header.
- `staleAgeMs` is wall-clock since the cached entry was captured —
  good for "stale 47s" badges.

---

## Fallback behavior

`LastClassificationCache` is per-process in memory (`Map`). It
survives within a warm Vercel function instance but is wiped on
cold start. The cache key is `"gcp_state"` (task-level granularity);
swap to `"gcp_state:${symbol}:${tf}"` if per-market staleness is
ever needed.

| Engine call result | Proxy behavior |
| --- | --- |
| Success | Cache, return body unchanged. |
| `EngineBudgetExceededError` (429) | Try cache → stale `budget_exceeded`. Else 429. |
| `EngineRateLimitedError` (429) | Try cache → stale `rate_limited`. Else 429. |
| `EngineRouteMissingError` (503) | Try cache → stale `route_missing`. Else 503. |
| `EngineProviderUnavailableError` (503) | Try cache → stale `provider_unavailable`. Else 503. |
| `EngineUnavailableError` (network/timeout/5xx) | Try cache → stale `engine_unavailable`. Else 502. |
| Anything else | Try cache → stale `unknown_error`. Else 502. |

Stale responses are always HTTP 200 — the client treats them as a
real classification with the `stale` flag flipped. UI must not
treat stale = error; it's a degraded-but-usable read.

---

## Diagnostics surface

`GET /api/engine-status` returns:

```ts
type EngineStatusEnvelope = {
  panel: EngineDiagnosticsPanel;   // from lib/engine-sdk/diagnostics.ts
  lastClassificationAgeMs: number | null;
  lastError: string | null;
  configured: boolean;
  timestamp: string;
};
```

Rendered in Settings → "Engine Integration" (desktop) and
Settings → ENGINE INTEGRATION (mobile). Auto-polls every 60s; click
REFRESH to force.

Fields the panel surfaces:

- `reachable` — Engine `/v1/status` responded.
- `engineVersion`, `workspaceSlug` — Engine self-report.
- `routeConfigured` — Engine has a routing rule for `gcp_state`.
- `providerAvailable` — Primary provider OR OpenRouter fallback OK.
- `budgetOk` — Workspace budget not blocked.
- `memoryActive` — Memory row landed in the last hour.
- `lastSuccessAgeMs` — Engine-reported age of last successful run.
- `degraded[]` — Engine warning flags.
- Per-call: `lastModel`, `lastProvider`, `lastRouteSource`,
  `lastLatencyMs`, `lastFallback`, `lastDeploymentId`.

---

## Cost gate (`manual: true`)

Pre-existing v11.18.5 server-side kill-switch is **preserved**:
the proxy refuses any POST that doesn't have `manual: true`.
This is GCP-Pro-internal — the flag is stripped before forwarding
to the SDK so the Engine never sees it.

Auto-loop must still be opt-in via Settings → Advanced. Even with
auto enabled, every call passes `manual: true` (deliberately
overloading the semantic for the simplest possible gate). If that
becomes a problem, replace the gate with a token-bucket on the
proxy rather than weakening it.

---

## How to verify integration

After a deploy:

1. **Env present** — Vercel project → Settings → Environment
   Variables should have `ENGINE_BASE_URL` and `ENGINE_API_KEY`
   (or the legacy `GCP_ENGINE_*` names). Production scope only;
   never preview/dev.

2. **Diagnostics panel green** — Open Settings → Engine
   Integration. Reachable should be green, route configured = yes,
   provider available = yes, budget OK = yes.

3. **Manual classification works** — Click "RUN AI ANALYSIS" on
   Guru. Within ~20s you should see a fresh state. The Guru header
   `_meta` chip should show `MODEL <name>` + `PROVIDER <id>` +
   latency.

4. **Stale fallback works** — Temporarily set
   `ENGINE_BASE_URL=https://invalid.example.com` in a preview env.
   The Engine-Integration panel should flip to unreachable; Guru's
   "RUN AI ANALYSIS" should still return the previously cached
   result with a STALE badge. Revert when done.

5. **Cost gate works** — Use DevTools to POST `/api/gcp-state`
   without `manual: true`. Should return 403 `manual_required`.

6. **Browser bundle is clean** — `grep -r "ENGINE_API_KEY" .next/`
   should yield zero matches. Same for `GCP_ENGINE_API_KEY`.

---

## Updating the vendored SDK

The vendored SDK at [`lib/engine-sdk/`](../lib/engine-sdk/) is a
copy of `c:/dev/6awayEngine/src/client/`. To refresh:

```powershell
Copy-Item -Recurse -Force c:/dev/6awayEngine/src/client/*.ts c:/dev/GCP/lib/engine-sdk/
```

Run typecheck + build after refreshing — the SDK is type-stable
but the Engine occasionally adds new optional fields that flow
through `_meta`.

Do NOT edit the vendored files directly. Patch upstream in the
Engine repo and re-vendor.
