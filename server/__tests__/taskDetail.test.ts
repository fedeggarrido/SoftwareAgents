import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubmitTaskChange } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { companyWorkspaceRoot } from '../src/companyControl.js';
import { HumanDecisions } from '../src/humanDecisions.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { approvedTaskDescription, taskChangeSafePoint } from '../src/taskChangeDecisions.js';
import { handleTaskDetailMessage } from '../src/taskDetail.js';
import { projectTaskDetail } from '../src/taskDetailProjection.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import { writeTaskChange } from '../src/workstore/taskChangeWrites.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

const gitFixture = vi.hoisted(() => ({ commonDir: '' }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), {
      // Only Git metadata discovery is stubbed. SQLite, transactions, leases and decisions are real.
      [promisify.custom]: async (file: string, args: string[]) => {
        if (
          file !== 'git' ||
          args.join(' ') !== 'rev-parse --path-format=absolute --git-common-dir'
        )
          throw new Error('Unexpected process invocation in task change tests');
        return { stdout: gitFixture.commonDir, stderr: '' };
      },
    }),
  };
});

vi.mock('../src/companyControl.js', () => ({ companyWorkspaceRoot: vi.fn() }));
vi.mock('../src/projectConfig.js', () => ({ loadProjectConfig: vi.fn() }));
vi.mock('../src/auditLog.js', () => ({
  AuditLog: class {
    append = vi.fn();
  },
  recordAudit: vi.fn(),
}));

const confirmation: SubmitTaskChange = {
  type: 'submitTaskChange',
  projectId: 'project',
  requestId: 'request',
  key: 'T1',
  revision: 'a'.repeat(64),
  text: 'Cambiar el comportamiento',
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const marker of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(marker, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('SA-143 human ingress', () => {
  it.each(['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])(
    'rejects an agent session marked by %s, even with an empty value and operator privilege',
    async (marker) => {
      vi.stubEnv(marker, '');
      const send = vi.fn();
      await handleTaskDetailMessage({ ...confirmation }, send, true);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'managed_process' }));
      expect(companyWorkspaceRoot).not.toHaveBeenCalled();
      expect(loadProjectConfig).not.toHaveBeenCalled();
    },
  );
  it('enforces connection privilege through the normal client message entry point', () => {
    const store = new AgentStateStore();
    const send = vi.fn();
    try {
      handleClientMessage({ ...confirmation }, send, { store, cache: null, privileged: false });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'taskChangeResult', errorCode: 'denied' }),
      );
      expect(loadProjectConfig).not.toHaveBeenCalled();
    } finally {
      store.dispose();
    }
  });
  it.each([{ actor: 'human' }, { confirmed: true }, { kind: 'follow_up' }, { SA_WORKER: null }])(
    'rejects client authority and route fields %j',
    async (fields) => {
      const send = vi.fn();
      await handleTaskDetailMessage({ ...confirmation, ...fields }, send, true);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'invalid_request' }));
      expect(loadProjectConfig).not.toHaveBeenCalled();
    },
  );
  it('rejects embedded adapters before looking up the project', async () => {
    const send = vi.fn();
    await handleTaskDetailMessage({ ...confirmation }, send, true, false);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'unsupported_adapter' }),
    );
    expect(loadProjectConfig).not.toHaveBeenCalled();
  });
});

describe('SA-143 durable task changes', () => {
  let root: string;
  let store: WorkStore;
  let db: DatabaseSync;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa143-'));
    gitFixture.commonDir = path.join(root, '.git');
    fs.mkdirSync(gitFixture.commonDir);
    store = await openWorkStore({
      repositoryPath: root,
      projectId: 'project',
      recoverLeases: false,
    });
    db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
    db.exec('PRAGMA foreign_keys = ON');
    store.createFeature({
      key: 'FEAT-001',
      title: 'Pedidos',
      doc_path: 'spec.md',
      git_sha: 'sha',
      status: 'approved',
    });
    for (const key of ['T1', 'T2', 'T3']) {
      store.createTask({ key, type: 'code', feature_key: 'FEAT-001', status: 'READY' });
      db.prepare('UPDATE tasks SET declaration = ? WHERE project_id = ? AND key = ?').run(
        JSON.stringify({ title: `Trabajo ${key}`, description: 'Descripción original' }),
        'project',
        key,
      );
    }
    store.addTaskDependency('T2', 'T1');
    vi.mocked(companyWorkspaceRoot).mockReturnValue(root);
    vi.mocked(loadProjectConfig).mockReturnValue({
      repoRoot: root,
      paths: { brain: path.join(root, '.softwareagents/brain') },
      project: {
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'project',
        name: 'Proyecto',
        repo: { remote: 'local', defaultBranch: 'main' },
        brain: { path: '.softwareagents/brain' },
      },
      operator: { autonomyLevel: 'A0', allowedExecutors: [] },
    });
  });
  afterEach(() => {
    db?.close();
    store?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  function request(key = 'T1'): SubmitTaskChange {
    return { ...confirmation, key, revision: projectTaskDetail(db, 'project', key).revision };
  }
  function commit(message: SubmitTaskChange) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = writeTaskChange(db, message);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  it('projects the task description, feature, pending Decisions options and impact without changing data', () => {
    const before = db.prepare('SELECT * FROM tasks ORDER BY key').all();
    const detail = projectTaskDetail(db, 'project', 'T1');
    expect(detail).toMatchObject({
      item: { title: 'Trabajo T1' },
      description: 'Descripción original',
      featureTitle: 'Pedidos',
    });
    expect(detail.impact.map((task) => task.id)).toEqual(['T2', 'T3']);
    expect(db.prepare('SELECT * FROM tasks ORDER BY key').all()).toEqual(before);
    expect(store.listDecisions()).toEqual([]);
  });
  it('writes through the server handler only after confirmation and consumes approved spec text without changing the immutable declaration', async () => {
    const message = request();
    const send = vi.fn();
    await handleTaskDetailMessage(
      { type: 'requestTaskDetail', projectId: 'project', requestId: 'read', key: 'T1' },
      send,
      true,
    );
    expect(store.getTask('T1')?.status).toBe('READY');
    expect(store.listDecisions()).toEqual([]);
    await handleTaskDetailMessage({ ...message }, send, true);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'taskChangeResult', errorCode: null }),
    );
    expect(store.getTask('T1')?.status).toBe('WAITING_HUMAN');
    expect(
      projectTaskDetail(db, 'project', 'T1').decisions[0].structuredOptions?.map(
        (option) => option.id,
      ),
    ).toEqual(['approve', 'keep']);
    const task = store.getTask('T1')!;
    expect(approvedTaskDescription(store.listDecisions(), task)).toBeUndefined();
    await new HumanDecisions(store).answer(
      store.listDecisions()[0].id,
      'approve',
      true,
      'operator',
      'A0',
    );
    expect(store.getTask('T1')?.status).toBe('READY');
    expect(store.getTask('T1')?.declaration).toBe(task.declaration);
    expect(approvedTaskDescription(store.listDecisions(), task)).toBe(message.text);
    expect(projectTaskDetail(db, 'project', 'T1').description).toBe(message.text);
  });
  it('keeps the old specification when the human declines a revision', async () => {
    commit(request());
    await store.resolveDecision(store.listDecisions()[0].id, 'keep', 'operator', () => {});
    expect(projectTaskDetail(db, 'project', 'T1').description).toBe('Descripción original');
  });
  it('preserves a running lease and work, then uses the existing decision gate at its safe point', async () => {
    const claimed = await store.claim('T1', 'worker');
    await store.transition('T1', claimed.version, 'RUNNING', 'test', 'worker');
    const running = store.getTask('T1');
    commit(request());
    expect(store.getTask('T1')).toEqual(running);
    expect(store.listDecisions()[0].blocks).toEqual([]);
    await expect(
      new HumanDecisions(store).answer(
        store.listDecisions()[0].id,
        'review',
        true,
        'operator',
        'A0',
      ),
    ).rejects.toThrow('punto seguro');
    const task = store.getTask('T1')!;
    await store.transition('T1', task.version, 'REVIEW', 'work saved', 'worker');
    await taskChangeSafePoint(store, 'T1');
    expect(store.getTask('T1')?.status).toBe('WAITING_HUMAN');
    expect(store.getTask('T1')?.attempt).toBe(task.attempt);
    expect(store.listDecisions()[0].blocks).toEqual(['T1']);
    await store.resolveDecision(store.listDecisions()[0].id, 'review', 'operator', () => {});
    expect(store.getTask('T1')?.status).toBe('REVIEW');
  });
  it('rejects managed-process approval of a specification too', async () => {
    commit(request());
    vi.stubEnv('SA_WORKER', '');
    await expect(
      new HumanDecisions(store).answer(
        store.listDecisions()[0].id,
        'approve',
        true,
        'operator',
        'A0',
      ),
    ).rejects.toThrow('una persona');
    expect(store.getTask('T1')?.status).toBe('WAITING_HUMAN');
  });
  it('creates one linked draft follow-up and serializes retries of the same confirmation', () => {
    db.prepare("UPDATE tasks SET status = 'DONE' WHERE key = 'T1'").run();
    const original = store.getTask('T1');
    const message = request();
    const followUp = commit(message)!;
    expect(commit(message)).toBe(followUp);
    expect(store.getTask('T1')).toEqual(original);
    expect(store.getTask(followUp)).toMatchObject({ status: 'DRAFT', feature_key: 'FEAT-001' });
    expect(store.listTaskDependencies(followUp)).toEqual([]);
    expect(projectTaskDetail(db, 'project', followUp).origin?.id).toBe('T1');
    expect(projectTaskDetail(db, 'project', followUp).description).toBe(message.text);
    expect(() => commit({ ...message, text: 'Otro cambio' })).toThrow('invalid_request');
  });
  it('requires a fresh confirmation if state, peer task or dependency changes after the preview', () => {
    const message = request();
    store.createTask({ key: 'T4', type: 'code', feature_key: 'FEAT-001' });
    expect(() => commit(message)).toThrow('stale_revision');
    expect(store.listDecisions()).toEqual([]);
    expect(store.getTask('T1')?.status).toBe('READY');
  });
  it('keeps a preview valid across ordinary lease heartbeats', async () => {
    await store.claim('T1', 'worker');
    const message = request();
    await store.heartbeat('T1', 'worker');
    expect(projectTaskDetail(db, 'project', 'T1').revision).toBe(message.revision);
    expect(() => commit(message)).not.toThrow();
  });
  it('retains an existing decision gate while recording another request', async () => {
    await store.openOrJoinIdleDecision({
      id: 'gate',
      context: 'Elegir el formato del recibo',
      requestedBy: 'reviewer',
      blocks: ['T1'],
      options: [
        {
          id: 'continue',
          label: 'Continuar',
          benefit: 'Avanzar',
          cost: 'Revisar',
          risk: 'Cambios',
        },
      ],
      recommendation: 'Revisar',
      disagreement: [],
      impact: 'Espera respuesta',
      urgency: 'medium',
    });
    commit(request());
    expect(store.getTask('T1')?.status).toBe('WAITING_HUMAN');
    expect(store.listDecisions().find((decision) => decision.id !== 'gate')?.blocks).toEqual([]);
    await store.resolveDecision('gate', 'continue', 'operator', () => {});
    await taskChangeSafePoint(store, 'T1');
    expect(store.getTask('T1')?.status).toBe('WAITING_HUMAN');
  });
  it('rolls back a failed follow-up creation', () => {
    db.prepare("UPDATE tasks SET status = 'DONE' WHERE key = 'T3'").run();
    db.exec(
      "CREATE TRIGGER reject_followup BEFORE INSERT ON idempotency_keys BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    expect(() => commit({ ...request('T3'), requestId: 'followup' })).toThrow('fixture failure');
    expect(store.listTasks()).toHaveLength(3);
  });
  it('rolls back the spec and decision together when a state write fails', () => {
    db.exec(
      "CREATE TRIGGER reject_change BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    expect(() => commit(request())).toThrow('fixture failure');
    expect(store.listDecisions()).toEqual([]);
    expect(store.getTask('T1')?.status).toBe('READY');
    expect(db.prepare('SELECT * FROM idempotency_keys').all()).toEqual([]);
  });
});
