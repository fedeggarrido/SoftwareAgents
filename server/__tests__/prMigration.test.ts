import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { parsePullRequest, PullRequestMonitor } from '../src/prMonitor.js';
import { runMigrations } from '../src/workstore/migrations.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});
let root: string;
let work: WorkStore | undefined;
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const ref = 'https://github.com/example/project/pull/42';
afterEach(() => {
  work?.close();
  work = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each([17, 18, 19])(
  'migrates populated v%s, preserving rows, event IDs and append-only guards across reopening',
  async (version) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-migration-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-config'));
    execFileSync('git', ['init', root], { windowsHide: true, stdio: 'pipe' });
    fs.mkdirSync(path.join(root, '.git/softwareagents'));
    const file = path.join(root, '.git/softwareagents/work.sqlite3');
    const db = new DatabaseSync(file);
    try {
      db.exec(fixture('workstore-v17.sql'));
      db.exec(`PRAGMA foreign_keys = ON;
      INSERT INTO projects VALUES ('p', '2026-01-01');
      INSERT INTO features VALUES ('p','FEAT-001','feature.md','sha','approved','Feature','2026-01-01');
      INSERT INTO tasks (project_id,feature_key,key,type,status,priority,version,attempt,max_attempts,pr_ref,created_at,updated_at,review_ref)
      VALUES ('p','FEAT-001','task','implementation','REVIEW',1,4,0,3,'legacy-branch','2026-01-01','2026-01-01','{"branch":"task","sha":"sha","base":"base"}');
      INSERT INTO tasks (project_id,key,type,status,priority,version,attempt,max_attempts,created_at,updated_at)
      VALUES ('p','dependency','implementation','DONE',1,1,0,3,'2026-01-01','2026-01-01');
      INSERT INTO task_dependencies VALUES ('p','task','dependency');
      INSERT INTO domain_events VALUES (41,'p','task','TASK_TRANSITIONED','RUNNING','REVIEW',4,0,'Execution finished without changes','owner','2026-01-01');
      INSERT INTO executions (project_id,key,task_key,agent_template_version,executor,model_id,session_id,started_at,system_prompt_hash,project_brain_sha,task_version,tool_policy_version)
      VALUES ('p','execution','task','v1','codex','test','session','2026-01-01','hash','sha',3,'v1');
      INSERT INTO human_decisions (project_id,key,task_key,execution_key,question,answer,actor,decided_at)
      VALUES ('p','decision','task','execution','Question','Answer','human','2026-01-01');
      INSERT INTO technical_designs VALUES ('p','FEAT-001','design.md','dag.yaml','sha','sha','{}');
      INSERT INTO adr_reservations VALUES ('p','FEAT-001',0,1);
      INSERT INTO idempotency_keys VALUES ('p','operation','COMPLETED','{}','2026-01-01');
      INSERT INTO feature_runs VALUES ('p','FEAT-001',NULL,NULL,'{"status":"ready_to_merge"}',NULL,'2026-01-01');
      INSERT INTO worker_publications VALUES ('p','task','FEAT-001','{"task":"task"}');
      INSERT INTO usage_ledger VALUES ('p','execution','{}');
      INSERT INTO finding_decisions VALUES ('p','execution',0,'{}');`);
      if (version >= 18) {
        db.exec(fixture('workstore-v18-upgrade.sql'));
        db.prepare('UPDATE tasks SET pr_ref = ?, pr_status = ? WHERE key = ?').run(
          ref,
          JSON.stringify(parsePullRequest(fixture('gh/open-green.json'), ref)),
          'task',
        );
        db.exec(fixture('workstore-v18-pr-events.sql'));
      }
      if (version === 19) {
        db.exec(fixture('workstore-v19-upgrade.sql'));
        db.prepare('UPDATE tasks SET pr_observation = ? WHERE key = ?').run(
          JSON.stringify({ lastSuccessAt: 9000, attemptedAt: 10000, error: 'unavailable' }),
          'task',
        );
        db.exec(`INSERT INTO tasks (project_id,key,type,status,priority,version,attempt,max_attempts,blocked_reason,created_at,updated_at)
          VALUES ('p','ci-block','implementation','BLOCKED',1,5,2,3,'CI failed: build','2026-01-01','2026-01-01'),
            ('p','human-block','implementation','BLOCKED',1,5,2,3,'CI failed: build','2026-01-01','2026-01-01'),
            ('p','suspended-ci','implementation','WAITING_HUMAN',1,6,2,3,'CI failed: build','2026-01-01','2026-01-01'),
            ('p','decision-first','implementation','BLOCKED',1,6,2,3,'CI failed: build','2026-01-01','2026-01-01'),
            ('p','ci-first','implementation','BLOCKED',1,7,2,3,'CI failed: build','2026-01-01','2026-01-01'),
            ('p','hidden-human','implementation','BLOCKED',1,6,2,3,'CI failed: build','2026-01-01','2026-01-01'),
            ('p','unknown-state','implementation','BLOCKED',1,6,2,3,'CI failed: build','2026-01-01','2026-01-01'),
            ('p','orphan-ci','implementation','WAITING_HUMAN',1,7,2,3,'CI failed: build','2026-01-01','2026-01-01');
          INSERT INTO human_decisions (project_id,key,question,answer,actor,decided_at,previous_states)
          VALUES ('p','decision-gate','Review','review','human','2026-01-01','{"decision-first":"REVIEW"}'),
            ('p','ci-gate','Review','review','human','2026-01-01','{"ci-first":"BLOCKED"}'),
            ('p','human-gate','Review','review','human','2026-01-01','{"hidden-human":"BLOCKED"}'),
            ('p','unknown-gate','Review','review','human','2026-01-01','{}'),
            ('p','orphan-gate','Review','review','human','2026-01-01','{"orphan-ci":"REVIEW"}');
          INSERT INTO domain_events (project_id,task_key,type,from_status,to_status,task_version,attempt,reason,actor,created_at)
          VALUES ('p','ci-block','TASK_TRANSITIONED','REVIEW','BLOCKED',5,2,'CI failed: build','pr-monitor','2026-01-01'),
            ('p','human-block','TASK_TRANSITIONED','RUNNING','BLOCKED',5,2,'CI failed: build','worker','2026-01-01'),
            ('p','suspended-ci','TASK_TRANSITIONED','REVIEW','BLOCKED',5,2,'CI failed: build','pr-monitor','2026-01-01'),
            ('p','suspended-ci','TASK_TRANSITIONED','BLOCKED','WAITING_HUMAN',6,2,'gate','system','2026-01-01'),
            ('p','decision-first','TASK_TRANSITIONED','REVIEW','WAITING_HUMAN',5,2,'decision-gate','system','2026-01-01'),
            ('p','decision-first','TASK_TRANSITIONED','WAITING_HUMAN','BLOCKED',6,2,'CI failed: build','pr-monitor','2026-01-01'),
            ('p','ci-first','TASK_TRANSITIONED','REVIEW','BLOCKED',5,2,'CI failed: build','pr-monitor','2026-01-01'),
            ('p','ci-first','TASK_TRANSITIONED','BLOCKED','WAITING_HUMAN',6,2,'ci-gate','system','2026-01-01'),
            ('p','ci-first','TASK_TRANSITIONED','WAITING_HUMAN','BLOCKED',7,2,'ci-gate','human','2026-01-01'),
            ('p','hidden-human','TASK_TRANSITIONED','READY','BLOCKED',4,2,'Human hold','human','2026-01-01'),
            ('p','hidden-human','TASK_TRANSITIONED','BLOCKED','WAITING_HUMAN',5,2,'human-gate','system','2026-01-01'),
            ('p','hidden-human','TASK_TRANSITIONED','WAITING_HUMAN','BLOCKED',6,2,'CI failed: build','pr-monitor','2026-01-01'),
            ('p','unknown-state','TASK_TRANSITIONED','REVIEW','WAITING_HUMAN',5,2,'unknown-gate','system','2026-01-01'),
            ('p','unknown-state','TASK_TRANSITIONED','WAITING_HUMAN','BLOCKED',6,2,'CI failed: build','pr-monitor','2026-01-01'),
            ('p','orphan-ci','TASK_TRANSITIONED','REVIEW','WAITING_HUMAN',5,2,'orphan-gate','system','2026-01-01'),
            ('p','orphan-ci','TASK_TRANSITIONED','WAITING_HUMAN','BLOCKED',6,2,'CI failed: build','pr-monitor','2026-01-01'),
            ('p','orphan-ci','TASK_TRANSITIONED','BLOCKED','WAITING_HUMAN',7,2,'manual_retry: CI fixed','human','2026-01-01');`);
        db.prepare('UPDATE human_decisions SET escalation = ? WHERE key = ?').run(
          JSON.stringify({
            id: 'orphan-gate',
            context: 'Review change',
            options: [
              { id: 'review', label: 'Review', benefit: 'Confidence', cost: 'Time', risk: 'Delay' },
            ],
            recommendation: 'Review',
            disagreement: [],
            impact: 'Review needed',
            urgency: 'high',
            requestedBy: 'system',
            status: 'answered',
            blocks: ['orphan-ci'],
            answer: 'review',
            answeredBy: 'human',
            answeredAt: '2026-01-01',
          }),
          'orphan-gate',
        );
      }
    } finally {
      db.close();
    }
    work = await openWorkStore({ repositoryPath: root, projectId: 'p' });
    expect(work.getTask('task')).toMatchObject({
      status: 'REVIEW',
      version: version === 17 ? 4 : 6,
      pr_ref: version === 17 ? 'legacy-branch' : ref,
      review_ref: { sha: 'sha' },
      pr_observation:
        version === 19 ? { lastSuccessAt: 9000, attemptedAt: 10000, error: 'unavailable' } : null,
      ci_restore_status: null,
      pr_binding_generation: 0,
      pr_poll_generation: 0,
      pr_observed_generation: 0,
    });
    expect(work.listDomainEvents()[0]).toMatchObject({ id: 41, type: 'TASK_TRANSITIONED' });
    if (version >= 18) {
      expect(work.listDomainEvents('task').slice(1)).toMatchObject([
        { id: 42, type: 'PR_UPDATED', task_version: 5 },
        { id: 43, type: 'PR_UPDATED', task_version: 6 },
      ]);
    }
    if (version === 19) {
      expect(work.getTask('ci-block')).toMatchObject({
        status: 'BLOCKED',
        version: 5,
        attempt: 2,
        ci_restore_status: 'REVIEW',
      });
      expect(work.getTask('human-block')).toMatchObject({
        status: 'BLOCKED',
        version: 5,
        attempt: 2,
        ci_restore_status: null,
      });
      expect(work.getTask('suspended-ci')).toMatchObject({
        status: 'WAITING_HUMAN',
        version: 6,
        ci_restore_status: 'REVIEW',
      });
      const audit = vi.fn();
      await work.retryTask('ci-block', 5, 'CI repaired', audit);
      expect(work.getTask('ci-block')).toMatchObject({
        status: 'REVIEW',
        version: 6,
        attempt: 2,
        ci_restore_status: null,
      });
      await expect(work.retryTask('human-block', 5, 'Try again', audit)).rejects.toThrow();
      expect(audit).toHaveBeenCalledTimes(1);
      for (const key of ['hidden-human', 'unknown-state']) {
        const held = work.getTask(key)!;
        expect(held).toMatchObject({ status: 'BLOCKED', ci_restore_status: null });
        await expect(work.retryTask(key, held.version, 'CI fixed', audit)).rejects.toThrow();
        expect(work.getTask(key)).toEqual(held);
      }
      expect(audit).toHaveBeenCalledTimes(1);
      expect(work.getTask('orphan-ci')).toMatchObject({
        status: 'WAITING_HUMAN',
        version: 7,
        ci_restore_status: 'REVIEW',
        feature_key: null,
      });
      await work.retryTask('orphan-ci', 7, 'CI fixed', audit);
      expect(work.getTask('orphan-ci')).toMatchObject({
        status: 'REVIEW',
        version: 8,
        attempt: 2,
        ci_restore_status: null,
      });
      expect(work.listDomainEvents('orphan-ci').at(-1)).toMatchObject({
        from_status: 'WAITING_HUMAN',
        to_status: 'REVIEW',
        actor: 'human',
      });
      for (const key of ['decision-first', 'ci-first']) {
        const blocked = work.getTask(key)!;
        expect(blocked).toMatchObject({ status: 'BLOCKED', ci_restore_status: 'REVIEW' });
        await work.retryTask(key, blocked.version, 'CI repaired', () => {});
        expect(work.getTask(key)).toMatchObject({
          status: 'REVIEW',
          ci_restore_status: null,
          attempt: 2,
        });
      }
    }
    expect(work.listTaskDependencies('task')[0].depends_on_key).toBe('dependency');
    expect(work.getExecution('execution')!.session_id).toBe('session');
    expect(work.getHumanDecision('decision')!.answer).toBe('Answer');
    work.close();
    work = undefined;
    work = await openWorkStore({ repositoryPath: root, projectId: 'p' });
    await work.bindPullRequest('task', work.getTask('task')!.version, ref);
    await new PullRequestMonitor({
      repositoryPath: root,
      projectId: 'p',
      read: async () => fixture('gh/merged.json'),
    }).tick();
    expect(work.listDomainEvents().at(-1)!.id).toBeGreaterThan(version === 17 ? 41 : 43);
    expect(work.getTask('task')!.version).toBe(version === 17 ? 4 : 6);
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare('SELECT version FROM schema_version').get()!.version).toBe(21);
      expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => check.exec("UPDATE domain_events SET reason = '' WHERE id = 41")).toThrow(
        'append-only',
      );
      expect(() => check.exec('DELETE FROM domain_events WHERE id = 41')).toThrow('append-only');
      const insert = check.prepare(
        "INSERT INTO domain_events (project_id,task_key,type,from_status,to_status,task_version,attempt,reason,actor,created_at) VALUES ('p','task',?,'REVIEW','REVIEW',4,0,'','test','2026-01-04')",
      );
      // Both PR kinds may share a version with each other and its existing transition.
      insert.run('PR_UPDATED');
      insert.run('PR_MERGED');
      expect(
        check
          .prepare(
            "SELECT type FROM domain_events WHERE task_version = 4 AND (id = 41 OR actor = 'test') ORDER BY id",
          )
          .all(),
      ).toEqual([{ type: 'TASK_TRANSITIONED' }, { type: 'PR_UPDATED' }, { type: 'PR_MERGED' }]);
      expect(() => insert.run('TASK_TRANSITIONED')).toThrow('UNIQUE');
      expect(() => insert.run('UNKNOWN')).toThrow('CHECK');
      for (const table of [
        'technical_designs',
        'adr_reservations',
        'idempotency_keys',
        'feature_runs',
        'worker_publications',
        'usage_ledger',
        'finding_decisions',
      ]) {
        expect(check.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count).toBe(1);
      }
    } finally {
      check.close();
    }
  },
);

it.each([17, 18])('rolls back every schema change when migration from v%s fails', (version) => {
  // This test needs no repository or profile writes.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-migration-rollback-'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(fixture('workstore-v17.sql'));
    if (version === 18) db.exec(fixture('workstore-v18-upgrade.sql'));
    // A collision forces failure after migration has begun altering the schema.
    db.exec('CREATE TABLE domain_events_transition_version (sentinel TEXT) STRICT');
    const before = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    expect(() => runMigrations(db)).toThrow('domain_events_transition_version');
    expect(db.prepare('SELECT version FROM schema_version').get()!.version).toBe(version);
    expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      before,
    );
    db.exec('BEGIN; ROLLBACK');
  } finally {
    db.close();
  }
});

it('rolls back v20 atomically on a populated v19 schema collision', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-v20-rollback-'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(fixture('workstore-v17.sql'));
    db.exec(fixture('workstore-v18-upgrade.sql'));
    db.exec(fixture('workstore-v19-upgrade.sql'));
    db.exec(
      "INSERT INTO projects (project_id,created_at) VALUES ('p','2026-01-01'); ALTER TABLE tasks ADD COLUMN pr_binding_generation INTEGER;",
    );
    const before = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    expect(() => runMigrations(db)).toThrow('pr_binding_generation');
    expect(db.prepare('SELECT version FROM schema_version').get()!.version).toBe(19);
    expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      before,
    );
    expect(db.prepare('SELECT * FROM projects').all()).toHaveLength(1);
  } finally {
    db.close();
  }
});
