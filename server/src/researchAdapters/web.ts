import type { ResearchOperatorConfig } from '../../../core/src/research.js';
import { RESEARCH_EXCERPT_CHARS } from '../../../core/src/research.js';
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
/** Select bounded evidence, retaining document order and section attribution as untrusted data. */
export function relevantExcerpts(document: string, question = '', plain = false): string {
  const text = plain ? document : readableText(document);
  if (text.length <= RESEARCH_EXCERPT_CHARS || !question.trim()) return text;
  const terms = (value: string) =>
    value
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const variants: Record<string, string> = {
    contraste: 'contrast',
    requisitos: 'requirements',
    texto: 'text',
    calcula: 'calculate',
    calculo: 'calculate',
    luminancia: 'luminance',
    relativa: 'relative',
    relacion: 'ratio',
  };
  const normalize = (word: string) => variants[word] ?? word.replace(/(?:ing|es|s)$/, '');
  const query = new Set(
    terms(question)
      .filter((word) => word.length > 2)
      .map(normalize),
  );
  let heading = 'Document';
  const segments: { text: string; score: number; index: number }[] = [];
  const blocks = plain
    ? document.split(/\n\s*\n/).map((body) => ({ body, heading: false, anchor: '' }))
    : [
        ...document
          .replace(/<(script|style|noscript|nav|footer|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
          .matchAll(/<(h[1-6]|p|li|dt|dd)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi),
      ].map((match) => ({
        body: readableText(match[3]),
        heading: /^h/.test(match[1]),
        anchor: /\bid=["']([^"']+)/i.exec(match[2])?.[1] ?? '',
      }));
  for (const block of blocks) {
    if (block.heading) heading = `${block.body}${block.anchor ? ` #${block.anchor}` : ''}`;
    if (!block.body.trim()) continue;
    // Chunk long paragraphs so a match near their end is not lost to prefix truncation.
    const words = block.body.split(/\s+/);
    let chunk = '';
    const add = () => {
      const body = `[${heading.slice(0, 200)}]\n${chunk}`;
      const overlap = new Set(
        terms(body)
          .map(normalize)
          .filter((word) => query.has(word)),
      );
      segments.push({ text: body, score: overlap.size, index: segments.length });
    };
    for (const word of words) {
      if (chunk.length + word.length > 550 && chunk) {
        add();
        chunk = '';
      }
      chunk += `${chunk ? ' ' : ''}${word}`;
    }
    if (chunk) add();
  }
  const selected = segments.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 6);
  if (!selected.some((segment) => segment.score)) return text;
  return selected
    .sort((a, b) => a.index - b.index)
    .map((segment) => segment.text)
    .join('\n\n')
    .slice(0, RESEARCH_EXCERPT_CHARS);
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
        excerpt: relevantExcerpts(text, options.question, /^text\/plain\b/i.test(type)),
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
