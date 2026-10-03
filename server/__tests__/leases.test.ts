import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processStartIdentity, terminateExecutionTree } from '../src/workstore/processRecovery.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

vi.mock('../src/workstore/processRecovery.js', () => ({
  processStartIdentity: vi.fn(async () => 'identity'),
  terminateExecutionTree: vi.fn(async () => {}),
}));

describe('WorkStore leases and durable idempotency', () => {
  let root: string;
  const stores: WorkStore[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-leases-'));
    execFileSync('git', ['init', root], { stdio: 'pipe', windowsHide: true });
    vi.mocked(terminateExecutionTree).mockReset();
    vi.mocked(processStartIdentity).mockResolvedValue('identity');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function open(projectId = 'a') {
    const store = await openWorkStore({ repositoryPath: root, projectId });
    stores.push(store);
    return store;
  }
  function queued(store: WorkStore, max_attempts = 3) {
    store.createTask({ key: 'task', type: 'implementation', status: 'QUEUED', max_attempts });
  }
  function clock() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T10:00:00Z'));
  }
  function advance(ms: number) {
    vi.setSystemTime(Date.now() + ms);
  }
  async function execution(store: WorkStore) {
    await store.createExecution({
      key: 'run',
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
  it('recovers at the TTL boundary once, increments attempts and records the event', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'worker-1', 1000);
    advance(999);
    expect(await store.recoverExpiredLeases()).toEqual([]);
    advance(1);
    expect(await store.recoverExpiredLeases()).toMatchObject([
      { status: 'FAILED_RETRYABLE', attempt: 1, lease_owner: null, lease_expires_at: null },
    ]);
    expect(await store.recoverExpiredLeases()).toEqual([]);
    expect(store.listDomainEvents('task').at(-1)).toMatchObject({
      from_status: 'LEASED',
      to_status: 'FAILED_RETRYABLE',
      attempt: 1,
      actor: 'lease-sweeper',
    });
  });
  it('heartbeats RUNNING without invalidating the execution version and rejects stale owners', async () => {
    const store = await open();
    queued(store);
    clock();
    const lease = await store.claim('task', 'worker-1', 1000);
    const running = await store.transition('task', lease.version, 'RUNNING', 'start', 'worker-1');
    advance(900);
    expect(await store.heartbeat('task', 'worker-1', 1000)).toMatchObject({
      version: running.version,
    });
    advance(200);
    expect(await store.recoverExpiredLeases()).toEqual([]);
    await expect(store.heartbeat('task', 'worker-2', 1000)).rejects.toThrow('not owned');
    advance(800);
    await expect(store.heartbeat('task', 'worker-1', 1000)).rejects.toThrow('expired');
    await expect(
      store.transition('task', running.version, 'REVIEW', 'done', 'worker-1'),
    ).rejects.toThrow('Expired');
    await store.claim('task', 'worker-2', 1000);
    await expect(store.release('task', 'worker-1')).rejects.toThrow('not owned');
    await expect(
      store.transition('task', running.version, 'REVIEW', 'late', 'worker-1'),
    ).rejects.toThrow('expected version');
  });
  it('only one concurrent claimant wins across two SQLite connections', async () => {
    const a = await open();
    const b = await open();
    queued(a);
    const results = await Promise.allSettled([a.claim('task', 'a'), b.claim('task', 'b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(a.listDomainEvents('task').filter((e) => e.to_status === 'LEASED')).toHaveLength(1);
  });
  it('stops at max_attempts and cannot claim FAILED_FINAL', async () => {
    const store = await open();
    queued(store, 2);
    clock();
    await store.claim('task', 'first', 100);
    advance(100);
    await store.claim('task', 'second', 100);
    advance(100);
    await store.recoverExpiredLeases();
    expect(store.getTask('task')).toMatchObject({ status: 'FAILED_FINAL', attempt: 2 });
    await expect(store.claim('task', 'third')).rejects.toThrow('INVALID_TRANSITION');
  });
  it('kills under a token and persistently blocks reassignment on termination failure', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'first', 100);
    await execution(store);
    expect(store.getExecution('run')?.pid_started_at).toBe('identity');
    advance(100);
    vi.mocked(terminateExecutionTree).mockImplementation(async () => {
      expect(store.getTask('task')?.status).toBe('LEASED');
      throw new Error('termination failed');
    });
    await expect(store.claim('task', 'second')).rejects.toThrow('termination failed');
    expect(store.getTask('task')).toMatchObject({ lease_owner: 'first', attempt: 0 });
    vi.mocked(terminateExecutionTree).mockImplementation(async () => {});
    await expect(store.claim('task', 'second')).rejects.toThrow('termination failed');
    expect(store.listLeaseRecoveries()).toMatchObject([
      { task_key: 'task', error: 'termination failed' },
    ]);
    expect(terminateExecutionTree).toHaveBeenCalledWith(12345, 'identity');
  });
  it('release terminates the executor and clears the lease; normal completion also clears it', async () => {
    const store = await open();
    queued(store);
    await store.claim('task', 'worker');
    await execution(store);
    expect(await store.release('task', 'worker')).toMatchObject({
      status: 'FAILED_RETRYABLE',
      lease_owner: null,
      attempt: 1,
    });
    expect(terminateExecutionTree).toHaveBeenCalled();
    const lease = await store.claim('task', 'next');
    expect(terminateExecutionTree).toHaveBeenCalledTimes(1); // Durable closure proof skips the old PID.
    const running = await store.transition('task', lease.version, 'RUNNING', 'start', 'next');
    expect(await store.transition('task', running.version, 'REVIEW', 'done', 'next')).toMatchObject(
      { lease_owner: null, lease_expires_at: null },
    );
  });
  it('a delayed sweeper never terminates an Execution from a newer lease', async () => {
    const store = await open();
    queued(store);
    clock();
    const old = await store.claim('task', 'old', 100);
    advance(100);
    await store.claim('task', 'new');
    await execution(store);
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: import('node:sqlite').DatabaseSync,
      sql,
    ) {
      if (sql.startsWith('SELECT key FROM tasks'))
        return { all: () => [{ key: old.key }] } as unknown as ReturnType<typeof prepare>;
      return prepare.call(this, sql);
    });
    vi.mocked(terminateExecutionTree).mockClear();
    expect(await store.recoverExpiredLeases()).toEqual([]);
    expect(terminateExecutionTree).not.toHaveBeenCalled();
    expect(store.getTask('task')?.lease_owner).toBe('new');
  });
  it('rejects every public entry to active states without atomic lease acquisition', async () => {
    const store = await open();
    expect(() => store.createTask({ key: 'invalid', type: 'dev', status: 'LEASED' })).toThrow(
      'claim',
    );
    expect(() =>
      store.createTask({
        key: 'invalid',
        type: 'dev',
        status: 'RUNNING',
        lease_owner: 'imported',
        lease_expires_at: new Date(Date.now() + 1000).toISOString(),
      }),
    ).toThrow('claim');
    queued(store);
    await expect(store.transition('task', 1, 'LEASED', 'bypass', 'worker')).rejects.toThrow(
      'lease',
    );
    const leased = await store.claim('task', 'worker');
    const running = await store.transition('task', leased.version, 'RUNNING', 'start', 'worker');
    const review = await store.transition('task', running.version, 'REVIEW', 'done', 'worker');
    await expect(
      store.transition('task', review.version, 'RUNNING', 'rework', 'worker'),
    ).rejects.toThrow('claimRework');
    const rework = await store.claimRework('task', review.version, 'new', 1000);
    expect(rework).toMatchObject({ status: 'RUNNING', attempt: 1, lease_owner: 'new' });
    expect(rework.lease_expires_at).not.toBeNull();
    const again = await store.transition('task', rework.version, 'REVIEW', 'done', 'new');
    const qa = await store.transition('task', again.version, 'QA', 'reviewed', 'reviewer');
    const other = await open();
    const results = await Promise.allSettled([
      store.claimRework('task', qa.version, 'a'),
      other.claimRework('task', qa.version, 'b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.getTask('task')).toMatchObject({ status: 'RUNNING', attempt: 2 });
  });
  it('keeps heartbeats and independent claims moving while one OS recovery is slow', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'old', 1000);
    await execution(store);
    store.createTask({ key: 'healthy', type: 'dev', status: 'QUEUED' });
    store.createTask({ key: 'independent', type: 'dev', status: 'QUEUED' });
    await store.claim('healthy', 'alive', 10000);
    advance(1000);
    let finish!: () => void;
    vi.mocked(terminateExecutionTree).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(store, 'listExecutions').mockImplementation(() => {
      throw new Error('must query relevant executions only');
    });
    const sweep = store.recoverExpiredLeases();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    for (let i = 0; i < 4; i++) {
      advance(2000);
      expect(await store.heartbeat('healthy', 'alive', 10000)).toMatchObject({
        lease_owner: 'alive',
      });
    }
    expect(await store.claim('independent', 'next')).toMatchObject({ status: 'LEASED' });
    await expect(store.heartbeat('task', 'old')).rejects.toThrow('recovery reserved');
    await expect(execution(store)).rejects.toThrow('recovery reserved');
    finish();
    expect(await sweep).toMatchObject([{ key: 'task', status: 'FAILED_RETRYABLE' }]);
  });
  it('persists errors per task across reopen without blocking other recoveries or claims', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'old', 100);
    await execution(store);
    store.createTask({ key: 'other', type: 'dev', status: 'QUEUED' });
    await store.claim('other', 'other-old', 100);
    advance(100);
    vi.mocked(terminateExecutionTree).mockRejectedValueOnce(
      new Error('root disappeared; tree closure unproven'),
    );
    expect(await store.recoverExpiredLeases()).toMatchObject([{ key: 'other' }]);
    const reopened = await open();
    expect(reopened.listLeaseRecoveries()).toMatchObject([
      { task_key: 'task', error: 'root disappeared; tree closure unproven' },
    ]);
    await expect(reopened.claim('task', 'next')).rejects.toThrow('tree closure unproven');
    expect(await reopened.claim('other', 'next')).toMatchObject({ lease_owner: 'next' });
    expect(store.getTask('task')).toMatchObject({ status: 'LEASED', attempt: 0 });
    const anotherProject = await open('b');
    queued(anotherProject);
    expect(anotherProject.listLeaseRecoveries()).toEqual([]);
    expect(await anotherProject.claim('task', 'isolated')).toMatchObject({
      lease_owner: 'isolated',
    });
  });
  it('scheduled heartbeats keep a healthy lease alive while a real async child delays recovery beyond its TTL', async () => {
    const store = await open();
    queued(store);
    const realNow = Date.now();
    clock();
    vi.setSystemTime(realNow - 2000);
    await store.claim('task', 'old', 1000);
    await execution(store);
    advance(1000);
    // The orphan is expired, but heartbeat and the OS delay now use real timers.
    vi.useRealTimers();
    store.createTask({ key: 'healthy', type: 'dev', status: 'QUEUED' });
    await store.claim('healthy', 'alive', 2000);
    let started = false;
    vi.mocked(terminateExecutionTree).mockImplementationOnce(async () => {
      started = true;
      await promisify(execFile)(process.execPath, ['-e', 'setTimeout(()=>{},2500)'], {
        windowsHide: true,
        timeout: 8000,
      });
    });
    let renewals = 0;
    const errors: unknown[] = [];
    const pending: Promise<void>[] = [];
    const timer = setInterval(() => {
      pending.push(
        store.heartbeat('healthy', 'alive', 2000).then(
          () => {
            renewals++;
          },
          (error: unknown) => {
            errors.push(error);
          },
        ),
      );
    }, 100);
    try {
      const sweep = store.recoverExpiredLeases();
      await vi.waitFor(() => expect(started).toBe(true));
      await sweep;
      expect(renewals).toBeGreaterThanOrEqual(5);
      expect(errors).toEqual([]);
      expect(await store.heartbeat('healthy', 'alive', 2000)).toMatchObject({
        lease_owner: 'alive',
      });
      expect(store.getTask('task')?.status).toBe('FAILED_RETRYABLE');
    } finally {
      clearInterval(timer);
      await Promise.all(pending);
    }
  });
  it('never finalizes against a replaced recovery token', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'old', 100);
    await execution(store);
    advance(100);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
    try {
      vi.mocked(terminateExecutionTree).mockImplementationOnce(async () => {
        db.prepare('UPDATE lease_recoveries SET token = ? WHERE task_key = ?').run(
          'replacement',
          'task',
        );
      });
      expect(await store.recoverExpiredLeases()).toEqual([]);
      expect(store.listLeaseRecoveries()).toMatchObject([{ token: 'replacement', error: null }]);
      expect(store.getTask('task')).toMatchObject({ lease_owner: 'old', version: 2, attempt: 0 });
      expect(store.getExecution('run')?.tree_closed_at).toBeNull();
      expect(store.listDomainEvents('task')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
  it('retains the token and tree proof when the final recovery transaction rolls back', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'old', 100);
    await execution(store);
    advance(100);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
    try {
      db.exec(
        "CREATE TRIGGER fail_recovery_event AFTER INSERT ON domain_events BEGIN SELECT RAISE(ABORT, 'event failed'); END;",
      );
      expect(await store.recoverExpiredLeases()).toEqual([]);
      expect(store.listLeaseRecoveries()).toMatchObject([{ error: 'event failed' }]);
      expect(store.getTask('task')).toMatchObject({ lease_owner: 'old', version: 2, attempt: 0 });
      expect(store.getExecution('run')?.tree_closed_at).toBeTruthy();
      expect(store.listDomainEvents('task')).toHaveLength(1);
      await expect(store.claim('task', 'next')).rejects.toThrow('event failed');
    } finally {
      db.close();
    }
  });
  it('fences an identity lookup started before recovery reserved its token', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'worker', 100);
    let identified!: (value: string) => void;
    vi.mocked(processStartIdentity).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          identified = resolve;
        }),
    );
    const registration = execution(store);
    advance(100);
    await store.recoverExpiredLeases();
    identified('identity');
    await expect(registration).rejects.toThrow('Task changed');
    expect(store.listExecutions()).toEqual([]);
  });
  it('handles forward/backward wall-clock jumps conservatively without reviving expired leases', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'worker', 1000);
    advance(-5000);
    expect(await store.recoverExpiredLeases()).toEqual([]);
    await store.heartbeat('task', 'worker', 1000);
    advance(6000);
    await expect(store.heartbeat('task', 'worker')).rejects.toThrow('expired');
    expect(await store.recoverExpiredLeases()).toMatchObject([{ attempt: 1 }]);
    advance(-10000);
    await expect(store.heartbeat('task', 'worker')).rejects.toThrow('not owned');
  });
  it('fences Execution registration if the lease expires while reading the OS identity', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'worker', 100);
    vi.mocked(processStartIdentity).mockImplementationOnce(async () => {
      advance(100);
      return 'identity';
    });
    await expect(execution(store)).rejects.toThrow('lease expired before Execution registration');
    expect(store.listExecutions()).toEqual([]);
  });
  it('fails closed on dependencies and invalid owner/TTL without recording transitions', async () => {
    const store = await open();
    queued(store);
    store.createTask({ key: 'dep', type: 'implementation' });
    store.addTaskDependency('task', 'dep');
    await expect(store.claim('task', 'worker')).rejects.toThrow('DEPENDENCIES_NOT_DONE');
    for (const ttl of [0, -1, NaN, Infinity, 1.5])
      await expect(store.claim('task', 'worker', ttl)).rejects.toThrow('TTL');
    await expect(store.claim('task', '')).rejects.toThrow('owner');
    expect(store.listDomainEvents()).toEqual([]);
  });
  it('the background sweeper recovers without another claim', async () => {
    const store = await open();
    queued(store);
    const recover = vi.spyOn(store, 'recoverExpiredLeases');
    await store.claim('task', 'worker', 20);
    recover.mockClear();
    await vi.waitFor(() => expect(store.getTask('task')?.status).toBe('FAILED_RETRYABLE'), {
      timeout: 6500,
      interval: 50,
    });
    expect(recover).toHaveBeenCalled();
  });
  it('persists results across reopening, scopes keys by Project and preserves undefined', async () => {
    const a = await open();
    const effect = vi.fn(() => ({ ref: 'external-result' }));
    expect(await a.withIdempotency('push', effect)).toEqual({ ref: 'external-result' });
    const reopened = await open();
    expect(await reopened.withIdempotency('push', effect)).toEqual({ ref: 'external-result' });
    expect(effect).toHaveBeenCalledTimes(1);
    const b = await open('b');
    await b.withIdempotency('push', effect);
    expect(effect).toHaveBeenCalledTimes(2);
    await a.withIdempotency('void', () => undefined);
    expect(
      await reopened.withIdempotency('void', () => {
        throw new Error('duplicate');
      }),
    ).toBeUndefined();
  });
  it('reserves before async effects and never repeats an uncertain failure', async () => {
    const a = await open();
    const b = await open();
    let finish!: () => void;
    const effect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = a.withIdempotency('PR', effect);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce());
    await expect(b.withIdempotency('PR', effect)).rejects.toThrow('pending or uncertain');
    finish();
    await first;
    const failed = vi.fn(() => {
      throw new Error('remote timeout');
    });
    await expect(a.withIdempotency('clickup', failed)).rejects.toThrow('remote timeout');
    await expect(b.withIdempotency('clickup', failed)).rejects.toThrow('pending or uncertain');
    expect(failed).toHaveBeenCalledOnce();
  });
});
