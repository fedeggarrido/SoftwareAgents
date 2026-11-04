import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { parsePullRequest, PullRequestMonitor } from '../src/prMonitor.js';
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

it.each([17, 18])(
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
      if (version === 18) {
        db.exec(fixture('workstore-v18-upgrade.sql'));
        db.prepare('UPDATE tasks SET pr_ref = ?, pr_status = ? WHERE key = ?').run(
          ref,
          JSON.stringify(parsePullRequest(fixture('gh/open-green.json'), ref)),
          'task',
        );
        db.exec(
          "UPDATE tasks SET version = 5 WHERE key = 'task'; INSERT INTO domain_events VALUES (42,'p','task','PR_UPDATED','REVIEW','REVIEW',5,0,'','pr-monitor','2026-01-01');",
        );
      }
    } finally {
      db.close();
    }
    work = await openWorkStore({ repositoryPath: root, projectId: 'p' });
    expect(work.getTask('task')).toMatchObject({
      status: 'REVIEW',
      pr_ref: version === 17 ? 'legacy-branch' : ref,
      review_ref: { sha: 'sha' },
      pr_observation: null,
    });
    expect(work.listDomainEvents()[0]).toMatchObject({ id: 41, type: 'TASK_TRANSITIONED' });
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
    expect(work.listDomainEvents().at(-1)!.id).toBeGreaterThan(version === 17 ? 41 : 42);
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare('SELECT version FROM schema_version').get()!.version).toBe(19);
      expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => check.exec("UPDATE domain_events SET reason = '' WHERE id = 41")).toThrow(
        'append-only',
      );
      expect(() => check.exec('DELETE FROM domain_events WHERE id = 41')).toThrow('append-only');
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
