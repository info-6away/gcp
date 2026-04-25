import { NextResponse } from 'next/server';
import { getGCPToken } from '@/lib/gcp-token';
import { regimeFor }   from '@/lib/gcp-data';

export const revalidate = 60;

export interface GCPLiveResponse {
  netvar: number | null;
  regime: string | null;
  t:      number;
}

export async function GET(): Promise<NextResponse> {
  try {
    const token = await getGCPToken();

    const res = await fetch('https://gcp2.net/api/getcurrentnetvar', {
      headers: { 'Authorization': token },
      next: { revalidate: 60 },
    });

    if (!res.ok) throw new Error(`GCP2 returned ${res.status}`);

    const data   = await res.json();
    const netvar = parseFloat(data.netvar[0].netvar);

    return NextResponse.json({
      netvar: +netvar.toFixed(1),
      regime: regimeFor(netvar),
      t:      Date.now(),
    });

  } catch (err) {
    console.error('[/api/gcp/live]', err);
    return NextResponse.json(
      { netvar: null, regime: null, t: Date.now(), error: String(err) },
      { status: 500 }
    );
  }
}
