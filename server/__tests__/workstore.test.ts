import { execFileSync, fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskDag } from '../../core/src/taskDag.js';
import { openArchitectDecision } from '../src/architect.js';
import { openRequirementsQuestions } from '../src/requirements.js';
import * as processRecovery from '../src/workstore/processRecovery.js';
import { retryBusy } from '../src/workstore/retryBusy.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import {
  TaskTransitionError,
  TaskVersionConflictError,
} from '../src/workstore/taskStateMachine.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

vi.setConfig({ testTimeout: 90_000 });

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
  it('atomically returns idle QA to design rework and clears the reviewed revision', async () => {
    const store = await open();
    store.createTask({ key: 'FEAT-105-T01', type: 'code', status: 'QA' });
    const db = await inspect();
    try {
      db.prepare('UPDATE tasks SET review_ref = ? WHERE project_id = ? AND key = ?').run(
        JSON.stringify({ branch: 'sa/task', sha: 'a'.repeat(40), base: 'b'.repeat(40) }),
        'a',
        'FEAT-105-T01',
      );
      await expect(store.requestDesignRework('FEAT-105-T01', 99)).rejects.toThrow(/version/);
      expect(store.getTask('FEAT-105-T01')!.review_ref).not.toBeNull();
      await store.requestDesignRework('FEAT-105-T01', 1);
      expect(store.getTask('FEAT-105-T01')).toMatchObject({
        status: 'READY',
        review_ref: null,
        version: 2,
      });
      expect(store.listDomainEvents('FEAT-105-T01').at(-1)!.reason).toBe(
        'Designer requested changes',
      );
      await expect(store.requestDesignRework('FEAT-105-T01', 2)).rejects.toThrow(/idle QA/);
    } finally {
      db.close();
    }
  });
  it('fences feature locks by exact process creation identity and retains uncertain locks', async () => {
    const store = await open();
    const initial = {
      branch: 'sa/FEAT-001-integration',
      initial_main: 'a'.repeat(40),
      head: 'a'.repeat(40),
      request: 'request.md',
      integrated: {},
      attempts: {},
      status: 'running',
    };
    const identity = vi.spyOn(processRecovery, 'processStartIdentity').mockResolvedValue('123');
    await store.claimFeatureRun('FEAT-001', 'first', initial);
    expect(store.getFeatureRun('FEAT-001')?.pid_started_at).toBe('123');
    await expect(store.claimFeatureRun('FEAT-001', 'second', initial)).rejects.toThrow(
      'another orchestrator',
    );
    identity.mockResolvedValueOnce('456').mockRejectedValueOnce(new Error('access denied'));
    await expect(store.claimFeatureRun('FEAT-001', 'second', initial)).rejects.toThrow(
      'reconciliation',
    );
    expect(store.getFeatureRun('FEAT-001')?.owner).toBe('first');
    // Same PID, different creation: the original owner has exited.
    identity.mockResolvedValue('456');
    await store.claimFeatureRun('FEAT-001', 'second', initial);
    expect(store.getFeatureRun('FEAT-001')).toMatchObject({
      owner: 'second',
      pid_started_at: '456',
    });
    await store.releaseFeatureRun('FEAT-001', 'second');
    const db = await inspect();
    db.exec("UPDATE feature_runs SET owner = 'legacy', pid = 123, pid_started_at = NULL");
    db.close();
    await expect(store.claimFeatureRun('FEAT-001', 'third', initial)).rejects.toThrow(
      'identity missing',
    );
    expect(store.getFeatureRun('FEAT-001')?.owner).toBe('legacy');
  });
  it('increments a failed Developer retry atomically and refuses an exhausted claim', async () => {
    const store = await open();
    store.createTask({
      key: 'developer',
      type: 'code',
      agent_role: 'developer',
      status: 'FAILED_RETRYABLE',
      attempt: 0,
      max_attempts: 2,
    });
    const results = await Promise.allSettled([
      store.claim('developer', 'first'),
      store.claim('developer', 'second'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const claimed = store.getTask('developer')!;
    expect(claimed).toMatchObject({ status: 'LEASED', attempt: 1 });
    await store.transition(
      'developer',
      claimed.version,
      'FAILED_RETRYABLE',
      'failure',
      claimed.lease_owner!,
    );
    await expect(store.claim('developer', 'third')).rejects.toThrow('max_attempts exhausted');
    expect(store.getTask('developer')).toMatchObject({
      status: 'FAILED_RETRYABLE',
      attempt: 1,
      lease_owner: null,
    });
    expect(store.listLeaseRecoveries()).toEqual([]);
  });
  it('does not adopt a FAILED_RETRYABLE Developer as a failed Reviewer', async () => {
    const store = await open();
    store.createTask({ key: 'developer-failed', type: 'code', status: 'FAILED_RETRYABLE' });
    const db = await inspect();
    db.prepare('UPDATE tasks SET review_ref = ? WHERE key = ?').run(
      JSON.stringify({ branch: 'branch', sha: 'a'.repeat(40), base: 'b'.repeat(40) }),
      'developer-failed',
    );
    db.close();
    await expect(
      store.claimReview('developer-failed', store.getTask('developer-failed')!.version, 'reviewer'),
    ).rejects.toThrow('review_ref');
    expect(store.getTask('developer-failed')!.status).toBe('FAILED_RETRYABLE');
  });
  it.each([0, 2, 3])(
    'recovers an expired Reviewer lease without consuming attempt %i',
    async (attempt) => {
      const store = await open();
      store.createTask({ key: 'review-task', type: 'code', status: 'READY', attempt });
      const claimed = await store.claim('review-task', 'developer');
      await store.setTaskWorktree('review-task', 'developer', 'sa/review-task-developer', root);
      const ref = { branch: 'sa/review-task-developer', sha: 'a'.repeat(40), base: 'b'.repeat(40) };
      await store.setTaskReview('review-task', 'developer', ref);
      const running = await store.transition(
        'review-task',
        claimed.version,
        'RUNNING',
        '',
        'developer',
      );
      const ready = await store.transition(
        'review-task',
        running.version,
        'REVIEW',
        '',
        'developer',
      );
      await store.claimReview('review-task', ready.version, 'reviewer');
      const db = await inspect();
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE key = ?').run(
        '2000-01-01T00:00:00.000Z',
        'review-task',
      );
      db.close();
      expect(await store.recoverExpiredLeases()).toMatchObject([
        { status: 'REVIEW', attempt, review_ref: ref, lease_owner: null },
      ]);
      expect(store.listDomainEvents('review-task').at(-1)?.reason).toContain('category=lease');
      await store.claimReview('review-task', store.getTask('review-task')!.version, 'retry');
      expect(store.getTask('review-task')!.attempt).toBe(attempt);
    },
  );
  it('rolls back Architect registration, DAG import and decision closure together', async () => {
    const store = await open();
    store.createFeature({
      key: 'FEAT-001',
      doc_path: 'features/FEAT-001.yaml',
      git_sha: 'approved',
      status: 'approved',
    });
    store.createTask({ key: 'FEAT-001-DESIGN', type: 'architecture', agent_role: 'architect' });
    await openArchitectDecision(store, 'FEAT-001', ['uncovered_acceptance']);
    const decisionId = store.listDecisions()[0].id;
    await store.claimRequirementsRevision(
      'FEAT-001-DESIGN',
      'approved',
      decisionId,
      'architect-run',
    );
    const dag: TaskDag = {
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'TaskDAG',
      feature: 'FEAT-001',
      tasks: [
        {
          key: 'FEAT-001-T01',
          type: 'code',
          title: 'Implement',
          description: 'Implement AC',
          dependsOn: [],
          acceptanceRefs: ['AC-001'],
          agentRole: 'developer',
          size: 'S',
          changeZones: ['server/**'],
          parallelizable: false,
        },
      ],
    };
    const design = {
      feature_key: 'FEAT-001',
      doc_path: 'technical-designs/FEAT-001.md',
      dag_path: 'technical-designs/FEAT-001.dag.yaml',
      git_sha: 'design',
      feature_sha: 'approved',
    };
    await expect(
      store.importTaskDag(dag, store.getFeature('FEAT-001')!, {
        design,
        owner: 'architect-run',
        revision: {
          decisionId,
          answersHash: 'hash',
          beforeCommit: () => {
            throw new Error('audit unavailable');
          },
        },
      }),
    ).rejects.toThrow('audit unavailable');
    expect(store.getDesign('FEAT-001')).toBeUndefined();
    expect(store.getTask('FEAT-001-T01')).toBeUndefined();
    expect(store.listDecisions()[0].status).toBe('open');
    expect(store.getFeature('FEAT-001')?.git_sha).toBe('approved');
    expect(
      await store.importTaskDag(dag, store.getFeature('FEAT-001')!, {
        design,
        owner: 'architect-run',
        revision: { decisionId, answersHash: 'hash', beforeCommit: () => {} },
      }),
    ).toBe(1);
    expect(store.getDesign('FEAT-001')).toMatchObject(design);
    expect(store.getTask('FEAT-001-T01')?.status).toBe('READY');
    expect(store.listDecisions()[0].status).toBe('answered');
    expect(await store.importTaskDag(dag, store.getFeature('FEAT-001')!)).toBe(0);
    const db = await inspect();
    try {
      // Designs migrated from v8 have no snapshot column value yet.
      db.exec('UPDATE technical_designs SET dag_declaration = NULL;');
      expect(await store.importTaskDag(dag, store.getFeature('FEAT-001')!)).toBe(0);
      const before = store.listTasks();
      for (const tasks of [
        [],
        [...dag.tasks, { ...dag.tasks[0], key: 'FEAT-001-T02' }],
        [{ ...dag.tasks[0], title: 'Edited' }],
      ]) {
        await expect(
          store.importTaskDag({ ...dag, tasks }, store.getFeature('FEAT-001')!),
        ).rejects.toThrow(/registered design; run feature design/);
        expect(store.listTasks()).toEqual(before);
      }
    } finally {
      db.close();
    }
  });
  it.each([undefined, null, 'Revised title'])(
    'fences Requirements rework and preserves or replaces the title (%s)',
    async (title) => {
      const first = await open();
      const second = await open();
      first.createTask({
        key: 'FEAT-001',
        type: 'docs',
        status: 'REVIEW',
        agent_role: 'requirements-analyst',
      });
      first.createFeature({
        key: 'FEAT-001',
        title: 'Original title',
        doc_path: 'features/FEAT-001.yaml',
        git_sha: 'old',
        status: 'in_review',
      });
      await openRequirementsQuestions(first, 'FEAT-001', ['Retention?'], '1.0.0');
      const id = first.listDecisions()[0].id;
      await expect(first.claim('FEAT-001', 'ordinary')).rejects.toThrow();
      await expect(
        first.claimRequirementsRevision('FEAT-001', 'stale', id, 'operator-run'),
      ).rejects.toThrow('revision');
      await first.claimRequirementsRevision('FEAT-001', 'old', id, 'operator-run');
      await expect(
        second.claimRequirementsRevision('FEAT-001', 'old', id, 'concurrent'),
      ).rejects.toThrow();
      expect(second.listDecisions()[0].status).toBe('open');
      const feature = {
        key: 'FEAT-001',
        title,
        doc_path: 'features/FEAT-001.yaml',
        git_sha: 'new',
        status: 'in_review',
      };
      const evidence = { version: '1.0.1', answersHash: 'digest' };
      await expect(
        first.reviseFeature(feature, 'old', id, 'operator-run', evidence, () => {
          throw new Error('audit unavailable');
        }),
      ).rejects.toThrow('audit unavailable');
      expect(second.getFeature('FEAT-001')?.git_sha).toBe('old');
      expect(second.getFeature('FEAT-001')?.title).toBe('Original title');
      expect(second.listDecisions()[0].status).toBe('open');
      await first.reviseFeature(feature, 'old', id, 'operator-run', evidence, () => {});
      expect(second.getFeature('FEAT-001')?.git_sha).toBe('new');
      expect(second.getFeature('FEAT-001')?.title).toBe(title ?? 'Original title');
      expect(JSON.parse(second.listDecisions()[0].answer!)).toEqual({ ...evidence, gitSha: 'new' });
      const task = first.getTask('FEAT-001')!;
      await first.transition(task.key, task.version, 'REVIEW', 'registered', 'operator-run');
      expect(second.getTask('FEAT-001')?.lease_owner).toBeNull();
    },
  );
  it('recovers an expired Requirements revision lease without resolving its question gate', async () => {
    const store = await open();
    store.createTask({
      key: 'FEAT-001',
      type: 'docs',
      status: 'REVIEW',
      agent_role: 'requirements-analyst',
    });
    store.createFeature({
      key: 'FEAT-001',
      doc_path: 'features/FEAT-001.yaml',
      git_sha: 'old',
      status: 'in_review',
    });
    await openRequirementsQuestions(store, 'FEAT-001', ['Retention?'], '1.0.0');
    await store.claimRequirementsRevision(
      'FEAT-001',
      'old',
      store.listDecisions()[0].id,
      'operator-run',
    );
    const db = await inspect();
    try {
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE key = ?').run(
        '2000-01-01T00:00:00.000Z',
        'FEAT-001',
      );
    } finally {
      db.close();
    }
    expect(await store.recoverExpiredLeases()).toHaveLength(1);
    expect(store.getTask('FEAT-001')).toMatchObject({ status: 'WAITING_HUMAN', lease_owner: null });
    expect(store.listDecisions()[0].status).toBe('open');
    await store.claimRequirementsRevision('FEAT-001', 'old', store.listDecisions()[0].id, 'retry');
  });
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
      expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 20 }]);
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table')).toHaveLength(
        16,
      );
    } finally {
      db.close();
    }
    expect(() => first.createTask({ key: 'task', type: 'implementation' })).toThrow();
  });
  it('migrates v11 without changing historical task state or review reports', async () => {
    const store = await open();
    store.createTask({ key: 'historical-qa', type: 'code', status: 'QA', attempt: 2 });
    const before = store.getTask('historical-qa')!;
    const db = await inspect();
    try {
      db.exec(
        'DROP TRIGGER tasks_clear_ci_restore; ALTER TABLE tasks DROP COLUMN ci_restore_status; ALTER TABLE tasks DROP COLUMN pr_binding_generation; ALTER TABLE tasks DROP COLUMN pr_poll_generation; ALTER TABLE tasks DROP COLUMN pr_observed_generation; ALTER TABLE tasks DROP COLUMN pr_observation; ALTER TABLE tasks DROP COLUMN pr_status; DROP TABLE usage_ledger; ALTER TABLE features DROP COLUMN title; ALTER TABLE features DROP COLUMN updated_at; DROP TABLE worker_publications; DROP TABLE feature_runs; ALTER TABLE tasks DROP COLUMN test_reports; ALTER TABLE tasks DROP COLUMN defect_context; UPDATE schema_version SET version = 11;',
      );
      const migrated = await open();
      expect(migrated.getTask('historical-qa')).toEqual(before);
      expect(migrated.getTask('historical-qa')).toMatchObject({
        test_reports: [],
        defect_context: null,
        status: 'QA',
        attempt: 2,
      });
    } finally {
      db.close();
    }
  });
  it('migrates v8 additively and persists Project-scoped ADR reservations', async () => {
    const store = await open();
    store.createFeature({
      key: 'FEAT-001',
      doc_path: 'spec.yaml',
      git_sha: 'spec',
      status: 'approved',
    });
    const db = await inspect();
    try {
      db.exec(
        'DROP TRIGGER tasks_clear_ci_restore; ALTER TABLE tasks DROP COLUMN ci_restore_status; ALTER TABLE tasks DROP COLUMN pr_binding_generation; ALTER TABLE tasks DROP COLUMN pr_poll_generation; ALTER TABLE tasks DROP COLUMN pr_observed_generation; ALTER TABLE tasks DROP COLUMN pr_observation; ALTER TABLE tasks DROP COLUMN pr_status; DROP TABLE usage_ledger; ALTER TABLE features DROP COLUMN title; ALTER TABLE features DROP COLUMN updated_at; DROP TABLE worker_publications; DROP TABLE feature_runs; DROP TABLE adr_reservations; ALTER TABLE technical_designs DROP COLUMN dag_declaration; ALTER TABLE tasks DROP COLUMN test_reports; ALTER TABLE tasks DROP COLUMN defect_context; ALTER TABLE tasks DROP COLUMN review_reports; ALTER TABLE executions DROP COLUMN agent_role; ALTER TABLE tasks DROP COLUMN review_ref; UPDATE schema_version SET version = 8;',
      );
      const migrated = await open();
      expect(migrated.getFeature('FEAT-001')).toEqual(store.getFeature('FEAT-001'));
      db.exec('ALTER TABLE adr_reservations ADD COLUMN future TEXT;');
      expect(await migrated.reserveAdrNumbers('FEAT-001', 2, 7)).toEqual([8, 9]);
      const other = await open('b');
      other.createFeature({
        key: 'FEAT-001',
        doc_path: 'spec.yaml',
        git_sha: 'spec',
        status: 'approved',
      });
      expect(await other.reserveAdrNumbers('FEAT-001', 1, 7)).toEqual([8]);
      expect(await store.reserveAdrNumbers('FEAT-001', 2, 100)).toEqual([8, 9]);
      await expect(store.reserveAdrNumbers('FEAT-001', 3, 9999)).rejects.toThrow('exhausted');
      expect(await store.reserveAdrNumbers('FEAT-001', 3, 7)).toEqual([8, 9, 10]);
    } finally {
      db.close();
    }
  });
  it('migrates v9 review refs additively and fences registration with the task lease', async () => {
    const store = await open();
    store.createTask({ key: 'FEAT-001-T01', type: 'code', status: 'READY' });
    const db = await inspect();
    try {
      db.exec(
        'DROP TRIGGER tasks_clear_ci_restore; ALTER TABLE tasks DROP COLUMN ci_restore_status; ALTER TABLE tasks DROP COLUMN pr_binding_generation; ALTER TABLE tasks DROP COLUMN pr_poll_generation; ALTER TABLE tasks DROP COLUMN pr_observed_generation; ALTER TABLE tasks DROP COLUMN pr_observation; ALTER TABLE tasks DROP COLUMN pr_status; DROP TABLE usage_ledger; ALTER TABLE features DROP COLUMN title; ALTER TABLE features DROP COLUMN updated_at; DROP TABLE worker_publications; DROP TABLE feature_runs; ALTER TABLE tasks DROP COLUMN test_reports; ALTER TABLE tasks DROP COLUMN defect_context; ALTER TABLE tasks DROP COLUMN review_reports; ALTER TABLE executions DROP COLUMN agent_role; ALTER TABLE tasks DROP COLUMN review_ref; UPDATE schema_version SET version = 9;',
      );
      const migrated = await open();
      expect(migrated.getTask('FEAT-001-T01')?.review_ref).toBeNull();
      await migrated.claim('FEAT-001-T01', 'developer');
      await migrated.setTaskWorktree(
        'FEAT-001-T01',
        'developer',
        'sa/FEAT-001-T01-developer',
        'tree',
      );
      const review = {
        branch: 'sa/FEAT-001-T01-developer',
        sha: 'a'.repeat(40),
        base: 'b'.repeat(40),
      };
      await expect(migrated.setTaskReview('FEAT-001-T01', 'wrong-owner', review)).rejects.toThrow();
      await migrated.withIdempotency('review/FEAT-001-T01', () =>
        migrated.setTaskReview('FEAT-001-T01', 'developer', review),
      );
      await migrated.withIdempotency('review/FEAT-001-T01', () => {
        throw new Error('duplicate');
      });
      expect(store.getTask('FEAT-001-T01')?.review_ref).toEqual(review);
      expect(migrated.listTasks()[0].review_ref).toEqual(review);
      await expect(migrated.setTaskReview('FEAT-001-T01', 'developer', review)).rejects.toThrow(
        'binding changed',
      );
    } finally {
      db.close();
    }
  });
  it.each([false, true])(
    'routes doc review through design only when requested (%s)',
    async (needsDesign) => {
      const store = await open();
      store.createTask({ key: 'doc', type: 'doc', status: 'READY' });
      const claimed = await store.claim('doc', 'developer');
      await store.setTaskWorktree('doc', 'developer', 'branch', 'tree');
      const ref = { branch: 'branch', sha: 'a'.repeat(40), base: 'b'.repeat(40) };
      await store.setTaskReview('doc', 'developer', ref);
      const running = await store.transition('doc', claimed.version, 'RUNNING', '', 'developer');
      const ready = await store.transition('doc', running.version, 'REVIEW', '', 'developer');
      const task = await store.claimReview('doc', ready.version, 'reviewer');
      const db = await inspect();
      try {
        db.prepare('UPDATE tasks SET declaration = ? WHERE key = ?').run(
          JSON.stringify({ needsDesignReview: needsDesign }),
          'doc',
        );
      } finally {
        db.close();
      }
      await store.createExecution({
        key: 'doc-review',
        task_key: 'doc',
        agent_template_version: '1.0.0',
        executor: 'codex',
        agent_role: 'reviewer',
        model_id: 'test',
        session_id: null,
        pid: null,
        started_at: new Date().toISOString(),
        system_prompt_hash: 'hash',
        project_brain_sha: 'sha',
        task_version: task.version,
        tool_policy_version: 'test',
      });
      await store.closeExecution('doc-review', 'reviewer');
      await store.completeReview(
        'doc',
        'reviewer',
        {
          execution_id: 'doc-review',
          review_ref: ref,
          developer_executor: 'claude',
          reviewer_executor: 'codex',
          report: { verdict: 'approve', findings: [] },
        },
        () => {},
      );
      expect(store.getTask('doc')!.status).toBe(needsDesign ? 'QA' : 'DONE');
    },
  );
  it('rolls back a ReviewReport with its rework transition and preserves the Developer attempt while reviewing', async () => {
    const store = await open();
    store.createTask({ key: 'task', type: 'code', status: 'READY' });
    let task = await store.claim('task', 'developer');
    await store.setTaskWorktree('task', 'developer', 'branch', 'tree');
    const ref = { branch: 'branch', sha: 'a'.repeat(40), base: 'b'.repeat(40) };
    await store.setTaskReview('task', 'developer', ref);
    task = await store.transition('task', task.version, 'RUNNING', '', 'developer');
    task = await store.transition('task', task.version, 'REVIEW', '', 'developer');
    task = await store.claimReview('task', task.version, 'reviewer');
    expect(task.attempt).toBe(0);
    await store.createExecution({
      key: 'review',
      task_key: 'task',
      agent_template_version: '1.0.0',
      executor: 'codex',
      agent_role: 'reviewer',
      model_id: 'test',
      session_id: null,
      pid: null,
      started_at: new Date().toISOString(),
      system_prompt_hash: 'hash',
      project_brain_sha: 'sha',
      task_version: task.version,
      tool_policy_version: 'test',
    });
    await store.closeExecution('review', 'reviewer');
    const review = {
      execution_id: 'review',
      review_ref: ref,
      developer_executor: 'claude',
      reviewer_executor: 'codex',
      report: {
        verdict: 'request_changes' as const,
        findings: [
          { severity: 'major' as const, file: 'source.ts', summary: 'Gap', suggestion: 'Fix' },
        ],
      },
    };
    const before = store.getTask('task');
    const db = await inspect();
    try {
      db.exec(
        "CREATE TRIGGER fail_rework BEFORE INSERT ON domain_events WHEN NEW.to_status = 'READY' BEGIN SELECT RAISE(ABORT, 'rework failure'); END",
      );
      await expect(store.completeReview('task', 'reviewer', review, () => {})).rejects.toThrow(
        'rework failure',
      );
      expect(store.getTask('task')).toEqual(before);
      db.exec('DROP TRIGGER fail_rework');
      await store.completeReview('task', 'reviewer', review, () => {});
      expect(store.getTask('task')).toMatchObject({
        status: 'READY',
        attempt: 1,
        review_ref: null,
        lease_owner: null,
        review_reports: [review],
      });
    } finally {
      db.close();
    }
  });
  it('keeps writers working after additive columns on every WorkStore table', async () => {
    await open();
    const db = await inspect();
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      for (const { name } of tables) db.exec(`ALTER TABLE ${name} ADD COLUMN future TEXT`);
      // Reopen exercises schema_version and projects writes against the expanded schema.
      const store = await open('future-project');
      store.createFeature({
        key: 'feature',
        doc_path: 'spec.yaml',
        git_sha: 'sha',
        status: 'approved',
      });
      store.createTask({ key: 'dependency', type: 'doc', status: 'DONE' });
      store.createTask({ key: 'task', type: 'code', feature_key: 'feature', status: 'READY' });
      store.addTaskDependency('task', 'dependency');
      await store.createExecution({
        key: 'execution',
        task_key: 'task',
        agent_template_version: 'developer@v1',
        executor: 'codex',
        model_id: 'test',
        session_id: null,
        pid: null,
        started_at: '2026-10-02T00:00:00Z',
        system_prompt_hash: 'hash',
        project_brain_sha: 'sha',
        task_version: 1,
        tool_policy_version: 'v1',
        model_tier: 'standard',
        model_effort: 'medium',
        selection_reason: 'test',
      });
      store.recordHumanDecision({
        key: 'decision',
        task_key: 'task',
        execution_key: 'execution',
        question: 'Proceed?',
        answer: 'yes',
        actor: 'operator',
        decided_at: 'now',
      });
      expect(await store.withIdempotency('effect', () => 'result')).toBe('result');
      expect(await store.withIdempotency('effect', () => 'unexpected')).toBe('result');
      await store.claim('task', 'worker');
      // No real process is attached: expiry exercises lease_recoveries without taskkill.
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE project_id = ? AND key = ?').run(
        '2000-01-01T00:00:00Z',
        store.projectId,
        'task',
      );
      expect(await store.recoverExpiredLeases()).toMatchObject([
        { key: 'task', status: 'FAILED_RETRYABLE' },
      ]);
      expect(store.getTask('task')).toMatchObject({
        feature_key: 'feature',
        future: null,
        declaration: null,
      });
      expect(store.listTaskDependencies('task')).toMatchObject([
        { depends_on_key: 'dependency', future: null },
      ]);
      expect(store.getExecution('execution')).toMatchObject({
        model_tier: 'standard',
        model_effort: 'medium',
        selection_reason: 'test',
        future: null,
      });
      expect(store.getHumanDecision('decision')).toMatchObject({ answer: 'yes', future: null });
      expect(store.listDomainEvents('task').map((event) => event.to_status)).toEqual([
        'QUEUED',
        'LEASED',
        'FAILED_RETRYABLE',
      ]);
      expect(store.listLeaseRecoveries()).toEqual([]);
    } finally {
      db.close();
    }
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
      await store.createExecution({
        key: 'execution',
        task_key: 'task',
        agent_template_version: 'developer@v1',
        executor: 'claude',
        model_id: store.projectId,
        session_id: 'session',
        // Historical metadata has no operational process and needs no lease.
        pid: null,
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
    await a.createExecution({ ...a.getExecution('execution')!, key: 'only-a' });
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
    await expect(
      b.createExecution({ ...execution, key: 'bad', task_key: 'only-a' }),
    ).rejects.toThrow(/FOREIGN KEY/);
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
    await a.claimRework('A', 1, 'reviewer');
    expect(a.getTask('A')).toMatchObject({ version: 2, attempt: 1 });
    await a.transition('A', 2, 'REVIEW', 'ready', 'developer');
    await a.claimRework('A', 3, 'reviewer');
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
        'DROP TRIGGER tasks_clear_ci_restore; ALTER TABLE tasks DROP COLUMN ci_restore_status; ALTER TABLE tasks DROP COLUMN pr_binding_generation; ALTER TABLE tasks DROP COLUMN pr_poll_generation; ALTER TABLE tasks DROP COLUMN pr_observed_generation; ALTER TABLE tasks DROP COLUMN pr_observation; ALTER TABLE tasks DROP COLUMN pr_status; DROP TABLE usage_ledger; ALTER TABLE features DROP COLUMN title; ALTER TABLE features DROP COLUMN updated_at; DROP TABLE worker_publications; DROP TABLE feature_runs; DROP TABLE adr_reservations; DROP TABLE technical_designs; ALTER TABLE tasks DROP COLUMN test_reports; ALTER TABLE tasks DROP COLUMN defect_context; ALTER TABLE tasks DROP COLUMN review_reports; ALTER TABLE executions DROP COLUMN agent_role; ALTER TABLE tasks DROP COLUMN review_ref; ALTER TABLE tasks DROP COLUMN declaration; ALTER TABLE executions DROP COLUMN model_tier; ALTER TABLE executions DROP COLUMN model_effort; ALTER TABLE executions DROP COLUMN selection_reason; ALTER TABLE human_decisions DROP COLUMN escalation; ALTER TABLE human_decisions DROP COLUMN previous_states; DROP TRIGGER tasks_active_lease_insert; DROP TRIGGER tasks_active_lease_update; DROP TABLE lease_recoveries; DROP INDEX executions_task_version; ALTER TABLE executions DROP COLUMN tree_closed_at; DROP TRIGGER tasks_status_insert; DROP TRIGGER tasks_status_update; DROP TABLE domain_events; DROP TABLE idempotency_keys; DROP INDEX tasks_lease_expiry; ALTER TABLE executions DROP COLUMN pid_started_at; UPDATE schema_version SET version = 1;',
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
  it('recognizes historical RUNNING-without-lease rows and recovers them conservatively after v3 migration', async () => {
    await open();
    const db = await inspect();
    try {
      db.exec(
        'DROP TRIGGER tasks_clear_ci_restore; ALTER TABLE tasks DROP COLUMN ci_restore_status; ALTER TABLE tasks DROP COLUMN pr_binding_generation; ALTER TABLE tasks DROP COLUMN pr_poll_generation; ALTER TABLE tasks DROP COLUMN pr_observed_generation; ALTER TABLE tasks DROP COLUMN pr_observation; ALTER TABLE tasks DROP COLUMN pr_status; DROP TABLE usage_ledger; ALTER TABLE features DROP COLUMN title; ALTER TABLE features DROP COLUMN updated_at; DROP TABLE worker_publications; DROP TABLE feature_runs; DROP TABLE adr_reservations; DROP TABLE technical_designs; ALTER TABLE tasks DROP COLUMN test_reports; ALTER TABLE tasks DROP COLUMN defect_context; ALTER TABLE tasks DROP COLUMN review_reports; ALTER TABLE executions DROP COLUMN agent_role; ALTER TABLE tasks DROP COLUMN review_ref; ALTER TABLE tasks DROP COLUMN declaration; ALTER TABLE executions DROP COLUMN model_tier; ALTER TABLE executions DROP COLUMN model_effort; ALTER TABLE executions DROP COLUMN selection_reason; ALTER TABLE human_decisions DROP COLUMN escalation; ALTER TABLE human_decisions DROP COLUMN previous_states; DROP TRIGGER tasks_active_lease_insert; DROP TRIGGER tasks_active_lease_update; DROP TABLE lease_recoveries; DROP INDEX executions_task_version; ALTER TABLE executions DROP COLUMN tree_closed_at; UPDATE schema_version SET version = 3;',
      );
      db.exec(
        "INSERT INTO tasks VALUES ('a', NULL, 'old-running', 'dev', 'RUNNING', 0, NULL, 7, NULL, NULL, 1, 3, NULL, NULL, NULL, NULL, 'then', 'then')",
      );
    } finally {
      db.close();
    }
    const migrated = await open();
    expect(await migrated.recoverExpiredLeases()).toMatchObject([
      { key: 'old-running', status: 'FAILED_RETRYABLE', attempt: 2, version: 8 },
    ]);
    expect(migrated.listDomainEvents('old-running')).toMatchObject([
      { from_status: 'RUNNING', to_status: 'FAILED_RETRYABLE' },
    ]);
  });
  it('enforces complete active leases in SQLite even when callers bypass the WorkStore API', async () => {
    const store = await open();
    store.createTask({ key: 'task', type: 'dev', status: 'QUEUED' });
    const db = await inspect();
    try {
      for (const [owner, expires] of [
        [null, null],
        ['', '2026-10-03T10:00:00Z'],
        ['worker', 'invalid'],
      ]) {
        expect(() =>
          db
            .prepare(
              "UPDATE tasks SET status = 'RUNNING', lease_owner = ?, lease_expires_at = ? WHERE key = 'task'",
            )
            .run(owner, expires),
        ).toThrow('Active Task requires a lease');
      }
      expect(() =>
        db.exec(
          "INSERT INTO tasks (project_id,feature_key,key,type,status,priority,agent_role,version,lease_owner,lease_expires_at,attempt,max_attempts,branch,worktree_ref,pr_ref,blocked_reason,created_at,updated_at,declaration,review_ref,review_reports,test_reports,defect_context,pr_status,pr_observation) SELECT project_id, feature_key, 'invalid', type, 'LEASED', priority, agent_role, version, NULL, NULL, attempt, max_attempts, branch, worktree_ref, pr_ref, blocked_reason, created_at, updated_at, declaration, review_ref, review_reports, test_reports, defect_context, pr_status, pr_observation FROM tasks WHERE key = 'task'",
        ),
      ).toThrow('Active Task requires a lease');
      expect(store.getTask('task')).toMatchObject({ status: 'QUEUED', version: 1 });
      expect(store.getTask('invalid')).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it('preserves a real Git worktree, partial changes, branch and junction during recovery', async () => {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    fs.writeFileSync(path.join(root, 'partial.txt'), 'base\n');
    git(['add', 'partial.txt']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=NUL',
      'commit',
      '-m',
      'fixture',
    ]);
    const worktree = path.join(root, 'worktree');
    git(['worktree', 'add', '-b', 'fixture-task', worktree]);
    const target = path.join(root, 'fixture-dependencies');
    const junction = path.join(worktree, 'node_modules');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'dependencies');
    fs.symlinkSync(target, junction, 'junction');
    try {
      fs.writeFileSync(path.join(worktree, 'partial.txt'), 'partial work\n');
      fs.writeFileSync(path.join(worktree, 'new.txt'), 'unfinished\n');
      const before = git(['-C', worktree, 'status', '--porcelain']);
      const taskStore = await openWorkStore({ repositoryPath: worktree, projectId: 'a' });
      stores.push(taskStore);
      taskStore.createTask({
        key: 'task',
        type: 'dev',
        status: 'QUEUED',
        branch: 'fixture-task',
        worktree_ref: worktree,
      });
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      await taskStore.claim('task', 'first', 1000);
      vi.setSystemTime(start + 1000);
      const claimed = await taskStore.claim('task', 'next');
      expect(claimed).toMatchObject({ attempt: 1, branch: 'fixture-task', worktree_ref: worktree });
      expect(git(['-C', worktree, 'status', '--porcelain'])).toBe(before);
      expect(fs.readFileSync(path.join(worktree, 'partial.txt'), 'utf8')).toBe('partial work\n');
      expect(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8')).toBe('unfinished\n');
      expect(fs.readFileSync(path.join(junction, 'keep.txt'), 'utf8')).toBe('dependencies');
      expect(fs.realpathSync(junction)).toBe(fs.realpathSync(target));
      expect(git(['-C', worktree, 'branch', '--show-current']).trim()).toBe('fixture-task');
    } finally {
      vi.useRealTimers();
      fs.unlinkSync(junction); // Unlink only the fixture junction; retain its target.
    }
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
      expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 20 }]);
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
