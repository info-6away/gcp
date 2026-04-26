import { NextResponse } from 'next/server';

export const revalidate = 300;

const FEEDS = [
  { name: 'Reuters World',   url: 'https://feeds.reuters.com/Reuters/worldNews' },
  { name: 'Reuters Finance', url: 'https://feeds.reuters.com/reuters/businessNews' },
  { name: 'AP Top News',     url: 'https://feeds.apnews.com/rss/topnews' },
  { name: 'BBC World',       url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
];

interface NewsItem {
  title:       string;
  source:      string;
  publishedAt: number;
  link:        string;
}

function parseRSS(xml: string, sourceName: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    const block = match[1];

    const title = (
      block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ??
      block.match(/<title>(.*?)<\/title>/)
    )?.[1]?.trim() ?? '';

    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() ?? '';

    const link = (
      block.match(/<link>(.*?)<\/link>/) ??
      block.match(/<guid>(.*?)<\/guid>/)
    )?.[1]?.trim() ?? '';

    if (!title || !pubDate) continue;

    const ts = new Date(pubDate).getTime();
    if (!isFinite(ts)) continue;

    if (Date.now() - ts > 86_400_000) continue;

    items.push({ title, source: sourceName, publishedAt: ts, link });
  }

  return items;
}

export async function GET() {
  const results = await Promise.allSettled(
    FEEDS.map(async feed => {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 GCPPro/10.0' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const xml = await res.text();
      return parseRSS(xml, feed.name);
    }),
  );

  const allItems: NewsItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allItems.push(...r.value);
  }

  const seen = new Set<string>();
  const deduped = allItems
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .filter(item => {
      const key = item.title.slice(0, 60).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30);

  return NextResponse.json({ items: deduped });
}
