import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import * as decisionSchema from '../../../core/schemas/human-decision.schema.json';
import type { HumanDecision, NewHumanDecision } from '../../../core/src/humanDecision.js';
import type { TaskDag } from '../../../core/src/taskDag.js';
import {
  WORKSTORE_BUSY_TIMEOUT_MS,
  WORKSTORE_DEFAULT_MAX_ATTEMPTS,
  WORKSTORE_INITIAL_TASK_STATUS,
  WORKSTORE_RECONCILE_REASON_PREFIX,
} from '../constants.js';
import { resolveInside } from '../pathGuard.js';
import { isFailedReview, REVIEW_FAILURE_PREFIX } from '../reviewAttempts.js';
import { compileSchema, validateSchema } from '../schemaValidation.js';
import { taskDagDeclaration, taskDeclaration } from '../taskDag.js';
import {
  hasCurrentApproval,
  sameReviewRef,
  TASK_REBASE_REASON,
  type TaskRebase,
} from '../taskRebaseHistory.js';
import { DEFAULT_LEASE_TTL_MS, LEASE_SWEEP_INTERVAL_MS, leaseDeadline } from './leasePolicy.js';
import { runMigrations } from './migrations.js';
import { processStartIdentity, terminateExecutionTree } from './processRecovery.js';
import { retryBusy } from './retryBusy.js';
import type { TaskStatus } from './taskStateMachine.js';
import {
  attemptIncrement,
  canStart,
  canTransition,
  isTaskStatus,
  TaskTransitionError,
  TaskVersionConflictError,
} from './taskStateMachine.js';
import type {
  DesignImport,
  DesignRecord,
  DomainEventRecord,
  ExecutionRecord,
  FeatureRecord,
  HumanDecisionRecord,
  LeaseRecoveryRecord,
  NewTask,
  ProjectRecord,
  ReviewRecord,
  ReviewRef,
  TaskDependencyRecord,
  TaskRecord,
  TestRecord,
  WorkStore,
} from './WorkStore.js';

const execute = promisify(execFile);

function taskRecord(row: unknown): TaskRecord {
  const record = row as Omit<
    TaskRecord,
    'review_ref' | 'review_reports' | 'test_reports' | 'defect_context'
  > & {
    review_ref: string | null;
    review_reports: string;
    test_reports: string;
    defect_context: string | null;
  };
  return {
    ...record,
    review_ref: record.review_ref ? JSON.parse(record.review_ref) : null,
    review_reports: JSON.parse(record.review_reports),
    test_reports: JSON.parse(record.test_reports),
    defect_context: record.defect_context ? JSON.parse(record.defect_context) : null,
  };
}

export interface OpenWorkStoreOptions {
  /** Trusted operator-selected repository. Never a DB path supplied by Project Brain. */
  repositoryPath: string;
  projectId: string;
}

/** Explicit standalone activation boundary. Importing this module requires no SQLite support. */
export async function openWorkStore(options: OpenWorkStoreOptions): Promise<WorkStore> {
  if (!options.projectId.trim()) throw new Error('WorkStore requires a nonempty Project id');
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
    if (
      typeof sqlite.DatabaseSync !== 'function' ||
      typeof sqlite.DatabaseSync.prototype.prepare !== 'function' ||
      typeof sqlite.DatabaseSync.prototype.exec !== 'function' ||
      typeof sqlite.DatabaseSync.prototype.close !== 'function' ||
      typeof sqlite.StatementSync !== 'function' ||
      typeof sqlite.StatementSync.prototype.run !== 'function' ||
      typeof sqlite.StatementSync.prototype.get !== 'function' ||
      typeof sqlite.StatementSync.prototype.all !== 'function'
    ) {
      throw new Error('Required DatabaseSync API unavailable');
    }
  } catch (cause) {
    throw new Error(
      `WorkStore requiere Node 22.13+ con node:sqlite disponible; ejecuta el servidor standalone con un Node compatible (actual: ${process.version})`,
      { cause },
    );
  }
  const { stdout } = await execute(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: options.repositoryPath, windowsHide: true },
  );
  const commonDir = fs.realpathSync.native(stdout.trim());
  fs.mkdirSync(resolveInside(commonDir, 'softwareagents'), { recursive: true });
  const filename = resolveInside(commonDir, 'softwareagents/work.sqlite3');
  // SQLite opens these sidecars itself: reject existing links escaping the trusted root too.
  resolveInside(commonDir, 'softwareagents/work.sqlite3-wal');
  resolveInside(commonDir, 'softwareagents/work.sqlite3-shm');
  resolveInside(commonDir, 'softwareagents/work.sqlite3-journal');
  const db = new sqlite.DatabaseSync(filename);
  try {
    db.exec(`PRAGMA busy_timeout = ${WORKSTORE_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
    const deadline = performance.now() + WORKSTORE_BUSY_TIMEOUT_MS;
    const mode = await retryBusy(
      db,
      deadline,
      () => db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode,
    );
    if (mode !== 'wal') throw new Error('WorkStore requires SQLite WAL journal mode');
    await retryBusy(db, deadline, () => runMigrations(db));
    await retryBusy(db, deadline, () =>
      db
        .prepare('INSERT OR IGNORE INTO projects(project_id, created_at) VALUES (?, ?)')
        .run(options.projectId, new Date().toISOString()),
    );
    db.exec(`PRAGMA busy_timeout = ${WORKSTORE_BUSY_TIMEOUT_MS}`);
    return new SqliteWorkStore(db, options.projectId);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Construct through openWorkStore; the connection stays private to the backend. */
class SqliteWorkStore implements WorkStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly projectId: string,
  ) {
    this.sweeper = setInterval(() => {
      void this.recoverExpiredLeases().catch((error: unknown) => {
        console.error('[WorkStore] Lease recovery failed; work remains reserved', error);
      });
    }, LEASE_SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }
  private readonly sweeper: ReturnType<typeof setInterval>;
  private closed = false;

  private write<T>(operation: () => T, rollback?: () => void): Promise<T> {
    if (this.closed) return Promise.reject(new Error('WorkStore is closed'));
    return retryBusy(this.db, performance.now() + WORKSTORE_BUSY_TIMEOUT_MS, () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (this.closed) throw new Error('WorkStore is closed');
        const result = operation();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        // Retain the writer fence until external publication has been compensated.
        try {
          rollback?.();
        } finally {
          this.db.exec('ROLLBACK');
        }
        throw error;
      }
    });
  }

  private owned(taskId: string, owner: string): TaskRecord {
    this.assertNotRecovering(taskId);
    const task = this.getTask(taskId);
    if (
      !task ||
      !owner.trim() ||
      task.lease_owner !== owner ||
      !['LEASED', 'RUNNING'].includes(task.status) ||
      !task.lease_expires_at ||
      task.lease_expires_at <= new Date().toISOString()
    )
      throw new Error(`Task ${taskId}: lease is expired or not owned by this worker`);
    return task;
  }

  private assertNotRecovering(taskId: string, token?: string): void {
    const recovery = this.db
      .prepare('SELECT * FROM lease_recoveries WHERE project_id = ? AND task_key = ?')
      .get(this.projectId, taskId) as unknown as LeaseRecoveryRecord | undefined;
    if (recovery && recovery.token !== token)
      throw new Error(
        `Task ${taskId}: recovery reserved; ${recovery.error ?? 'in progress (reconcile if abandoned)'}`,
      );
  }

  listLeaseRecoveries(): LeaseRecoveryRecord[] {
    return this.db
      .prepare('SELECT * FROM lease_recoveries WHERE project_id = ? ORDER BY task_key')
      .all(this.projectId) as unknown as LeaseRecoveryRecord[];
  }

  private reserve(task: TaskRecord, reason: string, actor: string): string {
    this.assertNotRecovering(task.key);
    const token = randomUUID();
    this.db
      .prepare(
        'INSERT INTO lease_recoveries (project_id, task_key, token, task_version, reason, actor, started_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(this.projectId, task.key, token, task.version, reason, actor, new Date().toISOString());
    return token;
  }

  private reservedTask(taskId: string, token: string): TaskRecord {
    const recovery = this.db
      .prepare('SELECT * FROM lease_recoveries WHERE project_id = ? AND task_key = ? AND token = ?')
      .get(this.projectId, taskId, token) as unknown as LeaseRecoveryRecord | undefined;
    const task = this.getTask(taskId);
    if (!recovery || !task || task.version !== recovery.task_version)
      throw new Error(`Task ${taskId}: recovery token or version changed`);
    return task;
  }

  private clearReservation(taskId: string, token: string): void {
    this.db
      .prepare('DELETE FROM lease_recoveries WHERE project_id = ? AND task_key = ? AND token = ?')
      .run(this.projectId, taskId, token);
  }

  private async recoveryFailure(taskId: string, token: string, error: unknown): Promise<void> {
    // Never expire/steal a token: its original killer may still have OS handles open.
    if (!this.closed)
      await this.write(() =>
        this.db
          .prepare(
            'UPDATE lease_recoveries SET error = ? WHERE project_id = ? AND task_key = ? AND token = ?',
          )
          .run(
            error instanceof Error ? error.message : String(error),
            this.projectId,
            taskId,
            token,
          ),
      );
    console.error(
      `[WorkStore] Task ${taskId}: recovery blocked; reconcile before reuse`,
      error instanceof Error ? error.message : String(error),
    );
  }

  private async terminate(task: TaskRecord, token: string): Promise<void> {
    // A delayed sweeper may run after another process reclaimed the Task.
    // Never terminate Executions registered under that newer incarnation.
    const executions = this.db
      .prepare(
        'SELECT * FROM executions WHERE project_id = ? AND task_key = ? AND task_version <= ? AND pid IS NOT NULL',
      )
      .all(this.projectId, task.key, task.version) as unknown as ExecutionRecord[];
    for (const execution of executions) {
      // The worker can die between persisting CLI closure and ACKing its retained
      // supervisor. Reap that root too, but never touch a reused PID. Absence is
      // acceptable here ONLY because closure was already durably recorded.
      if (execution.tree_closed_at) {
        if (!execution.pid_started_at) continue;
        // Closure is durably recorded: a PID whose identity differs or cannot be read
        // (a reused PID, e.g. a SYSTEM service) is not ours and is never touched.
        const identity = await processStartIdentity(execution.pid!).catch(() => undefined);
        if (identity !== execution.pid_started_at) continue;
      }
      await terminateExecutionTree(execution.pid!, execution.pid_started_at);
      await this.write(() => {
        this.reservedTask(task.key, token);
        this.db
          .prepare('UPDATE executions SET tree_closed_at = ? WHERE project_id = ? AND key = ?')
          .run(new Date().toISOString(), this.projectId, execution.key);
      });
    }
  }

  private failLease(task: TaskRecord, reason: string, actor: string, token: string): TaskRecord {
    // A registered Developer result survives loss of the read-only Reviewer lease.
    // terminate() has confirmed closure before this transaction can release it.
    if (task.review_ref) {
      const qa =
        this.listDomainEvents(task.key)
          .filter((e) => e.to_status === 'RUNNING')
          .at(-1)?.reason === 'Claim QA lease';
      let recovered = this.change(
        task.key,
        task.version,
        'REVIEW',
        `${REVIEW_FAILURE_PREFIX}category=lease; exit_code=unknown`,
        actor,
        task.attempt,
        undefined,
        token,
      );
      if (qa)
        recovered = this.change(
          task.key,
          recovered.version,
          'QA',
          'QA lease recovery',
          actor,
          task.attempt,
          undefined,
          token,
        );
      return recovered;
    }
    if (this.requirementsGate(task.key)) {
      this.decisionTask(task, 'WAITING_HUMAN', actor, reason, token);
      return this.getTask(task.key)!;
    }
    return this.change(
      task.key,
      task.version,
      task.attempt + 1 >= task.max_attempts ? 'FAILED_FINAL' : 'FAILED_RETRYABLE',
      reason,
      actor,
      task.attempt + 1,
      undefined,
      token,
    );
  }

  private async recoverTask(taskId: string): Promise<TaskRecord | undefined> {
    const reservation = await this.write(() => {
      const current = this.getTask(taskId);
      const recovery = this.db
        .prepare('SELECT token FROM lease_recoveries WHERE project_id = ? AND task_key = ?')
        .get(this.projectId, taskId);
      if (
        !current ||
        !['LEASED', 'RUNNING'].includes(current.status) ||
        (current.lease_owner?.trim() &&
          current.lease_expires_at &&
          Number.isFinite(Date.parse(current.lease_expires_at)) &&
          current.lease_expires_at > new Date().toISOString()) ||
        recovery
      )
        return undefined;
      return { task: current, token: this.reserve(current, 'Lease expired', 'lease-sweeper') };
    });
    if (!reservation) return undefined;
    const { task, token } = reservation;
    try {
      await this.terminate(task, token);
      return await this.write(() => {
        const current = this.reservedTask(taskId, token);
        const failed = this.failLease(current, 'Lease expired', 'lease-sweeper', token);
        this.clearReservation(taskId, token);
        return failed;
      });
    } catch (error) {
      await this.recoveryFailure(taskId, token, error);
      return undefined;
    }
  }

  async recoverExpiredLeases(): Promise<TaskRecord[]> {
    const recovered: TaskRecord[] = [];
    const candidates = this.db
      .prepare(
        "SELECT key FROM tasks WHERE project_id = ? AND status IN ('LEASED', 'RUNNING') AND (lease_owner IS NULL OR length(trim(lease_owner)) = 0 OR lease_expires_at IS NULL OR julianday(lease_expires_at) IS NULL OR lease_expires_at <= ?)",
      )
      .all(this.projectId, new Date().toISOString());
    // Independent tasks may recover concurrently; each has its own persistent token.
    const results = await Promise.allSettled(
      candidates.map((c) => this.recoverTask(c.key as string)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) recovered.push(result.value);
      if (result.status === 'rejected')
        console.error('[WorkStore] Recovery transaction failed', result.reason);
    }
    return recovered;
  }

  async claim(taskId: string, owner: string, ttl = DEFAULT_LEASE_TTL_MS): Promise<TaskRecord> {
    leaseDeadline(owner, ttl);
    await this.recoverTask(taskId);
    return this.acquire(taskId, owner, ttl);
  }

  async claimRework(
    taskId: string,
    expectedVersion: number,
    owner: string,
    ttl = DEFAULT_LEASE_TTL_MS,
  ): Promise<TaskRecord> {
    leaseDeadline(owner, ttl);
    return this.acquire(taskId, owner, ttl, expectedVersion);
  }

  claimReview(
    taskId: string,
    expectedVersion: number,
    owner: string,
    phase: 'review' | 'qa' = 'review',
  ): Promise<TaskRecord> {
    leaseDeadline(owner, DEFAULT_LEASE_TTL_MS);
    return this.acquire(taskId, owner, DEFAULT_LEASE_TTL_MS, expectedVersion, undefined, phase);
  }

  claimRequirementsRevision(
    key: string,
    gitSha: string,
    decisionId: string,
    owner: string,
  ): Promise<TaskRecord> {
    leaseDeadline(owner, DEFAULT_LEASE_TTL_MS);
    return this.acquire(key, owner, DEFAULT_LEASE_TTL_MS, undefined, { gitSha, decisionId });
  }

  private assertRequirementsRevision(key: string, gitSha: string, decisionId: string): void {
    const design = /^FEAT-\d{3}-DESIGN$/.test(key);
    const feature = this.getFeature(design ? key.replace(/-DESIGN$/, '') : key);
    const task = this.getTask(key);
    const decision = this.listDecisions().find((d) => d.id === decisionId);
    if (
      !feature ||
      feature.git_sha !== gitSha ||
      feature.status !== (design ? 'approved' : 'in_review') ||
      task?.agent_role !== (design ? 'architect' : 'requirements-analyst') ||
      task.type !== (design ? 'architecture' : 'docs') ||
      !decision?.blocks.includes(key) ||
      !decision.context.startsWith(
        `${design ? 'feature-design' : 'feature-requirements'}/${key}/`,
      ) ||
      this.listDecisions().some(
        (d) => d.id !== decisionId && d.status !== 'answered' && d.blocks.includes(key),
      )
    )
      throw new Error('Requirements revision or decision changed');
  }

  private async acquire(
    taskId: string,
    owner: string,
    ttl: number,
    reworkVersion?: number,
    revision?: { gitSha: string; decisionId: string },
    reviewOnly: false | 'review' | 'qa' = false,
  ): Promise<TaskRecord> {
    const reservation = await this.write(() => {
      this.assertNotRecovering(taskId);
      const task = this.getTask(taskId);
      if (!task) throw new TaskTransitionError(taskId, 'NOT_FOUND');
      if (revision) this.assertRequirementsRevision(taskId, revision.gitSha, revision.decisionId);
      if (
        reviewOnly &&
        (!task.review_ref ||
          !(reviewOnly === 'qa'
            ? task.status === 'QA'
            : ['REVIEW', 'WAITING_QUOTA'].includes(task.status) || isFailedReview(this, task)))
      )
        throw new Error('Reviewer requires a registered review_ref');
      this.assertNoDecisionGate(taskId, revision?.decisionId);
      if (reworkVersion !== undefined && task.version !== reworkVersion)
        throw new TaskVersionConflictError(taskId, reworkVersion, task.version);
      if (
        !(
          reviewOnly
            ? reviewOnly === 'qa'
              ? ['QA']
              : ['REVIEW', 'WAITING_QUOTA', 'FAILED_RETRYABLE']
            : revision
              ? ['WAITING_HUMAN', 'REVIEW', 'READY', 'FAILED_RETRYABLE', 'WAITING_QUOTA']
              : reworkVersion === undefined
                ? ['QUEUED', 'READY', 'FAILED_RETRYABLE']
                : ['REVIEW', 'QA']
        ).includes(task.status)
      )
        throw new TaskTransitionError(taskId, 'INVALID_TRANSITION');
      if (!this.canStart(taskId)) throw new TaskTransitionError(taskId, 'DEPENDENCIES_NOT_DONE');
      if (
        !reviewOnly &&
        task.type === 'code' &&
        task.agent_role === 'developer' &&
        task.status === 'FAILED_RETRYABLE' &&
        task.attempt + 1 >= task.max_attempts
      )
        throw new Error('Developer max_attempts exhausted');
      return { task, token: this.reserve(task, 'Claim cleanup', owner) };
    });
    const { task: candidate, token } = reservation;
    try {
      await this.terminate(candidate, token);
      return await this.write(() => {
        let task = this.reservedTask(taskId, token);
        if (reviewOnly === 'review' && task.status !== 'REVIEW') {
          this.decisionTask(task, 'REVIEW', owner, 'Resume Reviewer', token);
          task = this.getTask(taskId)!;
        }
        if (revision) {
          this.assertRequirementsRevision(taskId, revision.gitSha, revision.decisionId);
          if (task.status !== 'REVIEW')
            this.decisionTask(task, 'REVIEW', owner, 'Human Requirements revision', token);
          task = this.getTask(taskId)!;
        }
        if (task.status === 'FAILED_RETRYABLE')
          task = this.change(
            taskId,
            task.version,
            'READY',
            'Retry lease',
            owner,
            task.type === 'code' && task.agent_role === 'developer' ? task.attempt + 1 : undefined,
            undefined,
            token,
          );
        if (task.status === 'READY')
          task = this.change(
            taskId,
            task.version,
            'QUEUED',
            'Queue lease',
            owner,
            undefined,
            undefined,
            token,
          );
        task = this.change(
          taskId,
          task.version,
          revision || reworkVersion !== undefined ? 'RUNNING' : 'LEASED',
          reviewOnly === 'qa' ? 'Claim QA lease' : 'Claim lease',
          owner,
          reviewOnly ? task.attempt : undefined,
          { owner, expires: leaseDeadline(owner, ttl) },
          token,
          revision?.decisionId,
        );
        this.clearReservation(taskId, token);
        return task;
      });
    } catch (error) {
      await this.recoveryFailure(taskId, token, error);
      throw error;
    }
  }

  setTaskWorktree(taskId: string, owner: string, branch: string, worktree: string): Promise<void> {
    return this.write(() => {
      this.owned(taskId, owner);
      this.db
        .prepare('UPDATE tasks SET branch = ?, worktree_ref = ? WHERE project_id = ? AND key = ?')
        .run(branch, worktree, this.projectId, taskId);
    });
  }

  setTaskReview(taskId: string, owner: string, review: ReviewRef): Promise<void> {
    return this.write(() => {
      const task = this.owned(taskId, owner);
      if (task.branch !== review.branch || task.review_ref)
        throw new Error('Task review binding changed');
      this.db
        .prepare('UPDATE tasks SET review_ref = ? WHERE project_id = ? AND key = ?')
        .run(JSON.stringify(review), this.projectId, taskId);
    });
  }

  rebaseTask(
    taskId: string,
    version: number,
    rebase: TaskRebase,
    publish: () => void,
    rollback: () => void,
  ): Promise<void> {
    return this.write(() => {
      this.assertNotRecovering(taskId);
      this.assertNoDecisionGate(taskId);
      const task = this.getTask(taskId);
      if (
        !task ||
        task.version !== version ||
        task.lease_owner ||
        !['REVIEW', 'QA'].includes(task.status) ||
        !sameReviewRef(task.review_ref, rebase.before)
      )
        throw new Error('Task changed before rebase publication');
      publish();
      this.db
        .prepare('UPDATE tasks SET review_ref = ? WHERE project_id = ? AND key = ?')
        .run(JSON.stringify(rebase.after), this.projectId, taskId);
      this.decisionTask(
        task,
        rebase.oldPatchId === rebase.newPatchId ? task.status : 'REVIEW',
        'operator',
        TASK_REBASE_REASON + JSON.stringify(rebase),
      );
    }, rollback);
  }

  completeReview(
    taskId: string,
    owner: string,
    review: ReviewRecord,
    beforeCommit: () => void,
    input?: NewHumanDecision,
  ): Promise<void> {
    const decision = input ? this.validateDecision(input) : undefined;
    return this.write(() => {
      let task = this.owned(taskId, owner);
      const execution = this.getExecution(review.execution_id);
      if (
        JSON.stringify(task.review_ref) !== JSON.stringify(review.review_ref) ||
        !execution ||
        execution.task_key !== taskId ||
        execution.agent_role !== 'reviewer' ||
        execution.executor !== review.reviewer_executor ||
        !execution.tree_closed_at
      )
        throw new Error('Review binding changed or execution closure unconfirmed');
      beforeCommit();
      this.db
        .prepare('UPDATE tasks SET review_reports = ? WHERE project_id = ? AND key = ?')
        .run(JSON.stringify([...(task.review_reports ?? []), review]), this.projectId, taskId);
      task = this.change(taskId, task.version, 'REVIEW', 'Reviewer report persisted', owner);
      if (decision) {
        if (decision.blocks.length !== 1 || decision.blocks[0] !== taskId)
          throw new Error('Review decision must block exactly its task');
        this.decisionTask(task, 'WAITING_HUMAN', 'reviewer', decision.id);
        this.db
          .prepare(
            'INSERT INTO human_decisions (project_id,key,question,answer,actor,decided_at,escalation,previous_states) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            this.projectId,
            decision.id,
            decision.context,
            '',
            'reviewer',
            '',
            JSON.stringify(decision),
            JSON.stringify({ [taskId]: 'REVIEW' }),
          );
      } else if (review.report.verdict === 'approve') {
        this.change(taskId, task.version, 'QA', 'Reviewer approved', owner);
      } else {
        this.change(taskId, task.version, 'READY', 'Reviewer requested changes', owner);
        this.db
          .prepare('UPDATE tasks SET review_ref = NULL WHERE project_id = ? AND key = ?')
          .run(this.projectId, taskId);
      }
    });
  }

  completeQa(
    taskId: string,
    owner: string,
    record: TestRecord,
    beforeCommit: () => void,
    input?: NewHumanDecision,
  ): Promise<void> {
    const decision = input ? this.validateDecision(input) : undefined;
    return this.write(() => {
      let task = this.owned(taskId, owner);
      const execution = this.getExecution(record.execution_id);
      if (
        JSON.stringify(task.review_ref) !== JSON.stringify(record.review_ref) ||
        !hasCurrentApproval(this, taskId) ||
        !execution ||
        execution.task_key !== taskId ||
        execution.agent_role !== 'qa' ||
        !execution.tree_closed_at
      )
        throw new Error('QA binding changed or execution closure unconfirmed');
      beforeCommit();
      this.db
        .prepare('UPDATE tasks SET test_reports = ? WHERE project_id = ? AND key = ?')
        .run(JSON.stringify([...(task.test_reports ?? []), record]), this.projectId, taskId);
      task = this.change(taskId, task.version, 'REVIEW', 'QA report persisted', owner);
      task = this.change(taskId, task.version, 'QA', 'QA report accepted', owner);
      if (record.report.verdict === 'pass') {
        this.change(taskId, task.version, 'DONE', 'QA passed; ready for human merge', owner);
        for (const dependent of this.listTasks())
          if (
            dependent.feature_key === task.feature_key &&
            dependent.declaration &&
            dependent.status === 'DRAFT' &&
            this.listTaskDependencies(dependent.key).some((d) => d.depends_on_key === taskId) &&
            this.canStart(dependent.key)
          )
            this.change(
              dependent.key,
              dependent.version,
              'READY',
              'QA dependency completed',
              owner,
            );
      } else if (record.report.verdict === 'fail') {
        let ordinal = 1;
        // Reports remain append-only evidence. Match historical contexts too, without migration.
        const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
        const identity = (context: {
          task: string;
          review_ref: ReviewRef;
          ac: string;
          summary: string;
          reproduction: string;
        }) =>
          JSON.stringify([
            context.task,
            context.review_ref.sha,
            context.ac,
            normalize(context.summary),
            normalize(context.reproduction),
          ]);
        const existing = new Set(
          this.listTasks().flatMap((t) => (t.defect_context ? [identity(t.defect_context)] : [])),
        );
        for (const defect of record.report.defects) {
          const id = identity({ task: taskId, review_ref: record.review_ref, ...defect });
          if (existing.has(id)) continue;
          existing.add(id);
          while (this.getTask(taskId + '-D' + ordinal)) ordinal++;
          const key = taskId + '-D' + ordinal++;
          this.createTask({ key, type: 'bug', feature_key: task.feature_key, status: 'DRAFT' });
          this.db
            .prepare('UPDATE tasks SET defect_context = ? WHERE project_id = ? AND key = ?')
            .run(
              JSON.stringify({
                task: taskId,
                review_ref: record.review_ref,
                execution_id: record.execution_id,
                ...defect,
              }),
              this.projectId,
              key,
            );
        }
        if (decision) {
          if (decision.blocks.length !== 1 || decision.blocks[0] !== taskId)
            throw new Error('QA decision must block its task');
          this.decisionTask(task, 'WAITING_HUMAN', 'qa', decision.id);
          this.db
            .prepare(
              'INSERT INTO human_decisions (project_id,key,question,answer,actor,decided_at,escalation,previous_states) VALUES (?,?,?,?,?,?,?,?)',
            )
            .run(
              this.projectId,
              decision.id,
              decision.context,
              '',
              'qa',
              '',
              JSON.stringify(decision),
              JSON.stringify({ [taskId]: 'QA' }),
            );
        } else {
          this.change(taskId, task.version, 'READY', 'QA requested changes', owner);
          this.db
            .prepare('UPDATE tasks SET review_ref = NULL WHERE project_id = ? AND key = ?')
            .run(this.projectId, taskId);
        }
      }
    });
  }

  heartbeat(taskId: string, owner: string, ttl = DEFAULT_LEASE_TTL_MS): Promise<TaskRecord> {
    leaseDeadline(owner, ttl);
    return this.write(() => {
      const task = this.owned(taskId, owner);
      this.db
        .prepare(
          'UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE project_id = ? AND key = ? AND version = ?',
        )
        .run(
          leaseDeadline(owner, ttl),
          new Date().toISOString(),
          this.projectId,
          taskId,
          task.version,
        );
      return this.getTask(taskId)!;
    });
  }

  async release(taskId: string, owner: string): Promise<TaskRecord> {
    const { candidate, token } = await this.write(() => {
      const candidate = this.owned(taskId, owner);
      return { candidate, token: this.reserve(candidate, 'Lease released', owner) };
    });
    try {
      await this.terminate(candidate, token);
      return await this.write(() => {
        const current = this.reservedTask(taskId, token);
        const failed = this.failLease(current, 'Lease released', owner, token);
        this.clearReservation(taskId, token);
        return failed;
      });
    } catch (error) {
      await this.recoveryFailure(taskId, token, error);
      throw error;
    }
  }

  async withIdempotency<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    if (!key.trim()) throw new Error('Idempotency key must be nonempty');
    const reservation = await this.write(() => {
      const existing = this.db
        .prepare('SELECT state, result FROM idempotency_keys WHERE project_id = ? AND key = ?')
        .get(this.projectId, key);
      if (existing) {
        if (existing.state !== 'COMPLETED')
          throw new Error('Idempotency effect is pending or uncertain; reconcile before retrying');
        return { cached: true, result: existing.result as string };
      }
      this.db
        .prepare(
          "INSERT INTO idempotency_keys (project_id, key, state, result, created_at) VALUES (?, ?, 'PENDING', NULL, ?)",
        )
        .run(this.projectId, key, new Date().toISOString());
      return { cached: false, result: '' };
    });
    if (reservation.cached) return (JSON.parse(reservation.result) as { value?: T }).value as T;
    const result = await fn();
    const serialized = JSON.stringify({ value: result });
    await this.write(() =>
      this.db
        .prepare(
          "UPDATE idempotency_keys SET state = 'COMPLETED', result = ? WHERE project_id = ? AND key = ?",
        )
        .run(serialized, this.projectId, key),
    );
    return result;
  }

  getProject(): ProjectRecord {
    return this.db
      .prepare('SELECT * FROM projects WHERE project_id = ?')
      .get(this.projectId) as unknown as ProjectRecord;
  }
  createFeature(feature: Omit<FeatureRecord, 'project_id'>): void {
    this.db
      .prepare(
        'INSERT INTO features (project_id, key, doc_path, git_sha, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run(this.projectId, feature.key, feature.doc_path, feature.git_sha, feature.status);
  }
  reviseFeature(
    feature: Omit<FeatureRecord, 'project_id'>,
    previousSha: string,
    decisionId: string,
    owner: string,
    evidence: { version: string; answersHash: string },
    beforeCommit: () => void,
  ): Promise<void> {
    return this.write(() => {
      this.owned(feature.key, owner);
      this.assertRequirementsRevision(feature.key, previousSha, decisionId);
      if (
        this.listExecutions().some(
          (e) => e.task_key === feature.key && e.pid !== null && !e.tree_closed_at,
        )
      )
        throw new Error('Requirements Execution still active');
      this.db
        .prepare(
          'UPDATE features SET doc_path = ?, git_sha = ?, status = ? WHERE project_id = ? AND key = ?',
        )
        .run(feature.doc_path, feature.git_sha, feature.status, this.projectId, feature.key);
      this.answerArtifactDecision(decisionId, { ...evidence, gitSha: feature.git_sha });
      beforeCommit();
    });
  }
  private answerArtifactDecision(decisionId: string, evidence: Record<string, string>): void {
    const decision = this.listDecisions().find((d) => d.id === decisionId)!;
    decision.status = 'answered';
    decision.answer = JSON.stringify(evidence);
    decision.answeredBy = 'operator';
    decision.answeredAt = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE human_decisions SET escalation = ?, answer = ?, actor = ?, decided_at = ? WHERE project_id = ? AND key = ?',
      )
      .run(
        JSON.stringify(decision),
        decision.answer,
        'operator',
        decision.answeredAt,
        this.projectId,
        decisionId,
      );
  }
  getFeature(key: string): FeatureRecord | undefined {
    return this.db
      .prepare('SELECT * FROM features WHERE project_id = ? AND key = ?')
      .get(this.projectId, key) as unknown as FeatureRecord | undefined;
  }
  listFeatures(): FeatureRecord[] {
    return this.db
      .prepare('SELECT * FROM features WHERE project_id = ? ORDER BY key')
      .all(this.projectId) as unknown as FeatureRecord[];
  }
  getDesign(key: string): DesignRecord | undefined {
    return this.db
      .prepare(
        'SELECT project_id, feature_key, doc_path, dag_path, git_sha, feature_sha FROM technical_designs WHERE project_id = ? AND feature_key = ?',
      )
      .get(this.projectId, key) as unknown as DesignRecord | undefined;
  }
  reserveAdrNumbers(featureKey: string, count: number, minimum: number): Promise<number[]> {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(minimum) || minimum < 0)
      throw new Error('Invalid ADR reservation');
    return this.write(() => {
      const reserved = this.db
        .prepare(
          'SELECT number FROM adr_reservations WHERE project_id = ? AND feature_key = ? ORDER BY ordinal',
        )
        .all(this.projectId, featureKey)
        .map((row) => Number(row.number));
      let number = Math.max(
        minimum,
        Number(
          this.db
            .prepare(
              'SELECT coalesce(max(number), 0) AS number FROM adr_reservations WHERE project_id = ?',
            )
            .get(this.projectId)!.number,
        ),
      );
      for (let ordinal = reserved.length; ordinal < count; ordinal++) {
        if (++number > 9999) throw new Error('ADR numbering exhausted');
        this.db
          .prepare(
            'INSERT INTO adr_reservations (project_id, feature_key, ordinal, number) VALUES (?, ?, ?, ?)',
          )
          .run(this.projectId, featureKey, ordinal, number);
        reserved.push(number);
      }
      return reserved.slice(0, count);
    });
  }
  approveFeature(key: string, gitSha: string, beforeCommit: () => void): Promise<void> {
    return this.write(() => {
      const feature = this.getFeature(key);
      if (!feature || feature.git_sha !== gitSha) throw new Error('Feature revision changed');
      if (!['draft', 'in_review', 'approved'].includes(feature.status))
        throw new Error('Feature is not reviewable');
      if (this.listDecisions().some((d) => d.status !== 'answered' && d.blocks.includes(key)))
        throw new Error('Feature has unresolved Human Decisions');
      const task = this.getTask(key);
      if (task && (task.lease_owner || task.status === 'WAITING_HUMAN'))
        throw new Error('Feature requirements are still active or waiting for a human');
      beforeCommit();
      this.db
        .prepare('UPDATE features SET status = ? WHERE project_id = ? AND key = ?')
        .run('approved', this.projectId, key);
    });
  }
  createTask(task: NewTask): void {
    if (['LEASED', 'RUNNING'].includes(task.status ?? ''))
      throw new Error('Active Task must be acquired through claim or claimRework');
    if (task.lease_owner || task.lease_expires_at)
      throw new Error('New Task cannot import a lease; use claim');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (
        project_id, feature_key, key, type, status, priority, agent_role,
        version, lease_owner, lease_expires_at, attempt, max_attempts,
        branch, worktree_ref, pr_ref, blocked_reason, created_at, updated_at
      ) VALUES (${Array(18).fill('?').join(',')})`,
      )
      .run(
        this.projectId,
        task.feature_key ?? null,
        task.key,
        task.type,
        task.status ?? WORKSTORE_INITIAL_TASK_STATUS,
        task.priority ?? 0,
        task.agent_role ?? null,
        task.version ?? 1,
        task.lease_owner ?? null,
        task.lease_expires_at ?? null,
        task.attempt ?? 0,
        task.max_attempts ?? WORKSTORE_DEFAULT_MAX_ATTEMPTS,
        task.branch ?? null,
        task.worktree_ref ?? null,
        task.pr_ref ?? null,
        task.blocked_reason ?? null,
        now,
        now,
      );
  }
  getTask(key: string): TaskRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? AND key = ?')
      .get(this.projectId, key);
    return row ? taskRecord(row) : undefined;
  }
  listTasks(): TaskRecord[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY key')
      .all(this.projectId)
      .map(taskRecord);
  }
  importTaskDag(
    dag: TaskDag,
    feature: Omit<FeatureRecord, 'project_id'>,
    design?: DesignImport,
  ): Promise<number> {
    // Snapshot before a busy retry; callers cannot mutate the batch while waiting.
    dag = structuredClone(dag);
    const declarations = dag.tasks.map((task) => ({
      ...task,
      dependsOn: [...task.dependsOn].sort(),
      acceptanceRefs: [...task.acceptanceRefs].sort(),
      ...(task.changeZones ? { changeZones: [...task.changeZones].sort() } : {}),
    }));
    return this.write(() => {
      let created = 0;
      const registered = this.db
        .prepare(
          'SELECT dag_declaration FROM technical_designs WHERE project_id = ? AND feature_key = ?',
        )
        .get(this.projectId, dag.feature);
      if (registered && !design) {
        // v8 records predate the snapshot column; their immutable declarations are the baseline.
        const baseline =
          registered.dag_declaration ??
          JSON.stringify(
            this.listTasks()
              .filter((task) => task.feature_key === dag.feature && task.declaration)
              .map((task) => task.declaration!)
              .sort(),
          );
        if (baseline !== taskDagDeclaration(dag))
          throw new Error('TaskDAG differs from the registered design; run feature design again');
      }
      if (!this.getFeature(feature.key)) this.createFeature(feature);
      if (design) {
        const current = this.getFeature(feature.key)!;
        const taskKey = `${feature.key}-DESIGN`;
        this.owned(taskKey, design.owner);
        this.assertNoDecisionGate(taskKey, design.revision?.decisionId);
        if (
          this.listExecutions().some(
            (e) => e.task_key === taskKey && e.pid !== null && !e.tree_closed_at,
          )
        )
          throw new Error('Architect Execution still active');
        if (
          current.status !== 'approved' ||
          current.git_sha !== design.design.feature_sha ||
          design.design.feature_key !== dag.feature ||
          dag.feature !== feature.key
        )
          throw new Error('Approved FeatureSpec changed before design registration');
        if (design.revision)
          this.assertRequirementsRevision(taskKey, current.git_sha, design.revision.decisionId);
        if (this.getDesign(feature.key)) throw new Error('Design already registered');
        this.db
          .prepare(
            'INSERT INTO technical_designs (project_id, feature_key, doc_path, dag_path, git_sha, feature_sha, dag_declaration) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            this.projectId,
            dag.feature,
            design.design.doc_path,
            design.design.dag_path,
            design.design.git_sha,
            design.design.feature_sha,
            taskDagDeclaration(dag),
          );
      }
      for (const task of declarations) {
        // Explicit field order makes YAML/JSON property ordering irrelevant.
        const declaration = taskDeclaration(dag.feature, task);
        const current = this.getTask(task.key);
        if (current) {
          const deps = this.listTaskDependencies(task.key).map((edge) => edge.depends_on_key);
          if (
            current.declaration !== declaration ||
            current.feature_key !== dag.feature ||
            current.type !== task.type ||
            current.agent_role !== task.agentRole ||
            JSON.stringify(deps) !== JSON.stringify(task.dependsOn)
          )
            throw new Error(`Task ${task.key}: reimport conflicts with its immutable declaration`);
          continue;
        }
        this.createTask({
          key: task.key,
          type: task.type,
          feature_key: dag.feature,
          agent_role: task.agentRole,
          // Legacy task import remains DRAFT. Architect roots are ready immediately.
          status:
            design && task.dependsOn.every((dep) => this.getTask(dep)?.status === 'DONE')
              ? 'READY'
              : 'DRAFT',
        });
        this.db
          .prepare('UPDATE tasks SET declaration = ? WHERE project_id = ? AND key = ?')
          .run(declaration, this.projectId, task.key);
        created++;
      }
      for (const task of declarations)
        for (const dep of task.dependsOn)
          this.db
            .prepare(
              'INSERT OR IGNORE INTO task_dependencies (project_id, task_key, depends_on_key) VALUES (?, ?, ?)',
            )
            .run(this.projectId, task.key, dep);
      if (design?.revision) {
        this.answerArtifactDecision(design.revision.decisionId, {
          gitSha: design.design.git_sha,
          answersHash: design.revision.answersHash,
        });
        design.revision.beforeCommit();
      }
      return created;
    });
  }
  async backup(destination: string): Promise<void> {
    if (this.closed) throw new Error('WorkStore is closed');
    await retryBusy(this.db, performance.now() + WORKSTORE_BUSY_TIMEOUT_MS, () =>
      this.db.prepare('VACUUM INTO ?').run(destination),
    );
  }
  canStart(taskId: string): boolean {
    if (!this.getTask(taskId)) return false;
    return canStart({
      dependencies: this.listTaskDependencies(taskId).map((edge) =>
        this.getTask(edge.depends_on_key),
      ),
    });
  }
  async transition(
    taskId: string,
    expectedVersion: number,
    to: TaskStatus,
    reason: string,
    actor: string,
  ): Promise<TaskRecord> {
    return this.write(() => this.change(taskId, expectedVersion, to, reason, actor));
  }

  private change(
    taskId: string,
    expectedVersion: number,
    to: TaskStatus,
    reason: string,
    actor: string,
    failureAttempt?: number,
    lease?: { owner: string; expires: string },
    token?: string,
    requirementsDecisionId?: string,
  ): TaskRecord {
    this.assertNotRecovering(taskId, token);
    const task = this.getTask(taskId);
    if (!task) throw new TaskTransitionError(taskId, 'NOT_FOUND');
    if (task.version !== expectedVersion)
      throw new TaskVersionConflictError(taskId, expectedVersion, task.version);
    if (!isTaskStatus(to) || !isTaskStatus(task.status) || !canTransition(task.status, to))
      throw new TaskTransitionError(taskId, 'INVALID_TRANSITION');
    // Failure/cleanup retains the unresolved gate. Only the dedicated human revision
    // claim may enter RUNNING while that one gate remains open.
    const returningToGate =
      to === 'WAITING_HUMAN' &&
      task.lease_owner === actor &&
      ['LEASED', 'RUNNING'].includes(task.status) &&
      this.requirementsGate(taskId);
    this.assertNoDecisionGate(
      taskId,
      requirementsDecisionId ?? (returningToGate ? this.requirementsGate(taskId)!.id : undefined),
    );
    if (['QUEUED', 'LEASED', 'RUNNING'].includes(to) && !this.canStart(taskId))
      throw new TaskTransitionError(taskId, 'DEPENDENCIES_NOT_DONE');
    if (
      ['LEASED', 'RUNNING'].includes(task.status) &&
      (!task.lease_owner ||
        !task.lease_expires_at ||
        task.lease_expires_at <= new Date().toISOString()) &&
      failureAttempt === undefined
    )
      throw new Error('Expired lease must be recovered before transitioning');
    const now = new Date().toISOString();
    const attempt = failureAttempt ?? task.attempt + attemptIncrement(task.status, to);
    const active = ['LEASED', 'RUNNING'].includes(to);
    if (
      active &&
      !lease &&
      (!['LEASED', 'RUNNING'].includes(task.status) || !task.lease_owner || !task.lease_expires_at)
    )
      throw new Error('Active Task requires a lease; use claim or claimRework');
    if (to === 'LEASED' && !lease) throw new Error('Entering LEASED requires claim');
    this.db
      .prepare(
        'UPDATE tasks SET status = ?, version = version + 1, attempt = ?, blocked_reason = ?, updated_at = ?, lease_owner = ?, lease_expires_at = ? WHERE project_id = ? AND key = ? AND version = ?',
      )
      .run(
        to,
        attempt,
        ['BLOCKED', 'WAITING_QUOTA', 'FAILED_RETRYABLE', 'FAILED_FINAL'].includes(to)
          ? reason
          : null,
        now,
        active ? (lease?.owner ?? task.lease_owner) : null,
        active ? (lease?.expires ?? task.lease_expires_at) : null,
        this.projectId,
        taskId,
        expectedVersion,
      );
    this.db
      .prepare(
        "INSERT INTO domain_events (project_id, task_key, type, from_status, to_status, task_version, attempt, reason, actor, created_at) VALUES (?, ?, 'TASK_TRANSITIONED', ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(this.projectId, taskId, task.status, to, task.version + 1, attempt, reason, actor, now);
    return this.getTask(taskId)!;
  }
  listDomainEvents(taskId?: string): DomainEventRecord[] {
    return (taskId === undefined
      ? this.db
          .prepare('SELECT * FROM domain_events WHERE project_id = ? ORDER BY id')
          .all(this.projectId)
      : this.db
          .prepare('SELECT * FROM domain_events WHERE project_id = ? AND task_key = ? ORDER BY id')
          .all(this.projectId, taskId)) as unknown as DomainEventRecord[];
  }
  addTaskDependency(taskKey: string, dependsOnKey: string): void {
    this.db
      .prepare(
        'INSERT INTO task_dependencies (project_id, task_key, depends_on_key) VALUES (?, ?, ?)',
      )
      .run(this.projectId, taskKey, dependsOnKey);
  }
  listTaskDependencies(taskKey: string): TaskDependencyRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM task_dependencies
      WHERE project_id = ? AND task_key = ? ORDER BY depends_on_key`,
      )
      .all(this.projectId, taskKey) as unknown as TaskDependencyRecord[];
  }
  async createExecution(
    execution: Omit<ExecutionRecord, 'project_id' | 'tree_closed_at'>,
  ): Promise<void> {
    execution = { ...execution };
    this.assertNotRecovering(execution.task_key);
    const task = this.getTask(execution.task_key);
    let identity = execution.pid_started_at ?? null;
    if (execution.pid !== null) {
      if (!Number.isSafeInteger(execution.pid) || execution.pid <= 0)
        throw new Error('Execution PID must be a positive integer');
      this.owned(execution.task_key, task?.lease_owner ?? '');
    }
    if (task && ['LEASED', 'RUNNING'].includes(task.status)) {
      this.owned(task.key, task.lease_owner ?? '');
      if (execution.task_version !== task.version)
        throw new TaskVersionConflictError(task.key, execution.task_version, task.version);
      if (execution.pid !== null) {
        identity = await processStartIdentity(execution.pid);
        if (!identity) throw new Error('Executor died before its identity was recorded');
      }
    }
    // Capture OS identity outside a transaction, then fence the insertion atomically.
    // Recovery on another connection may have advanced the Task during that query.
    const guard = task
      ? " WHERE EXISTS (SELECT 1 FROM tasks WHERE project_id = ? AND key = ? AND version = ? AND lease_owner IS ? AND (lease_owner IS NULL OR (status IN ('LEASED', 'RUNNING') AND lease_expires_at > ?)) AND (? IS NULL OR (lease_owner IS NOT NULL AND status IN ('LEASED', 'RUNNING') AND lease_expires_at > ?))) AND NOT EXISTS (SELECT 1 FROM lease_recoveries WHERE project_id = ? AND task_key = ?)"
      : '';
    const result = await this.write(() =>
      this.db
        .prepare(
          `INSERT INTO executions (
            project_id, key, task_key, agent_template_version, executor, model_id,
            session_id, pid, started_at, system_prompt_hash, project_brain_sha,
            task_version, tool_policy_version, pid_started_at, tree_closed_at,
            model_tier, model_effort, selection_reason, agent_role
          ) SELECT ${Array(14).fill('?').join(',')}, NULL, ?, ?, ?, ?${guard}`,
        )
        .run(
          this.projectId,
          execution.key,
          execution.task_key,
          execution.agent_template_version,
          execution.executor,
          execution.model_id,
          execution.session_id,
          execution.pid,
          execution.started_at,
          execution.system_prompt_hash,
          execution.project_brain_sha,
          execution.task_version,
          execution.tool_policy_version,
          identity,
          execution.model_tier ?? null,
          execution.model_effort ?? null,
          execution.selection_reason ?? null,
          execution.agent_role ?? null,
          ...(task
            ? [
                this.projectId,
                task.key,
                execution.task_version,
                task.lease_owner,
                new Date().toISOString(),
                execution.pid,
                new Date().toISOString(),
                this.projectId,
                task.key,
              ]
            : []),
        ),
    );
    if (result.changes !== 1)
      throw new Error('Task changed or lease expired before Execution registration');
  }
  setExecutionSession(key: string, sessionId: string): Promise<void> {
    return this.write(() => {
      this.db
        .prepare('UPDATE executions SET session_id = ? WHERE project_id = ? AND key = ?')
        .run(sessionId, this.projectId, key);
    });
  }
  async setExecutionProcess(key: string, owner: string, pid: number): Promise<void> {
    const execution = this.getExecution(key);
    if (!execution || execution.pid !== null) throw new Error('Execution not awaiting a process');
    const task = this.owned(execution.task_key, owner);
    const identity = await processStartIdentity(pid);
    if (!identity) throw new Error('Executor died before its identity was recorded');
    await this.write(() => {
      const current = this.owned(task.key, owner);
      if (current.version !== task.version)
        throw new TaskVersionConflictError(task.key, task.version, current.version);
      const result = this.db
        .prepare(
          'UPDATE executions SET pid = ?, pid_started_at = ? WHERE project_id = ? AND key = ? AND pid IS NULL',
        )
        .run(pid, identity, this.projectId, key);
      if (result.changes !== 1) throw new Error('Execution process already registered');
    });
  }
  closeExecution(key: string, owner: string): Promise<void> {
    return this.write(() => {
      const execution = this.getExecution(key);
      if (!execution) throw new Error('Unknown Execution');
      this.owned(execution.task_key, owner);
      this.db
        .prepare('UPDATE executions SET tree_closed_at = ? WHERE project_id = ? AND key = ?')
        .run(new Date().toISOString(), this.projectId, key);
    });
  }
  getExecution(key: string): ExecutionRecord | undefined {
    return this.db
      .prepare('SELECT * FROM executions WHERE project_id = ? AND key = ?')
      .get(this.projectId, key) as unknown as ExecutionRecord | undefined;
  }
  listExecutions(): ExecutionRecord[] {
    return this.db
      .prepare('SELECT * FROM executions WHERE project_id = ? ORDER BY key')
      .all(this.projectId) as unknown as ExecutionRecord[];
  }
  recordHumanDecision(decision: Omit<HumanDecisionRecord, 'project_id'>): void {
    this.db
      .prepare(
        'INSERT INTO human_decisions (project_id,key,task_key,execution_key,question,answer,actor,decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.projectId,
        decision.key,
        decision.task_key,
        decision.execution_key,
        decision.question,
        decision.answer,
        decision.actor,
        decision.decided_at,
      );
  }
  getHumanDecision(key: string): HumanDecisionRecord | undefined {
    return this.db
      .prepare('SELECT * FROM human_decisions WHERE project_id = ? AND key = ?')
      .get(this.projectId, key) as unknown as HumanDecisionRecord | undefined;
  }
  listHumanDecisions(): HumanDecisionRecord[] {
    return this.db
      .prepare('SELECT * FROM human_decisions WHERE project_id = ? ORDER BY key')
      .all(this.projectId) as unknown as HumanDecisionRecord[];
  }

  listDecisions(): HumanDecision[] {
    return this.db
      .prepare(
        'SELECT escalation FROM human_decisions WHERE project_id = ? AND escalation IS NOT NULL ORDER BY key',
      )
      .all(this.projectId)
      .map((row) => JSON.parse(row.escalation as string) as HumanDecision);
  }
  private requirementsGate(taskId: string): HumanDecision | undefined {
    return this.listDecisions().find(
      (d) =>
        d.status !== 'answered' &&
        d.blocks.includes(taskId) &&
        (d.context.startsWith(`feature-requirements/${taskId}/`) ||
          d.context.startsWith(`feature-design/${taskId}/`)),
    );
  }
  private assertNoDecisionGate(taskId: string, exceptId?: string): void {
    // Expiry retains the gate; only explicit decision resolution/reconciliation releases it.
    if (
      this.listDecisions().some(
        (d) =>
          d.id !== exceptId && ['open', 'expired'].includes(d.status) && d.blocks.includes(taskId),
      )
    )
      throw new TaskTransitionError(taskId, 'INVALID_TRANSITION');
  }
  /** Decision suspension/restoration preserves attempts and blocked_reason, but never a lease. */
  private decisionTask(
    task: TaskRecord,
    status: TaskStatus,
    actor: string,
    reason: string,
    token?: string,
  ): void {
    this.assertNotRecovering(task.key, token);
    if (['LEASED', 'RUNNING'].includes(status))
      throw new Error('Active Task requires a lease; use claim or claimRework');
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        'UPDATE tasks SET status = ?, version = version + 1, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE project_id = ? AND key = ? AND version = ?',
      )
      .run(status, now, this.projectId, task.key, task.version);
    if (result.changes !== 1)
      throw new TaskVersionConflictError(task.key, task.version, this.getTask(task.key)!.version);
    this.db
      .prepare(
        "INSERT INTO domain_events (project_id,task_key,type,from_status,to_status,task_version,attempt,reason,actor,created_at) VALUES (?,?,'TASK_TRANSITIONED',?,?,?,?,?,?,?)",
      )
      .run(
        this.projectId,
        task.key,
        task.status,
        status,
        task.version + 1,
        task.attempt,
        reason,
        actor,
        now,
      );
  }
  private validateDecision(input: NewHumanDecision): HumanDecision {
    const decision = validateSchema(compileSchema<HumanDecision>(decisionSchema), {
      // Snapshot nested input before asynchronous process cleanup.
      ...structuredClone(input),
      status: 'open',
      answeredBy: null,
      answeredAt: null,
    });
    if (
      new Set(decision.options.map((o) => o.id)).size !== decision.options.length ||
      decision.options.some((o) => !o.id.trim())
    )
      throw new Error('Option IDs must be nonempty and unique');
    return decision;
  }
  openOrJoinIdleDecision(
    input: NewHumanDecision,
  ): Promise<{ decision: HumanDecision; created: boolean; added: boolean }> {
    const proposed = this.validateDecision(input);
    const key = proposed.context.split('\n', 1)[0];
    if (!key.trim()) throw new Error('Decision requires a context key');
    // BEGIN IMMEDIATE serializes the key lookup and all Task/decision changes
    // across connections and processes, including resolution of the same decision.
    return this.write(() => {
      const existing = this.listDecisions().find(
        (d) => d.status === 'open' && d.context.split('\n', 1)[0] === key,
      );
      const decision = existing ?? proposed;
      const row = existing
        ? this.db
            .prepare('SELECT previous_states FROM human_decisions WHERE project_id = ? AND key = ?')
            .get(this.projectId, existing.id)
        : undefined;
      const states: Record<string, TaskStatus> = row
        ? JSON.parse(row.previous_states as string)
        : Object.create(null);
      let added = false;
      for (const taskKey of new Set(proposed.blocks)) {
        this.assertNotRecovering(taskKey);
        if (!this.getTask(taskKey))
          this.createTask({ key: taskKey, type: 'unknown', status: 'DRAFT' });
        const task = this.getTask(taskKey)!;
        if (existing?.blocks.includes(taskKey)) {
          if (task.status !== 'WAITING_HUMAN') throw new Error('Blocked task state changed');
          continue;
        }
        if (
          task.lease_owner !== null ||
          ['LEASED', 'RUNNING', 'DONE', 'FAILED_FINAL', 'CANCELLED', 'WAITING_HUMAN'].includes(
            task.status,
          ) ||
          this.db
            .prepare(
              'SELECT 1 FROM executions WHERE project_id = ? AND task_key = ? AND pid IS NOT NULL AND tree_closed_at IS NULL LIMIT 1',
            )
            .get(this.projectId, taskKey)
        )
          throw new Error('Task cannot wait for a human while active or blocked: ' + taskKey);
        this.assertNoDecisionGate(taskKey);
        states[taskKey] = task.status;
        this.decisionTask(task, 'WAITING_HUMAN', decision.requestedBy, decision.id);
        if (existing) decision.blocks.push(taskKey);
        added = true;
      }
      if (existing) {
        this.db
          .prepare(
            'UPDATE human_decisions SET escalation = ?, previous_states = ? WHERE project_id = ? AND key = ?',
          )
          .run(JSON.stringify(decision), JSON.stringify(states), this.projectId, decision.id);
      } else {
        this.db
          .prepare(
            'INSERT INTO human_decisions (project_id,key,question,answer,actor,decided_at,escalation,previous_states) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            this.projectId,
            decision.id,
            decision.context,
            '',
            decision.requestedBy,
            '',
            JSON.stringify(decision),
            JSON.stringify(states),
          );
      }
      return { decision, created: !existing, added };
    });
  }
  async openDecision(input: NewHumanDecision): Promise<HumanDecision> {
    const decision = this.validateDecision(input);
    // Reserve every block atomically before touching the OS. No partial decision or suspension
    // is visible, and neither a sweeper nor a worker may change these Task generations.
    const reservations = await this.write(() => {
      if (this.getHumanDecision(decision.id)) throw new Error('Decision already exists');
      const tasks = decision.blocks.map((key) => {
        this.assertNotRecovering(key);
        const task = this.getTask(key);
        if (!task || ['DONE', 'FAILED_FINAL', 'CANCELLED', 'WAITING_HUMAN'].includes(task.status))
          throw new Error('Task cannot wait for a human: ' + key);
        // Expired/incomplete active leases must follow normal recovery, including attempts.
        if (['LEASED', 'RUNNING'].includes(task.status)) this.owned(key, task.lease_owner ?? '');
        return task;
      });
      return tasks.map((task) => ({
        task,
        token: this.reserve(task, decision.id, decision.requestedBy),
      }));
    });
    try {
      for (const { task, token } of reservations) await this.terminate(task, token);
      return await this.write(() => {
        const states: Record<string, TaskStatus> = Object.create(null) as Record<
          string,
          TaskStatus
        >;
        for (const { task: candidate, token } of reservations) {
          const task = this.reservedTask(candidate.key, token);
          states[task.key] = task.status;
          this.decisionTask(task, 'WAITING_HUMAN', decision.requestedBy, decision.id, token);
          this.clearReservation(task.key, token);
        }
        this.db
          .prepare(
            'INSERT INTO human_decisions (project_id,key,question,answer,actor,decided_at,escalation,previous_states) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            this.projectId,
            decision.id,
            decision.context,
            '',
            decision.requestedBy,
            '',
            JSON.stringify(decision),
            JSON.stringify(states),
          );
        return decision;
      });
    } catch (error) {
      // OS effects cannot roll back. Retain all tokens until the operator reconciles them.
      for (const { task, token } of reservations)
        await this.recoveryFailure(task.key, token, error);
      throw error;
    }
  }
  async resolveDecision(
    id: string,
    answer: string | null,
    actor: string,
    beforeCommit: () => void,
  ): Promise<HumanDecision> {
    return this.finishDecision(id, answer, actor, beforeCommit, false);
  }
  async reconcileDecision(
    id: string,
    answer: string,
    actor: string,
    beforeCommit: () => void,
  ): Promise<HumanDecision> {
    return this.finishDecision(id, answer, actor, beforeCommit, true);
  }
  private finishDecision(
    id: string,
    answer: string | null,
    actor: string,
    beforeCommit: () => void,
    reconcile: boolean,
  ): Promise<HumanDecision> {
    return this.write(() => {
      const row = this.db
        .prepare(
          'SELECT escalation,previous_states FROM human_decisions WHERE project_id = ? AND key = ?',
        )
        .get(this.projectId, id);
      if (!row?.escalation) throw new Error('Unknown structured decision');
      const decision = JSON.parse(row.escalation as string) as HumanDecision;
      if (decision.status !== (reconcile ? 'expired' : 'open'))
        throw new Error('Decision is closed');
      if (reconcile && answer === null) throw new Error('Reconciliation requires a human answer');
      if (answer !== null && !decision.options.some((o) => o.id === answer))
        throw new Error('Answer must be a listed option');
      const states = JSON.parse(row.previous_states as string) as Record<string, TaskStatus>;
      for (const [key, status] of Object.entries(states)) {
        this.assertNotRecovering(key);
        const task = this.getTask(key);
        if (!task || task.status !== 'WAITING_HUMAN') throw new Error('Blocked task state changed');
        if (
          answer !== null &&
          this.db
            .prepare(
              'SELECT 1 FROM executions WHERE project_id = ? AND task_key = ? AND pid IS NOT NULL AND tree_closed_at IS NULL LIMIT 1',
            )
            .get(this.projectId, key)
        )
          throw new Error('Blocked task has Executions pending closure');
        // Expiry is not a human answer: retain the gate until explicit recovery.
        // A human answer is no lease owner and starts no Execution. Active work must re-claim.
        if (answer !== null)
          this.decisionTask(
            task,
            ['LEASED', 'RUNNING'].includes(status) ? 'READY' : status,
            actor,
            reconcile ? `${WORKSTORE_RECONCILE_REASON_PREFIX}${id}` : id,
          );
      }
      decision.status = answer === null ? 'expired' : 'answered';
      decision.answer = answer;
      decision.answeredBy = answer === null ? null : actor;
      decision.answeredAt = answer === null ? null : new Date().toISOString();
      this.db
        .prepare(
          'UPDATE human_decisions SET escalation = ?, answer = ?, actor = ?, decided_at = ? WHERE project_id = ? AND key = ?',
        )
        .run(
          JSON.stringify(decision),
          answer ?? '',
          actor,
          decision.answeredAt ?? '',
          this.projectId,
          id,
        );
      beforeCommit();
      return decision;
    });
  }
  close(): void {
    clearInterval(this.sweeper);
    this.closed = true;
    this.db.close();
  }
}
