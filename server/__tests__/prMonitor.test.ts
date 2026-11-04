import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NewHumanDecision } from '../../core/src/humanDecision.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { readCharacterDetail } from '../src/characterDetail.js';
import { GH_PR_MAX_BUFFER_BYTES, PR_MAX_CHECKS, PR_MAX_STRING_CHARS } from '../src/constants.js';
import { DomainEventRelay } from '../src/domainEventRelay.js';
import { parsePullRequest, PullRequestMonitor, readPullRequest } from '../src/prMonitor.js';
import { processStartIdentity, terminateExecutionTree } from '../src/workstore/processRecovery.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';
import { WorkStoreBoardSource } from '../src/workStoreBoardSource.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});
vi.mock('../src/workstore/processRecovery.js', () => ({
  processStartIdentity: vi.fn(async () => 'identity'),
  terminateExecutionTree: vi.fn(async () => {}),
}));

// Synthetic scenarios in gh's JSON wire format for example/project.
// Live recording is pending operator access to GitHub outside the sandbox.
const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures/gh', `${name}.json`), 'utf8');
const ref = 'https://github.com/example/project/pull/42';
let root: string;
let work: WorkStore;
let file: string;

beforeEach(async () => {
  vi.mocked(processStartIdentity).mockReset().mockResolvedValue('identity');
  vi.mocked(terminateExecutionTree).mockReset().mockResolvedValue(undefined);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-monitor-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-config'));
  execFileSync('git', ['init', root], { windowsHide: true, stdio: 'pipe' });
  work = await openWorkStore({ repositoryPath: root, projectId: 'p' });
  file = path.join(root, '.git/softwareagents/work.sqlite3');
  work.createTask({
    key: 'SA-055',
    type: 'implementation',
    status: 'REVIEW',
    branch: 'sa/SA-055',
    worktree_ref: path.join(root, '.worktrees/SA-055'),
  });
  await work.bindPullRequest('SA-055', work.getTask('SA-055')!.version, ref);
  fs.mkdirSync(path.join(root, '.worktrees/SA-055'), { recursive: true });
  fs.writeFileSync(path.join(root, '.worktrees/SA-055/uncommitted.txt'), 'keep');
});
afterEach(() => {
  work?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function monitor(
  read: typeof readPullRequest = vi.fn(async () => fixture('open-green')),
  log = vi.fn(),
) {
  return new PullRequestMonitor({ repositoryPath: root, projectId: 'p', read, log });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function reviewDecision(): NewHumanDecision {
  return {
    id: 'gate',
    context: 'Review change',
    options: [
      { id: 'review', label: 'Review', benefit: 'Confidence', cost: 'Time', risk: 'Delay' },
    ],
    recommendation: 'Review',
    disagreement: [],
    impact: 'Review needed',
    urgency: 'high',
    requestedBy: 'system',
    blocks: ['SA-055'],
  };
}

async function beginPoll(taskId = 'SA-055') {
  const task = work.getTask(taskId)!;
  return (await work.beginPullRequestPoll(taskId, task.pr_ref!, task.pr_binding_generation!))!;
}

async function observePullRequest(
  ...args: [
    string,
    number,
    string,
    Parameters<WorkStore['observePullRequest']>[3],
    Parameters<WorkStore['observePullRequest']>[4],
  ]
) {
  await work.observePullRequest(...args, await beginPoll(args[0]));
}

describe('PR observations through the real WorkStore and relay', () => {
  it('keeps open green work in REVIEW and projects PR/CI to snapshots, detail and board', async () => {
    const version = work.getTask('SA-055')!.version;
    const poller = monitor();
    await poller.tick();
    expect(work.getTask('SA-055')).toMatchObject({
      status: 'REVIEW',
      blocked_reason: null,
      pr_status: { state: 'OPEN', ci: 'success', reviewDecision: 'APPROVED' },
    });
    expect(work.listDecisions()).toEqual([]);
    expect(work.getTask('SA-055')!.version).toBe(version);
    await poller.tick();
    expect(work.getTask('SA-055')!.version).toBe(version);
    const store = new AgentStateStore();
    const relay = new DomainEventRelay(store, { projectId: 'p', workStoreFile: () => file });
    expect(relay.snapshot().tasks[0].prStatus?.ci).toBe('success');
    expect(readCharacterDetail(file, 'p', 'SA-055', 'unrecorded')).toMatchObject({
      pr: ref,
      prState: 'OPEN · APPROVED',
      ciState: 'success',
    });
    const source = new WorkStoreBoardSource();
    try {
      expect((await source.read(file, 'p', Date.now()))?.items[0]).toMatchObject({
        prRef: ref,
        prStatus: { ci: 'success', state: 'OPEN' },
      });
    } finally {
      source.dispose();
      relay.dispose();
      store.dispose();
    }
  });

  it('relays same-version PR updates across snapshots and refreshes observation-only projections', async () => {
    const version = work.getTask('SA-055')!.version;
    const state = new AgentStateStore();
    const broadcast = vi.spyOn(state, 'broadcast');
    const relay = new DomainEventRelay(state, { projectId: 'p', workStoreFile: () => file });
    const source = new WorkStoreBoardSource();
    const read = vi.fn(async () => fixture('open-green'));
    const poller = monitor(read);
    try {
      expect(relay.snapshot().lastEventId).toBeNull();
      await poller.tick();
      const green = (await source.read(file, 'p', Date.now()))!;
      expect(readCharacterDetail(file, 'p', 'SA-055', 'none')!.ciState).toBe('success');
      // A later snapshot must not advance the established cursor past pending notices.
      expect(relay.snapshot().tasks[0]).toMatchObject({ version, prStatus: { ci: 'success' } });
      relay.tick();
      const changed = { ...parsePullRequest(fixture('open-green'), ref), ci: 'pending' as const };
      await observePullRequest('SA-055', version, ref, changed, undefined);
      expect(relay.snapshot().tasks[0]).toMatchObject({ version, prStatus: { ci: 'pending' } });
      relay.tick();
      expect(readCharacterDetail(file, 'p', 'SA-055', 'none')!.ciState).toBe('pending');
      const pending = (await source.read(file, 'p', Date.now()))!;
      expect(pending.items[0].prStatus?.ci).toBe('pending');
      expect(pending).not.toEqual(green);
      expect(work.listDomainEvents().map((event) => event.task_version)).toEqual([
        version,
        version,
      ]);
      expect(broadcast.mock.calls.map(([message]) => message)).toEqual(
        work.listDomainEvents().map((event) => ({
          type: 'domainEvent',
          event: expect.objectContaining({
            eventId: event.id,
            kind: 'pr.updated',
            taskVersion: version,
          }),
        })),
      );
      const events = work.listDomainEvents();
      await work.recordPullRequestError('SA-055', ref, 'unavailable', await beginPoll());
      relay.tick();
      expect(work.getTask('SA-055')).toMatchObject({ version, pr_status: changed });
      expect(work.listDomainEvents()).toEqual(events);
      expect(relay.snapshot().tasks[0].prObservation?.error).toBe('unavailable');
      const unavailable = (await source.read(file, 'p', Date.now()))!;
      expect(unavailable.items[0].prObservation?.error).toBe('unavailable');
      expect(unavailable).not.toEqual(pending);
      expect(readCharacterDetail(file, 'p', 'SA-055', 'none')!.ciState).toBe('unavailable');
      await observePullRequest('SA-055', version, ref, changed, undefined);
      expect(work.listDomainEvents()).toEqual(events);
      expect((await source.read(file, 'p', Date.now()))!.items[0].prObservation?.error).toBeNull();
      expect(readCharacterDetail(file, 'p', 'SA-055', 'none')!.ciState).toBe('pending');
      expect(broadcast).toHaveBeenCalledTimes(2);
    } finally {
      await poller.dispose();
      source.dispose();
      relay.dispose();
      state.dispose();
    }
  });

  it('blocks failed checks with their names, ignoring neutral and skipped checks', async () => {
    const version = work.getTask('SA-055')!.version;
    await monitor(vi.fn(async () => fixture('failed'))).tick();
    expect(work.getTask('SA-055')).toMatchObject({
      version: version + 1,
      status: 'BLOCKED',
      blocked_reason: 'CI failed: build, lint, security, tests',
    });
    expect(work.listDomainEvents().map((event) => event.type)).toEqual([
      'TASK_TRANSITIONED',
      'PR_UPDATED',
    ]);
    expect(work.listDomainEvents().map((event) => event.task_version)).toEqual([
      version + 1,
      version + 1,
    ]);
    await monitor().tick();
    expect(work.getTask('SA-055')!.status).toBe('BLOCKED');
  });

  it('records failing CI without interrupting the active worker or clearing its lease', async () => {
    work.createTask({ key: 'active', type: 'implementation', status: 'QUEUED' });
    await work.bindPullRequest('active', work.getTask('active')!.version, ref);
    const lease = await work.claim('active', 'worker');
    await work.transition('active', lease.version, 'RUNNING', 'start', 'worker');
    await work.createExecution({
      key: 'execution',
      task_key: 'active',
      agent_template_version: 'v1',
      executor: 'codex',
      model_id: 'test',
      session_id: null,
      pid: 12345,
      pid_started_at: 'identity',
      started_at: new Date().toISOString(),
      system_prompt_hash: 'hash',
      project_brain_sha: 'sha',
      task_version: work.getTask('active')!.version,
      tool_policy_version: 'v1',
    });
    await monitor(vi.fn(async () => fixture('failed'))).tick();
    expect(terminateExecutionTree).not.toHaveBeenCalled();
    expect(work.getExecution('execution')!.tree_closed_at).toBeNull();
    expect(work.getTask('active')).toMatchObject({
      status: 'RUNNING',
      lease_owner: 'worker',
      pr_status: { ci: 'failure' },
    });
    expect(work.listLeaseRecoveries()).toEqual([]);
  });

  it('requests one cleanup per merged PR, leaving closed tasks closed', async () => {
    work.createTask({ key: 'done', type: 'implementation', status: 'DONE' });
    await work.bindPullRequest('done', work.getTask('done')!.version, ref);
    const version = work.getTask('done')!.version;
    const store = new AgentStateStore();
    const broadcast = vi.spyOn(store, 'broadcast');
    const relay = new DomainEventRelay(store, { projectId: 'p', workStoreFile: () => file });
    relay.tick();
    try {
      await monitor(vi.fn(async () => fixture('merged'))).tick();
      relay.tick();
      const gates = work.listDecisions();
      expect(gates).toHaveLength(2);
      expect(gates.some((entry) => entry.context.startsWith('pr-cleanup/done\n'))).toBe(true);
      expect(gates[0]).toMatchObject({
        status: 'open',
        blocks: [],
        impact: expect.stringContaining('delete_worktree'),
      });
      expect(broadcast).toHaveBeenCalledWith({
        type: 'domainEvent',
        event: expect.objectContaining({
          kind: 'pr.merged',
          taskKey: 'SA-055',
          decisionId: expect.any(String),
        }),
      });
      expect(work.getTask('done')).toMatchObject({ status: 'DONE', version });
      await monitor(vi.fn(async () => fixture('merged'))).tick();
      expect(work.listDecisions()).toHaveLength(2);
      expect(work.listDomainEvents().filter((event) => event.type === 'PR_MERGED')).toHaveLength(2);
      const gate = gates.find((entry) => entry.context.startsWith('pr-cleanup/SA-055\n'))!;
      await work.resolveDecision(gate.id, 'review', 'operator', () => {});
      expect(fs.readFileSync(path.join(root, '.worktrees/SA-055/uncommitted.txt'), 'utf8')).toBe(
        'keep',
      );
      await monitor(vi.fn(async () => fixture('merged'))).tick();
      expect(work.listDecisions()).toHaveLength(2);
    } finally {
      relay.dispose();
      store.dispose();
    }
  });

  it('fails soft and logs once when gh is missing or unauthenticated', async () => {
    const before = work.getTask('SA-055');
    const read = vi.fn(async (): Promise<string> => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const log = vi.fn();
    const poller = monitor(read, log);
    await poller.tick();
    await poller.tick();
    expect(work.getTask('SA-055')).toMatchObject({
      ...before,
      pr_poll_generation: before!.pr_poll_generation! + 2,
      pr_observed_generation: before!.pr_observed_generation! + 2,
      pr_observation: { lastSuccessAt: null, error: 'unavailable' },
    });
    expect(work.listDomainEvents()).toEqual([]);
    expect(work.listDecisions()).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    read.mockRejectedValue(new Error('authentication required'));
    await poller.tick();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale response if the task changes while gh runs', async () => {
    const read = vi.fn(async () => {
      const task = work.getTask('SA-055')!;
      await work.transition(task.key, task.version, 'BLOCKED', 'human hold', 'operator');
      return fixture('merged');
    });
    await monitor(read).tick();
    expect(work.getTask('SA-055')!.blocked_reason).toBe('human hold');
    expect(work.listDecisions()).toEqual([]);
    expect(work.getTask('SA-055')!.pr_status).toBeNull();
    const version = work.getTask('SA-055')!.version;
    await monitor().tick();
    expect(work.getTask('SA-055')).toMatchObject({
      version,
      status: 'BLOCKED',
      blocked_reason: 'human hold',
      pr_status: { ci: 'success' },
    });
  });

  it.each(['observation', 'rebinding'] as const)(
    'allows %s during a paused release without changing its reservation fence',
    async (operation) => {
      work.createTask({ key: 'leased', type: 'implementation', status: 'QUEUED', pr_ref: ref });
      const lease = await work.claim('leased', 'owner');
      await work.createExecution({
        key: 'execution',
        task_key: 'leased',
        agent_template_version: 'v1',
        executor: 'codex',
        model_id: 'test',
        session_id: null,
        pid: 12345,
        pid_started_at: 'identity',
        started_at: new Date().toISOString(),
        system_prompt_hash: 'hash',
        project_brain_sha: 'sha',
        task_version: lease.version,
        tool_policy_version: 'v1',
      });
      let entered!: () => void;
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      vi.mocked(terminateExecutionTree).mockImplementationOnce(async () => {
        entered();
        await resumed;
      });
      const releasing = work.release('leased', 'owner');
      await paused;
      const reservation = work.listLeaseRecoveries();
      expect(reservation).toMatchObject([{ task_key: 'leased', task_version: lease.version }]);
      const rebound = ref.replace('/42', '/43');
      try {
        if (operation === 'observation') {
          await observePullRequest(
            'leased',
            lease.version,
            ref,
            parsePullRequest(fixture('failed'), ref),
            undefined,
          );
          expect(work.getTask('leased')!.pr_status?.ci).toBe('failure');
          expect(terminateExecutionTree).toHaveBeenCalledTimes(1);
        } else {
          await work.bindPullRequest('leased', lease.version, rebound);
          expect(work.getTask('leased')!.pr_ref).toBe(rebound);
        }
        expect(work.getTask('leased')).toMatchObject({
          version: lease.version,
          status: 'LEASED',
          lease_owner: 'owner',
        });
        expect(work.listLeaseRecoveries()).toEqual(reservation);
      } finally {
        resume();
        await releasing;
      }
      expect(work.getTask('leased')).toMatchObject({
        version: lease.version + 1,
        status: 'FAILED_RETRYABLE',
        lease_owner: null,
        lease_expires_at: null,
        pr_ref: operation === 'rebinding' ? rebound : ref,
      });
      expect(work.getExecution('execution')!.tree_closed_at).toBeTruthy();
      expect(work.listLeaseRecoveries()).toEqual([]);
    },
  );

  it('allows observation while process registration awaits its identity', async () => {
    work.createTask({ key: 'launch', type: 'implementation', status: 'QUEUED', pr_ref: ref });
    const lease = await work.claim('launch', 'owner');
    await work.createExecution({
      key: 'execution',
      task_key: 'launch',
      agent_template_version: 'v1',
      executor: 'codex',
      model_id: 'test',
      session_id: null,
      pid: null,
      started_at: new Date().toISOString(),
      system_prompt_hash: 'hash',
      project_brain_sha: 'sha',
      task_version: lease.version,
      tool_policy_version: 'v1',
    });
    let identify!: (identity: string) => void;
    vi.mocked(processStartIdentity).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        identify = resolve;
      }),
    );
    const registration = work.setExecutionProcess('execution', 'owner', 12345);
    try {
      expect(processStartIdentity).toHaveBeenCalledWith(12345);
      await observePullRequest(
        'launch',
        lease.version,
        ref,
        parsePullRequest(fixture('failed'), ref),
        undefined,
      );
      expect(work.getTask('launch')).toMatchObject({
        version: lease.version,
        status: 'LEASED',
        lease_owner: 'owner',
        lease_expires_at: lease.lease_expires_at,
        pr_status: { ci: 'failure' },
      });
    } finally {
      identify('identity');
      await registration;
    }
    expect(work.getExecution('execution')).toMatchObject({
      pid: 12345,
      pid_started_at: 'identity',
      tree_closed_at: null,
    });
    expect(work.getTask('launch')).toMatchObject({
      version: lease.version,
      status: 'LEASED',
      lease_owner: 'owner',
      lease_expires_at: lease.lease_expires_at,
    });
    expect(work.listLeaseRecoveries()).toEqual([]);
    expect(terminateExecutionTree).not.toHaveBeenCalled();
  });

  it('coalesces overlapping polls and discards a response after disposal', async () => {
    let finish: (json: string) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = monitor(read);
    const pending = poller.tick();
    expect(poller.tick()).toBe(pending);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    poller.dispose();
    finish(fixture('merged'));
    await pending;
    expect(work.getTask('SA-055')!.pr_status).toBeNull();
    expect(work.listDecisions()).toEqual([]);
  });

  it('requires a cleanup gate in the same commit as the merge observation', async () => {
    const before = work.getTask('SA-055')!;
    const pr = parsePullRequest(fixture('merged'), ref);
    await expect(
      observePullRequest(before.key, before.version, ref, pr, undefined),
    ).rejects.toThrow('manual cleanup decision');
    expect(work.getTask('SA-055')).toEqual({
      ...before,
      pr_poll_generation: before.pr_poll_generation! + 1,
    });
    expect(work.listDomainEvents()).toEqual([]);
  });

  it('preserves existing human gates when CI blocks their tasks', async () => {
    await work.openDecision({
      id: 'gate',
      context: 'Review change',
      options: [
        { id: 'review', label: 'Review', benefit: 'Confidence', cost: 'Time', risk: 'Delay' },
      ],
      recommendation: 'Review',
      disagreement: [],
      impact: 'Review needed',
      urgency: 'high',
      requestedBy: 'system',
      blocks: ['SA-055'],
    });
    await monitor(vi.fn(async () => fixture('failed'))).tick();
    expect(work.getTask('SA-055')!.status).toBe('BLOCKED');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(
        JSON.parse(
          db.prepare('SELECT previous_states FROM human_decisions WHERE key = ?').get('gate')!
            .previous_states as string,
        ),
      ).toEqual({ 'SA-055': 'REVIEW' });
    } finally {
      db.close();
    }
    await work.resolveDecision('gate', 'review', 'operator', () => {});
    expect(work.getTask('SA-055')!.status).toBe('BLOCKED');
  });

  it.each(['DONE', 'CANCELLED', 'FAILED_FINAL'] as const)(
    'preserves closed %s tasks on red CI',
    async (status) => {
      work.createTask({ key: 'closed', type: 'implementation', status });
      await work.bindPullRequest('closed', work.getTask('closed')!.version, ref);
      await monitor(vi.fn(async () => fixture('failed'))).tick();
      expect(work.getTask('closed')).toMatchObject({
        status,
        blocked_reason: null,
        pr_status: { ci: 'failure' },
      });
      expect(work.listDomainEvents('closed').map((event) => event.type)).toEqual(['PR_UPDATED']);
    },
  );

  it('blocks on a later red poll after the owner releases its lease, even with unchanged checks', async () => {
    work.createTask({ key: 'leased', type: 'implementation', status: 'QUEUED' });
    await work.bindPullRequest('leased', work.getTask('leased')!.version, ref);
    await work.claim('leased', 'owner');
    const poller = monitor(vi.fn(async () => fixture('failed')));
    await poller.tick();
    expect(work.getTask('leased')).toMatchObject({ status: 'LEASED', lease_owner: 'owner' });
    await work.release('leased', 'owner');
    await poller.tick();
    expect(work.getTask('leased')).toMatchObject({ status: 'BLOCKED', lease_owner: null });
    expect(terminateExecutionTree).not.toHaveBeenCalled();
  });

  it('retains an expired lease until independent recovery, then permits a later CI block', async () => {
    work.createTask({ key: 'expired', type: 'implementation', status: 'QUEUED' });
    await work.bindPullRequest('expired', work.getTask('expired')!.version, ref);
    await work.claim('expired', 'owner');
    work.close();
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "UPDATE tasks SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE key = 'expired'",
      );
    } finally {
      db.close();
    }
    work = await openWorkStore({ repositoryPath: root, projectId: 'p', recoverLeases: false });
    const poller = monitor(vi.fn(async () => fixture('failed')));
    await poller.tick();
    expect(work.getTask('expired')).toMatchObject({
      status: 'LEASED',
      lease_owner: 'owner',
      lease_expires_at: '2020-01-01T00:00:00.000Z',
      pr_status: { ci: 'failure' },
    });
    expect(work.listLeaseRecoveries()).toEqual([]);
    expect(terminateExecutionTree).not.toHaveBeenCalled();
    await work.recoverExpiredLeases();
    await poller.tick();
    expect(work.getTask('expired')).toMatchObject({ status: 'BLOCKED', lease_owner: null });
  });

  it('refreshes success and errors independently of task versions and events', async () => {
    const read = vi.fn(async () => fixture('open-green'));
    const poller = monitor(read);
    await poller.tick();
    const before = work.getTask('SA-055')!;
    const events = work.listDomainEvents();
    read.mockRejectedValue(new Error('credentials and raw CLI output must stay private'));
    await poller.tick();
    await poller.tick();
    expect(work.getTask('SA-055')).toMatchObject({
      version: before.version,
      pr_status: before.pr_status,
      pr_observation: { lastSuccessAt: before.pr_status!.observedAt, error: 'unavailable' },
    });
    expect(readCharacterDetail(file, 'p', 'SA-055', 'none')!.ciState).toBe('unavailable');
    read.mockResolvedValue(fixture('open-green'));
    await poller.tick();
    expect(work.getTask('SA-055')).toMatchObject({
      version: before.version,
      pr_observation: { error: null },
    });
    expect(work.listDomainEvents()).toEqual(events);
  });

  it('keeps the execution attribution when PR_UPDATED occurs during LEASED', async () => {
    work.createTask({ key: 'leased', type: 'implementation', status: 'QUEUED' });
    await work.bindPullRequest('leased', work.getTask('leased')!.version, ref);
    const lease = await work.claim('leased', 'owner');
    await work.createExecution({
      key: 'execution',
      task_key: 'leased',
      agent_template_version: 'v1',
      executor: 'codex',
      model_id: 'test',
      session_id: 'session',
      pid: null,
      started_at: new Date().toISOString(),
      system_prompt_hash: 'hash',
      project_brain_sha: 'sha',
      task_version: lease.version,
      tool_policy_version: 'v1',
    });
    const state = new AgentStateStore();
    const broadcast = vi.spyOn(state, 'broadcast');
    const relay = new DomainEventRelay(state, { projectId: 'p', workStoreFile: () => file });
    const source = new WorkStoreBoardSource();
    relay.tick();
    try {
      await monitor().tick();
      expect(
        (await source.read(file, 'p', Date.now()))!.items.find((item) => item.id === 'leased')!
          .owner!.session,
      ).toBe('session');
      const task = work.getTask('leased')!;
      expect(task.version).toBe(lease.version);
      expect(work.listDomainEvents('leased').map((event) => event.task_version)).toEqual([
        lease.version,
        lease.version,
      ]);
      await work.transition('leased', task.version, 'RUNNING', 'start', 'owner');
      relay.tick();
      expect(broadcast).toHaveBeenCalledWith({
        type: 'domainEvent',
        event: expect.objectContaining({
          kind: 'execution.started',
          taskKey: 'leased',
          executionId: 'execution',
        }),
      });
    } finally {
      source.dispose();
      relay.dispose();
      state.dispose();
    }
  });

  it('requires explicit rebinding for legacy branch selectors, including a reused branch', async () => {
    work.createTask({
      key: 'legacy',
      type: 'implementation',
      status: 'REVIEW',
      pr_ref: 'reused-branch',
    });
    const read = vi.fn(async () => fixture('open-green'));
    await monitor(read).tick();
    expect(read.mock.calls).toHaveLength(1); // Only the canonically bound SA-055 task.
    expect(work.getTask('legacy')).toMatchObject({
      status: 'REVIEW',
      pr_status: null,
      pr_ref: 'reused-branch',
      pr_observation: { error: 'binding_required' },
    });
  });

  it('coalesces concurrent monitor merge observations without duplicate gates', async () => {
    let waiting = 0;
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async () => {
      if (++waiting === 2) release();
      await ready;
      return fixture('merged');
    });
    await Promise.all([monitor(read).tick(), monitor(read).tick()]);
    expect(work.listDecisions()).toHaveLength(1);
    expect(work.listDomainEvents().filter((event) => event.type === 'PR_MERGED')).toHaveLength(1);
  });

  it('aborts the active gh read and waits for the poll during disposal', async () => {
    let active: AbortSignal | undefined;
    const read = vi.fn(
      (_repo: string, _ref: string, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          active = signal;
          signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const poller = monitor(read);
    const pending = poller.tick();
    await vi.waitFor(() => expect(active).toBeDefined());
    await poller.dispose();
    await pending;
    expect(active!.aborted).toBe(true);
    expect(work.getTask('SA-055')!.pr_status).toBeNull();
    await poller.tick();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('ignores an older poll even when its timestamp is later', async () => {
    work.createTask({ key: 'order', type: 'implementation', status: 'QUEUED' });
    await work.bindPullRequest('order', work.getTask('order')!.version, ref);
    const version = work.getTask('order')!.version;
    const older = await beginPoll('order');
    const newer = await beginPoll('order');
    const observe = (name: string, at: number, poll: typeof older) =>
      work.observePullRequest(
        'order',
        version,
        ref,
        parsePullRequest(fixture(name), ref, at),
        undefined,
        poll,
      );
    await observe('open-green', 1000, newer);
    await observe('failed', 2000, older);
    expect(work.getTask('order')).toMatchObject({
      status: 'QUEUED',
      version,
      pr_status: { ci: 'success', observedAt: 1000 },
    });
  });

  it('accepts new CI and merge observations after the wall clock moves backward', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(3000);
    const version = work.getTask('SA-055')!.version;
    await monitor().tick();
    clock.mockReturnValue(2000);
    await monitor(async () => fixture('failed')).tick();
    expect(work.getTask('SA-055')).toMatchObject({
      status: 'BLOCKED',
      version: version + 1,
      pr_status: { ci: 'failure', observedAt: 2000 },
    });
    clock.mockReturnValue(1000);
    await monitor(async () => fixture('merged')).tick();
    expect(work.getTask('SA-055')).toMatchObject({
      status: 'BLOCKED',
      version: version + 1,
      pr_status: { state: 'MERGED', observedAt: 1000 },
      pr_observation: { lastSuccessAt: 1000, attemptedAt: 1000, error: null },
    });
    expect(work.listDecisions()).toHaveLength(1);
    expect(work.listDomainEvents().at(-1)!.type).toBe('PR_MERGED');
  });

  it.each(['success', 'error'] as const)(
    'discards delayed %s after a newer error across monitors',
    async (outcome) => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      await monitor().tick();
      const started = deferred<void>();
      const response = deferred<string>();
      const older = monitor(async () => {
        started.resolve();
        return response.promise;
      });
      const pending = older.tick();
      await started.promise;
      vi.mocked(Date.now).mockReturnValue(3000);
      await monitor(async () => {
        throw new Error('unavailable');
      }).tick();
      const before = work.getTask('SA-055')!;
      const events = work.listDomainEvents();
      expect(before.pr_observation).toEqual({
        lastSuccessAt: 1000,
        attemptedAt: 3000,
        error: 'unavailable',
      });
      vi.mocked(Date.now).mockReturnValue(2000);
      if (outcome === 'success') response.resolve(fixture('open-green'));
      else response.reject(new Error('old error'));
      await pending;
      expect(work.getTask('SA-055')).toEqual(before);
      expect(work.listDomainEvents()).toEqual(events);
      await older.dispose();
    },
  );

  it.each(['success', 'error'] as const)(
    'fences an old binding %s through A -> B -> A',
    async (outcome) => {
      const before = work.getTask('SA-055')!;
      const started = deferred<void>();
      const response = deferred<string>();
      const older = monitor(async () => {
        started.resolve();
        return response.promise;
      });
      const pending = older.tick();
      await started.promise;
      await work.bindPullRequest('SA-055', before.version, ref.replace('/42', '/43'));
      await work.bindPullRequest('SA-055', before.version, ref);
      expect(
        await work.beginPullRequestPoll('SA-055', ref, before.pr_binding_generation!),
      ).toBeUndefined();
      const rebound = work.getTask('SA-055')!;
      expect(rebound).toMatchObject({
        status: 'REVIEW',
        version: before.version,
        pr_binding_generation: before.pr_binding_generation! + 2,
        pr_status: null,
        pr_observation: null,
      });
      if (outcome === 'success') response.resolve(fixture('failed'));
      else response.reject(new Error('old binding'));
      await pending;
      expect(work.getTask('SA-055')).toEqual(rebound);
      await monitor().tick();
      expect(work.getTask('SA-055')).toMatchObject({
        status: 'REVIEW',
        version: before.version,
        pr_status: { ci: 'success' },
      });
      await older.dispose();
    },
  );

  it.each(['decision-first', 'ci-first'] as const)(
    'restores REVIEW after resolving the gate and retrying (%s)',
    async (order) => {
      const red = monitor(async () => fixture('failed'));
      if (order === 'ci-first') await red.tick();
      await work.openDecision(reviewDecision());
      if (order === 'decision-first') await red.tick();
      const audit = vi.fn();
      await expect(
        work.retryTask('SA-055', work.getTask('SA-055')!.version, 'CI fixed', audit),
      ).rejects.toThrow();
      expect(audit).not.toHaveBeenCalled();
      await work.resolveDecision('gate', 'review', 'operator', () => {});
      expect(work.getTask('SA-055')).toMatchObject({
        status: 'BLOCKED',
        ci_restore_status: 'REVIEW',
      });
      await monitor().tick();
      expect(work.getTask('SA-055')!.status).toBe('BLOCKED');
      const restored = await work.retryTask(
        'SA-055',
        work.getTask('SA-055')!.version,
        'CI fixed',
        audit,
      );
      expect(restored).toMatchObject({
        status: 'REVIEW',
        ci_restore_status: null,
        blocked_reason: null,
      });
      expect(work.listDecisions()[0].status).toBe('answered');
      expect(audit).toHaveBeenCalledTimes(1);
      await red.dispose();
    },
  );

  it.each(['BLOCKED', 'unknown', null])(
    'leaves a suspended human block unowned when its saved state is %s',
    async (saved) => {
      await work.transition(
        'SA-055',
        work.getTask('SA-055')!.version,
        'BLOCKED',
        'Human hold',
        'human',
      );
      await work.openDecision(reviewDecision());
      const db = new DatabaseSync(file);
      try {
        db.prepare('UPDATE human_decisions SET previous_states = ? WHERE key = ?').run(
          JSON.stringify({ 'SA-055': saved }),
          'gate',
        );
      } finally {
        db.close();
      }
      const before = work.getTask('SA-055')!;
      await monitor(async () => fixture('failed')).tick();
      expect(work.getTask('SA-055')).toMatchObject({
        status: 'WAITING_HUMAN',
        version: before.version,
        blocked_reason: 'Human hold',
        ci_restore_status: null,
        ci_restore_blocked_reason: null,
        pr_status: { ci: 'failure' },
      });
    },
  );

  it.each(['direct', 'decision-first', 'ci-first'])(
    'preserves infrastructure admission through CI and retry (%s)',
    async (order) => {
      const diagnostic = 'Verifier infrastructure: test runner unavailable';
      work.createTask({
        key: 'developer',
        type: 'code',
        agent_role: 'developer',
        status: 'FAILED_RETRYABLE',
        attempt: 2,
        max_attempts: 3,
        pr_ref: ref,
      });
      // A real claim of the identical pre-CI state proves the baseline admission.
      work.createTask({
        key: 'baseline',
        type: 'code',
        agent_role: 'developer',
        status: 'FAILED_RETRYABLE',
        attempt: 2,
        max_attempts: 3,
      });
      const db = new DatabaseSync(file);
      try {
        db.prepare('UPDATE tasks SET blocked_reason = ? WHERE key IN (?, ?)').run(
          diagnostic,
          'developer',
          'baseline',
        );
      } finally {
        db.close();
      }
      expect(await work.claim('baseline', 'baseline-owner')).toMatchObject({ status: 'LEASED' });
      if (order === 'ci-first') await monitor(async () => fixture('failed')).tick();
      if (order !== 'direct')
        await work.openDecision({ ...reviewDecision(), blocks: ['developer'] });
      if (order !== 'ci-first') await monitor(async () => fixture('failed')).tick();
      expect(work.getTask('developer')).toMatchObject({
        ci_restore_status: 'FAILED_RETRYABLE',
        ci_restore_blocked_reason: diagnostic,
      });
      if (order !== 'direct') await work.resolveDecision('gate', 'review', 'operator', () => {});
      const retried = await work.retryTask(
        'developer',
        work.getTask('developer')!.version,
        'CI fixed',
        () => {},
      );
      expect(retried).toMatchObject({
        status: 'FAILED_RETRYABLE',
        attempt: 2,
        max_attempts: 3,
        blocked_reason: diagnostic,
        ci_restore_status: null,
        ci_restore_blocked_reason: null,
      });
      expect(await work.claim('developer', 'owner')).toMatchObject({
        status: 'LEASED',
        lease_owner: 'owner',
      });
    },
  );

  it('refuses a non-monitor RUNNING block with the CI prefix before auditing', async () => {
    work.createTask({ key: 'manual', type: 'implementation', status: 'QUEUED' });
    await work.claim('manual', 'owner');
    await work.transition('manual', work.getTask('manual')!.version, 'RUNNING', 'start', 'owner');
    const blocked = await work.transition(
      'manual',
      work.getTask('manual')!.version,
      'BLOCKED',
      'CI failed: operator hold',
      'owner',
    );
    const audit = vi.fn();
    await expect(work.retryTask('manual', blocked.version, 'retry', audit)).rejects.toThrow();
    expect(work.getTask('manual')).toEqual(blocked);
    expect(blocked.ci_restore_status).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it('validates a CI retry lease and dependencies before auditing', async () => {
    work.createTask({ key: 'queued', type: 'implementation', status: 'QUEUED', pr_ref: ref });
    await monitor(async () => fixture('failed')).tick();
    work.createTask({ key: 'dependency', type: 'implementation', status: 'DRAFT' });
    work.addTaskDependency('queued', 'dependency');
    const blocked = work.getTask('queued')!;
    const audit = vi.fn();
    await expect(work.retryTask('queued', blocked.version, 'retry', audit)).rejects.toThrow(
      'DEPENDENCIES_NOT_DONE',
    );
    expect(work.getTask('queued')).toEqual(blocked);
    const db = new DatabaseSync(file);
    try {
      db.prepare('UPDATE tasks SET lease_owner = ?, lease_expires_at = ? WHERE key = ?').run(
        'owner',
        '2099-01-01T00:00:00.000Z',
        'queued',
      );
    } finally {
      db.close();
    }
    await expect(work.retryTask('queued', blocked.version, 'retry', audit)).rejects.toThrow(
      'lease',
    );
    expect(audit).not.toHaveBeenCalled();
    expect(work.getTask('queued')).toMatchObject({ status: 'BLOCKED', lease_owner: 'owner' });
  });

  it('clears CI provenance when a human leaves the block before a later ordinary block', async () => {
    await monitor(async () => fixture('failed')).tick();
    const blocked = work.getTask('SA-055')!;
    const ready = await work.transition(
      'SA-055',
      blocked.version,
      'READY',
      'operator reset',
      'human',
    );
    expect(ready.ci_restore_status).toBeNull();
    const held = await work.transition(
      'SA-055',
      ready.version,
      'BLOCKED',
      'CI failed: manual hold',
      'human',
    );
    const audit = vi.fn();
    await expect(work.retryTask('SA-055', held.version, 'retry', audit)).rejects.toThrow();
    expect(work.getTask('SA-055')).toEqual(held);
    expect(audit).not.toHaveBeenCalled();
  });

  it('lets only a human retry restore a CI-blocked task to its previous state', async () => {
    work.createTask({ key: 'ci-block', type: 'implementation', status: 'QUEUED' });
    await work.bindPullRequest('ci-block', work.getTask('ci-block')!.version, ref);
    const observe = (name: string, at: number) =>
      observePullRequest(
        'ci-block',
        work.getTask('ci-block')!.version,
        ref,
        parsePullRequest(fixture(name), ref, at),
        undefined,
      );
    await observe('failed', 1000);
    expect(work.getTask('ci-block')!.status).toBe('BLOCKED');
    await observe('open-green', 2000);
    expect(work.getTask('ci-block')!.status).toBe('BLOCKED');
    const task = work.getTask('ci-block')!;
    const retried = await work.retryTask('ci-block', task.version, 'CI fixed', () => {});
    expect(retried).toMatchObject({ status: 'QUEUED', blocked_reason: null });
    await observe('failed', 3000);
    expect(work.getTask('ci-block')!.status).toBe('BLOCKED');
  });

  it('defers the merge cleanup while a worker holds the task, then asks once', async () => {
    work.createTask({ key: 'active-merge', type: 'implementation', status: 'QUEUED' });
    await work.bindPullRequest('active-merge', work.getTask('active-merge')!.version, ref);
    await work.claim('active-merge', 'owner');
    const leasedVersion = work.getTask('active-merge')!.version;
    await monitor(vi.fn(async () => fixture('merged'))).tick();
    expect(work.getTask('active-merge')).toMatchObject({
      version: leasedVersion,
      status: 'LEASED',
      lease_owner: 'owner',
      pr_status: { state: 'MERGED' },
    });
    expect(
      work
        .listDecisions()
        .every((decision) => !decision.context.startsWith('pr-cleanup/active-merge\n')),
    ).toBe(true);
    await work.release('active-merge', 'owner');
    const version = work.getTask('active-merge')!.version;
    const state = new AgentStateStore();
    const broadcast = vi.spyOn(state, 'broadcast');
    const relay = new DomainEventRelay(state, { projectId: 'p', workStoreFile: () => file });
    relay.snapshot();
    const cleanups = () =>
      work
        .listDecisions()
        .filter((decision) => decision.context.startsWith('pr-cleanup/active-merge\n'));
    try {
      await monitor(vi.fn(async () => fixture('merged'))).tick();
      expect(cleanups()).toHaveLength(1);
      expect(work.getTask('active-merge')!.version).toBe(version);
      const decisionId = cleanups()[0].id;
      expect(work.listDomainEvents('active-merge').at(-1)).toMatchObject({
        type: 'PR_MERGED',
        task_version: version,
        reason: decisionId,
      });
      relay.tick();
      expect(broadcast).toHaveBeenCalledWith({
        type: 'domainEvent',
        event: expect.objectContaining({
          kind: 'pr.merged',
          taskKey: 'active-merge',
          taskVersion: version,
          decisionId,
        }),
      });
      await monitor(vi.fn(async () => fixture('merged'))).tick();
      expect(cleanups()).toHaveLength(1);
    } finally {
      relay.dispose();
      state.dispose();
    }
  });
});

describe('gh JSON parsing', () => {
  it('counts StatusContext ERROR and FAILURE separately from CheckRun conclusions', () => {
    const pr = parsePullRequest(fixture('status-error'), ref);
    expect(pr.ci).toBe('failure');
    expect(pr.failedChecks).toEqual(['commit-status-error', 'commit-status-failure']);
  });
  it.each([
    'http://github.com/example/project/pull/42',
    'https://user:password@github.com/example/project/pull/42',
    'https://github.com:443/example/project/pull/42',
    'https://github.com:8443/example/project/pull/42',
    'https://other.invalid/example/project/pull/42',
    'https://github.com/other/project/pull/42',
    'https://github.com/example/project/pull/43',
    'https://github.com/example/project/pull/42?extra=1',
  ])('rejects mismatched or unsafe URL %s', (url) => {
    expect(() =>
      parsePullRequest(JSON.stringify({ ...JSON.parse(fixture('open-green')), url }), ref),
    ).toThrow();
  });
  it('rejects excessive strings, check counts and raw output', () => {
    const pr = JSON.parse(fixture('open-green'));
    expect(() =>
      parsePullRequest(
        JSON.stringify({ ...pr, headRefName: 'x'.repeat(PR_MAX_STRING_CHARS + 1) }),
        ref,
      ),
    ).toThrow();
    expect(() =>
      parsePullRequest(
        JSON.stringify({
          ...pr,
          statusCheckRollup: Array.from({ length: PR_MAX_CHECKS + 1 }, () => ({
            __typename: 'StatusContext',
            context: 'ci',
            state: 'SUCCESS',
          })),
        }),
        ref,
      ),
    ).toThrow();
    expect(() =>
      parsePullRequest(' '.repeat(GH_PR_MAX_BUFFER_BYTES + 1) + fixture('open-green'), ref),
    ).toThrow();
  });
  it('distinguishes pending, empty and ignored checks from success', () => {
    const pr = JSON.parse(fixture('open-green'));
    for (const rollup of [
      [],
      null,
      [{ __typename: 'CheckRun', name: 'optional', conclusion: 'SKIPPED' }],
    ]) {
      expect(parsePullRequest(JSON.stringify({ ...pr, statusCheckRollup: rollup }), ref).ci).toBe(
        'unknown',
      );
    }
    expect(
      parsePullRequest(
        JSON.stringify({
          ...pr,
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' },
          ],
        }),
        ref,
      ).ci,
    ).toBe('pending');
  });
  it('rejects malformed output and inconsistent merges', () => {
    expect(() => parsePullRequest('invalid json', ref)).toThrow();
    expect(() => parsePullRequest('{}', ref)).toThrow();
    const pr = JSON.parse(fixture('merged'));
    expect(() => parsePullRequest(JSON.stringify({ ...pr, mergedAt: null }), ref)).toThrow();
  });
});
