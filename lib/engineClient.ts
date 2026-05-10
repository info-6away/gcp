// v12.0.0 — Server-only EngineClient factory.
//
// Single shared EngineClient + LastClassificationCache instance per
// Node/serverless process. Lives in lib/ but is intended for API route
// imports ONLY — never bundled to the browser, because reading the
// API key in client code would leak it.
//
// Env vars (server-side, never NEXT_PUBLIC_):
//   ENGINE_BASE_URL       preferred
//   ENGINE_API_KEY        preferred
//   GCP_ENGINE_BASE_URL   legacy fallback (kept so existing prod env
//                         continues to work without redeploying secrets)
//   GCP_ENGINE_API_KEY    legacy fallback
//
// Pattern:
//   import { getEngineClient, lastClassificationCache } from '@/lib/engineClient';
//   const engine = getEngineClient();      // throws if not configured
//   const ok = isEngineConfigured();       // never throws

// IMPORTANT: server-only module. Importing this from a client component
// would leak ENGINE_API_KEY into the browser bundle. Only API routes
// (`app/api/**/route.ts`) may import this file.

import {
  EngineClient,
  LastClassificationCache,
} from '@/lib/engine-sdk';

const BASE_URL_ENV = ['ENGINE_BASE_URL', 'GCP_ENGINE_BASE_URL'] as const;
const API_KEY_ENV  = ['ENGINE_API_KEY',  'GCP_ENGINE_API_KEY']  as const;

function readEnv(keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.length > 0) return v;
  }
  return null;
}

export function getEngineEnv(): { baseUrl: string | null; apiKey: string | null } {
  return {
    baseUrl: readEnv(BASE_URL_ENV),
    apiKey:  readEnv(API_KEY_ENV),
  };
}

export function isEngineConfigured(): boolean {
  const { baseUrl, apiKey } = getEngineEnv();
  return !!baseUrl && !!apiKey;
}

// Module-level singletons. Vercel keeps a warm Node process for a
// while, so the same client + cache are reused across invocations on
// that instance. A cold start gets a fresh pair — that's fine, the
// stale fallback degrades gracefully when empty.
let _client: EngineClient | null = null;
export function getEngineClient(): EngineClient {
  if (_client) return _client;
  const { baseUrl, apiKey } = getEngineEnv();
  if (!baseUrl || !apiKey) {
    throw new Error('Engine is not configured (missing ENGINE_BASE_URL / ENGINE_API_KEY)');
  }
  _client = new EngineClient({
    baseUrl,
    apiKey,
    // 35s — leaves a small buffer under our route's maxDuration=40.
    timeoutMs: 35_000,
    // The SDK retries network / timeout / 5xx. Two retries with the
    // SDK's default backoff (~250ms, 500ms) stays comfortably inside
    // our timeout.
    retries: 2,
  });
  return _client;
}

// Single shared in-memory cache. Per-process, not cross-instance —
// good enough for the warm-instance stale window; cold starts get an
// empty cache and the very first request after a cold start cannot
// fall back to stale. Acceptable trade-off for v12.0.
export const lastClassificationCache = new LastClassificationCache({ maxEntries: 32 });
