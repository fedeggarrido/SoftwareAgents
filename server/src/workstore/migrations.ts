import type { DatabaseSync } from 'node:sqlite';

const migrations = [
  `CREATE TABLE projects (
    project_id TEXT PRIMARY KEY NOT NULL CHECK(length(project_id) > 0),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE features (
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    key TEXT NOT NULL, doc_path TEXT NOT NULL, git_sha TEXT NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY(project_id, key)
  ) STRICT;
  CREATE TABLE tasks (
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    feature_key TEXT, key TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
    priority INTEGER NOT NULL, agent_role TEXT,
    version INTEGER NOT NULL CHECK(version >= 1), lease_owner TEXT, lease_expires_at TEXT,
    attempt INTEGER NOT NULL CHECK(attempt >= 0),
    max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
    branch TEXT, worktree_ref TEXT, pr_ref TEXT, blocked_reason TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, key),
    FOREIGN KEY(project_id, feature_key) REFERENCES features(project_id, key)
  ) STRICT;
  CREATE TABLE task_dependencies (
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    task_key TEXT NOT NULL, depends_on_key TEXT NOT NULL,
    PRIMARY KEY(project_id, task_key, depends_on_key),
    CHECK(task_key <> depends_on_key),
    FOREIGN KEY(project_id, task_key) REFERENCES tasks(project_id, key),
    FOREIGN KEY(project_id, depends_on_key) REFERENCES tasks(project_id, key)
  ) STRICT;
  CREATE TABLE executions (
    project_id TEXT NOT NULL REFERENCES projects(project_id), key TEXT NOT NULL,
    task_key TEXT NOT NULL, agent_template_version TEXT NOT NULL,
    executor TEXT NOT NULL, model_id TEXT NOT NULL, session_id TEXT, pid INTEGER,
    started_at TEXT NOT NULL, system_prompt_hash TEXT NOT NULL,
    project_brain_sha TEXT NOT NULL, task_version INTEGER NOT NULL CHECK(task_version >= 1),
    tool_policy_version TEXT NOT NULL,
    PRIMARY KEY(project_id, key),
    FOREIGN KEY(project_id, task_key) REFERENCES tasks(project_id, key)
  ) STRICT;
  CREATE TABLE human_decisions (
    project_id TEXT NOT NULL REFERENCES projects(project_id), key TEXT NOT NULL,
    task_key TEXT, execution_key TEXT, question TEXT NOT NULL, answer TEXT NOT NULL,
    actor TEXT NOT NULL, decided_at TEXT NOT NULL,
    PRIMARY KEY(project_id, key),
    FOREIGN KEY(project_id, task_key) REFERENCES tasks(project_id, key),
    FOREIGN KEY(project_id, execution_key) REFERENCES executions(project_id, key)
  ) STRICT;`,
] as const;

/** Acquire the writer lock before reading the version, including on simultaneous first opens. */
export function runMigrations(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      version INTEGER NOT NULL CHECK(version >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO schema_version VALUES (1, 0);`);
    const version = db
      .prepare('SELECT version FROM schema_version WHERE singleton = 1')
      .get()?.version;
    if (typeof version !== 'number' || version > migrations.length) {
      throw new Error('Unsupported WorkStore schema version');
    }
    for (let index = version; index < migrations.length; index++) {
      db.exec(migrations[index]);
      db.prepare('UPDATE schema_version SET version = ? WHERE singleton = 1').run(index + 1);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
