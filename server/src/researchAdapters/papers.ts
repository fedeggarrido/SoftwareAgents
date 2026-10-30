import { setTimeout as delay } from 'timers/promises';

import { makeSource, type ResearchAdapter } from '../research.js';
import { type ResearchHttp, researchHttp } from '../researchHttp.js';
import { readableText } from './web.js';

const USER_AGENT = 'SoftwareAgents-Research/1.0 (https://github.com/pixel-agents-hq/pixel-agents)';
const PAPER_INTERVAL_MS = 3100;
const FAILURE_PAUSE_MS = 60 * 60 * 1000;
const text = (value: string) => readableText(value).slice(0, 1000);
const date = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

/** Atom metadata only. No PDF links are followed; entities never resolve external resources. */
const STOP_WORDS = new Set(
  'a an and are as at be by can do does for from how in is it of on or that the this to was what when which who why will with'.split(
    ' ',
  ),
);

/** arXiv applies a field prefix to one term only: `all:Does a lower temperature …` matched
 * physics papers on "temperature". Use content keywords joined with AND instead. */
export function arxivQuery(question: string): string {
  const terms = [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^\p{L}\p{N}-]+/u)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  ]
    // Six ANDed terms returned nothing in the real run; the longest terms are the most
    // distinctive (e.g. hallucinations, temperature, language), so AND only three.
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  return terms.length ? terms.map((t) => `all:${t}`).join(' AND ') : `all:${question}`;
}

export function normalizeArxiv(atom: string, limit: number) {
  return [...atom.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)]
    .slice(0, limit)
    .flatMap((match) => {
      const entry = match[1];
      const field = (name: string) =>
        new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(entry)?.[1] ?? '';
      const id = text(field('id')).match(/arxiv\.org\/abs\/([a-zA-Z0-9./-]+)$/)?.[1];
      const title = text(field('title'));
      if (!id || !title) return [];
      const author = [...entry.matchAll(/<name\b[^>]*>([\s\S]*?)<\/name>/g)]
        .map((m) => text(m[1]))
        .join(', ')
        .slice(0, 500);
      const doi = text(field('arxiv:doi'));
      return [
        makeSource({
          adapter: 'arxiv',
          kind: 'paper',
          url: `https://arxiv.org/abs/${id}`,
          title,
          ...(author ? { author } : {}),
          publishedAt: date(field('published')),
          channel: text(field('arxiv:journal_ref') || 'arXiv').slice(0, 500),
          ...(doi ? { citation: `DOI: ${doi}`.slice(0, 1000) } : {}),
          excerpt: readableText(field('summary')),
          language: 'und',
        }),
      ];
    });
}
interface ScholarPaper {
  paperId?: string;
  title?: string;
  authors?: { name: string }[];
  abstract?: string;
  publicationDate?: string;
  year?: number;
  venue?: string;
  citationCount?: number;
  externalIds?: { DOI?: string };
}
export function normalizeSemanticScholar(value: { data?: ScholarPaper[] }, limit: number) {
  return (value.data ?? []).slice(0, limit).flatMap((paper) => {
    if (!paper.paperId || !paper.title) return [];
    const author = (paper.authors ?? [])
      .map((a) => a.name)
      .join(', ')
      .slice(0, 500);
    return [
      makeSource({
        adapter: 'semantic-scholar',
        kind: 'paper',
        url: `https://www.semanticscholar.org/paper/${encodeURIComponent(paper.paperId)}`,
        title: paper.title.slice(0, 1000),
        ...(author ? { author } : {}),
        publishedAt: date(
          paper.publicationDate ?? (paper.year ? `${paper.year}-01-01` : undefined),
        ),
        ...(paper.venue ? { channel: paper.venue.slice(0, 500) } : {}),
        ...(paper.externalIds?.DOI
          ? { citation: `DOI: ${paper.externalIds.DOI}`.slice(0, 1000) }
          : {}),
        ...(Number.isFinite(paper.citationCount) && paper.citationCount! >= 0
          ? { signals: { citations: paper.citationCount } }
          : {}),
        excerpt: paper.abstract ?? '',
        language: 'und',
      }),
    ];
  });
}
/** Conservative shared pacing per service, across adapter instances. Errors suspend requests. */
const nextRequest = new Map<string, number>();
const blockedUntil = new Map<string, number>();
export function paperAdapter(
  service: 'arxiv' | 'semantic-scholar',
  http: ResearchHttp = researchHttp,
): ResearchAdapter {
  return {
    id: service,
    kinds: ['paper'],
    search: async (query, options) => {
      if (options.limit <= 0) return [];
      const now = Date.now();
      if (now < (blockedUntil.get(service) ?? 0))
        throw new Error('Paper service suspended after request failure');
      const slot = Math.max(now, nextRequest.get(service) ?? 0);
      nextRequest.set(service, slot + PAPER_INTERVAL_MS);
      await delay(slot - now, undefined, { signal: options.signal });
      const limit = Math.min(options.limit, 100);
      const url =
        service === 'arxiv'
          ? `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(arxivQuery(query))}&max_results=${limit}`
          : `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,abstract,publicationDate,year,venue,citationCount,externalIds`;
      try {
        const response = await http(url, {
          signal: options.signal,
          headers: { 'User-Agent': USER_AGENT },
        });
        return service === 'arxiv'
          ? normalizeArxiv(response.text, limit)
          : normalizeSemanticScholar(JSON.parse(response.text), limit);
      } catch (error) {
        blockedUntil.set(service, Date.now() + FAILURE_PAUSE_MS);
        throw error;
      }
    },
  };
}
