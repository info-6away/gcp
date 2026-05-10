/**
 * Phase 10C — Engine client types.
 *
 * Hand-written TypeScript types matching the public Engine contract.
 * Decoupled from the Engine's internal Zod schemas so consumers can
 * import the client module without pulling in `zod` or `drizzle-orm`
 * as transitive dependencies.
 *
 * If the public response shape changes (rare — the Engine treats
 * /v1/* response shapes as a versioned contract), update these
 * types AND publish a new client version.
 */

// ---------------------------------------------------------------------------
// /v1/status — Phase 10B contract
// ---------------------------------------------------------------------------

export type DegradedFlag =
  | "provider_unavailable"
  | "budget_exceeded"
  | "schema_out_of_date"
  | "route_missing"
  | "rate_limited";

export type BudgetStatus = "ok" | "warning" | "blocked" | "unlimited";
export type RateLimitStatus = "ok" | "throttled";

export type SupportedCapabilities = {
  routing: boolean;
  workspaceBudgets: boolean;
  evaluationsAvailable: boolean;
  deploymentsAvailable: boolean;
  /** Per-task memory availability. The Engine ships gcp_state today. */
  memoryAvailable: { gcp_state: boolean } & Record<string, boolean>;
};

export type CurrentLimits = {
  monthlyBudget: BudgetStatus;
  rateLimit: RateLimitStatus;
};

/** Optional per-task block returned when the caller passed `?task=…`. */
export type TaskStatus = {
  task: string;
  routeConfigured: boolean;
  providerAvailable: boolean;
  budgetOk: boolean;
  /** Time since the last successful call for this (workspace, task);
   *  null when nothing has succeeded yet. */
  lastSuccessAgeMs: number | null;
  /** Phase 9A — gcp_state-only today. true means a memory row landed
   *  in the last hour. null for tasks without memory. */
  memoryActive: boolean | null;
};

export type EngineStatusResponse = {
  ok: boolean;
  engineVersion: string;
  workspaceId: string;
  workspaceSlug: string | null;
  workspaceDisplayName: string | null;
  enabledTasks: string[];
  supportedCapabilities: SupportedCapabilities;
  currentLimits: CurrentLimits;
  degraded: DegradedFlag[];
  task?: TaskStatus;
  timestamp: string;
};

// ---------------------------------------------------------------------------
// /v1/coherence/gcp-state — minimal request/response shape
// ---------------------------------------------------------------------------

/**
 * Minimal request shape for `classifyGcpState`. The Engine accepts a
 * larger schema (priorState / patternStory / timeframeContext / etc.);
 * we expose the required fields here and accept arbitrary extra keys
 * via the index signature so callers don't need to upgrade the SDK
 * every time the Engine adds an optional input.
 */
export type GcpStateRequest = {
  symbol?: string;
  timeframe?: string;
  windowMinutes?: number;
  current: { netVariance: number; regime: string; regimeName: string };
  series: Array<{ t: number; v: number }>;
  metrics: {
    slope: number;
    curvature: number;
    ced: number;
    compressionDuration: number;
    oscillationTightness: number;
    pss: number;
  };
  recentPatterns?: Array<Record<string, unknown>>;
  goldContext?: Record<string, unknown>;
  /** Index signature for optional Engine-internal fields callers may
   *  set without us tracking every one. */
  [key: string]: unknown;
};

export type GcpStateCode = "CS" | "DD" | "IS" | "AT" | "SS" | "CL" | "SH" | "FA" | "DS";
export type GcpStateDirection = "Up" | "Down" | "Neutral" | "Mixed";
export type GcpStatePhase = "Early" | "Mid" | "Late" | "Exhausted";

/**
 * Phase 11A — Optional classification metadata returned alongside a
 * gcp-state response. `_meta` lives outside the validated domain
 * contract so the Engine can ship richer diagnostics without forcing
 * a breaking schema change. Consumers should treat the whole field
 * as best-effort and tolerate any sub-field being missing.
 */
export type RouteSource =
  | "workspace_override"
  | "global"
  | "default"
  | "deployment_canary";

export type ClassificationMeta = {
  /** Effective model id used for the call (post-fallback). */
  model: string | null;
  /** Effective provider used for the call (post-fallback). */
  provider: string | null;
  /** Where the route resolution came from. */
  routeSource: RouteSource | null;
  /** True when the call dropped to a cross-provider fallback. */
  fallback: boolean;
  /** End-to-end Engine-side latency in ms. */
  latencyMs: number | null;
  /** Active deployment id when the call ran on a candidate route. */
  deploymentId: string | null;
};

export type GcpStateResponse = {
  state: string;
  stateCode: GcpStateCode;
  direction: GcpStateDirection;
  phase: GcpStatePhase;
  strength: number;
  confidence: number;
  coherenceType: string;
  marketBias: string;
  goldInterpretation: string;
  reasoningShort: string;
  invalidators: string[];
  watchNext: string[];
  /** Optional Phase 11A diagnostics surface — always safe to ignore. */
  _meta?: ClassificationMeta;
};

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export type EngineClientOptions = {
  /** Engine base URL, e.g. `https://engine.example.com`. No trailing slash. */
  baseUrl: string;
  /** Workspace API key. Sent as `X-API-Key` on every request. */
  apiKey: string;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Number of retry attempts on retry-safe failures (network /
   *  timeout / 5xx). Default 2 (=> up to 3 total attempts). 4xx
   *  errors are NEVER retried. */
  retries?: number;
  /** Initial backoff in ms; doubled on each retry, capped at 5s. */
  retryBaseDelayMs?: number;
  /** Optional override for fetch (testing). */
  fetchImpl?: typeof fetch;
};

/** Per-call options that override the client defaults. */
export type RequestOptions = {
  timeoutMs?: number;
  retries?: number;
  /** Forward an AbortSignal so a calling app's "user navigated
   *  away" cancellation propagates. */
  signal?: AbortSignal;
};
