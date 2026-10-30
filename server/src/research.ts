import { createHash } from 'crypto';

import * as reportContract from '../../core/schemas/research-report.schema.json';
import * as sourceContract from '../../core/schemas/source-item.schema.json';
import {
  RESEARCH_EXCERPT_CHARS,
  RESEARCH_HTTP_BYTES,
  RESEARCH_QUOTE_CHARS,
  type ResearchReport,
  type SourceItem,
  type SourceKind,
} from '../../core/src/research.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

const sourceValidator = compileSchema<SourceItem>(sourceContract);
const reportValidator = compileSchema<ResearchReport>(reportContract);
export const RESEARCH_REPORT_SCHEMA = (
  'default' in reportContract ? reportContract.default : reportContract
) as Record<string, unknown>;
export const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function validateSourceItem(value: unknown): SourceItem {
  const item = validateSchema(sourceValidator, value);
  for (const date of [item.retrievedAt, item.publishedAt].filter((v) => v !== undefined))
    if (!date || !/^\d{4}-\d\d-\d\dT/.test(date) || !Number.isFinite(Date.parse(date)))
      throw new Error('Invalid source date');
  if (item.url) {
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid source URL');
  }
  if (item.contentHash !== sourceHash(item.excerpt)) throw new Error('Source hash mismatch');
  return item;
}
export function makeSource(
  input: Omit<SourceItem, 'id' | 'contentHash' | 'retrievedAt'>,
): SourceItem {
  const excerpt = input.excerpt.slice(0, RESEARCH_EXCERPT_CHARS);
  const contentHash = sourceHash(excerpt);
  return validateSourceItem({
    ...input,
    excerpt,
    contentHash,
    id: sourceHash(`${input.adapter}:${input.url ?? input.citation}:${contentHash}`),
    retrievedAt: new Date().toISOString(),
  });
}
export interface ResearchSearchOptions {
  question?: string;
  limit: number;
  since?: string;
  signal: AbortSignal;
}
export interface ResearchAdapter {
  id: string;
  kinds: readonly SourceKind[];
  search?: (query: string, options: ResearchSearchOptions) => Promise<SourceItem[]>;
  fetch?: (ref: string, options: ResearchSearchOptions) => Promise<SourceItem[]>;
  unavailable?: string;
}
/** Composition root registers modules; the registry knows no concrete adapter. */
export class ResearchAdapters {
  private readonly entries = new Map<string, ResearchAdapter>();
  register(adapter: ResearchAdapter): void {
    if (
      !adapter.id ||
      this.entries.has(adapter.id) ||
      !adapter.kinds.length ||
      (!adapter.search && !adapter.fetch && !adapter.unavailable)
    )
      throw new Error('Invalid or duplicate research adapter');
    this.entries.set(adapter.id, adapter);
  }
  all(): ResearchAdapter[] {
    return [...this.entries.values()];
  }
}
export function validateResearchReport(source: string, sources: SourceItem[]): ResearchReport {
  if (Buffer.byteLength(source) > RESEARCH_HTTP_BYTES) throw new Error('ResearchReport too large');
  const report = validateSchema(reportValidator, JSON.parse(source));
  const byId = new Map(sources.map((s) => [s.id, validateSourceItem(s)]));
  if (byId.size !== sources.length) throw new Error('Duplicate source IDs');
  const lookup = (id: string) => {
    const s = byId.get(id);
    if (!s) throw new Error(`Unknown source: ${id}`);
    return s;
  };
  const quotedCharacters = new Map<string, number>();
  for (const finding of report.findings) {
    const evidence = finding.sources.map(lookup);
    // Conservative independence: both identifiable authors/channels AND domains must differ.
    const independent = evidence.some((a) =>
      evidence.some((b) => {
        const identity = (s: SourceItem) => (s.author ?? s.channel ?? '').trim().toLowerCase();
        const domain = (s: SourceItem) =>
          // Conservative without a PSL dependency: related subdomains are never independent.
          // Multi-label public suffixes may collapse unrelated sites (safe downgrade).
          s.url ? new URL(s.url).hostname.toLowerCase().split('.').slice(-2).join('.') : '';
        return (
          a.contentHash !== b.contentHash &&
          identity(a) &&
          identity(b) &&
          identity(a) !== identity(b) &&
          domain(a) &&
          domain(b) &&
          domain(a) !== domain(b)
        );
      }),
    );
    if (finding.confidence !== 'low' && !independent) {
      finding.confidence = 'low';
      finding.reason = `${finding.reason.slice(0, 3800)}; runtime: fewer than two independent sources.`;
    }
    for (const quote of finding.quotes ?? []) {
      const total = (quotedCharacters.get(quote.sourceId) ?? 0) + quote.text.length;
      quotedCharacters.set(quote.sourceId, total);
      if (
        total > RESEARCH_QUOTE_CHARS ||
        !finding.sources.includes(quote.sourceId) ||
        quote.text.length > RESEARCH_QUOTE_CHARS ||
        !lookup(quote.sourceId).excerpt.includes(quote.text)
      )
        throw new Error('Invalid attributed quote');
    }
  }
  for (const contradiction of report.contradictions) contradiction.sources.forEach(lookup);
  report.discardedSources.forEach((s) => lookup(s.id));
  // Never trust model-authored metadata or bibliography.
  if (report.bibliography.length) throw new Error('Bibliography is runtime-owned; return []');
  report.bibliography = structuredClone(sources);
  return report;
}
