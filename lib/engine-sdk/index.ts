/**
 * Phase 10C — Engine client public exports.
 *
 * App repos that integrate with 6away Engine import from this entry
 * point:
 *
 *   import {
 *     EngineClient,
 *     EngineBudgetExceededError,
 *     EngineRouteMissingError,
 *     EngineUnavailableError,
 *     type EngineStatusResponse,
 *   } from "@6away/engine-client"; // or relative path when copy-pasted
 *
 * The client is self-contained — no zod, no drizzle, no Engine
 * internals. Copy this directory verbatim into another repo and it
 * compiles.
 */

export { EngineClient, extractWarnings } from "./client";
export {
  EngineError,
  EngineUnavailableError,
  EngineBudgetExceededError,
  EngineRateLimitedError,
  EngineProviderUnavailableError,
  EngineRouteMissingError,
  EngineSchemaOutOfDateWarning,
  classifyResponseError,
  type EngineErrorBody,
} from "./errors";
export {
  isRetriable,
  backoffFor,
  withRetry,
  MAX_BACKOFF_MS,
} from "./retry";
export {
  LastClassificationCache,
  type CachedClassification,
} from "./cache";
export {
  buildEngineDiagnostics,
  isEngineDegraded,
  type EngineDiagnosticsPanel,
} from "./diagnostics";
export type {
  EngineClientOptions,
  RequestOptions,
  EngineStatusResponse,
  TaskStatus,
  SupportedCapabilities,
  CurrentLimits,
  DegradedFlag,
  BudgetStatus,
  RateLimitStatus,
  GcpStateRequest,
  GcpStateResponse,
  GcpStateCode,
  GcpStateDirection,
  GcpStatePhase,
  ClassificationMeta,
  RouteSource,
} from "./types";
