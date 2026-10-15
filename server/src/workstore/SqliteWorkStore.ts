import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import * as decisionSchema from '../../../core/schemas/human-decision.schema.json';
import type { HumanDecision, NewHumanDecision } from '../../../core/src/humanDecision.js';
import {
  WORKSTORE_BUSY_TIMEOUT_MS,
  WORKSTORE_DEFAULT_MAX_ATTEMPTS,
  WORKSTORE_INITIAL_TASK_STATUS,
  WORKSTORE_RECONCILE_REASON_PREFIX,
} from '../constants.js';
import { resolveInside } from '../pathGuard.js';
import { compileSchema, validateSchema } from '../schemaValidation.js';
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
  LeaseRecoveryRecord,
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
  private closed = false;

  private write<T>(operation: () => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error('WorkStore is closed'));
    return retryBusy(this.db, performance.now() + WORKSTORE_BUSY_TIMEOUT_MS, () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (this.closed) throw new Error('WorkStore is closed');
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
      .prepare('INSERT INTO lease_recoveries VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
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
      if (
        execution.tree_closed_at &&
        (!execution.pid_started_at ||
          (await processStartIdentity(execution.pid!)) !== execution.pid_started_at)
      )
        continue;
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

  private async acquire(
    taskId: string,
    owner: string,
    ttl: number,
    reworkVersion?: number,
  ): Promise<TaskRecord> {
    const reservation = await this.write(() => {
      this.assertNotRecovering(taskId);
      const task = this.getTask(taskId);
      if (!task) throw new TaskTransitionError(taskId, 'NOT_FOUND');
      this.assertNoDecisionGate(taskId);
      if (reworkVersion !== undefined && task.version !== reworkVersion)
        throw new TaskVersionConflictError(taskId, reworkVersion, task.version);
      if (
        !(
          reworkVersion === undefined ? ['QUEUED', 'READY', 'FAILED_RETRYABLE'] : ['REVIEW', 'QA']
        ).includes(task.status)
      )
        throw new TaskTransitionError(taskId, 'INVALID_TRANSITION');
      if (!this.canStart(taskId)) throw new TaskTransitionError(taskId, 'DEPENDENCIES_NOT_DONE');
      return { task, token: this.reserve(task, 'Claim cleanup', owner) };
    });
    const { task: candidate, token } = reservation;
    try {
      await this.terminate(candidate, token);
      return await this.write(() => {
        let task = this.reservedTask(taskId, token);
        if (task.status === 'FAILED_RETRYABLE')
          task = this.change(
            taskId,
            task.version,
            'READY',
            'Retry lease',
            owner,
            undefined,
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
          reworkVersion === undefined ? 'LEASED' : 'RUNNING',
          'Claim lease',
          owner,
          undefined,
          { owner, expires: leaseDeadline(owner, ttl) },
          token,
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
    if (['LEASED', 'RUNNING'].includes(task.status ?? ''))
      throw new Error('Active Task must be acquired through claim or claimRework');
    if (task.lease_owner || task.lease_expires_at)
      throw new Error('New Task cannot import a lease; use claim');
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
    lease?: { owner: string; expires: string },
    token?: string,
  ): TaskRecord {
    this.assertNotRecovering(taskId, token);
    const task = this.getTask(taskId);
    if (!task) throw new TaskTransitionError(taskId, 'NOT_FOUND');
    if (task.version !== expectedVersion)
      throw new TaskVersionConflictError(taskId, expectedVersion, task.version);
    if (!isTaskStatus(to) || !isTaskStatus(task.status) || !canTransition(task.status, to))
      throw new TaskTransitionError(taskId, 'INVALID_TRANSITION');
    this.assertNoDecisionGate(taskId);
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
          `INSERT INTO executions SELECT ${Array(14).fill('?').join(',')}, NULL, ?, ?, ?${guard}`,
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
  private assertNoDecisionGate(taskId: string): void {
    // Expiry retains the gate; only explicit decision resolution/reconciliation releases it.
    if (
      this.listDecisions().some(
        (d) => ['open', 'expired'].includes(d.status) && d.blocks.includes(taskId),
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
