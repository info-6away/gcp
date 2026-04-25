import { NextResponse } from 'next/server';
import { getGCPToken }  from '@/lib/gcp-token';
import { regimeFor }    from '@/lib/gcp-data';
import type { RegimeId } from '@/types/gcp';

export const revalidate = 30;

export interface GCPPoint {
  t: number;
  v: number;
  r: RegimeId;
}

export interface GCPSeriesResponse {
  points:  GCPPoint[];
  count:   number;
  latest:  number;
  source:  'live';
}

export async function GET(): Promise<NextResponse> {
  try {
    const token = await getGCPToken();

    const res = await fetch('https://gcp2.net/api/getNetVarAggregate24H', {
      headers: {
        'Authorization': token,
        'Content-Type':  'application/json',
      },
      next: { revalidate: 30 },
    });

    if (!res.ok) throw new Error(`GCP2 returned ${res.status}`);

    const data = await res.json();
    const aggregates: { end_epoch: number; netvar_aggregate: string | number }[] =
      data.aggregates ?? [];

    const points: GCPPoint[] = aggregates.map(pt => {
      const v = parseFloat(String(pt.netvar_aggregate));
      return {
        t: pt.end_epoch * 1000,
        v: +v.toFixed(1),
        r: regimeFor(v),
      };
    });

    const body: GCPSeriesResponse = {
      points,
      count:  points.length,
      latest: points.at(-1)?.t ?? 0,
      source: 'live',
    };

    return NextResponse.json(body);

  } catch (err) {
    console.error('[/api/gcp]', err);
    return NextResponse.json(
      { points: [], count: 0, latest: 0, source: 'live', error: String(err) },
      { status: 500 }
    );
  }
}
