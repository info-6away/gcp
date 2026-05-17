import { NextResponse } from 'next/server';

// ── RSS sources ─────────────────────────────────────────────────────
// v14.3.1: Reuters + AP public RSS endpoints were discontinued
// (feeds.reuters.com / feeds.apnews.com no longer resolve). Replaced
// with NPR World + two finance-focused feeds (CNBC, MarketWatch) —
// better macro/markets coverage for a trading terminal.
const FEEDS = [
  { name: 'BBC World',      url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Al Jazeera',     url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
  { name: 'NPR World',      url: 'https://feeds.npr.org/1004/rss.xml' },
  { name: 'CNBC',           url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'MarketWatch',    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
];

// ── Brave News Search ───────────────────────────────────────────────
// v14.3: Brave is an ADDITIONAL candidate source — broader coverage
// and search intent that RSS feeds miss or lag on. Brave only supplies
// headline candidates; it never determines importance or impact. The
// client still runs local classifyNews() + deriveNewsReactionScore()
// over every candidate regardless of where it came from.
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/news/search';
const BRAVE_QUERIES = [
  'gold price market',
  'bitcoin cryptocurrency',
  'federal reserve interest rates central bank',
  'forex dollar euro yen currency',
  'war conflict geopolitics',
  'election results',
];
// Brave's API quota is finite — cache the Brave portion for 20 min so
// repeated /api/news polls (every 3 min per client) don't burn it.
// RSS still refreshes on every request.
const BRAVE_TTL_MS = 20 * 60_000;

interface NewsItem {
  title:       string;
  source:      string;
  publishedAt: number;
  link:        string;
  provider:    'rss' | 'brave';
}

const DAY_MS = 86_400_000;

// ── RSS parsing ─────────────────────────────────────────────────────
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
    if (Date.now() - ts > DAY_MS) continue;

    items.push({ title, source: sourceName, publishedAt: ts, link, provider: 'rss' });
  }

  return items;
}

// ── Brave parsing helpers ───────────────────────────────────────────
function stripMarkup(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

// Brave returns a relative "age" string ("5 hours ago"); turn it into
// an absolute ms timestamp when the ISO page_age is missing.
function parseRelativeAge(s: string): number | null {
  const m = s.match(/(\d+)\s*(minute|hour|day|week)s?/i);
  if (!m) return null;
  const n    = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms =
      unit === 'minute' ? 60_000
    : unit === 'hour'   ? 3_600_000
    : unit === 'day'    ? DAY_MS
    :                     7 * DAY_MS;
  return Date.now() - n * ms;
}

function cleanHost(host: string): string {
  return host.replace(/^www\./, '').toLowerCase();
}

function parseBraveResults(json: unknown): NewsItem[] {
  const out: NewsItem[] = [];
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return out;

  for (const raw of results) {
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === 'string' ? stripMarkup(r.title) : '';
    const link  = typeof r.url === 'string' ? r.url : '';
    if (!title || !link) continue;

    let ts = NaN;
    if (typeof r.page_age === 'string') ts = Date.parse(r.page_age);
    if (!isFinite(ts) && typeof r.age === 'string') {
      const rel = parseRelativeAge(r.age);
      if (rel != null) ts = rel;
    }
    if (!isFinite(ts)) ts = Date.now();
    if (Date.now() - ts > DAY_MS) continue;

    const meta = r.meta_url as { hostname?: string; netloc?: string } | undefined;
    const host = meta?.hostname || meta?.netloc || 'brave';

    out.push({
      title, link, publishedAt: ts,
      source:   cleanHost(host),
      provider: 'brave',
    });
  }
  return out;
}

// ── Brave fetch + module cache ──────────────────────────────────────
let braveCache:    { items: NewsItem[]; at: number } | null = null;
let braveInflight: Promise<NewsItem[]> | null = null;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function braveQuery(key: string, q: string): Promise<NewsItem[]> {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(q)}`
    + `&count=12&country=us&search_lang=en&freshness=pd`;
  const headers = {
    'Accept':               'application/json',
    'Accept-Encoding':      'gzip',
    'X-Subscription-Token': key,
  };
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(7_000), cache: 'no-store' });
  // One backoff retry on 429 — the free tier's 1 req/sec limiter can
  // still trip on burst, even with the inter-query spacing below.
  if (res.status === 429) {
    await sleep(1_500);
    res = await fetch(url, { headers, signal: AbortSignal.timeout(7_000), cache: 'no-store' });
  }
  if (!res.ok) throw new Error(`brave ${res.status}`);
  return parseBraveResults(await res.json());
}

async function fetchBraveOnce(key: string): Promise<NewsItem[]> {
  // SEQUENTIAL, not parallel. Brave's free tier allows ~1 request per
  // second — firing all queries concurrently makes every one but the
  // first return 429. Space them ~1.2 s apart. This whole pass runs
  // only on a cache miss (every 20 min), so the ~9 s cost is fine.
  const items: NewsItem[] = [];
  for (let i = 0; i < BRAVE_QUERIES.length; i++) {
    if (i > 0) await sleep(1_200);
    try {
      items.push(...await braveQuery(key, BRAVE_QUERIES[i]));
    } catch (e) {
      console.warn(`[news] Brave query "${BRAVE_QUERIES[i]}" failed:`, e);
    }
  }
  return items;
}

async function getBraveItems(): Promise<NewsItem[]> {
  const key = process.env.BRAVE_API_KEY ?? '';
  if (!key) return [];   // no key configured — RSS-only, no error

  // Serve a warm cache.
  if (braveCache && Date.now() - braveCache.at < BRAVE_TTL_MS) {
    return braveCache.items;
  }
  // Coalesce concurrent cache-miss requests into one fetch.
  if (braveInflight) return braveInflight;

  braveInflight = (async () => {
    try {
      const items = await fetchBraveOnce(key);
      // Only replace the cache on a non-empty fetch; a transient
      // total failure keeps the last good Brave set.
      if (items.length > 0 || !braveCache) {
        braveCache = { items, at: Date.now() };
      }
      return braveCache?.items ?? items;
    } catch (e) {
      console.warn('[news] Brave fetch failed:', e);
      return braveCache?.items ?? [];
    } finally {
      braveInflight = null;
    }
  })();
  return braveInflight;
}

// ── route ───────────────────────────────────────────────────────────
export async function GET() {
  console.log(`[news] Fetching at ${new Date().toISOString()}`);

  const [rssSettled, braveItems] = await Promise.all([
    Promise.allSettled(
      FEEDS.map(async feed => {
        const url = `${feed.url}${feed.url.includes('?') ? '&' : '?'}_=${Date.now()}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent':    'Mozilla/5.0 GCPPro/14.3',
            'Cache-Control': 'no-cache',
            'Pragma':        'no-cache',
          },
          signal: AbortSignal.timeout(6_000),
          cache:  'no-store',
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return parseRSS(await res.text(), feed.name);
      }),
    ),
    getBraveItems(),
  ]);

  const allItems: NewsItem[] = [];
  rssSettled.forEach((r, i) => {
    if (r.status === 'fulfilled') allItems.push(...r.value);
    else console.warn(`[news] Feed "${FEEDS[i].name}" failed:`, r.reason);
  });
  allItems.push(...braveItems);

  // Dedupe by normalised title prefix. RSS is pushed first, so on a
  // collision the RSS copy (with a real pubDate) wins over Brave.
  const seen = new Set<string>();
  const dedupedAll = allItems
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .filter(item => {
      const key = item.title.slice(0, 60).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Prefer the last 6 hours; fall back to the 24 h pool if sparse.
  const SIX_H = 6 * 3_600_000;
  const fresh = dedupedAll.filter(item => Date.now() - item.publishedAt < SIX_H);
  const deduped = (fresh.length >= 8 ? fresh : dedupedAll).slice(0, 45);

  const braveCount = deduped.filter(i => i.provider === 'brave').length;
  console.log(
    `[news] Returning ${deduped.length} items (${braveCount} brave), newest: ${
      deduped[0] ? new Date(deduped[0].publishedAt).toISOString() : 'none'
    }`,
  );

  return NextResponse.json(
    { items: deduped },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
