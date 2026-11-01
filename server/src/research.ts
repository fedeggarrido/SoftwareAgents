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
import {
  EXTERNAL_HANDOFF_ITEMS,
  EXTERNAL_HANDOFF_TEXT_CHARS,
  type ExternalReaderResult,
  validateExternalReaderResult,
} from './externalContent.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

const sourceValidator = compileSchema<SourceItem>(sourceContract);
const reportValidator = compileSchema<ResearchReport>(reportContract);
export const RESEARCH_REPORT_SCHEMA = (
  'default' in reportContract ? reportContract.default : reportContract
) as Record<string, unknown>;
/** What the CLI enforces on the model: same shape, no length/extra-field limits, so one
 * overlong quote or an explanatory field cannot discard the whole report (it did, twice).
 * The runtime normalizes and enforces the strict contract afterwards. */
export const RESEARCH_MODEL_SCHEMA = (function relax(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relax);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) => !['maxLength', 'maxItems', 'minItems', 'additionalProperties'].includes(key),
      )
      .map(([key, child]) => [key, relax(child)]),
  );
})(RESEARCH_REPORT_SCHEMA) as Record<string, unknown>;

/** Keep only contract fields; model extras (e.g. a contradiction explanation) are dropped. */
function normalizeReport(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  const pick = (value: unknown, keys: string[]) =>
    value && typeof value === 'object'
      ? Object.fromEntries(
          keys
            .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
            .map((k) => [k, (value as Record<string, unknown>)[k]]),
        )
      : value;
  const list = (value: unknown) => (Array.isArray(value) ? value : value);
  return {
    summary: r.summary,
    findings: Array.isArray(r.findings)
      ? r.findings.map((f) => {
          const finding = pick(f, ['claim', 'type', 'confidence', 'reason', 'sources', 'quotes']);
          const quotes = (finding as Record<string, unknown>).quotes;
          if (Array.isArray(quotes))
            (finding as Record<string, unknown>).quotes = quotes.map((q) =>
              pick(q, ['sourceId', 'text']),
            );
          return finding;
        })
      : r.findings,
    contradictions: Array.isArray(r.contradictions)
      ? r.contradictions.map((c) => pick(c, ['claim', 'sources']))
      : r.contradictions,
    gaps: list(r.gaps),
    discardedSources: Array.isArray(r.discardedSources)
      ? r.discardedSources.map((d) => pick(d, ['id', 'reason']))
      : r.discardedSources,
    bibliography: list(r.bibliography),
  };
}
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
  return { ...item, provenance: 'untrusted-external' };
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
  language?: string;
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
  const parsed = normalizeReport(JSON.parse(source)) as Record<string, unknown>;
  // Overlong or unverifiable quotes are dropped below with a note, never the whole report.
  for (const finding of Array.isArray(parsed.findings) ? parsed.findings : [])
    if (Array.isArray((finding as { quotes?: unknown[] }).quotes))
      (finding as { quotes: { text?: unknown }[] }).quotes = (
        finding as { quotes: { text?: unknown }[] }
      ).quotes.filter((q) => typeof q.text === 'string' && q.text.length <= RESEARCH_QUOTE_CHARS);
  // A claim with no cited source is not a finding: it becomes a gap (spec: every claim cites).
  if (Array.isArray(parsed.findings)) {
    const unsourced = (parsed.findings as { claim?: unknown; sources?: unknown }[]).filter(
      (f) => !Array.isArray(f.sources) || f.sources.length === 0,
    );
    if (unsourced.length) {
      parsed.findings = (parsed.findings as unknown[]).filter(
        (f) => !unsourced.includes(f as never),
      );
      parsed.gaps = [
        ...(Array.isArray(parsed.gaps) ? parsed.gaps : []),
        ...unsourced.map((f) => `Unsupported claim (no cited source): ${String(f.claim ?? '')}`),
      ];
    }
  }
  const report = validateSchema(reportValidator, parsed);
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
    // Independence (spec: not the same author/channel/repost): different content and
    // different registrable domains; authors/channels must also differ when both are known.
    // Web pages often omit an author, which must not make W3C + MDN look dependent.
    const independent = evidence.some((a) =>
      evidence.some((b) => {
        const identity = (s: SourceItem) => (s.author ?? s.channel ?? '').trim().toLowerCase();
        const domain = (s: SourceItem) =>
          // Conservative without a PSL dependency: related subdomains are never independent.
          // Multi-label public suffixes may collapse unrelated sites (safe downgrade).
          s.url ? new URL(s.url).hostname.toLowerCase().split('.').slice(-2).join('.') : '';
        return (
          a.contentHash !== b.contentHash &&
          domain(a) &&
          domain(b) &&
          domain(a) !== domain(b) &&
          !(identity(a) && identity(b) && identity(a) === identity(b))
        );
      }),
    );
    if (finding.confidence !== 'low' && !independent) {
      finding.confidence = 'low';
      finding.reason = `${finding.reason.slice(0, 3800)}; runtime: fewer than two independent sources.`;
    }
    // Copyright and attribution limits stay strict: a quote that is too long, over the
    // per-source budget, unattributed or not verbatim in the excerpt is removed, not kept.
    const kept: NonNullable<typeof finding.quotes> = [];
    for (const quote of finding.quotes ?? []) {
      const total = (quotedCharacters.get(quote.sourceId) ?? 0) + quote.text.length;
      if (
        total > RESEARCH_QUOTE_CHARS ||
        !finding.sources.includes(quote.sourceId) ||
        quote.text.length > RESEARCH_QUOTE_CHARS ||
        !byId.has(quote.sourceId) ||
        !lookup(quote.sourceId).excerpt.includes(quote.text)
      )
        continue;
      quotedCharacters.set(quote.sourceId, total);
      kept.push(quote);
    }
    if (finding.quotes && kept.length !== finding.quotes.length) {
      finding.reason = `${finding.reason.slice(0, 3800)}; runtime: removed quotes over the limit or not verbatim.`;
      finding.quotes = kept;
    }
  }
  for (const contradiction of report.contradictions) contradiction.sources.forEach(lookup);
  report.discardedSources.forEach((s) => lookup(s.id));
  // Never trust model-authored metadata or bibliography.
  if (report.bibliography.length) throw new Error('Bibliography is runtime-owned; return []');
  report.bibliography = structuredClone(sources);
  return report;
}

/** Handoff facts carry no links, quotes or code spans: a claim stays data even if a
 * source phrased it as an instruction. */
export function handoffText(claim: string): string {
  return claim
    .replace(/\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/gi, '[link removed]')
    .replace(/[`"\u201c\u201d\u00ab\u00bb]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXTERNAL_HANDOFF_TEXT_CHARS);
}

/** Revalidate the reader output and its sources before exporting a bounded handoff.
 * Full reports remain evidence artifacts and must never be supplied to a tool role. */
export function researchHandoff(source: string, sources: SourceItem[]): ExternalReaderResult {
  const report = validateResearchReport(source, sources);
  return validateExternalReaderResult({
    kind: 'external-reader-result',
    facts: report.findings.slice(0, EXTERNAL_HANDOFF_ITEMS).map((finding) => ({
      text: handoffText(finding.claim),
      confidence: finding.confidence,
    })),
    insufficientEvidence: report.gaps.length > 0 || report.findings.length === 0,
  });
}
