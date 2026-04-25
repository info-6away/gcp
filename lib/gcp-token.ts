let _cachedToken: string | null = null;

export async function getGCPToken(): Promise<string> {
  if (process.env.GCP2_BEARER) return process.env.GCP2_BEARER;

  if (_cachedToken) return _cachedToken;

  try {
    const res = await fetch('https://gcp2.net/js/data/api_token.js');
    const js  = await res.text();
    const match = js.match(/Bearer\s+[\w|]+/);
    if (match) {
      _cachedToken = match[0];
      return _cachedToken;
    }
  } catch {
    console.warn('[gcp-token] Could not fetch fresh token');
  }

  throw new Error('No GCP2 bearer token available');
}
