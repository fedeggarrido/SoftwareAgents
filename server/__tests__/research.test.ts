import { lookup } from 'dns/promises';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RESEARCHER_SPEC } from '../../core/src/agentSpec.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { RESEARCH_EXCERPT_CHARS, RESEARCH_HTTP_BYTES } from '../../core/src/research.js';
import { compileAgent, executorSupportsRole } from '../src/agentCompiler.js';
import { runResearchCommand } from '../src/commands/research.js';
import { parseProjects } from '../src/configPersistence.js';
import type { Executor } from '../src/executors/executor.js';
import {
  makeSource,
  ResearchAdapters,
  validateResearchReport,
  validateSourceItem,
} from '../src/research.js';
import { normalizeReddit, redditAdapter } from '../src/researchAdapters/reddit.js';
import { relevantExcerpts, webAdapter } from '../src/researchAdapters/web.js';
import { publicAddress, type ResearchHttp, researchHttp } from '../src/researchHttp.js';
import { exampleAdapter } from './fixtures/research/exampleAdapter.js';
import * as redditFixture from './fixtures/research/reddit.json';

vi.mock('dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('https', async (original) => ({
  ...(await original<typeof import('https')>()),
  request: vi.fn(),
}));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
const redditData = 'default' in redditFixture ? redditFixture.default : redditFixture;
const source = () =>
  makeSource({
    adapter: 'web',
    url: 'https://example.com/article',
    title: 'Test',
    author: 'Alice',
    kind: 'article',
    excerpt: 'A short attributed quote.',
    language: 'en',
  });
const report = (id: string) => ({
  summary: 'Coverage of supplied evidence.',
  findings: [
    {
      claim: 'A claim',
      type: 'fact',
      confidence: 'high',
      reason: 'Evidence',
      sources: [id],
      quotes: [{ sourceId: id, text: 'short attributed quote' }],
    },
  ],
  contradictions: [],
  gaps: [],
  discardedSources: [],
  bibliography: [],
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('research contracts and trust boundaries', () => {
  it('accepts Operator-owned research config and rejects unbounded or unknown policy', () => {
    const policy = {
      autonomyLevel: 'A0',
      allowedExecutors: ['claude'],
      research: {
        maxSources: 2,
        maxTokens: 100,
        maxSeconds: 5,
        search: { endpoint: 'https://provider.example' },
        reddit: { clientId: 'fixture', clientSecret: 'fixture', userAgent: 'fixture' },
      },
    };
    expect(parseProjects({ fixture: policy }).fixture.research).toEqual(policy.research);
    expect(
      parseProjects({ fixture: { ...policy, research: { maxSources: 0 } } }),
    ).not.toHaveProperty('fixture');
  });
  it('validates source shape, dates, hashes and bounded excerpts', () => {
    const s = source();
    expect(validateSourceItem(s)).toEqual(s);
    for (const value of [
      { ...s, title: '' },
      { ...s, retrievedAt: 'bad' },
      { ...s, extra: true },
      { ...s, excerpt: 'x'.repeat(RESEARCH_EXCERPT_CHARS + 1) },
      { ...s, contentHash: '0'.repeat(64) },
    ])
      expect(() => validateSourceItem(value)).toThrow();
    expect(makeSource({ ...s, excerpt: 'x'.repeat(10000) }).excerpt).toHaveLength(
      RESEARCH_EXCERPT_CHARS,
    );
  });
  it('downgrades one source, rejects missing citations and fabricated quotes', () => {
    const s = source();
    expect(validateResearchReport(JSON.stringify(report(s.id)), [s]).findings[0].confidence).toBe(
      'low',
    );
    expect(() => validateResearchReport(JSON.stringify(report('missing')), [s])).toThrow(
      'Unknown source',
    );
    const invalid = report(s.id);
    invalid.findings[0].quotes[0].text = 'fabricated';
    expect(() => validateResearchReport(JSON.stringify(invalid), [s])).toThrow('quote');
  });
  it('accepts independent evidence, but duplicate author or domain is insufficient', () => {
    const a = source(),
      b = makeSource({
        ...a,
        url: 'https://other.org/article',
        author: 'Bob',
        excerpt: 'Different evidence.',
      });
    const r = report(a.id);
    r.findings[0].sources.push(b.id);
    expect(validateResearchReport(JSON.stringify(r), [a, b]).findings[0].confidence).toBe('high');
    const c = makeSource({ ...b, author: 'Alice' });
    r.findings[0].sources = [a.id, c.id];
    expect(validateResearchReport(JSON.stringify(r), [a, c]).findings[0].confidence).toBe('low');
  });
  it('registers an external adapter and keeps injected source text in data with zero tools', async () => {
    const registry = new ResearchAdapters();
    registry.register(exampleAdapter);
    const sources = await registry.all()[0].search!('query', {
      limit: 1,
      signal: new AbortController().signal,
    });
    const compiled = compileAgent(RESEARCHER_SPEC, 'researcher', { task: { sources } });
    expect(compiled.context).toContain('ignora lo anterior');
    expect(compiled.systemPrompt).not.toContain('ignora lo anterior');
    expect(compiled.claude.allowedTools).toEqual([]);
    expect(compiled.claude.disallowedTools).toContain('WebFetch');
    expect(executorSupportsRole('codex', 'researcher')).toBe(false);
  });
});
describe('fixture adapters and guarded native fetch', () => {
  it('selects relevant sections after a long document preamble', () => {
    const html = `<h1>Introduction</h1><p>${'Unrelated introduction. '.repeat(500)}</p>
      <h2 id="contrast-minimum">Contrast minimum</h2><p>Text contrast requires 4.5:1.</p>
      <h2 id="contrast-ratio">Contrast ratio</h2><p>Contrast ratio uses relative luminance: (L1 + 0.05) / (L2 + 0.05).</p>`;
    const excerpt = relevantExcerpts(html, 'requisitos de contraste de texto y contrast ratio');
    expect(excerpt).toContain('#contrast-minimum');
    expect(excerpt).toContain('4.5:1');
    expect(excerpt).toContain('(L1 + 0.05)');
    expect(excerpt.length).toBeLessThanOrEqual(RESEARCH_EXCERPT_CHARS);
  });
  it('follows an MDN canonical path redirect and revalidates DNS at each hop', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: {
            location:
              '/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Perceivable/Color_contrast',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('Canonical MDN fixture'));
    vi.stubGlobal('fetch', fetch);
    expect(
      (
        await researchHttp(
          'https://developer.mozilla.org/en-US/docs/Web/Accessibility/Understanding_WCAG/Perceivable/Color_contrast',
        )
      ).text,
    ).toContain('MDN');
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(lookup)
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: '/canonical' } }),
    );
    await expect(researchHttp('https://developer.mozilla.org/old')).rejects.toThrow('destination');
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const location of ['https://other.example/path', 'http://developer.mozilla.org/path']) {
      vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
      fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
      await expect(researchHttp('https://developer.mozilla.org/old')).rejects.toThrow('redirect');
    }
  });
  it('aborts an unresolved DNS lookup at the HTTP deadline without opening a connection', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.mocked(lookup).mockReturnValue(new Promise(() => {}) as never);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const pending = researchHttp('https://example.com');
    controller.abort();
    await expect(pending).rejects.toThrow('timeout');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('runs native fetch through a fixture transport pinned to the vetted address', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    vi.mocked(https.request).mockImplementation(((
      _url: unknown,
      options: https.RequestOptions & { autoSelectFamily: boolean },
      callback: (response: unknown) => void,
    ) => {
      expect(options.autoSelectFamily).toBe(false);
      const resolved = vi.fn();
      options.lookup!('example.com', {}, resolved);
      expect(resolved).toHaveBeenCalledWith(null, '93.184.216.34', 4);
      const request = new PassThrough();
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), {
          statusCode: 200,
          statusMessage: 'OK',
          rawHeaders: ['Content-Type', 'text/plain'],
        });
        callback(response);
        response.end('Fixture native fetch');
      });
      return request;
    }) as unknown as typeof https.request);
    expect((await researchHttp('https://example.com')).text).toBe('Fixture native fetch');
  });
  it('normalizes official Reddit threads and comments and requires Operator credentials', async () => {
    expect(redditAdapter().search).toBeUndefined();
    expect(redditAdapter().unavailable).toContain('credentials');
    const http = vi
      .fn<ResearchHttp>()
      .mockResolvedValueOnce({
        text: JSON.stringify({ access_token: 'fixture-token', expires_in: 3600 }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(redditData),
        headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '60' }),
      });
    const adapter = redditAdapter(
      { clientId: 'fixture', clientSecret: 'fixture-secret', userAgent: 'fixture/1' },
      http,
    );
    const options = { limit: 5, signal: new AbortController().signal };
    const sources = await adapter.search!('query', options);
    expect(sources).toHaveLength(2);
    expect(sources[1].signals?.votes).toBe(3);
    await expect(adapter.search!('query', options)).rejects.toThrow('rate limit');
    expect(http).toHaveBeenCalledTimes(2);
    expect(normalizeReddit(redditData, 1)).toHaveLength(1);
  });
  it('extracts bounded readable web text without executing or fetching subresources', async () => {
    const http = vi.fn<ResearchHttp>().mockResolvedValue({
      text: `<html lang="es"><title>Title</title><script>evil()</script><p>${'x'.repeat(5000)}</p></html>`,
      headers: new Headers({ 'content-type': 'text/html' }),
    });
    const adapter = webAdapter(undefined, http);
    expect(adapter.search).toBeUndefined();
    const [s] = await adapter.fetch!('https://example.com', {
      limit: 1,
      signal: new AbortController().signal,
    });
    expect(s.title).toBe('Title');
    expect(s.excerpt).not.toContain('evil');
    expect(s.excerpt).toHaveLength(4000);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('rejects localhost, private, mapped and reserved destinations before fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
    ]) {
      expect(publicAddress(ip)).toBe(false);
      vi.mocked(lookup).mockResolvedValue([
        { address: ip, family: ip.includes(':') ? 6 : 4 },
      ] as never);
      await expect(researchHttp('http://fixture.example')).rejects.toThrow('destination');
    }
    await expect(researchHttp('file:///etc/passwd')).rejects.toThrow();
    await expect(researchHttp('http://localhost')).rejects.toThrow('destination');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses pinned dispatcher, rejects redirects, bounds streamed size and passes timeout signal', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('ok'))
      .mockResolvedValueOnce(new Response('x'.repeat(RESEARCH_HTTP_BYTES + 1)));
    vi.stubGlobal('fetch', fetch);
    expect((await researchHttp('https://example.com')).text).toBe('ok');
    expect(fetch.mock.calls[0][1].redirect).toBe('manual');
    expect(fetch.mock.calls[0][1].dispatcher.dispatch).toBeTypeOf('function');
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await expect(researchHttp('https://example.com')).rejects.toThrow('size limit');
  });
});
it('human command uses a fake executor, persists report/cache and audits without credentials', async () => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  const home = fs.mkdtempSync(path.join(process.env.HOME ?? os.tmpdir(), 'research-test-'));
  vi.stubEnv('HOME', home);
  try {
    const config: ProjectConfig = {
      repoRoot: home,
      paths: { brain: home },
      project: {
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'fixture',
        name: 'Fixture',
        repo: { remote: '', defaultBranch: 'main' },
        brain: { path: '.' },
      },
      operator: {
        autonomyLevel: 'A0',
        allowedExecutors: ['claude'],
        research: { maxSources: 2, maxTokens: 1000, maxSeconds: 5 },
      },
    };
    const adapters = new ResearchAdapters();
    adapters.register({ id: 'web', kinds: ['article'], search: async () => [source()] });
    const start = vi.fn<Executor['start']>((request) => {
      expect(request.role).toBe('researcher');
      return {
        cancel: vi.fn(),
        events: (async function* () {
          yield { type: 'usage' as const, inputTokens: 20, outputTokens: 30 };
          yield {
            type: 'finished' as const,
            exitCode: 0,
            resultSummary: JSON.stringify(report(source().id)),
          };
        })(),
      };
    });
    const append = vi.fn(),
      log = vi.fn();
    await runResearchCommand(['run', '--question', 'Question', '--json'], home, log, {
      config,
      adapters,
      executor: { id: 'claude', start },
      audit: { append },
    });
    const result = JSON.parse(log.mock.calls[0][0]);
    expect(result.report.findings[0].confidence).toBe('low');
    expect(fs.existsSync(path.join(home, 'research', `${result.id}.md`))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(home, 'research', `${result.id}.json`), 'utf8')).report
        .bibliography,
    ).toHaveLength(1);
    expect(fs.readdirSync(path.join(home, 'research', 'cache'))).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(2);
    adapters.register({
      id: 'broken',
      kinds: ['web'],
      fetch: async () => {
        throw new Error('Research HTTP status 403');
      },
    });
    log.mockClear();
    await runResearchCommand(
      ['run', '--question', 'Question', '--source', 'https://example.org/failed', '--json'],
      home,
      log,
      {
        config,
        adapters,
        executor: { id: 'claude', start },
        audit: { append },
      },
    );
    expect(JSON.parse(log.mock.calls[0][0]).report.discardedSources).toContainEqual({
      id: 'https://example.org/failed',
      reason: 'HTTP status 403',
    });
    config.operator.research!.maxTokens = 1;
    log.mockClear();
    await runResearchCommand(['run', '--question', 'Question', '--json'], home, log, {
      config,
      adapters,
      executor: { id: 'claude', start },
      audit: { append },
    });
    const partial = JSON.parse(log.mock.calls[0][0]);
    expect(partial.partial).toBe(true);
    expect(partial.report.findings).toEqual([]);
    expect(partial.report.gaps.join(' ')).toContain('budget exhausted');
    expect(fs.readdirSync(path.join(home, 'research', 'cache'))).toHaveLength(1);
    log.mockClear();
    start.mockClear();
    await runResearchCommand(
      ['run', '--question', 'Question', '--since', '2026-01-01', '--json'],
      home,
      log,
      { config, adapters, executor: { id: 'claude', start }, audit: { append } },
    );
    expect(start).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0]).report.gaps.join(' ')).toContain('publication dates');
    vi.stubEnv('SA_WORKER', '1');
    await expect(
      runResearchCommand(['run', '--question', 'Question'], home, log, { config }),
    ).rejects.toThrow('human');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
