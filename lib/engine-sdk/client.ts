import {
  EngineError,
  EngineUnavailableError,
  EngineSchemaOutOfDateWarning,
  classifyResponseError,
  type EngineErrorBody,
} from "./errors";
import { withRetry } from "./retry";
import type {
  EngineClientOptions,
  EngineStatusResponse,
  GcpStateRequest,
  GcpStateResponse,
  RequestOptions,
} from "./types";

/**
 * Phase 10C — Engine client.
 *
 * Lightweight TypeScript SDK for calling 6away Engine /v1 endpoints.
 * Designed to be copy-pastable into client repos (GCP Pro, Coherence,
 * Rotalink, 6degrees, Ritual) without importing zod, drizzle-orm, or
 * any Engine-internal modules.
 *
 * Public surface:
 *   - new EngineClient({ baseUrl, apiKey, … })
 *   - getStatus(task?)               → EngineStatusResponse
 *   - classifyGcpState(payload)      → GcpStateResponse
 *   - postTask<T>(endpoint, payload) → T (generic escape hatch)
 *
 * Failure modes are typed (errors.ts). Retry policy is exponential
 * with jitter, capped at 5s; only retry-safe errors (network,
 * timeout, 5xx, rate-limited) are retried.
 *
 * No secrets leak: error messages and JSON.stringify'd errors never
 * include the apiKey or the workspace identifier beyond what the
 * Engine itself returns. Tests enforce this.
 */
export class EngineClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: EngineClientOptions) {
    if (!opts.baseUrl) throw new Error("EngineClient: baseUrl is required");
    if (!opts.apiKey) throw new Error("EngineClient: apiKey is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 2;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 250;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * GET /v1/status[?task=…] — workspace + capability snapshot.
   *
   * Apps poll this before / alongside production calls to surface
   * "Engine degraded" UIs cleanly. The response is cached server-side
   * for cheap polling; the SDK does not cache locally — that's the
   * caller's choice.
   *
   * Returns the parsed status; never throws on an *ok-with-degraded*
   * response. Surface degraded flags via `.degraded[]` and act on
   * them in the calling UI.
   */
  async getStatus(task?: string, opts: RequestOptions = {}): Promise<EngineStatusResponse> {
    const search = task ? `?task=${encodeURIComponent(task)}` : "";
    return this.request<EngineStatusResponse>("GET", `/v1/status${search}`, undefined, opts);
  }

  /**
   * POST /v1/coherence/gcp-state — classify a GCP coherence state.
   *
   * Throws the typed Engine* errors when the call fails for a known
   * reason. App pattern:
   *
   *   try {
   *     const result = await engine.classifyGcpState(payload);
   *     // …
   *   } catch (err) {
   *     if (err instanceof EngineBudgetExceededError) showFallback();
   *     else if (err instanceof EngineRouteMissingError) showSetupHint();
   *     else if (err instanceof EngineUnavailableError) showRetry();
   *     else throw err;
   *   }
   */
  async classifyGcpState(
    payload: GcpStateRequest,
    opts: RequestOptions = {},
  ): Promise<GcpStateResponse> {
    return this.postTask<GcpStateResponse>("/v1/coherence/gcp-state", payload, opts);
  }

  /**
   * Generic escape hatch for any /v1/* endpoint that takes a JSON
   * body and returns a JSON body. Useful for endpoints the SDK
   * doesn't yet wrap (like /v1/network/search or /v1/extract).
   *
   * Example:
   *   const matches = await engine.postTask<{ results: NetworkMatch[] }>(
   *     "/v1/network/search",
   *     { query, members },
   *   );
   */
  async postTask<T>(endpoint: string, payload: unknown, opts: RequestOptions = {}): Promise<T> {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    return this.request<T>("POST", path, payload, opts);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const retries = opts.retries ?? this.retries;

    return withRetry(
      async () => this.singleAttempt<T>(method, path, body, timeoutMs, opts.signal),
      { retries, baseDelayMs: this.retryBaseDelayMs, signal: opts.signal },
    );
  }

  private async singleAttempt<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<T> {
    // Combine caller's optional signal with our timeout signal so
    // either source can cancel the in-flight fetch.
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
    const onCallerAbort = () => timeoutCtl.abort(callerSignal!.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: timeoutCtl.signal,
      });
    } catch (err) {
      // Network failure or abort. Distinguish timeout from generic
      // network error so callers' triage logs are actionable.
      const cause: "network" | "timeout" =
        err && typeof err === "object" && "name" in err && (err as { name?: string }).name === "AbortError"
          ? "timeout"
          : "network";
      // Never include `apiKey` in the message; only the URL path
      // (which doesn't contain auth material). The base URL hostname
      // is by definition known to the caller.
      throw new EngineUnavailableError(
        `${method} ${path} ${cause === "timeout" ? "timed out" : "failed"}`,
        cause,
        null,
        null,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    if (res.ok) {
      // Tolerate empty/non-JSON bodies — return undefined-as-T.
      const text = await res.text();
      if (!text) return undefined as unknown as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new EngineUnavailableError(
          `${method} ${path} returned non-JSON body`,
          "server",
          res.status,
          null,
        );
      }
    }

    const errBody = await this.safeBody(res);
    throw classifyResponseError(res.status, errBody);
  }

  private async safeBody(res: Response): Promise<EngineErrorBody | null> {
    try {
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text) as EngineErrorBody;
    } catch {
      return null;
    }
  }
}

/**
 * Phase 10C convenience: extract any schema-drift warnings from a
 * status response. Returns an array (zero or one entries today —
 * Phase 9B only emits `schema_out_of_date`) so apps can iterate +
 * forward to their logger without conditionals.
 */
export function extractWarnings(
  status: EngineStatusResponse,
): EngineSchemaOutOfDateWarning[] {
  const out: EngineSchemaOutOfDateWarning[] = [];
  if (status.degraded.includes("schema_out_of_date")) {
    out.push(
      new EngineSchemaOutOfDateWarning(
        "Engine admin schema is out of date",
        "Operator should run `npm run db:push` on the Engine. App-facing endpoints continue to work.",
      ),
    );
  }
  return out;
}
