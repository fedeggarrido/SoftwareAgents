import { execFileSync, fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { retryBusy } from '../src/workstore/retryBusy.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import {
  TaskTransitionError,
  TaskVersionConflictError,
} from '../src/workstore/taskStateMachine.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

describe('WorkStore (real SQLite)', () => {
  let root: string;
  const stores: WorkStore[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-workstore-'));
    execFileSync('git', ['init', root], { windowsHide: true, stdio: 'pipe' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function open(projectId = 'a'): Promise<WorkStore> {
    const store = await openWorkStore({ repositoryPath: root, projectId });
    stores.push(store);
    return store;
  }
  async function inspect() {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
  }
  it('migrates an empty DB once, persists records and configures every connection', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const configure = vi.spyOn(DatabaseSync.prototype, 'exec');
    const first = await open();
    first.createTask({ key: 'task', type: 'implementation' });
    const second = await open();
    expect(
      configure.mock.calls.filter(([sql]) => sql.includes('PRAGMA foreign_keys = ON')),
    ).toHaveLength(2);
    expect(second.getTask('task')).toMatchObject({ project_id: 'a', version: 1, attempt: 0 });
    const db = await inspect();
    try {
      expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 3 }]);
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table')).toHaveLength(
        9,
      );
    } finally {
      db.close();
    }
    expect(() => first.createTask({ key: 'task', type: 'implementation' })).toThrow();
  });
  it('isolates all entities and rejects references to records existing only in another Project', async () => {
    const a = await open('a');
    const b = await open('b');
    for (const store of [a, b]) {
      store.createFeature({
        key: 'feature',
        doc_path: store.projectId,
        git_sha: 'sha',
        status: 'approved',
      });
      store.createTask({ key: 'task', type: store.projectId, feature_key: 'feature' });
      store.createTask({ key: 'dependency', type: store.projectId });
      store.addTaskDependency('task', 'dependency');
      store.createExecution({
        key: 'execution',
        task_key: 'task',
        agent_template_version: 'developer@v1',
        executor: 'claude',
        model_id: store.projectId,
        session_id: 'session',
        pid: 123,
        started_at: '2026-10-02T00:00:00Z',
        system_prompt_hash: 'hash',
        project_brain_sha: 'sha',
        task_version: 1,
        tool_policy_version: 'v1',
      });
      store.recordHumanDecision({
        key: 'decision',
        task_key: 'task',
        execution_key: 'execution',
        question: 'Proceed?',
        answer: store.projectId,
        actor: 'operator',
        decided_at: 'now',
      });
    }
    a.createFeature({ key: 'only-a', doc_path: 'a', git_sha: 'sha', status: 'draft' });
    a.createTask({ key: 'only-a', type: 'implementation' });
    a.createExecution({ ...a.getExecution('execution')!, key: 'only-a' });
    a.recordHumanDecision({ ...a.getHumanDecision('decision')!, key: 'only-a' });
    for (const store of [a, b]) {
      expect(store.getProject().project_id).toBe(store.projectId);
      expect(store.getFeature('feature')?.doc_path).toBe(store.projectId);
      expect(store.getTask('task')?.type).toBe(store.projectId);
      expect(store.getExecution('execution')?.model_id).toBe(store.projectId);
      expect(store.getHumanDecision('decision')?.answer).toBe(store.projectId);
      for (const records of [
        store.listFeatures(),
        store.listTasks(),
        store.listExecutions(),
        store.listHumanDecisions(),
        store.listTaskDependencies('task'),
      ]) {
        expect(records.every((record) => record.project_id === store.projectId)).toBe(true);
      }
    }
    expect(b.getFeature('only-a')).toBeUndefined();
    expect(b.getTask('only-a')).toBeUndefined();
    expect(b.getExecution('only-a')).toBeUndefined();
    expect(b.getHumanDecision('only-a')).toBeUndefined();
    expect(() =>
      b.recordHumanDecision({
        ...a.getHumanDecision('decision')!,
        key: 'bad-execution',
        execution_key: 'only-a',
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      b.createTask({ key: 'bad-feature', type: 'implementation', feature_key: 'only-a' }),
    ).toThrow(/FOREIGN KEY/);
    expect(() => b.addTaskDependency('task', 'only-a')).toThrow(/FOREIGN KEY/);
    const execution = a.getExecution('execution')!;
    expect(() => b.createExecution({ ...execution, key: 'bad', task_key: 'only-a' })).toThrow(
      /FOREIGN KEY/,
    );
    expect(() =>
      b.recordHumanDecision({
        key: 'bad',
        task_key: 'only-a',
        execution_key: null,
        question: '?',
        answer: 'yes',
        actor: 'operator',
        decided_at: 'now',
      }),
    ).toThrow(/FOREIGN KEY/);
    // Even an extra runtime project_id property cannot override the handle's scope.
    b.createTask({ ...a.getTask('only-a')!, key: 'injected' });
    expect(b.getTask('injected')?.project_id).toBe('b');
    expect(a.getTask('injected')).toBeUndefined();
  });
  it('enforces dependencies, versions, rework and Project isolation', async () => {
    const a = await open();
    const b = await open('b');
    a.createTask({ key: 'A', type: 'implementation', status: 'QA' });
    a.createTask({ key: 'B', type: 'implementation', status: 'READY' });
    a.addTaskDependency('B', 'A');
    b.createTask({ key: 'A', type: 'implementation', status: 'DONE' });
    expect(a.canStart('B')).toBe(false);
    await expect(a.transition('B', 1, 'QUEUED', 'schedule', 'operator')).rejects.toBeInstanceOf(
      TaskTransitionError,
    );
    expect(a.getTask('B')).toMatchObject({ version: 1, status: 'READY' });
    expect(a.listDomainEvents()).toEqual([]);
    await a.transition('A', 1, 'RUNNING', 'rework', 'reviewer');
    expect(a.getTask('A')).toMatchObject({ version: 2, attempt: 1 });
    await a.transition('A', 2, 'REVIEW', 'ready', 'developer');
    await a.transition('A', 3, 'RUNNING', 'rework', 'reviewer');
    expect(a.getTask('A')?.attempt).toBe(2);
    await a.transition('A', 4, 'REVIEW', 'ready', 'developer');
    await a.transition('A', 5, 'QA', 'reviewed', 'reviewer');
    await a.transition('A', 6, 'DONE', 'tested', 'qa');
    expect(a.canStart('B')).toBe(true);
    const other = await open();
    const results = await Promise.allSettled([
      a.transition('B', 1, 'QUEUED', 'schedule', 'operator'),
      other.transition('B', 1, 'QUEUED', 'schedule', 'operator'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(TaskVersionConflictError);
    expect(a.listDomainEvents('B')).toHaveLength(1);
    expect(a.listDomainEvents('B')[0]).toMatchObject({
      from_status: 'READY',
      to_status: 'QUEUED',
      task_version: 2,
      actor: 'operator',
      reason: 'schedule',
    });
    expect(b.listDomainEvents()).toEqual([]);
    await expect(b.transition('B', 1, 'QUEUED', '', '')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('retries a busy transition after rolling back its partial write', async () => {
    const store = await open();
    store.createTask({ key: 'task', type: 'implementation' });
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    let inserts = 0;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: import('node:sqlite').DatabaseSync,
      sql,
    ) {
      if (sql.includes('INSERT INTO domain_events') && ++inserts === 1)
        throw Object.assign(new Error('busy'), { errcode: 5 });
      return prepare.call(this, sql);
    });
    await store.transition('task', 1, 'READY', 'ready', 'operator');
    expect(inserts).toBe(2);
    expect(store.getTask('task')).toMatchObject({ status: 'READY', version: 2 });
    expect(store.listDomainEvents()).toHaveLength(1);
  });
  it('rolls back the Task when event insertion fails and rejects event mutation', async () => {
    const store = await open();
    store.createTask({ key: 'task', type: 'implementation' });
    const before = store.getTask('task');
    const db = await inspect();
    try {
      db.exec(
        "CREATE TRIGGER fail_event AFTER INSERT ON domain_events BEGIN SELECT RAISE(ABORT, 'event failure'); END;",
      );
      await expect(store.transition('task', 1, 'READY', 'ready', 'operator')).rejects.toThrow(
        'event failure',
      );
      expect(store.getTask('task')).toEqual(before);
      expect(store.listDomainEvents()).toEqual([]);
      db.exec('DROP TRIGGER fail_event');
      await store.transition('task', 1, 'READY', 'ready', 'operator');
      expect(() => db.exec('DELETE FROM domain_events')).toThrow('append-only');
      expect(() => db.exec("UPDATE domain_events SET actor = 'other'")).toThrow('append-only');
    } finally {
      db.close();
    }
  });
  it('migrates v1 pending tasks without changing version or attempt', async () => {
    await open();
    const db = await inspect();
    try {
      db.exec(
        'DROP TRIGGER tasks_status_insert; DROP TRIGGER tasks_status_update; DROP TABLE domain_events; DROP TABLE idempotency_keys; DROP INDEX tasks_lease_expiry; ALTER TABLE executions DROP COLUMN pid_started_at; UPDATE schema_version SET version = 1;',
      );
      db.prepare(
        `INSERT INTO tasks VALUES ('a', NULL, 'old', 'implementation', 'pending', 0, NULL, 4, NULL, NULL, 2, 3, NULL, NULL, NULL, NULL, 'then', 'then')`,
      ).run();
    } finally {
      db.close();
    }
    const store = await open();
    expect(store.getTask('old')).toMatchObject({ status: 'DRAFT', version: 4, attempt: 2 });
    expect(store.listDomainEvents()).toEqual([]);
  });
  it('rejects a schema newer than this implementation', async () => {
    await open();
    const db = await inspect();
    db.exec('UPDATE schema_version SET version = 999');
    db.close();
    await expect(open()).rejects.toThrow('Unsupported WorkStore schema version');
  });
  it('reports a corrupt database as a database error', async () => {
    fs.mkdirSync(path.join(root, '.git/softwareagents'));
    fs.writeFileSync(path.join(root, '.git/softwareagents/work.sqlite3'), 'not a database');
    await expect(open()).rejects.toThrow(/not a database/);
  });
  it('retries opening WAL and rolls back a busy migration before retrying', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    const exec = DatabaseSync.prototype.exec;
    let walAttempts = 0;
    let migrationAttempts = 0;
    let rollbacks = 0;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: import('node:sqlite').DatabaseSync,
      sql,
    ) {
      if (sql === 'PRAGMA journal_mode = WAL' && ++walAttempts <= 2) {
        throw Object.assign(new Error('database is locked'), { errcode: 5 });
      }
      return prepare.call(this, sql);
    });
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: import('node:sqlite').DatabaseSync,
      sql,
    ) {
      if (sql === 'ROLLBACK') rollbacks++;
      if (sql.includes('CREATE TABLE IF NOT EXISTS schema_version') && ++migrationAttempts === 1) {
        exec.call(this, sql);
        throw Object.assign(new Error('database table is locked'), { errcode: 6 });
      }
      return exec.call(this, sql);
    });
    const store = await open();
    expect(walAttempts).toBe(3);
    expect(migrationAttempts).toBe(2);
    expect(rollbacks).toBe(1);
    expect(store.getProject().project_id).toBe('a');
    const db = await inspect();
    try {
      expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 3 }]);
    } finally {
      db.close();
    }
  });
  it('bounds retries by the shared deadline and preserves other errors', async () => {
    await open();
    const db = await inspect();
    const busy = Object.assign(new Error('busy'), { errcode: 5 });
    const operation = vi.fn(() => {
      throw busy;
    });
    try {
      await expect(retryBusy(db, performance.now() + 25, operation)).rejects.toBe(busy);
      expect(operation.mock.calls.length).toBeGreaterThan(1);
      const expired = vi.fn(() => {
        throw busy;
      });
      await expect(retryBusy(db, performance.now() - 1, expired)).rejects.toBe(busy);
      expect(expired).toHaveBeenCalledTimes(1);
      for (const error of [
        new Error('other'),
        Object.assign(new Error('constraint'), { errcode: 19 }),
      ]) {
        const fail = vi.fn(() => {
          throw error;
        });
        await expect(retryBusy(db, performance.now() + 5000, fail)).rejects.toBe(error);
        expect(fail).toHaveBeenCalledTimes(1);
      }
    } finally {
      db.close();
    }
  });
  it('keeps SQLite external and lazy in a real bundle when the builtin is disabled', () => {
    const bundle = path.join(root, 'workstore.cjs');
    buildSync({
      entryPoints: [path.resolve('src/workstore/SqliteWorkStore.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
    });
    const script = `
      const {openWorkStore} = require(process.argv[1]);
      openWorkStore({repositoryPath: '.', projectId: 'a'}).then(
        () => process.exit(1),
        error => {
          if (!error.message.includes('WorkStore requiere Node 22.13+') || !error.cause) process.exit(2);
          console.log('lazy load OK');
        });`;
    expect(
      execFileSync(process.execPath, ['--no-experimental-sqlite', '-e', script, bundle], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toContain('lazy load OK');
  });
  it('rejects an escaping directory junction before creating the DB', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, '.git/softwareagents'), 'junction');
    await expect(open()).rejects.toThrow('Path must stay inside its root');
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(root, '.git/softwareagents'));
  });
  it.each([false, true])(
    'two real Node processes simultaneously migrate and write without lock errors (opening reader lock: %s)',
    async (holdReader) => {
      let reader: import('node:sqlite').DatabaseSync | undefined;
      if (holdReader) {
        fs.mkdirSync(path.join(root, '.git/softwareagents'));
        reader = await inspect();
        reader.exec('BEGIN; SELECT * FROM sqlite_master;');
        expect(reader.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
      }
      const worker = path.join(root, 'worker.cjs');
      buildSync({
        stdin: {
          contents: `
      import { openWorkStore } from './server/src/workstore/SqliteWorkStore.ts';
      process.send('ready');
      process.once('message', async () => {
        try {
          const store = await openWorkStore({repositoryPath: process.argv[2], projectId: 'shared'});
          for (let i = 0; i < 100; i++) {
            store.createTask({key: process.argv[3] + '-' + i, type: 'implementation'});
          }
          store.close(); process.disconnect();
        } catch (error) { console.error(error); process.exit(1); }
      });`,
          resolveDir: path.resolve('..'),
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: worker,
      });
      const children = ['one', 'two'].map((id) =>
        fork(worker, [root, id], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          execArgv: [],
        }),
      );
      const exits = children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            let stderr = '';
            child.stderr!.on('data', (chunk) => {
              stderr += chunk;
            });
            child.once('error', reject);
            child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
          }),
      );
      try {
        await Promise.all(
          children.map(
            (child) => new Promise<void>((resolve) => child.once('message', () => resolve())),
          ),
        );
        children.forEach((child) => child.send('start'));
        // A real rollback-journal reader prevents either child switching to WAL.
        // Release from the parent: the child's synchronous SQLite calls cannot
        // prevent this timer firing, unlike a timer inside the opening process.
        const release = setTimeout(() => {
          reader?.close();
          reader = undefined;
        }, 250);
        release.unref();
        await Promise.all(exits);
        expect((await open('shared')).listTasks()).toHaveLength(200);
      } finally {
        reader?.close();
        reader = undefined;
        children.forEach((child) => {
          if (child.exitCode === null) child.kill();
        });
        await Promise.allSettled(exits);
      }
    },
    20_000,
  );
});

describe('lazy SQLite availability boundary', () => {
  afterEach(() => {
    vi.doUnmock('node:sqlite');
    vi.resetModules();
  });
  it('loads the module without SQLite and fails clearly only when opening', async () => {
    vi.resetModules();
    vi.doMock('node:sqlite', () => {
      throw new Error('sqlite unavailable');
    });
    const module = await import('../src/workstore/SqliteWorkStore.js');
    await expect(module.openWorkStore({ repositoryPath: '.', projectId: 'a' })).rejects.toThrow(
      /WorkStore requiere Node 22.13\+.*actual:/,
    );
  });
});
