import type { ResearchOperatorConfig, SourceItem } from '../../../core/src/research.js';
import { makeSource, type ResearchAdapter, type ResearchSearchOptions } from '../research.js';
import { type ResearchHttp, researchHttp } from '../researchHttp.js';

interface RedditData {
  id?: string;
  title?: string;
  selftext?: string;
  body?: string;
  author?: string;
  subreddit?: string;
  permalink?: string;
  score?: number;
  created_utc?: number;
  replies?: Listing;
}
interface Listing {
  data?: { children?: { kind: string; data: RedditData }[] };
}
export function normalizeReddit(value: unknown, limit: number) {
  const sources: SourceItem[] = [];
  const visit = (listing: Listing) => {
    for (const child of listing?.data?.children ?? []) {
      if (sources.length >= limit) break;
      if (!['t1', 't3'].includes(child.kind)) continue;
      const d = child.data;
      if (!d.id || !d.permalink || !d.author) continue;
      const url = new URL(d.permalink, 'https://www.reddit.com');
      if (url.origin !== 'https://www.reddit.com') throw new Error('Invalid Reddit permalink');
      sources.push(
        makeSource({
          adapter: 'reddit',
          url: url.href,
          title: (d.title ?? `Comment ${d.id}`).slice(0, 1000),
          author: d.author,
          ...(d.subreddit ? { channel: d.subreddit } : {}),
          ...(d.created_utc ? { publishedAt: new Date(d.created_utc * 1000).toISOString() } : {}),
          kind: 'thread',
          excerpt: d.body ?? d.selftext ?? '',
          language: 'und',
          ...(Number.isFinite(d.score) ? { signals: { votes: d.score! } } : {}),
        }),
      );
      if (d.replies && typeof d.replies === 'object') visit(d.replies);
    }
  };
  for (const listing of Array.isArray(value) ? value : [value]) visit(listing as Listing);
  return sources;
}
export function redditAdapter(
  config?: ResearchOperatorConfig['reddit'],
  http: ResearchHttp = researchHttp,
): ResearchAdapter {
  if (!config)
    return {
      id: 'reddit',
      kinds: ['thread'],
      unavailable: 'Reddit unavailable: Operator OAuth app-only credentials required.',
    };
  let token: string | undefined;
  let expires = 0;
  let blockedUntil = 0;
  const call = async (pathname: string, options: ResearchSearchOptions) => {
    if (Date.now() < blockedUntil) throw new Error('Reddit rate limit: retry later');
    // OAuth errors must not produce repeated credential requests for each seed.
    blockedUntil = Date.now() + 60 * 60 * 1000;
    if (!token || Date.now() >= expires) {
      const auth = await http('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        signal: options.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          'User-Agent': config.userAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const data = JSON.parse(auth.text) as { access_token?: string; expires_in?: number };
      if (!data.access_token || !data.expires_in || data.expires_in <= 0)
        throw new Error('Reddit OAuth unavailable');
      token = data.access_token;
      expires = Date.now() + data.expires_in * 1000;
    }
    // Reserve pacing before I/O; HTTP errors including 429 never trigger retries.
    blockedUntil = Date.now() + 1000;
    let result: Awaited<ReturnType<ResearchHttp>>;
    try {
      result = await http(`https://oauth.reddit.com${pathname}`, {
        signal: options.signal,
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': config.userAgent },
      });
    } catch {
      blockedUntil = Date.now() + 60 * 60 * 1000;
      throw new Error('Reddit request failed; adapter suspended for this run.');
    }
    const remaining = result.headers.get('x-ratelimit-remaining');
    const reset = Number(result.headers.get('x-ratelimit-reset'));
    if (remaining !== null && Number(remaining) < 1)
      blockedUntil = Date.now() + Math.max(60, reset || 0) * 1000;
    return normalizeReddit(JSON.parse(result.text), options.limit);
  };
  return {
    id: 'reddit',
    kinds: ['thread'],
    search: (query, options) =>
      call(
        `/search?q=${encodeURIComponent(query)}&limit=${options.limit}&sort=new&raw_json=1`,
        options,
      ),
    fetch: (ref, options) => {
      const url = new URL(ref);
      if (
        url.protocol !== 'https:' ||
        !['reddit.com', 'www.reddit.com'].includes(url.hostname) ||
        !/^\/r\/[^/]+\/comments\/[a-z0-9]+(?:\/[^/]*)?\/?$/i.test(url.pathname) ||
        url.username ||
        url.password
      )
        throw new Error('Expected Reddit thread URL');
      return call(
        `${url.pathname.replace(/\/$/, '')}.json?limit=${options.limit}&raw_json=1`,
        options,
      );
    },
  };
}
