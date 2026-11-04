import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, it } from 'vitest';

import { type FindingDecision, findingPrecision } from '../src/findingPrecision.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';

it('migrates populated v16 with backup, persists human decisions and derives identity from the execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-decisions-'));
  execFileSync('git', ['init', root], { windowsHide: true, stdio: 'pipe' });
  let store = await openWorkStore({ repositoryPath: root, projectId: 'p' });
  const filename = path.join(root, '.git/softwareagents/work.sqlite3');
  try {
    store.createTask({ key: 'T', type: 'code' });
    store.close();
    const db = new DatabaseSync(filename);
    try {
      db.exec(
        'DROP TRIGGER tasks_clear_ci_restore; ALTER TABLE tasks DROP COLUMN ci_restore_status; ALTER TABLE tasks DROP COLUMN ci_restore_blocked_reason; ALTER TABLE tasks DROP COLUMN pr_binding_generation; ALTER TABLE tasks DROP COLUMN pr_poll_generation; ALTER TABLE tasks DROP COLUMN pr_observed_generation; DROP TABLE finding_decisions; ALTER TABLE tasks DROP COLUMN pr_observation; ALTER TABLE tasks DROP COLUMN pr_status; UPDATE schema_version SET version = 16',
      );
      db.prepare(
        `INSERT INTO executions(project_id,key,task_key,agent_template_version,executor,model_id,started_at,system_prompt_hash,project_brain_sha,task_version,tool_policy_version,agent_role) VALUES ('p','E','T','v1','codex','actual-model','2026-01-01','hash','sha',1,'v1','reviewer')`,
      ).run();
      db.prepare('UPDATE tasks SET review_reports = ? WHERE key = ?').run(
        JSON.stringify([
          {
            execution_id: 'E',
            report: {
              verdict: 'approve',
              findings: [
                { severity: 'minor', downgradeReasons: ['missing evidence'] },
                { severity: 'minor' },
              ],
            },
          },
        ]),
        'T',
      );
    } finally {
      db.close();
    }
    store = await openWorkStore({ repositoryPath: root, projectId: 'p' });
    expect(store.getTask('T')?.version).toBe(1);
    expect(
      fs.readdirSync(path.dirname(filename)).some((name) => name.startsWith('work.pre-v17-')),
    ).toBe(true);
    const row: FindingDecision = {
      task: 'T',
      execution: 'E',
      index: 0,
      feature: null,
      role: 'spoof',
      executor: 'spoof',
      model: 'spoof',
      severity: 'major',
      downgradeReasons: [],
      actor: 'human',
      decision: 'accept',
      decidedAt: new Date().toISOString(),
    };
    await store.recordFindingDecision(row);
    await store.recordFindingDecision({
      ...row,
      index: 1,
      decision: 'reject',
      reason: 'Expected behavior',
    });
    await expect(store.recordFindingDecision(row)).rejects.toThrow();
    store.close();
    store = await openWorkStore({ repositoryPath: root, projectId: 'p' });
    const rows = store.listFindingDecisions();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      executor: 'codex',
      model: 'actual-model',
      role: 'reviewer',
      severity: 'minor',
      downgradeReasons: ['missing evidence'],
    });
    expect(findingPrecision(rows).groups[0]).toMatchObject({ n: 2, acceptanceRate: 0.5 });
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
