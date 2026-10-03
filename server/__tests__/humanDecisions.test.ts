import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/auditLog.js';
import { HumanDecisions } from '../src/humanDecisions.js';
import { processStartIdentity, terminateExecutionTree } from '../src/workstore/processRecovery.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});
vi.mock('../src/workstore/processRecovery.js', () => ({
  processStartIdentity: vi.fn(async () => 'identity'),
  terminateExecutionTree: vi.fn(async () => {}),
}));
const input = {
  id: 'decision',
  context: 'Choose a strategy',
  options: [{ id: 'review', label: 'Review', benefit: 'Confidence', cost: 'Time', risk: 'Delay' }],
  recommendation: 'Review',
  disagreement: [{ role: 'developer', position: 'Ship' }],
  impact: 'Blocks work',
  urgency: 'high' as const,
  requestedBy: 'developer',
  blocks: ['task'],
};
describe('structured human decisions', () => {
  let root: string;
  let store: WorkStore;
  let service: HumanDecisions;
  beforeEach(async () => {
    vi.mocked(terminateExecutionTree).mockReset();
    vi.mocked(processStartIdentity).mockResolvedValue('identity');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-decisions-'));
    vi.stubEnv('HOME', root);
    execFileSync('git', ['init', root], { stdio: 'pipe', windowsHide: true });
    store = await openWorkStore({ repositoryPath: root, projectId: 'test' });
    service = new HumanDecisions(store);
    store.createTask({ key: 'task', type: 'implementation', status: 'QUEUED' });
    const leased = await store.claim('task', 'worker');
    await store.transition('task', leased.version, 'RUNNING', 'start', 'worker');
  });
  afterEach(() => {
    store?.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function execution(key = 'run') {
    await store.createExecution({
      key,
      task_key: 'task',
      agent_template_version: 'developer@v1',
      executor: 'codex',
      model_id: 'model',
      session_id: null,
      pid: 12345,
      started_at: new Date().toISOString(),
      system_prompt_hash: 'hash',
      project_brain_sha: 'sha',
      task_version: store.getTask('task')!.version,
      tool_policy_version: 'v1',
    });
  }
  it('suspends active work, records events and answeredBy durably, and requires a new claim', async () => {
    await execution();
    await store.openDecision(input);
    expect(store.getTask('task')).toMatchObject({
      status: 'WAITING_HUMAN',
      version: 4,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(terminateExecutionTree).toHaveBeenCalledExactlyOnceWith(12345, 'identity');
    expect(store.getExecution('run')?.tree_closed_at).toEqual(expect.any(String));
    expect(store.listLeaseRecoveries()).toEqual([]);
    await expect(store.transition('task', 4, 'READY', 'bypass', 'agent')).rejects.toThrow();
    await service.answer('decision', 'review', true, 'fede', 'A0');
    expect(store.getTask('task')).toMatchObject({
      status: 'READY',
      version: 5,
      attempt: 0,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(store.listDomainEvents().map((e) => e.to_status)).toEqual([
      'LEASED',
      'RUNNING',
      'WAITING_HUMAN',
      'READY',
    ]);
    await expect(store.heartbeat('task', 'worker')).rejects.toThrow('not owned');
    await expect(store.transition('task', 5, 'RUNNING', 'resume', 'worker')).rejects.toThrow();
    expect(store.listExecutions()).toHaveLength(1);
    store.close();
    store = await openWorkStore({ repositoryPath: root, projectId: 'test' });
    expect(store.listDecisions()[0]).toMatchObject({
      status: 'answered',
      answeredBy: 'fede',
      answer: 'review',
    });
    const audit = fs
      .readFileSync(new AuditLog().file('test'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(audit[0]).toMatchObject({
      actorId: 'fede',
      policyDecision: { outcome: 'allow' },
      outcome: { status: 'answered', detail: JSON.stringify({ answeredBy: 'fede' }) },
    });
    expect(await store.claim('task', 'next-worker')).toMatchObject({
      status: 'LEASED',
      lease_owner: 'next-worker',
      attempt: 0,
    });
    expect(terminateExecutionTree).toHaveBeenCalledTimes(1);
  });
  it('rejects unlisted answers and missing token without releasing tasks', async () => {
    await store.openDecision(input);
    await expect(service.answer('decision', 'invented', true, 'fede', 'A4')).rejects.toThrow(
      'listed option',
    );
    await expect(service.answer('decision', 'review', false, 'agent', 'A4')).rejects.toThrow(
      'token',
    );
    expect(store.getTask('task')?.status).toBe('WAITING_HUMAN');
    expect(store.listDecisions()[0].status).toBe('open');
  });
  it('rolls back all task changes when one block is missing or duplicate decision is opened', async () => {
    const original = store.getTask('task');
    const events = store.listDomainEvents();
    await execution();
    await expect(store.openDecision({ ...input, blocks: ['task', 'missing'] })).rejects.toThrow();
    expect(store.getTask('task')).toEqual(original);
    expect(store.listDomainEvents()).toEqual(events);
    expect(store.listLeaseRecoveries()).toEqual([]);
    expect(terminateExecutionTree).not.toHaveBeenCalled();
    await store.openDecision(input);
    await expect(store.openDecision({ ...input, blocks: [] })).rejects.toThrow();
    expect(store.listDecisions()).toHaveLength(1);
  });
  it('rolls back the answer and restoration when audit persistence fails', async () => {
    await store.openDecision(input);
    vi.spyOn(AuditLog.prototype, 'append').mockImplementation(() => {
      throw new Error('audit unavailable');
    });
    await expect(service.answer('decision', 'review', true, 'fede', 'A2')).rejects.toThrow(
      'audit unavailable',
    );
    expect(store.listDecisions()[0].status).toBe('open');
    expect(store.getTask('task')?.status).toBe('WAITING_HUMAN');
  });
  it('rejects duplicate option IDs and invalid escalation packages', async () => {
    await expect(
      store.openDecision({ ...input, options: [input.options[0], input.options[0]] }),
    ).rejects.toThrow('unique');
    await expect(store.openDecision({ ...input, urgency: 'invalid' as 'high' })).rejects.toThrow();
  });
  it('policy require_human opens a scoped decision and never bypasses deny', async () => {
    expect(
      await service.requireHuman('push_main', 'agent', 'A4', 'Push', ['task']),
    ).toBeUndefined();
    await service.requireHuman('touch_protected_path', 'system', 'A4', 'Protected paths', ['task']);
    expect(store.listDecisions()[0]).toMatchObject({ status: 'open', blocks: ['task'] });
    expect(store.getTask('task')?.status).toBe('WAITING_HUMAN');
  });
  it.each([
    'DRAFT',
    'READY',
    'QUEUED',
    'LEASED',
    'RUNNING',
    'REVIEW',
    'QA',
    'BLOCKED',
    'FAILED_RETRYABLE',
    'WAITING_QUOTA',
  ] as const)('restores %s without incrementing attempts', async (status) => {
    store.createTask({
      key: 'other',
      type: 'implementation',
      status: ['LEASED', 'RUNNING'].includes(status) ? 'QUEUED' : status,
      blocked_reason: 'existing reason',
    });
    if (status === 'LEASED' || status === 'RUNNING') {
      const leased = await store.claim('other', 'other-worker');
      if (status === 'RUNNING')
        await store.transition('other', leased.version, 'RUNNING', 'start', 'other-worker');
    }
    const original = store.getTask('other')!;
    await store.openDecision({ ...input, blocks: ['other'] });
    await service.answer('decision', 'review', true, 'operator', 'A0');
    expect(store.getTask('other')).toMatchObject({
      status: ['LEASED', 'RUNNING'].includes(status) ? 'READY' : status,
      attempt: 0,
      blocked_reason: original.blocked_reason,
      lease_owner: null,
      lease_expires_at: null,
    });
  });
  it('expires without releasing the human gate or recording a human answer', async () => {
    await store.openDecision(input);
    await store.resolveDecision('decision', null, 'runtime', () => {});
    expect(store.listDecisions()[0]).toMatchObject({
      status: 'expired',
      answeredBy: null,
      answeredAt: null,
    });
    expect(store.getTask('task')?.status).toBe('WAITING_HUMAN');
  });
  it('rejects overlapping gates and repeated answers', async () => {
    await store.openDecision(input);
    await expect(store.openDecision({ ...input, id: 'other' })).rejects.toThrow();
    await service.answer('decision', 'review', true, 'fede', 'A4');
    await expect(service.answer('decision', 'review', true, 'fede', 'A4')).rejects.toThrow(
      'closed',
    );
  });
  it('reserves all blocks across connections while stopping executors, then commits together', async () => {
    await execution();
    store.createTask({ key: 'other', type: 'implementation', status: 'REVIEW' });
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(terminateExecutionTree).mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const peer = await openWorkStore({ repositoryPath: root, projectId: 'test' });
    const submitted = structuredClone({ ...input, blocks: ['task', 'other'] });
    const opening = store.openDecision(submitted);
    try {
      await started;
      submitted.blocks.push('unreserved');
      submitted.options[0].id = 'mutated';
      const pending = peer.listLeaseRecoveries();
      expect(pending).toHaveLength(2);
      expect(peer.listDecisions()).toEqual([]);
      expect(peer.getTask('task')?.status).toBe('RUNNING');
      expect(peer.getTask('other')?.status).toBe('REVIEW');
      await expect(peer.heartbeat('task', 'worker')).rejects.toThrow('recovery reserved');
      await expect(peer.release('task', 'worker')).rejects.toThrow('recovery reserved');
      await expect(peer.claim('task', 'new-worker')).rejects.toThrow('recovery reserved');
      await expect(peer.claimRework('other', 1, 'new-worker')).rejects.toThrow('recovery reserved');
      await expect(peer.transition('task', 3, 'REVIEW', 'done', 'worker')).rejects.toThrow(
        'recovery reserved',
      );
      await expect(
        peer.createExecution({ ...store.getExecution('run')!, key: 'late' }),
      ).rejects.toThrow('recovery reserved');
      await expect(peer.openDecision({ ...input, id: 'competing' })).rejects.toThrow(
        'recovery reserved',
      );
      expect(peer.listLeaseRecoveries()).toEqual(pending);
      finish();
      await opening;
      expect(peer.listDecisions()[0]).toMatchObject({
        blocks: ['task', 'other'],
        options: [{ id: 'review' }],
      });
      expect(peer.listTasks().map((t) => t.status)).toEqual(['WAITING_HUMAN', 'WAITING_HUMAN']);
      expect(peer.listLeaseRecoveries()).toEqual([]);
      await service.answer('decision', 'review', true, 'fede', 'A0');
      expect(peer.getTask('task')?.status).toBe('READY');
      expect(peer.getTask('other')?.status).toBe('REVIEW');
    } finally {
      finish();
      await opening.catch(() => {});
      peer.close();
    }
  });
  it('retains durable recovery tokens and all task states if termination cannot be verified', async () => {
    await execution();
    store.createTask({ key: 'other', type: 'implementation', status: 'READY' });
    const tasks = store.listTasks();
    const events = store.listDomainEvents();
    vi.mocked(terminateExecutionTree).mockRejectedValueOnce(new Error('tree closure unproven'));
    await expect(store.openDecision({ ...input, blocks: ['other', 'task'] })).rejects.toThrow(
      'tree closure unproven',
    );
    expect(store.listTasks()).toEqual(tasks);
    expect(store.listDomainEvents()).toEqual(events);
    expect(store.listDecisions()).toEqual([]);
    expect(store.getExecution('run')?.tree_closed_at).toBeNull();
    const pending = store.listLeaseRecoveries();
    expect(pending).toHaveLength(2);
    expect(pending.every((r) => r.error === 'tree closure unproven')).toBe(true);
    store.close();
    store = await openWorkStore({ repositoryPath: root, projectId: 'test' });
    expect(store.listLeaseRecoveries()).toEqual(pending);
    await expect(store.openDecision(input)).rejects.toThrow('recovery reserved');
    await expect(store.claim('other', 'new-worker')).rejects.toThrow('recovery reserved');
  });
  it('rolls back decision, task and event writes on SQL failure after verified termination', async () => {
    await execution();
    const task = store.getTask('task');
    const events = store.listDomainEvents();
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    const failing = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: import('node:sqlite').DatabaseSync,
      sql,
    ) {
      if (sql.includes('INSERT INTO human_decisions')) throw new Error('decision write failed');
      return prepare.call(this, sql);
    });
    await expect(store.openDecision(input)).rejects.toThrow('decision write failed');
    failing.mockRestore();
    expect(store.getTask('task')).toEqual(task);
    expect(store.listDomainEvents()).toEqual(events);
    expect(store.listDecisions()).toEqual([]);
    expect(store.getExecution('run')?.tree_closed_at).toEqual(expect.any(String));
    expect(store.listLeaseRecoveries()).toMatchObject([
      { task_key: 'task', task_version: 3, error: 'decision write failed' },
    ]);
  });
  it('requires normal recovery of an expired lease before opening a decision', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(store.getTask('task')!.lease_expires_at!));
    const task = store.getTask('task');
    await expect(store.openDecision(input)).rejects.toThrow('expired');
    expect(store.getTask('task')).toEqual(task);
    expect(store.listLeaseRecoveries()).toEqual([]);
    expect(store.listDecisions()).toEqual([]);
    await store.recoverExpiredLeases();
    await store.openDecision(input);
    await service.answer('decision', 'review', true, 'fede', 'A0');
    expect(store.getTask('task')).toMatchObject({
      status: 'FAILED_RETRYABLE',
      attempt: 1,
      lease_owner: null,
    });
  });
  it.each(['review', null])(
    'rejects answer/expiry %s when a block has a recovery token',
    async (answer) => {
      await store.openDecision(input);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
      try {
        db.prepare('INSERT INTO lease_recoveries VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(
          'test',
          'task',
          'reserved-token',
          4,
          'reconcile',
          'operator',
          new Date().toISOString(),
        );
      } finally {
        db.close();
      }
      const decision = store.listDecisions()[0];
      const task = store.getTask('task');
      const events = store.listDomainEvents();
      const beforeCommit = vi.fn();
      await expect(store.resolveDecision('decision', answer, 'fede', beforeCommit)).rejects.toThrow(
        'recovery reserved',
      );
      expect(beforeCommit).not.toHaveBeenCalled();
      expect(store.listDecisions()[0]).toEqual(decision);
      expect(store.getTask('task')).toEqual(task);
      expect(store.listDomainEvents()).toEqual(events);
      expect(store.listLeaseRecoveries()[0].token).toBe('reserved-token');
    },
  );
  it('rolls back every restoration and event when the answer audit fails', async () => {
    store.createTask({
      key: 'other',
      type: 'implementation',
      status: 'BLOCKED',
      blocked_reason: 'dependency',
    });
    await store.openDecision({ ...input, blocks: ['task', 'other'] });
    const tasks = store.listTasks();
    const events = store.listDomainEvents();
    await expect(
      store.resolveDecision('decision', 'review', 'fede', () => {
        throw new Error('audit unavailable');
      }),
    ).rejects.toThrow('audit unavailable');
    expect(store.listTasks()).toEqual(tasks);
    expect(store.listDomainEvents()).toEqual(events);
    expect(store.listDecisions()[0].status).toBe('open');
  });
});
