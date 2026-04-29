import { NextResponse } from 'next/server';

// v11.14a: Server proxy for the 6away Engine /v1/coherence/gcp-state
// endpoint. Lives server-side so GCP_ENGINE_API_KEY never reaches the
// browser bundle. Returns either the Engine's raw classification body
// (success) or a structured `{ ok: false, error: "engine_unavailable" }`
// envelope (any failure path) so the client can distinguish a real
// classification from a transient outage without parsing exception types.
//
// SW behaviour: this is a POST route. The v11.11+ service worker
// intercepts only GET requests for /api/*, so this response is never
// cached -- exactly the spec requirement.

const ENGINE_PATH = '/v1/coherence/gcp-state';
// Sonnet calls genuinely take 5-20s; 10s was too tight even for the
// happy path. With one corrective retry on schema fail the Engine
// route caps at ~40s. Give the proxy 35s + the function ceiling 40s
// so a slow-but-successful classification still reaches the client.
const TIMEOUT_MS  = 35_000;

// Without an explicit cap, Vercel kills the function at 10s on Hobby and
// the user sees an empty response. 40s matches the Engine route ceiling
// + a small buffer.
export const maxDuration = 40;

function fail(status: number, error = 'engine_unavailable', extra?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, error, ...(extra ?? {}) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: Request) {
  const baseUrl = process.env.GCP_ENGINE_BASE_URL;
  const apiKey  = process.env.GCP_ENGINE_API_KEY;

  if (!baseUrl || !apiKey) {
    // Env not configured. Don't crash; the client treats this the
    // same as any other failure and keeps the prior AI state in place.
    return fail(503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_request');
  }

  try {
    const upstream = await fetch(`${baseUrl}${ENGINE_PATH}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        // Engine authenticates via X-API-Key, not Authorization: Bearer.
        // Sending Bearer made every upstream call 401 silently.
        'X-API-Key':    apiKey,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!upstream.ok) {
      let upstreamBody = '';
      try { upstreamBody = (await upstream.text()).slice(0, 200); } catch {}
      console.warn('[gcp-state] engine returned', upstream.status, upstreamBody);
      return fail(502, 'engine_unavailable', {
        upstreamStatus: upstream.status,
        upstreamBody,
      });
    }

    // Engine success body is the GcpStateResponse shape -- forward as-is.
    const data = await upstream.json();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    // Timeout (AbortSignal) lands here too via DOMException name TimeoutError.
    console.warn('[gcp-state] proxy error', e);
    return fail(502);
  }
}
