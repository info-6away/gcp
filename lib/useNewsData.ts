'use client';

import { useState, useEffect, useCallback } from 'react';
import type { DataPoint } from '@/types/gcp';

export interface NewsItem {
  title:       string;
  source:      string;
  publishedAt: number;
  link:        string;
  regime:      string | null;
  nv:          number | null;
  // v14.3: which candidate source supplied this headline (RSS feed
  // vs Brave search). Optional so older shapes still validate.
  provider?:   'rss' | 'brave';
}

interface RawNewsItem {
  title:       string;
  source:      string;
  publishedAt: number;
  link:        string;
  provider?:   'rss' | 'brave';
}

function findRegimeAtTime(series: DataPoint[], ts: number): { regime: string; nv: number } | null {
  if (!series.length) return null;

  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t < ts) lo = mid + 1;
    else hi = mid;
  }

  const candidate = series[Math.min(lo, series.length - 1)];
  const diff = Math.abs(candidate.t - ts);
  if (diff > 7_200_000) return null;

  return { regime: candidate.r, nv: +candidate.v.toFixed(1) };
}

export function useNewsData(series: DataPoint[]) {
  const [items, setItems]     = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchNews = useCallback(async () => {
    try {
      const res = await fetch('/api/news');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();

      const tagged: NewsItem[] = ((data.items as RawNewsItem[]) ?? []).map(item => {
        const ctx = findRegimeAtTime(series, item.publishedAt);
        return {
          ...item,
          regime: ctx?.regime ?? null,
          nv:     ctx?.nv     ?? null,
        };
      });

      setItems(tagged);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [series]);

  useEffect(() => {
    fetchNews();
    const id = setInterval(fetchNews, 180_000);
    return () => clearInterval(id);
  }, [fetchNews]);

  return { items, loading, error };
}
