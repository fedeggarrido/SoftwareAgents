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
import { runMigrations } from './migrations.js';
import { retryBusy } from './retryBusy.js';
import type {
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
  ) {}

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
    this.db
      .prepare(`INSERT INTO executions VALUES (${Array(13).fill('?').join(',')})`)
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
      );
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
    this.db.close();
  }
}
