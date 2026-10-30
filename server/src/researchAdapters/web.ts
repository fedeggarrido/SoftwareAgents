import type { ResearchOperatorConfig } from '../../../core/src/research.js';
import { makeSource, type ResearchAdapter } from '../research.js';
import { type ResearchHttp, researchHttp } from '../researchHttp.js';

/** Deliberately conservative text extraction, never execute scripts or load subresources. */
export function readableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|nav|footer|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (s) =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[
          s
        ] ?? s,
    )
    .replace(/\s+/g, ' ')
    .trim();
}
export function webAdapter(
  config?: ResearchOperatorConfig['search'],
  http: ResearchHttp = researchHttp,
): ResearchAdapter {
  const fetchSource: NonNullable<ResearchAdapter['fetch']> = async (ref, options) => {
    const { text, headers } = await http(ref, { signal: options.signal });
    const type = headers.get('content-type') ?? '';
    if (!/^(text\/html|text\/plain|application\/xhtml\+xml)\b/i.test(type))
      throw new Error('Unsupported web content type');
    const title = readableText(
      /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? new URL(ref).hostname,
    ).slice(0, 1000);
    const author = /<meta\b[^>]*name=["']author["'][^>]*content=["']([^"']+)/i.exec(text)?.[1];
    const language = /<html\b[^>]*lang=["']([^"']+)/i.exec(text)?.[1]?.slice(0, 100) ?? 'und';
    const published =
      /<meta\b[^>]*(?:property|name)=["'](?:article:published_time|date)["'][^>]*content=["']([^"']+)/i.exec(
        text,
      )?.[1];
    const publishedAt =
      published && Number.isFinite(Date.parse(published))
        ? new Date(published).toISOString()
        : undefined;
    return [
      makeSource({
        adapter: 'web',
        url: new URL(ref).href,
        title: title || ref.slice(0, 1000),
        ...(author ? { author: readableText(author).slice(0, 500) } : {}),
        kind: 'web',
        excerpt: type.startsWith('text/plain') ? text : readableText(text),
        language,
        ...(publishedAt ? { publishedAt } : {}),
      }),
    ];
  };
  return {
    id: 'web',
    kinds: ['web', 'article'],
    fetch: fetchSource,
    ...(config
      ? {
          search: async (query, options) => {
            const endpoint = new URL(config.endpoint);
            endpoint.searchParams.set('q', query);
            const { text } = await http(endpoint.href, {
              signal: options.signal,
              headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
            });
            const result: unknown = JSON.parse(text);
            if (
              !result ||
              typeof result !== 'object' ||
              !('urls' in result) ||
              !Array.isArray(result.urls) ||
              result.urls.some((u) => typeof u !== 'string')
            )
              throw new Error('Search provider must return {urls: string[]}');
            const sources = [];
            for (const url of result.urls.slice(0, options.limit) as string[])
              sources.push(...(await fetchSource(url, options)));
            return sources;
          },
        }
      : {
          unavailable:
            'Web search unavailable: no Operator search provider configured (URL fetch remains available).',
        }),
  };
}
