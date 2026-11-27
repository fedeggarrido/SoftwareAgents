import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type { ClickUpMirrorConfig } from '../../core/src/project.js';
import {
  type ClickUpClient,
  ClickUpError,
  clickUpToken,
  createClickUpClient,
} from '../src/integrations/clickup/client.js';
import {
  type MirrorAuditEvent,
  pullRequestComment,
  reconcileClickUp,
} from '../src/integrations/clickup/mirror.js';
import { evaluatePolicy } from '../src/policy.js';
import type { TaskRecord } from '../src/workstore/WorkStore.js';

const TOKEN = 'pk_secret_test_token';
const config: ClickUpMirrorConfig = {
  enabled: true,
  statuses: {
    READY: 'to do',
    IN_PROGRESS: 'in progress',
    REVIEW: 'review',
    QA: 'qa',
    BLOCKED: 'blocked',
    DONE: 'complete',
  },
};

function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function task(key: string, status: TaskRecord['status'], pr: string | null = null): TaskRecord {
  // SAFETY: the mirror reads only key, status and pr_ref; the other columns are irrelevant here.
  return { key, status, pr_ref: pr } as TaskRecord;
}

/** In-memory ClickUp: one list, status writes and comments recorded. */
function fakeClickUp(tasks: { id: string; name: string; status: string; customId?: string }[]) {
  const comments = new Map<string, string[]>();
  const writes: string[] = [];
  const client: ClickUpClient = {
    listTasks: async () =>
      tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        customId: t.customId ?? null,
      })),
    setStatus: async (id, status) => {
      writes.push(`${id}=${status}`);
      const found = tasks.find((t) => t.id === id);
      if (found) found.status = status;
    },
    comments: async (id) => comments.get(id) ?? [],
    comment: async (id, text) => {
      writes.push(`${id}+comment`);
      comments.set(id, [...(comments.get(id) ?? []), text]);
    },
  };
  return { client, writes };
}

function run(
  client: ClickUpClient,
  tasks: TaskRecord[],
  overrides: Partial<Parameters<typeof reconcileClickUp>[0]> = {},
) {
  const events: MirrorAuditEvent[] = [];
  return {
    events,
    result: reconcileClickUp({
      tasks,
      listIds: ['list-1'],
      config,
      client,
      actor: 'system',
      authorize: (actor) => evaluatePolicy('clickup_write', actor, 'A3'),
      record: (event) => events.push(event),
      ...overrides,
    }),
  };
}

function clock(start: number) {
  const state = { now: start, sleeps: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

describe('SA-053 ClickUp REST client', () => {
  it('waits for X-RateLimit-Reset after a 429 and retries', async () => {
    const time = clock(1_000_000);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({}, 429, { 'X-RateLimit-Reset': String(1_000_000 / 1000 + 7) }))
      .mockResolvedValueOnce(reply({ tasks: [], last_page: true }));
    const client = createClickUpClient({ token: TOKEN, fetch, now: time.now, sleep: time.sleep });
    await expect(client.listTasks('list-1')).resolves.toEqual([]);
    expect(time.state.sleeps).toEqual([7000]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('pauses before the next call when the window is exhausted', async () => {
    const time = clock(2_000_000);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        reply({ tasks: [], last_page: true }, 200, {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(2_000_000 / 1000 + 3),
        }),
      )
      .mockResolvedValueOnce(reply({}));
    const client = createClickUpClient({ token: TOKEN, fetch, now: time.now, sleep: time.sleep });
    await client.listTasks('list-1');
    await client.setStatus('t1', 'qa');
    expect(time.state.sleeps).toEqual([3000]);
  });

  it('never puts the token in errors or logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createClickUpClient({
      token: TOKEN,
      fetch: async () => reply({ err: TOKEN }, 401),
      sleep: async () => {},
    });
    const failure = await client.comment('t1', 'x').catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ClickUpError);
    expect(String(failure)).not.toContain(TOKEN);
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
    for (const spy of [log, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
    error.mockRestore();
  });

  it('pages through a list and keeps only the mirrored fields', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        reply({
          tasks: [{ id: 'a', name: 'FEAT-1-T01 · x', status: { status: 'to do' } }],
          last_page: false,
        }),
      )
      .mockResolvedValueOnce(
        reply({
          tasks: [{ id: 'b', custom_id: 'K', name: 'y', status: { status: 'qa' } }],
          last_page: true,
        }),
      );
    const client = createClickUpClient({ token: TOKEN, fetch });
    expect(await client.listTasks('l')).toEqual([
      { id: 'a', name: 'FEAT-1-T01 · x', status: 'to do', customId: null },
      { id: 'b', name: 'y', status: 'qa', customId: 'K' },
    ]);
  });

  it('pages through comments from the oldest one seen', async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `m${from + i}`,
        date: String(1000 - from - i),
        comment_text: `c${from + i}`,
      }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ comments: page(25, 0) }))
      .mockResolvedValueOnce(reply({ comments: page(2, 25) }));
    const client = createClickUpClient({ token: TOKEN, fetch });
    expect(await client.comments('t1')).toHaveLength(27);
    expect(String(fetch.mock.calls[1][0])).toContain('start=976&start_id=m24');
  });

  it('reads the token from CLICKUP_TOKEN, then from the Operator secrets file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-home-'));
    try {
      expect(clickUpToken({ CLICKUP_TOKEN: ' env ' }, home)).toBe('env');
      expect(clickUpToken({}, home)).toBeNull();
      fs.mkdirSync(path.join(home, '.pixel-agents'));
      const file = path.join(home, '.pixel-agents', 'secrets.json');
      fs.writeFileSync(file, JSON.stringify({ clickupToken: 'file' }), { mode: 0o600 });
      expect(clickUpToken({}, home)).toBe('file');
      fs.writeFileSync(file, `{"clickupToken": "${TOKEN}"`, { mode: 0o600 });
      expect(() => clickUpToken({}, home)).toThrow('no es JSON válido');
      try {
        clickUpToken({}, home);
      } catch (error) {
        expect(String(error)).not.toContain(TOKEN);
      }
      if (process.platform !== 'win32') {
        fs.writeFileSync(file, JSON.stringify({ clickupToken: 'file' }));
        fs.chmodSync(file, 0o644);
        expect(() => clickUpToken({}, home)).toThrow('chmod 600');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('SA-053 ClickUp mirror reconciliation', () => {
  it('corrects a status changed by hand in ClickUp and records the drift (work store wins)', async () => {
    const { client, writes } = fakeClickUp([
      { id: 'c1', name: 'FEAT-001-T01 · Login', status: 'complete' },
    ]);
    const { result, events } = run(client, [task('FEAT-001-T01', 'RUNNING')]);
    expect(await result).toEqual([
      {
        key: 'FEAT-001-T01',
        result: 'mirrored',
        clickupId: 'c1',
        status: { from: 'complete', to: 'in progress' },
        prComment: false,
      },
    ]);
    expect(writes).toEqual(['c1=in progress']);
    expect(events.map((e) => e.status)).toEqual(['drift', 'written']);
  });

  it('matches by custom id and never by a longer key that shares the prefix', async () => {
    const { client, writes } = fakeClickUp([
      { id: 'long', name: 'FEAT-001-T010 · Other', status: 'to do' },
      { id: 'custom', name: 'Sin prefijo', status: 'to do', customId: 'FEAT-001-T01' },
    ]);
    await run(client, [task('FEAT-001-T01', 'DONE')]).result;
    expect(writes).toEqual(['custom=complete']);
  });

  it('a repeated sync posts the PR comment once', async () => {
    const { client, writes } = fakeClickUp([{ id: 'c1', name: 'T1 · x', status: 'review' }]);
    const tasks = [task('T1', 'REVIEW', 'https://github.com/o/r/pull/7')];
    expect((await run(client, tasks).result)[0]).toMatchObject({
      result: 'mirrored',
      status: null,
      prComment: true,
    });
    expect((await run(client, tasks).result)[0]).toMatchObject({ result: 'in_sync' });
    expect(writes).toEqual(['c1+comment']);
    expect(await client.comments('c1')).toEqual([
      pullRequestComment('T1', 'https://github.com/o/r/pull/7'),
    ]);
  });

  it('writes nothing when the policy denies clickup_write, and reports why', async () => {
    const { client, writes } = fakeClickUp([{ id: 'c1', name: 'T1 · x', status: 'to do' }]);
    const { result, events } = run(client, [task('T1', 'QA')], {
      authorize: (actor) => evaluatePolicy('clickup_write', actor, 'A1'),
    });
    expect((await result)[0]).toMatchObject({ result: 'denied' });
    expect(writes).toEqual([]);
    expect(events[0]).toMatchObject({ status: 'denied' });
  });

  it('a dry run only reports and records nothing', async () => {
    const { client, writes } = fakeClickUp([{ id: 'c1', name: 'T1 · x', status: 'to do' }]);
    const { result, events } = run(client, [task('T1', 'QA')], { dryRun: true });
    expect((await result)[0]).toMatchObject({ result: 'would_mirror' });
    expect(writes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('does not ask the policy when nothing is pending', async () => {
    const { client } = fakeClickUp([{ id: 'c1', name: 'T1 · x', status: 'qa' }]);
    const { result } = run(client, [task('T1', 'QA')], {
      authorize: (actor) => evaluatePolicy('clickup_write', actor, 'A1'),
    });
    expect((await result)[0]).toMatchObject({ result: 'in_sync' });
  });

  it('a failed write records the failure and continues with the next task', async () => {
    const { client, writes } = fakeClickUp([
      { id: 'c1', name: 'T1 · x', status: 'to do' },
      { id: 'c2', name: 'T2 · y', status: 'to do' },
    ]);
    const setStatus = client.setStatus;
    client.setStatus = async (id, status) => {
      if (id === 'c1') throw new ClickUpError(500, 'PUT /task');
      await setStatus(id, status);
    };
    const { result, events } = run(client, [task('T1', 'QA'), task('T2', 'QA')]);
    expect((await result).map((o) => o.result)).toEqual(['failed', 'mirrored']);
    expect(writes).toEqual(['c2=qa']);
    expect(events.some((e) => e.status === 'failed')).toBe(true);
  });

  it('never binds a sub-task whose key extends the task key', async () => {
    const { client, writes } = fakeClickUp([{ id: 's', name: 'T1.1 · sub', status: 'to do' }]);
    expect((await run(client, [task('T1', 'DONE')]).result)[0]).toMatchObject({
      result: 'unmatched',
    });
    expect(writes).toEqual([]);
  });

  it('leaves cancelled and unlinked tasks alone', async () => {
    const { client, writes } = fakeClickUp([{ id: 'c1', name: 'T1 · x', status: 'to do' }]);
    expect(await run(client, [task('T1', 'CANCELLED'), task('T2', 'DONE')]).result).toEqual([
      { key: 'T1', result: 'unmapped' },
      { key: 'T2', result: 'unmatched' },
    ]);
    expect(writes).toEqual([]);
  });
});
