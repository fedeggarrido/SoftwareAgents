import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processStartIdentity, terminateExecutionTree } from '../src/workstore/processRecovery.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

vi.mock('../src/workstore/processRecovery.js', () => ({
  processStartIdentity: vi.fn(() => 'identity'),
  terminateExecutionTree: vi.fn(),
}));

describe('WorkStore leases and durable idempotency', () => {
  let root: string;
  const stores: WorkStore[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-leases-'));
    execFileSync('git', ['init', root], { stdio: 'pipe', windowsHide: true });
    vi.mocked(terminateExecutionTree).mockReset();
    vi.mocked(processStartIdentity).mockReturnValue('identity');
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
  function execution(store: WorkStore) {
    store.createExecution({
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
  it('kills before recovery, blocks reassignment on termination failure, then retries safely', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'first', 100);
    execution(store);
    expect(store.getExecution('run')?.pid_started_at).toBe('identity');
    advance(100);
    vi.mocked(terminateExecutionTree).mockImplementation(() => {
      expect(store.getTask('task')?.status).toBe('LEASED');
      throw new Error('termination failed');
    });
    await expect(store.claim('task', 'second')).rejects.toThrow('termination failed');
    expect(store.getTask('task')).toMatchObject({ lease_owner: 'first', attempt: 0 });
    vi.mocked(terminateExecutionTree).mockImplementation(() => {});
    expect(await store.claim('task', 'second')).toMatchObject({
      status: 'LEASED',
      lease_owner: 'second',
      attempt: 1,
    });
    expect(terminateExecutionTree).toHaveBeenCalledWith(12345, 'identity');
  });
  it('release terminates the executor and clears the lease; normal completion also clears it', async () => {
    const store = await open();
    queued(store);
    await store.claim('task', 'worker');
    execution(store);
    expect(await store.release('task', 'worker')).toMatchObject({
      status: 'FAILED_RETRYABLE',
      lease_owner: null,
      attempt: 1,
    });
    expect(terminateExecutionTree).toHaveBeenCalled();
    const lease = await store.claim('task', 'next');
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
    execution(store);
    vi.spyOn(store, 'listTasks').mockReturnValue([old]);
    vi.mocked(terminateExecutionTree).mockClear();
    expect(await store.recoverExpiredLeases()).toEqual([]);
    expect(terminateExecutionTree).not.toHaveBeenCalled();
    expect(store.getTask('task')?.lease_owner).toBe('new');
  });
  it('fences Execution registration if the lease expires while reading the OS identity', async () => {
    const store = await open();
    queued(store);
    clock();
    await store.claim('task', 'worker', 100);
    vi.mocked(processStartIdentity).mockImplementationOnce(() => {
      advance(100);
      return 'identity';
    });
    expect(() => execution(store)).toThrow('lease expired before Execution registration');
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
