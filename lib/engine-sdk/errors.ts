/**
 * Phase 10C — Engine client typed error hierarchy.
 *
 * Apps catch `EngineError` for the broad case and the specific
 * subclasses for actionable cases. Every error carries the original
 * HTTP status when one was available, the structured body the
 * Engine returned (if any), and a `degraded` array on warning-class
 * errors so app UIs can surface the cause without parsing strings.
 *
 * Design rules (enforced by tests):
 *   - Errors NEVER stringify the API key, the prompt, or any field
 *     the Engine considers admin-only.
 *   - Subclass selection is deterministic: a 429 with
 *     `detail = "budget_exceeded"` always becomes
 *     `EngineBudgetExceededError`, not the generic rate-limited.
 *   - Network / timeout / 5xx → `EngineUnavailableError`.
 *
 * Apps doing simple integration:
 *
 *   try {
 *     await engine.classifyGcpState(payload);
 *   } catch (err) {
 *     if (err instanceof EngineBudgetExceededError) showFallbackUI();
 *     else if (err instanceof EngineRateLimitedError) backoff();
 *     else if (err instanceof EngineRouteMissingError) showSetupHint();
 *     else if (err instanceof EngineUnavailableError) showRetryUI();
 *     else throw err;
 *   }
 */

export type EngineErrorBody = {
  /** The Engine's structured error envelope from
   *  `errorResponse(message, status, details)` — wrapped in `{ error: {…} }`. */
  message?: string;
  ok?: false;
  /** Top-level `error` is the nested envelope object;
   *  inner-level `error` is the string failure class. Same key,
   *  different semantics by depth — accept either. */
  error?: unknown;
  reason?: string;
  detail?: string;
  /** When the body came from the Phase 9B schema-drift classifier. */
  code?: string;
  hint?: string;
  /** Phase 10B `/v1/status` response, when status was OK but degraded. */
  degraded?: string[];
  // Pass-through of any other top-level fields, intentionally unstructured.
  [key: string]: unknown;
};

export class EngineError extends Error {
  /** HTTP status code, when the failure was a non-2xx response.
   *  null for network/timeout failures where no response was received. */
  status: number | null;
  /** The parsed body, when one came back. null for network failures. */
  body: EngineErrorBody | null;

  constructor(message: string, status: number | null, body: EngineErrorBody | null) {
    super(message);
    this.name = "EngineError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Engine reachable but reported a budget-exceeded gate. Maps to:
 *   { reason: "rate_limited", detail: "budget_exceeded" }
 * (HTTP 429 from /v1/coherence/gcp-state and friends; or /v1/status
 *  with `degraded` containing "budget_exceeded".)
 */
export class EngineBudgetExceededError extends EngineError {
  constructor(message: string, status: number | null, body: EngineErrorBody | null) {
    super(message, status, body);
    this.name = "EngineBudgetExceededError";
  }
}

/**
 * Engine reachable but reported per-minute rate-limit pressure
 * (NOT a budget cap). Apps should back off and retry.
 */
export class EngineRateLimitedError extends EngineError {
  constructor(message: string, status: number | null, body: EngineErrorBody | null) {
    super(message, status, body);
    this.name = "EngineRateLimitedError";
  }
}

/**
 * The workspace's policy blocks the model the routing rule resolves
 * to AND the OpenRouter fallback isn't allowed either. Until an
 * operator fixes routing, calls won't succeed. Apps should show a
 * setup-hint UI rather than retrying.
 */
export class EngineProviderUnavailableError extends EngineError {
  constructor(message: string, status: number | null, body: EngineErrorBody | null) {
    super(message, status, body);
    this.name = "EngineProviderUnavailableError";
  }
}

/**
 * No active routing rule for the (workspace, task) pair. Until an
 * admin configures one (`/admin/routing` or workspace override),
 * calls won't succeed.
 */
export class EngineRouteMissingError extends EngineError {
  constructor(message: string, status: number | null, body: EngineErrorBody | null) {
    super(message, status, body);
    this.name = "EngineRouteMissingError";
  }
}

/**
 * Network failure, timeout, or 5xx-class infrastructure failure.
 * Retry-safe (the client retries automatically by default).
 */
export class EngineUnavailableError extends EngineError {
  /** Whether the failure was a fetch-level error (no response) vs a
   *  server-level error (5xx). Useful for triage; both are retried. */
  cause: "network" | "timeout" | "server";

  constructor(
    message: string,
    cause: "network" | "timeout" | "server",
    status: number | null,
    body: EngineErrorBody | null,
  ) {
    super(message, status, body);
    this.name = "EngineUnavailableError";
    this.cause = cause;
  }
}

/**
 * NOT thrown — surfaced via `result.warnings` on getStatus(), or
 * attached to recoverable errors. Schema drift means the engine
 * is running stale admin tooling; apps don't depend on the missing
 * tables, so they keep working. Apps should LOG this for ops, not
 * fail.
 */
export class EngineSchemaOutOfDateWarning {
  readonly name = "EngineSchemaOutOfDateWarning";
  message: string;
  hint: string;

  constructor(message: string, hint: string) {
    this.message = message;
    this.hint = hint;
  }
}

/**
 * Pure helper: classify a non-2xx response body into the right
 * subclass. Tested directly. Decoupled from `fetch` so retry logic
 * can dry-run classification without a request.
 */
export function classifyResponseError(
  status: number,
  body: EngineErrorBody | null,
): EngineError {
  // /v1/* failures wrap the actual fields under `body.error`. Fall
  // through to the top-level when the wrapper isn't present (e.g.
  // /v1/status returns the structure flat).
  const envelope = (body?.error && typeof body.error === "object"
    ? (body.error as EngineErrorBody)
    : body) ?? {};

  const reason = typeof envelope.reason === "string" ? envelope.reason : null;
  const detail = typeof envelope.detail === "string" ? envelope.detail : null;
  const message =
    typeof envelope.message === "string"
      ? envelope.message
      : typeof body?.message === "string"
        ? body.message
        : `HTTP ${status}`;

  // Budget gate — the Engine's canonical shape from Phase 5A.
  if (reason === "rate_limited" && (detail === "budget_exceeded" || detail === "hourly_cost_ceiling")) {
    return new EngineBudgetExceededError(message, status, body);
  }
  if (reason === "rate_limited" || status === 429) {
    return new EngineRateLimitedError(message, status, body);
  }
  if (reason === "provider_disabled") {
    return new EngineProviderUnavailableError(message, status, body);
  }
  if (status === 503 && envelope.error === "anthropic_key_missing") {
    return new EngineProviderUnavailableError(message, status, body);
  }
  // Schema drift surfaces as 503 with code; Phase 9B contract.
  if (status === 503 && (envelope.code === "missing_table" || envelope.code === "missing_column")) {
    // Apps can keep working through schema drift — but classify it
    // as Unavailable so the calling code retries, gives ops time to
    // run db:push, etc.
    return new EngineUnavailableError(message, "server", status, body);
  }
  if (status >= 500) {
    return new EngineUnavailableError(message, "server", status, body);
  }
  // Default: throw the generic EngineError so callers can still
  // .status / .body it.
  return new EngineError(message, status, body);
}
