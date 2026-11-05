import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { WEB_SCOUT_SPEC } from '../../core/src/agentSpec.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { compileAgent, executorSupportsRole } from '../src/agentCompiler.js';
import type { Executor } from '../src/executors/executor.js';
import { ResearchAdapters } from '../src/research.js';
import { redditAdapter } from '../src/researchAdapters/reddit.js';
import { webAdapter } from '../src/researchAdapters/web.js';
import { timedText, youtubeAdapter } from '../src/researchAdapters/youtube.js';
import type { ResearchHttp } from '../src/researchHttp.js';
import { discoverUrls, scoutSchema, scoutUrls } from '../src/webScout.js';
import { operatorToken } from './helpers/operatorToken.js';
import { runResearchCommand } from './helpers/researchCommand.js';

vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
// timers/promises captures native timers; route only this fixture's waits through
// the global timer so fake time verifies pacing without wall-clock sleeps.
vi.mock('timers/promises', () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
const signal = new AbortController().signal;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const candidate = { url: 'https://example.org/', title: 'SCOUT_PAYLOAD', reason: 'SCOUT_PAYLOAD' };
const output = (candidates = [candidate]) => JSON.stringify({ candidates });
it('strictly rejects scout URL schemes, credentials, extra fields, prose and excessive candidates', () => {
  expect(scoutUrls(output(), 1)).toEqual([candidate.url]);
  for (const raw of [
    output([{ ...candidate, url: 'file:///secret' }]),
    output([{ ...candidate, url: 'https://user:secret@example.org/' }]),
    output([candidate, candidate]),
    output() + ' prose',
    '```json\n' + output() + '\n```',
    JSON.stringify({ candidates: [candidate], text: 'extra' }),
  ])
    expect(() => scoutUrls(raw, 1)).toThrow();
});
it('gives scout only WebSearch, no external or private context and no Codex', () => {
  const data = { task: { question: 'public question' }, outputSchema: scoutSchema(2) };
  const compiled = compileAgent(WEB_SCOUT_SPEC, 'web-scout', data);
  expect(compiled.claude.allowedTools).toEqual(['WebSearch']);
  expect(compiled.claude.disallowedTools).toEqual(
    expect.arrayContaining([
      'WebFetch',
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'Bash',
      'Agent',
      'Task',
    ]),
  );
  expect(executorSupportsRole('codex', 'web-scout')).toBe(false);
  for (const invalid of [
    { ...data, repository: {} },
    { ...data, brainContents: { x: 'private' } },
    { ...data, task: { question: 'q', sources: [] } },
  ])
    expect(() => compileAgent(WEB_SCOUT_SPEC, 'web-scout', invalid)).toThrow();
});
const player = {
  videoDetails: { title: 'Fixture video', author: 'Fixture channel' },
  microformat: { playerMicroformatRenderer: { publishDate: '2026-01-02' } },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk', languageCode: 'en' },
      ],
    },
  },
};
it('fetches player JSON and manual English captions with bounded untrusted output', async () => {
  const data = {
    ...player,
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?track=asr',
            languageCode: 'en',
            kind: 'asr',
          },
          { baseUrl: 'https://www.youtube.com/api/timedtext?track=manual', languageCode: 'en' },
        ],
      },
    },
  };
  const http = vi
    .fn<ResearchHttp>()
    .mockResolvedValueOnce({ text: JSON.stringify(data), headers: new Headers() })
    .mockResolvedValueOnce({
      text: JSON.stringify({ events: [{ segs: [{ utf8: 'word '.repeat(2000) }] }] }),
      headers: new Headers(),
    });
  const [source] = await youtubeAdapter(http).fetch!('https://youtu.be/abcdefghijk', {
    limit: 1,
    signal,
  });
  expect(source).toMatchObject({
    kind: 'video',
    provenance: 'untrusted-external',
    title: 'Fixture video',
    channel: 'Fixture channel',
    publishedAt: '2026-01-02T00:00:00.000Z',
  });
  expect(source.excerpt.length).toBeLessThanOrEqual(4000);
  expect(http.mock.calls[0][1]?.json).toMatchObject({
    context: { client: { clientName: 'IOS' } },
    videoId: 'abcdefghijk',
  });
  expect(http.mock.calls[1][0]).toContain('track=manual&fmt=json3');
  expect(
    timedText(JSON.stringify({ events: [{ segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] }] })),
  ).toBe('Hello world');
});
it('falls back to Android and rejects missing subtitles', async () => {
  const http = vi.fn<ResearchHttp>().mockResolvedValue({ text: '{}', headers: new Headers() });
  await expect(
    youtubeAdapter(http).fetch!('https://youtu.be/abcdefghijk', { limit: 1, signal }),
  ).rejects.toThrow('No public YouTube subtitles');
  expect(http).toHaveBeenCalledTimes(2);
  expect(http.mock.calls[1][1]?.json).toMatchObject({
    context: { client: { clientName: 'ANDROID' } },
  });
});
it('uses requested manual language and Android ASR after an empty IOS transcript', async () => {
  const tracks = [
    { baseUrl: 'https://www.youtube.com/api/timedtext?track=en', languageCode: 'en' },
    { baseUrl: 'https://www.youtube.com/api/timedtext?track=es', languageCode: 'es' },
  ];
  const metadata = (captionTracks: typeof tracks) =>
    JSON.stringify({ ...player, captions: { playerCaptionsTracklistRenderer: { captionTracks } } });
  const http = vi
    .fn<ResearchHttp>()
    .mockResolvedValueOnce({ text: metadata(tracks), headers: new Headers() })
    .mockResolvedValueOnce({ text: '', headers: new Headers() })
    .mockResolvedValueOnce({
      text: metadata([{ ...tracks[1], ...{ kind: 'asr' } }]),
      headers: new Headers(),
    })
    .mockResolvedValueOnce({
      text: JSON.stringify({ events: [{ segs: [{ utf8: 'Hola' }] }] }),
      headers: new Headers(),
    });
  const sources = await youtubeAdapter(http).fetch!('https://youtu.be/abcdefghijk', {
    limit: 1,
    signal,
    language: 'es',
  });
  expect(sources).toMatchObject([
    { language: 'es', excerpt: 'Hola', provenance: 'untrusted-external' },
  ]);
  expect(http.mock.calls[1][0]).toContain('track=es&fmt=json3');
  expect(http.mock.calls[2][1]?.json).toMatchObject({
    context: { client: { clientName: 'ANDROID' } },
  });
});
it.each([403, 429])(
  'paces public Reddit Atom across instances and suspends after %s',
  async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`2030-01-${status === 403 ? '01' : '02'}T00:00:00Z`));
    const data = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Thread &amp; title</title><link href="https://www.reddit.com/r/test/comments/abc/title/"/><author><name>/u/alice</name></author><updated>2026-01-02T00:00:00Z</updated><content type="html">&lt;p&gt;Readable &amp;amp; evidence&lt;/p&gt;</content></entry></feed>`;
    const http = vi.fn<ResearchHttp>().mockResolvedValue({ text: data, headers: new Headers() });
    const first = redditAdapter(undefined, http).search!('fixture query', { limit: 2, signal });
    await vi.runAllTimersAsync();
    expect(await first).toMatchObject([
      {
        title: 'Thread & title',
        author: '/u/alice',
        excerpt: 'Readable & evidence',
        provenance: 'untrusted-external',
      },
    ]);
    expect(http.mock.calls[0][0]).toContain('/search.rss?q=fixture%20query');
    expect(http.mock.calls[0][1]?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('SoftwareAgents'),
    });
    const comments = redditAdapter(undefined, http).fetch!(
      'https://www.reddit.com/r/test/comments/abc/title/',
      { limit: 2, signal },
    );
    expect(http).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await comments).toMatchObject([{ provenance: 'untrusted-external' }]);
    expect(http.mock.calls[1][0]).toContain('/comments/abc/title.rss');
    const subreddit = redditAdapter(undefined, http).fetch!(
      'https://www.reddit.com/r/test/search?q=topic',
      { limit: 2, signal },
    );
    await vi.advanceTimersByTimeAsync(6000);
    await subreddit;
    expect(http.mock.calls[2][0]).toContain('/r/test/search.rss?restrict_sr=1&q=topic');
    http.mockRejectedValueOnce(new Error(`Research HTTP status ${status}`));
    const failure = expect(
      redditAdapter(undefined, http).search!('q', { limit: 1, signal }),
    ).rejects.toThrow(String(status));
    await vi.advanceTimersByTimeAsync(6000);
    await failure;
    await expect(redditAdapter(undefined, http).search!('q', { limit: 1, signal })).rejects.toThrow(
      'suspended',
    );
    expect(http).toHaveBeenCalledTimes(4);
  },
);
it('refetches scout URLs and never forwards scout text to Researcher', async () => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyless-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  // research run is a human decision (SA-107): confirm with an isolated test token.
  operatorToken(home);
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
        research: { maxSources: 2, maxTokens: 100, maxSeconds: 5 },
      },
    };
    const http = vi.fn<ResearchHttp>().mockResolvedValue({
      text: '<title>Runtime title</title><p>Runtime evidence</p>',
      headers: new Headers({ 'content-type': 'text/html' }),
    });
    const adapters = new ResearchAdapters();
    adapters.register(webAdapter(undefined, http));
    const start = vi.fn<Executor['start']>((req) => ({
      cancel: vi.fn(),
      events: (async function* () {
        yield { type: 'usage' as const, inputTokens: 10, outputTokens: 10 };
        yield {
          type: 'finished' as const,
          exitCode: 0,
          costUsd: 0.001,
          resultSummary:
            req.role === 'web-scout'
              ? output()
              : JSON.stringify({
                  summary: 'Coverage.',
                  findings: [],
                  contradictions: [],
                  gaps: [],
                  discardedSources: [],
                  bibliography: [],
                }),
        };
      })(),
    }));
    await runResearchCommand(['run', '--question', 'Question', '--discover'], home, vi.fn(), {
      config,
      adapters,
      executor: { id: 'claude', start },
      audit: { append: vi.fn() },
    });
    expect(start.mock.calls.map(([req]) => req.role)).toEqual(['web-scout', 'researcher']);
    expect(start.mock.calls[0][0].taskData?.task).toEqual({ question: 'Question' });
    const task = JSON.stringify(start.mock.calls[1][0].taskData);
    expect(task).not.toContain('SCOUT_PAYLOAD');
    expect(task).toContain('Runtime title');
    expect(task).toContain('untrusted-external');
    expect(http.mock.calls[0][0]).toBe(candidate.url);
    await expect(
      discoverUrls(
        { id: 'claude', start },
        {
          executionId: 'budget',
          projectId: 'fixture',
          taskKey: 'budget',
          flags: [],
          prompt: '',
          worktreePath: home,
          timeoutMin: 1,
        },
        'q',
        1,
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('budget');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
