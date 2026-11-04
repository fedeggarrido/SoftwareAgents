-- Frozen v18 upgrade for testing reopening a genuinely populated v18 database.
ALTER TABLE tasks ADD COLUMN pr_status TEXT;
DROP TRIGGER domain_events_no_update;
DROP TRIGGER domain_events_no_delete;
ALTER TABLE domain_events RENAME TO domain_events_previous;
CREATE TABLE domain_events (
  id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, task_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('TASK_TRANSITIONED','PR_UPDATED','PR_MERGED')),
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, task_version INTEGER NOT NULL,
  attempt INTEGER NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(project_id, task_key, task_version),
  FOREIGN KEY(project_id, task_key) REFERENCES tasks(project_id, key)
) STRICT;
INSERT INTO domain_events SELECT * FROM domain_events_previous;
DROP TABLE domain_events_previous;
CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON domain_events BEGIN SELECT RAISE(ABORT, 'Domain events are append-only'); END;
CREATE TRIGGER domain_events_no_delete BEFORE DELETE ON domain_events BEGIN SELECT RAISE(ABORT, 'Domain events are append-only'); END;
UPDATE schema_version SET version = 18;
