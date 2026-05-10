## Vendored Engine SDK

These files are a verbatim copy of `c:/dev/6awayEngine/src/client/` (Phase 10C / 11A,
Engine v1.9.59) — the public 6away Engine client. Pinned here so GCP Pro builds
without depending on a workspace path; refresh by re-copying from the Engine repo
whenever a new client release lands.

DO NOT edit these files directly. If a field is missing for GCP Pro's needs,
patch upstream in the Engine repo and re-vendor.

Files:
- `index.ts`        — public exports
- `client.ts`       — `EngineClient`
- `types.ts`        — request/response/options types
- `errors.ts`       — typed error hierarchy
- `retry.ts`        — backoff + retry helpers
- `cache.ts`        — `LastClassificationCache`
- `diagnostics.ts`  — `buildEngineDiagnostics` / `isEngineDegraded`
