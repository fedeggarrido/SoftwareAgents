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
  `UPDATE tasks SET status = CASE WHEN status = 'pending' THEN 'DRAFT' ELSE upper(status) END;
  CREATE TRIGGER tasks_status_insert BEFORE INSERT ON tasks WHEN NEW.status NOT IN ('DRAFT','READY','QUEUED','LEASED','RUNNING','REVIEW','QA','DONE','BLOCKED','FAILED_RETRYABLE','FAILED_FINAL','WAITING_HUMAN','WAITING_QUOTA','CANCELLED')
    BEGIN SELECT RAISE(ABORT, 'Invalid Task status'); END;
  CREATE TRIGGER tasks_status_update BEFORE UPDATE OF status ON tasks WHEN NEW.status NOT IN ('DRAFT','READY','QUEUED','LEASED','RUNNING','REVIEW','QA','DONE','BLOCKED','FAILED_RETRYABLE','FAILED_FINAL','WAITING_HUMAN','WAITING_QUOTA','CANCELLED')
    BEGIN SELECT RAISE(ABORT, 'Invalid Task status'); END;
  UPDATE tasks SET status = status;
  CREATE TABLE domain_events (
    id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, task_key TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type = 'TASK_TRANSITIONED'),
    from_status TEXT NOT NULL, to_status TEXT NOT NULL,
    task_version INTEGER NOT NULL, attempt INTEGER NOT NULL,
    reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(project_id, task_key, task_version),
    FOREIGN KEY(project_id, task_key) REFERENCES tasks(project_id, key)
  ) STRICT;
  CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON domain_events
    BEGIN SELECT RAISE(ABORT, 'Domain events are append-only'); END;
  CREATE TRIGGER domain_events_no_delete BEFORE DELETE ON domain_events
    BEGIN SELECT RAISE(ABORT, 'Domain events are append-only'); END;`,
  `ALTER TABLE executions ADD COLUMN pid_started_at TEXT;
  CREATE TABLE idempotency_keys (
    project_id TEXT NOT NULL REFERENCES projects(project_id), key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('PENDING', 'COMPLETED')),
    result TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, key)
  ) STRICT;
  CREATE INDEX tasks_lease_expiry ON tasks(project_id, lease_expires_at)
    WHERE status IN ('LEASED', 'RUNNING');`,
  `CREATE TABLE lease_recoveries (
    project_id TEXT NOT NULL, task_key TEXT NOT NULL, token TEXT NOT NULL,
    task_version INTEGER NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL,
    started_at TEXT NOT NULL, error TEXT,
    PRIMARY KEY(project_id, task_key),
    FOREIGN KEY(project_id, task_key) REFERENCES tasks(project_id, key)
  ) STRICT;
  ALTER TABLE executions ADD COLUMN tree_closed_at TEXT;
  CREATE INDEX executions_task_version ON executions(project_id, task_key, task_version);
  CREATE TRIGGER tasks_active_lease_insert BEFORE INSERT ON tasks
    WHEN NEW.status IN ('LEASED','RUNNING') AND
      (NEW.lease_owner IS NULL OR length(trim(NEW.lease_owner)) = 0 OR NEW.lease_expires_at IS NULL OR julianday(NEW.lease_expires_at) IS NULL)
    BEGIN SELECT RAISE(ABORT, 'Active Task requires a lease'); END;
  CREATE TRIGGER tasks_active_lease_update BEFORE UPDATE ON tasks
    WHEN NEW.status IN ('LEASED','RUNNING') AND
      (NEW.lease_owner IS NULL OR length(trim(NEW.lease_owner)) = 0 OR NEW.lease_expires_at IS NULL OR julianday(NEW.lease_expires_at) IS NULL)
    BEGIN SELECT RAISE(ABORT, 'Active Task requires a lease'); END;`,
  `ALTER TABLE human_decisions ADD COLUMN escalation TEXT;
  ALTER TABLE human_decisions ADD COLUMN previous_states TEXT;`,
  `ALTER TABLE executions ADD COLUMN model_tier TEXT CHECK(model_tier IN ('economy','standard','deep'));
  ALTER TABLE executions ADD COLUMN model_effort TEXT;
  ALTER TABLE executions ADD COLUMN selection_reason TEXT;`,
  `ALTER TABLE tasks ADD COLUMN declaration TEXT;`,
  `CREATE TABLE technical_designs (
    project_id TEXT NOT NULL, feature_key TEXT NOT NULL,
    doc_path TEXT NOT NULL, dag_path TEXT NOT NULL, git_sha TEXT NOT NULL, feature_sha TEXT NOT NULL,
    PRIMARY KEY(project_id, feature_key),
    FOREIGN KEY(project_id, feature_key) REFERENCES features(project_id, key)
  ) STRICT;`,
  `ALTER TABLE technical_designs ADD COLUMN dag_declaration TEXT;
  CREATE TABLE adr_reservations (
    project_id TEXT NOT NULL, feature_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 9999),
    PRIMARY KEY(project_id, feature_key, ordinal),
    UNIQUE(project_id, number),
    FOREIGN KEY(project_id, feature_key) REFERENCES features(project_id, key)
  ) STRICT;`,
  `ALTER TABLE tasks ADD COLUMN review_ref TEXT;`,
  `ALTER TABLE tasks ADD COLUMN review_reports TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE executions ADD COLUMN agent_role TEXT;`,
  `ALTER TABLE tasks ADD COLUMN test_reports TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN defect_context TEXT;`,
  `CREATE TABLE feature_runs (
    project_id TEXT NOT NULL REFERENCES projects(project_id), feature_key TEXT NOT NULL,
    owner TEXT, pid INTEGER, state TEXT NOT NULL,
    PRIMARY KEY(project_id, feature_key)
  ) STRICT;
  CREATE TABLE worker_publications (
    project_id TEXT NOT NULL REFERENCES projects(project_id), task_key TEXT NOT NULL,
    feature_key TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(project_id, task_key)
  ) STRICT;`,
  `ALTER TABLE feature_runs ADD COLUMN pid_started_at TEXT;`,
  `ALTER TABLE features ADD COLUMN title TEXT;
  ALTER TABLE features ADD COLUMN updated_at TEXT;
  ALTER TABLE feature_runs ADD COLUMN updated_at TEXT;`,
  `CREATE TABLE usage_ledger (
    project_id TEXT NOT NULL, execution_key TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(project_id, execution_key),
    FOREIGN KEY(project_id, execution_key) REFERENCES executions(project_id, key)
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS finding_decisions (
    project_id TEXT NOT NULL, execution_key TEXT NOT NULL, finding_index INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY(project_id, execution_key, finding_index),
    FOREIGN KEY(project_id, execution_key) REFERENCES executions(project_id, key)
  ) STRICT;`,
  `ALTER TABLE tasks ADD COLUMN pr_status TEXT;
  DROP TRIGGER domain_events_no_update;
  DROP TRIGGER domain_events_no_delete;
  ALTER TABLE domain_events RENAME TO domain_events_previous;
  CREATE TABLE domain_events (
    id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, task_key TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('TASK_TRANSITIONED', 'PR_UPDATED', 'PR_MERGED')),
    from_status TEXT NOT NULL, to_status TEXT NOT NULL,
    task_version INTEGER NOT NULL, attempt INTEGER NOT NULL,
    reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(project_id, task_key, task_version),
    FOREIGN KEY(project_id, task_key) REFERENCES tasks(project_id, key)
  ) STRICT;
  INSERT INTO domain_events SELECT * FROM domain_events_previous;
  DROP TABLE domain_events_previous;
  CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON domain_events
    BEGIN SELECT RAISE(ABORT, 'Domain events are append-only'); END;
  CREATE TRIGGER domain_events_no_delete BEFORE DELETE ON domain_events
    BEGIN SELECT RAISE(ABORT, 'Domain events are append-only'); END;`,
  `ALTER TABLE tasks ADD COLUMN pr_observation TEXT;
  DROP TRIGGER domain_events_no_update;
  DROP TRIGGER domain_events_no_delete;
  ALTER TABLE domain_events RENAME TO domain_events_previous;
  CREATE TABLE domain_events (
    id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, task_key TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('TASK_TRANSITIONED', 'PR_UPDATED', 'PR_MERGED')),
    from_status TEXT NOT NULL, to_status TEXT NOT NULL,
    task_version INTEGER NOT NULL, attempt INTEGER NOT NULL,
    reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(project_id, task_key) REFERENCES tasks(project_id, key)
  ) STRICT;
  INSERT INTO domain_events SELECT * FROM domain_events_previous;
  DROP TABLE domain_events_previous;
  CREATE UNIQUE INDEX domain_events_transition_version
    ON domain_events(project_id, task_key, task_version) WHERE type = 'TASK_TRANSITIONED';
  CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON domain_events
    BEGIN SELECT RAISE(ABORT, 'Domain events are append-only'); END;
  CREATE TRIGGER domain_events_no_delete BEFORE DELETE ON domain_events
    BEGIN SELECT RAISE(ABORT, 'Domain events are append-only'); END;`,
  `ALTER TABLE tasks ADD COLUMN ci_restore_status TEXT
    CHECK(ci_restore_status IN ('DRAFT','READY','QUEUED','REVIEW','QA','FAILED_RETRYABLE','WAITING_QUOTA'));
  ALTER TABLE tasks ADD COLUMN ci_restore_blocked_reason TEXT;
  ALTER TABLE tasks ADD COLUMN pr_binding_generation INTEGER NOT NULL DEFAULT 0 CHECK(pr_binding_generation >= 0);
  ALTER TABLE tasks ADD COLUMN pr_poll_generation INTEGER NOT NULL DEFAULT 0 CHECK(pr_poll_generation >= 0);
  ALTER TABLE tasks ADD COLUMN pr_observed_generation INTEGER NOT NULL DEFAULT 0 CHECK(pr_observed_generation >= 0);
  -- Recover provenance from the recorded actor, never from human-readable reason text.
  UPDATE tasks SET ci_restore_status = (
    SELECT CASE WHEN event.from_status IN ('DRAFT','READY','QUEUED','REVIEW','QA','FAILED_RETRYABLE','WAITING_QUOTA')
      THEN event.from_status WHEN event.from_status = 'WAITING_HUMAN' THEN (
        SELECT saved.value FROM domain_events AS suspension
        JOIN human_decisions AS decision ON decision.project_id = suspension.project_id AND decision.key = suspension.reason
        JOIN json_each(CASE WHEN json_valid(decision.previous_states) THEN decision.previous_states ELSE '{}' END) AS saved
          ON saved.key = event.task_key
        WHERE suspension.project_id = event.project_id AND suspension.task_key = event.task_key
          AND suspension.type = 'TASK_TRANSITIONED' AND suspension.to_status = 'WAITING_HUMAN'
          AND suspension.task_version = event.task_version - 1
          AND saved.value IN ('DRAFT','READY','QUEUED','REVIEW','QA','FAILED_RETRYABLE','WAITING_QUOTA')
        LIMIT 1
      ) END
    FROM domain_events AS event
    WHERE event.project_id = tasks.project_id AND event.task_key = tasks.key
      AND event.type = 'TASK_TRANSITIONED' AND event.to_status = 'BLOCKED' AND event.actor = 'pr-monitor'
      AND NOT EXISTS (SELECT 1 FROM domain_events AS later
        WHERE later.project_id = event.project_id AND later.task_key = event.task_key
          AND later.type = 'TASK_TRANSITIONED' AND later.id > event.id
          AND later.to_status <> 'WAITING_HUMAN'
          AND NOT (later.from_status = 'WAITING_HUMAN' AND later.to_status = 'BLOCKED'
            AND EXISTS (SELECT 1 FROM human_decisions AS decision
              WHERE decision.project_id = later.project_id
                AND later.reason IN (decision.key, 'Reconcile expired decision: ' || decision.key))))
    ORDER BY event.id DESC LIMIT 1
  ) WHERE status IN ('BLOCKED','WAITING_HUMAN');
  CREATE TRIGGER tasks_clear_ci_restore AFTER UPDATE OF status ON tasks
    WHEN NEW.status NOT IN ('BLOCKED','WAITING_HUMAN') AND NEW.ci_restore_status IS NOT NULL
    BEGIN UPDATE tasks SET ci_restore_status = NULL, ci_restore_blocked_reason = NULL
      WHERE project_id = NEW.project_id AND key = NEW.key; END;`,
  `ALTER TABLE features ADD COLUMN approved_plan_revision TEXT;`,
] as const;

/** Acquire the writer lock before reading the version, including on simultaneous first opens. */
export function runMigrations(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      version INTEGER NOT NULL CHECK(version >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO schema_version (singleton, version) VALUES (1, 0);`);
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
