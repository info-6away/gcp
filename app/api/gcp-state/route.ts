import { NextResponse } from 'next/server';

// Server proxy for the 6away Engine /v1/coherence/gcp-state endpoint.
// Lives server-side so ENGINE_API_KEY never reaches the browser bundle.
// Returns null with a non-2xx status on every failure path so the client
// helper can fall back gracefully without breaking the UI.

export async function POST(req: Request) {
  const baseUrl = process.env.ENGINE_BASE_URL;
  const apiKey  = process.env.ENGINE_API_KEY;

  if (!baseUrl || !apiKey) {
    // Env not configured -- return null so the UI hides the AI section.
    return NextResponse.json(null, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(null, { status: 400 });
  }

  try {
    const upstream = await fetch(`${baseUrl}/v1/coherence/gcp-state`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key':    apiKey,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    if (!upstream.ok) {
      console.warn('[gcp-state] engine returned', upstream.status);
      return NextResponse.json(null, { status: upstream.status });
    }

    const data = await upstream.json();
    return NextResponse.json(data, {
      // Don't cache classifications -- they're tied to the live series.
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    console.warn('[gcp-state] proxy error', e);
    return NextResponse.json(null, { status: 502 });
  }
}
