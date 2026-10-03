import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import {
  WORKSTORE_BUSY_TIMEOUT_MS,
  WORKSTORE_DEFAULT_MAX_ATTEMPTS,
  WORKSTORE_INITIAL_TASK_STATUS,
} from '../constants.js';
import { resolveInside } from '../pathGuard.js';
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
  DomainEventRecord,
  ExecutionRecord,
  FeatureRecord,
  HumanDecisionRecord,
  NewTask,
  ProjectRecord,
  TaskDependencyRecord,
  TaskRecord,
  WorkStore,
} from './WorkStore.js';

const execute = promisify(execFile);

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

  private write<T>(operation: () => T): Promise<T> {
    return retryBusy(this.db, performance.now() + WORKSTORE_BUSY_TIMEOUT_MS, () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  private owned(taskId: string, owner: string): TaskRecord {
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

  private terminate(task: TaskRecord): void {
    // A delayed sweeper may run after another process reclaimed the Task.
    // Never terminate Executions registered under that newer incarnation.
    for (const execution of this.listExecutions().filter(
      (e) => e.task_key === task.key && e.task_version <= task.version,
    )) {
      if (execution.pid !== null) terminateExecutionTree(execution.pid, execution.pid_started_at);
    }
  }

  private failLease(task: TaskRecord, reason: string, actor: string): TaskRecord {
    return this.change(
      task.key,
      task.version,
      task.attempt + 1 >= task.max_attempts ? 'FAILED_FINAL' : 'FAILED_RETRYABLE',
      reason,
      actor,
      task.attempt + 1,
    );
  }

  async recoverExpiredLeases(): Promise<TaskRecord[]> {
    const recovered: TaskRecord[] = [];
    let failure: unknown;
    for (const candidate of this.listTasks().filter(
      (task) =>
        ['LEASED', 'RUNNING'].includes(task.status) &&
        task.lease_expires_at !== null &&
        task.lease_expires_at <= new Date().toISOString(),
    )) {
      try {
        // Never hold the SQLite writer lock while querying/killing OS processes.
        this.terminate(candidate);
        const task = await this.write(() => {
          const current = this.getTask(candidate.key)!;
          if (
            current.version !== candidate.version ||
            !current.lease_expires_at ||
            current.lease_expires_at > new Date().toISOString()
          )
            return undefined;
          return this.failLease(current, 'Lease expired', 'lease-sweeper');
        });
        if (task) recovered.push(task);
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
    return recovered;
  }

  async claim(taskId: string, owner: string, ttl = DEFAULT_LEASE_TTL_MS): Promise<TaskRecord> {
    leaseDeadline(owner, ttl);
    await this.recoverExpiredLeases();
    const candidate = this.getTask(taskId);
    if (!candidate) throw new TaskTransitionError(taskId, 'NOT_FOUND');
    if (!['QUEUED', 'READY', 'FAILED_RETRYABLE'].includes(candidate.status))
      throw new TaskTransitionError(taskId, 'INVALID_TRANSITION');
    this.terminate(candidate);
    return this.write(() => {
      let task = this.getTask(taskId);
      if (!task) throw new TaskTransitionError(taskId, 'NOT_FOUND');
      if (task.version !== candidate.version)
        throw new TaskVersionConflictError(taskId, candidate.version, task.version);
      if (!['QUEUED', 'READY', 'FAILED_RETRYABLE'].includes(task.status))
        throw new TaskTransitionError(taskId, 'INVALID_TRANSITION');
      if (task.status === 'FAILED_RETRYABLE')
        task = this.change(taskId, task.version, 'READY', 'Retry lease', owner);
      if (task.status === 'READY')
        task = this.change(taskId, task.version, 'QUEUED', 'Queue lease', owner);
      task = this.change(taskId, task.version, 'LEASED', 'Claim lease', owner);
      this.db
        .prepare(
          'UPDATE tasks SET lease_owner = ?, lease_expires_at = ? WHERE project_id = ? AND key = ? AND version = ?',
        )
        .run(owner, leaseDeadline(owner, ttl), this.projectId, taskId, task.version);
      return this.getTask(taskId)!;
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
    const candidate = this.owned(taskId, owner);
    this.terminate(candidate);
    return this.write(() => {
      const current = this.owned(taskId, owner);
      if (current.version !== candidate.version)
        throw new TaskVersionConflictError(taskId, candidate.version, current.version);
      return this.failLease(current, 'Lease released', owner);
    });
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
        .prepare("INSERT INTO idempotency_keys VALUES (?, ?, 'PENDING', NULL, ?)")
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
      .prepare('INSERT INTO features VALUES (?, ?, ?, ?, ?)')
      .run(this.projectId, feature.key, feature.doc_path, feature.git_sha, feature.status);
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
  createTask(task: NewTask): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO tasks VALUES (${Array(18).fill('?').join(',')})`)
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
    return this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? AND key = ?')
      .get(this.projectId, key) as unknown as TaskRecord | undefined;
  }
  listTasks(): TaskRecord[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY key')
      .all(this.projectId) as unknown as TaskRecord[];
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
  ): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new TaskTransitionError(taskId, 'NOT_FOUND');
    if (task.version !== expectedVersion)
      throw new TaskVersionConflictError(taskId, expectedVersion, task.version);
    if (!isTaskStatus(to) || !isTaskStatus(task.status) || !canTransition(task.status, to))
      throw new TaskTransitionError(taskId, 'INVALID_TRANSITION');
    if (['QUEUED', 'LEASED', 'RUNNING'].includes(to) && !this.canStart(taskId))
      throw new TaskTransitionError(taskId, 'DEPENDENCIES_NOT_DONE');
    if (
      task.lease_owner &&
      ['LEASED', 'RUNNING'].includes(task.status) &&
      (!task.lease_expires_at || task.lease_expires_at <= new Date().toISOString()) &&
      failureAttempt === undefined
    )
      throw new Error('Expired lease must be recovered before transitioning');
    const now = new Date().toISOString();
    const attempt = failureAttempt ?? task.attempt + attemptIncrement(task.status, to);
    const active = ['LEASED', 'RUNNING'].includes(to);
    this.db
      .prepare(
        'UPDATE tasks SET status = ?, version = version + 1, attempt = ?, blocked_reason = ?, updated_at = ?, lease_owner = ?, lease_expires_at = ? WHERE project_id = ? AND key = ? AND version = ?',
      )
      .run(
        to,
        attempt,
        to === 'BLOCKED' ? reason : null,
        now,
        active ? task.lease_owner : null,
        active ? task.lease_expires_at : null,
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
      .prepare('INSERT INTO task_dependencies VALUES (?, ?, ?)')
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
  createExecution(execution: Omit<ExecutionRecord, 'project_id'>): void {
    const task = this.getTask(execution.task_key);
    let identity = execution.pid_started_at ?? null;
    if (task?.lease_owner) {
      this.owned(task.key, task.lease_owner);
      if (execution.task_version !== task.version)
        throw new TaskVersionConflictError(task.key, execution.task_version, task.version);
      if (execution.pid !== null) {
        identity = processStartIdentity(execution.pid);
        if (!identity) throw new Error('Executor died before its identity was recorded');
      }
    }
    // Capture OS identity outside a transaction, then fence the insertion atomically.
    // Recovery on another connection may have advanced the Task during that query.
    const guard = task
      ? " WHERE EXISTS (SELECT 1 FROM tasks WHERE project_id = ? AND key = ? AND version = ? AND lease_owner IS ? AND (lease_owner IS NULL OR (status IN ('LEASED', 'RUNNING') AND lease_expires_at > ?)))"
      : '';
    const result = this.db
      .prepare(`INSERT INTO executions SELECT ${Array(14).fill('?').join(',')}${guard}`)
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
        ...(task
          ? [
              this.projectId,
              task.key,
              execution.task_version,
              task.lease_owner,
              new Date().toISOString(),
            ]
          : []),
      );
    if (result.changes !== 1)
      throw new Error('Task changed or lease expired before Execution registration');
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
      .prepare('INSERT INTO human_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
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
  close(): void {
    clearInterval(this.sweeper);
    this.db.close();
  }
}
