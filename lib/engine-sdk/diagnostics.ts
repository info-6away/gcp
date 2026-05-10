/**
 * Phase 11A — Engine diagnostics panel data shape.
 *
 * Pure projection over `EngineStatusResponse` + an optional
 * `ClassificationMeta` from the most recent classification. The shape
 * is what GCP Pro (or any other app) renders into a small
 * "Engine status" panel. No DOM, no React — the SDK stays renderless
 * so it can ship into Next, Remix, plain Node scripts, etc.
 *
 * Reachability is implied by whether `getStatus` resolved at all; the
 * caller should pass `null` for `status` when the call threw.
 */

import type {
  ClassificationMeta,
  DegradedFlag,
  EngineStatusResponse,
} from "./types";

export type EngineDiagnosticsPanel = {
  /** True when the Engine answered `/v1/status` successfully. */
  reachable: boolean;
  /** Engine version reported by the status response, when available. */
  engineVersion: string | null;
  /** Workspace slug, for display ("you are talking to engine for: <slug>"). */
  workspaceSlug: string | null;
  /** True when a routing rule is configured for this task. */
  routeConfigured: boolean;
  /**
   * True when the task's primary provider OR a fallback (OpenRouter)
   * is configured at the Engine. False means the call will fail
   * with `provider_unavailable` until an operator adds keys.
   */
  providerAvailable: boolean;
  /** Workspace budget is not blocked. */
  budgetOk: boolean;
  /**
   * Phase 9A — `gcp_state` only today. true = a memory row landed in
   * the last hour, indicating the longitudinal layer is being fed.
   * null when the task doesn't expose memory.
   */
  memoryActive: boolean | null;
  /** Time since the last successful call for (workspace, task), in ms. */
  lastSuccessAgeMs: number | null;
  /** Server-reported degraded flags, surfaced for an "Engine degraded" badge. */
  degraded: DegradedFlag[];

  // Last-classification echo — empty until at least one successful call.
  lastModel: string | null;
  lastProvider: string | null;
  lastRouteSource: ClassificationMeta["routeSource"] | null;
  lastLatencyMs: number | null;
  lastFallback: boolean | null;
  lastDeploymentId: string | null;
};

/**
 * Combine a `/v1/status?task=…` response with the most recent
 * `ClassificationMeta` to produce the panel snapshot. Always returns
 * a value — degraded states project as `reachable: false` plus
 * default-off booleans, so a UI binding to this shape never has to
 * deal with `undefined`.
 */
export function buildEngineDiagnostics(args: {
  status: EngineStatusResponse | null;
  lastMeta?: ClassificationMeta | null;
}): EngineDiagnosticsPanel {
  const { status, lastMeta } = args;
  const reachable = !!status?.ok;

  // The task block is optional even on a reachable status response —
  // present only when the caller passed `?task=` and the task is
  // known. When absent, we project everything as "off".
  const task = status?.task ?? null;

  return {
    reachable,
    engineVersion: status?.engineVersion ?? null,
    workspaceSlug: status?.workspaceSlug ?? null,
    routeConfigured: task?.routeConfigured ?? false,
    providerAvailable: task?.providerAvailable ?? false,
    budgetOk: task?.budgetOk ?? false,
    memoryActive: task?.memoryActive ?? null,
    lastSuccessAgeMs: task?.lastSuccessAgeMs ?? null,
    degraded: status?.degraded ?? [],

    lastModel: lastMeta?.model ?? null,
    lastProvider: lastMeta?.provider ?? null,
    lastRouteSource: lastMeta?.routeSource ?? null,
    lastLatencyMs: lastMeta?.latencyMs ?? null,
    lastFallback: lastMeta?.fallback ?? null,
    lastDeploymentId: lastMeta?.deploymentId ?? null,
  };
}

/**
 * Convenience — a minimal "is the Engine degraded for this task?"
 * decision used to gate UI affordances. Returns true when ANY of:
 *   - the status call failed,
 *   - the engine reported a degraded flag,
 *   - the task block reports route or provider unavailable,
 *   - the workspace budget is blocked.
 *
 * Apps can also derive their own predicates; this is the common case.
 */
export function isEngineDegraded(panel: EngineDiagnosticsPanel): boolean {
  if (!panel.reachable) return true;
  if (panel.degraded.length > 0) return true;
  if (!panel.routeConfigured) return true;
  if (!panel.providerAvailable) return true;
  if (!panel.budgetOk) return true;
  return false;
}
