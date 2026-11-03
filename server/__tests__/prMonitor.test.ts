import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { readCharacterDetail } from '../src/characterDetail.js';
import { DomainEventRelay } from '../src/domainEventRelay.js';
import { parsePullRequest, PullRequestMonitor } from '../src/prMonitor.js';
import { terminateExecutionTree } from '../src/workstore/processRecovery.js';
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
const ref = '42';
let root: string;
let work: WorkStore;
let file: string;

beforeEach(async () => {
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
    pr_ref: ref,
    branch: 'sa/SA-055',
    worktree_ref: path.join(root, '.worktrees/SA-055'),
  });
  fs.mkdirSync(path.join(root, '.worktrees/SA-055'), { recursive: true });
  fs.writeFileSync(path.join(root, '.worktrees/SA-055/uncommitted.txt'), 'keep');
});
afterEach(() => {
  work?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function monitor(read = vi.fn(async () => fixture('open-green')), log = vi.fn()) {
  return new PullRequestMonitor({ repositoryPath: root, projectId: 'p', read, log });
}

describe('PR observations through the real WorkStore and relay', () => {
  it('keeps open green work in REVIEW and projects PR/CI to snapshots, detail and board', async () => {
    const poller = monitor();
    await poller.tick();
    expect(work.getTask('SA-055')).toMatchObject({
      status: 'REVIEW',
      blocked_reason: null,
      pr_status: { state: 'OPEN', ci: 'success', reviewDecision: 'APPROVED' },
    });
    expect(work.listDecisions()).toEqual([]);
    const version = work.getTask('SA-055')!.version;
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

  it('blocks failed checks with their names, ignoring neutral and skipped checks', async () => {
    await monitor(vi.fn(async () => fixture('failed'))).tick();
    expect(work.getTask('SA-055')).toMatchObject({
      status: 'BLOCKED',
      blocked_reason: 'CI failed: build, lint, security, tests',
    });
    expect(work.listDomainEvents().map((event) => event.type)).toEqual([
      'TASK_TRANSITIONED',
      'PR_UPDATED',
    ]);
    await monitor().tick();
    expect(work.getTask('SA-055')!.status).toBe('BLOCKED');
  });

  it('closes an active execution before releasing the lease on CI failure', async () => {
    work.createTask({ key: 'active', type: 'implementation', status: 'QUEUED', pr_ref: ref });
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
    expect(terminateExecutionTree).toHaveBeenCalledWith(12345, 'identity');
    expect(work.getExecution('execution')!.tree_closed_at).toBeTruthy();
    expect(work.getTask('active')).toMatchObject({ status: 'BLOCKED', lease_owner: null });
    expect(work.listLeaseRecoveries()).toEqual([]);
  });

  it('emits a single merge event and durable human cleanup request even for DONE work', async () => {
    work.createTask({ key: 'done', type: 'implementation', status: 'DONE', pr_ref: ref });
    const store = new AgentStateStore();
    const broadcast = vi.spyOn(store, 'broadcast');
    const relay = new DomainEventRelay(store, { projectId: 'p', workStoreFile: () => file });
    relay.tick();
    try {
      await monitor(vi.fn(async () => fixture('merged'))).tick();
      relay.tick();
      const gates = work.listDecisions();
      expect(gates).toHaveLength(2);
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
      expect(work.getTask('done')!.status).toBe('DONE');
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
    expect(work.getTask('SA-055')).toEqual(before);
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
      work.observePullRequest(before.key, before.version, ref, pr, undefined),
    ).rejects.toThrow('manual cleanup decision');
    expect(work.getTask('SA-055')).toEqual(before);
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
    await work.resolveDecision('gate', 'review', 'operator', () => {});
    expect(work.getTask('SA-055')!.status).toBe('BLOCKED');
  });

  it('migrates an existing store without losing append-only event ids or PR references', async () => {
    const task = work.getTask('SA-055')!;
    await work.transition(task.key, task.version, 'BLOCKED', 'hold', 'operator');
    const events = work.listDomainEvents();
    work.close();
    const db = new DatabaseSync(file);
    try {
      db.exec(
        'ALTER TABLE tasks DROP COLUMN pr_status; UPDATE schema_version SET version = version - 1',
      );
    } finally {
      db.close();
    }
    work = await openWorkStore({ repositoryPath: root, projectId: 'p' });
    expect(work.listDomainEvents()).toEqual(events);
    expect(work.getTask('SA-055')).toMatchObject({ pr_ref: ref, pr_status: null });
    await monitor(vi.fn(async () => fixture('merged'))).tick();
    expect(work.listDomainEvents().at(-1)!.id).toBeGreaterThan(events[0].id);
  });
});

describe('gh JSON parsing', () => {
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
