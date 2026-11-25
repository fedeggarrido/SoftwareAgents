import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { RESEARCH_EXCERPT_CHARS } from '../../core/src/research.js';
import { makeSource, researchHandoff, validateResearchReport } from '../src/research.js';
import { podcastAdapter } from '../src/researchAdapters/podcast.js';
import type { ResearchHttp } from '../src/researchHttp.js';

const feed = readFileSync(join(__dirname, 'fixtures/research/podcast.xml'), 'utf8');
const ref = 'https://publisher.example/feed.xml';
const options = () => ({ limit: 2, signal: new AbortController().signal });
const response = (text: string, type: string) => ({
  text,
  headers: new Headers({ 'content-type': type }),
});

describe('publisher podcast RSS', () => {
  it('reads metadata and only declared text transcripts through bounded HTTP', async () => {
    const http = vi.fn<ResearchHttp>(async (url) =>
      url === ref
        ? response(feed, 'application/rss+xml')
        : response('Published transcript. '.repeat(400), 'text/plain'),
    );
    const adapter = podcastAdapter(http);
    const sources = await adapter.fetch!(ref, options());
    expect(adapter.search).toBeUndefined();
    expect(adapter.unavailable).toContain('discovery unavailable');
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      adapter: 'podcast',
      kind: 'podcast',
      title: 'Episode & evidence',
      author: 'Publisher',
      channel: 'Publisher show',
      language: 'es',
      publishedAt: '2026-11-24T10:00:00.000Z',
      provenance: 'untrusted-external',
    });
    expect(sources[0].excerpt).toHaveLength(RESEARCH_EXCERPT_CHARS);
    expect(sources[1].excerpt).toBe('Second description.');
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      ref,
      'https://publisher.example/transcript.txt',
    ]);
    expect(http.mock.calls.every(([, init]) => init?.signal)).toBe(true);
  });
  it('honours source/date budgets and cancellation without fetching subresources', async () => {
    const http = vi.fn<ResearchHttp>(async () => response(feed, 'text/xml'));
    const adapter = podcastAdapter(http);
    expect(await adapter.fetch!(ref, { ...options(), limit: 0 })).toEqual([]);
    expect(http).not.toHaveBeenCalled();
    expect(await adapter.fetch!(ref, { ...options(), since: '2026-11-25' })).toEqual([]);
    expect(http).toHaveBeenCalledTimes(1);
    const abort = new AbortController();
    abort.abort();
    await expect(adapter.fetch!(ref, { ...options(), signal: abort.signal })).rejects.toThrow();
  });
  it('rejects HTML, DTDs and invalid feeds, and never reads a mismatched transcript', async () => {
    for (const [text, type] of [
      [feed, 'text/html'],
      ['<!DOCTYPE rss>' + feed, 'text/xml'],
      ['<html/>', 'text/xml'],
    ]) {
      await expect(
        podcastAdapter(async () => response(text, type)).fetch!(ref, options()),
      ).rejects.toThrow();
    }
    const http: ResearchHttp = async (url) =>
      url === ref ? response(feed, 'text/xml') : response('<html/>', 'text/html');
    const [source] = await podcastAdapter(http).fetch!(ref, options());
    expect(source.excerpt).toMatch(/^Transcript unavailable\. /);
    expect(source.excerpt).not.toContain('html');
  });
  it.each([
    ['unclosed items', `<rss><channel>${'<item>'.repeat(150_000)}</channel></rss>`],
    ['unclosed comments', `<rss><channel>${'<!--'.repeat(200_000)}</channel></rss>`],
    ['unclosed channels', `<rss>${'<channel>'.repeat(100_000)}</rss>`],
    ['lookalike tags', `<rss><channel>${'<itemx>'.repeat(140_000)}</channel></rss>`],
    [
      'unclosed CDATA',
      `<rss><channel><item><title>${'<![CDATA['.repeat(100_000)}</title></item></channel></rss>`,
    ],
  ])('stays linear on hostile feeds: %s', async (_name, xml) => {
    const started = performance.now();
    await podcastAdapter(async () => response(xml, 'text/xml')).fetch!(ref, options()).catch(
      () => [],
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });
  it('does not fetch undeclared transcript formats or resolve XML entities', async () => {
    const http = vi.fn<ResearchHttp>(async () =>
      response(feed.replace('type="text/plain"', 'type="application/json"'), 'text/xml'),
    );
    const [source] = await podcastAdapter(http).fetch!(ref, { ...options(), limit: 1 });
    expect(source.excerpt).toBe('Public episode description.');
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('keeps the feed but reads nothing when the transport rejects a private transcript', async () => {
    const http = vi.fn<ResearchHttp>(async (url) => {
      if (url === ref)
        return response(feed.replace('/transcript.txt', 'http://127.0.0.1/secret'), 'text/xml');
      throw new Error('Private research destination rejected');
    });
    const sources = await podcastAdapter(http).fetch!(ref, options());
    expect(sources).toHaveLength(2);
    expect(sources[0].excerpt).toMatch(/^Transcript unavailable\. /);
    expect(http.mock.calls[1][0]).toBe('http://127.0.0.1/secret');
  });
});

describe('important research claims', () => {
  const a = makeSource({
    adapter: 'web',
    url: 'https://one.example/a',
    title: 'A',
    author: 'Alice',
    kind: 'web',
    excerpt: 'Evidence A',
    language: 'en',
  });
  const b = makeSource({ ...a, url: 'https://two.org/b', author: 'Bob', excerpt: 'Evidence B' });
  const report = (sources: string[], important?: boolean, confidence = 'high') =>
    JSON.stringify({
      summary: 'Scope',
      findings: [
        {
          claim: 'Material claim',
          type: 'fact',
          confidence,
          reason: 'Evidence',
          sources,
          ...(important === undefined ? {} : { important }),
        },
      ],
      contradictions: [],
      gaps: [],
      discardedSources: [],
      bibliography: [],
    });
  it('records insufficient evidence even when the important claim was already low', () => {
    for (const confidence of ['high', 'medium', 'low']) {
      const json = report([a.id], true, confidence);
      const result = validateResearchReport(json, [a]);
      expect(result.findings[0]).toMatchObject({ important: true, confidence: 'low' });
      expect(result.gaps.join(' ')).toContain('Insufficient evidence for important claim');
      expect(researchHandoff(json, [a]).insufficientEvidence).toBe(true);
    }
  });
  it('uses the existing independence checks for authors, domains and copied content', () => {
    for (const dependent of [
      makeSource({ ...b, author: 'Alice' }),
      makeSource({ ...b, url: 'https://sub.one.example/b' }),
      makeSource({ ...b, excerpt: a.excerpt }),
    ]) {
      const result = validateResearchReport(report([a.id, dependent.id], true), [a, dependent]);
      expect(result.findings[0].confidence).toBe('low');
      expect(result.gaps).toHaveLength(1);
    }
    const result = validateResearchReport(report([a.id, b.id], true), [a, b]);
    expect(result.findings[0].confidence).toBe('high');
    expect(result.gaps).toEqual([]);
  });
  it('preserves legacy shape, keeps single sources low and validates importance', () => {
    const json = report([a.id]);
    const result = validateResearchReport(json, [a]);
    expect(result.findings[0]).not.toHaveProperty('important');
    expect(result.findings[0].confidence).toBe('low');
    expect(result.gaps).toEqual([]);
    expect(validateResearchReport(report([a.id, b.id]), [a, b]).findings[0].confidence).toBe(
      'high',
    );
    expect(() =>
      validateResearchReport(
        json.replace('"reason":"Evidence"', '"important":"yes","reason":"Evidence"'),
        [a],
      ),
    ).toThrow();
  });
});
