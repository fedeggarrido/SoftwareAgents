import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { RoleResolver } from '../src/agentRoles.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { projectCharacterDetail, readCharacterDetail } from '../src/characterDetail.js';
import type { AgentState } from '../src/types.js';

describe('character detail allow-list', () => {
  it('reads only the exact project/task/session, including a task without an execution', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'character-detail-'));
    const file = path.join(root, 'work.sqlite3');
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE tasks (project_id, key, status, branch, worktree_ref, pr_ref, declaration);
        CREATE TABLE executions (project_id, key, task_key, session_id, agent_role,
          agent_template_version, executor, model_id, model_tier, model_effort, selection_reason, started_at);
        INSERT INTO tasks VALUES ('p', 'SA-049', 'RUNNING', 'sa/task', '/work', NULL,
          '{"title":"Panel","description":"PRIVATE","actors":["PRIVATE"],"prompt":"PRIVATE"}');
        INSERT INTO executions VALUES ('p', 'e', 'SA-049', 's', 'developer', '1.0.0',
          'codex', 'recorded-model', 'deep', 'high', 'policy', '2026-10-30T10:00:00Z');`);
      expect(readCharacterDetail(file, 'p', 'SA-049', 's')).toMatchObject({
        taskTitle: 'Panel',
        model: 'recorded-model',
        branch: 'sa/task',
        pr: 'desconocido',
      });
      expect(JSON.stringify(readCharacterDetail(file, 'p', 'SA-049', 's'))).not.toContain(
        'PRIVATE',
      );
      expect(readCharacterDetail(file, 'other', 'SA-049', 's')).toBeUndefined();
      expect(readCharacterDetail(file, 'p', 'SA-049', 'other')).toMatchObject({
        taskTitle: 'Panel',
        model: 'desconocido',
      });
      expect(readCharacterDetail(file, 'p', 'absent', 's')).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('assigns task detail only to the newest session in the same project', () => {
    const store = new AgentStateStore();
    store.broadcast = () => {};
    for (const [id, projectId] of [
      [1, 'p'],
      [2, 'p'],
      [3, 'other'],
    ] as const) {
      store.set(id, { id, projectId, sessionId: `s${id}`, jsonlFile: '' } as AgentState);
      store.get(id)!.projectId = projectId;
    }
    const detail = projectCharacterDetail({
      project_id: 'p',
      task_key: 'SA-049',
      task_title: 'Panel',
    });
    const sessions = new Map(
      [1, 2].map((id) => [
        `s${id}`,
        {
          executionId: `e${id}`,
          role: 'developer',
          taskKey: 'SA-049',
          characterDetail: detail,
        },
      ]),
    );
    sessions.set('s3', {
      executionId: 'foreign',
      role: 'developer',
      taskKey: 'SA-049',
      characterDetail: detail,
    });
    new RoleResolver(store, 2000, () => sessions).tick();
    expect(store.get(1)?.role?.characterDetail).toBeUndefined();
    expect(store.get(2)?.role?.characterDetail?.taskKey).toBe('SA-049');
    expect(store.get(3)?.role?.characterDetail).toBeUndefined();
    store.dispose();
  });
  it('projects recorded fields and elapsed time without private payloads', () => {
    const detail = projectCharacterDetail(
      {
        project_id: 'p',
        task_key: 'SA-049',
        task_title: 'Panel',
        status: 'RUNNING',
        execution_role: 'developer',
        executor: 'codex',
        model_id: 'model',
        model_tier: 'deep',
        model_effort: 'high',
        selection_reason: 'recorded choice',
        agent_template_version: '1.0.0',
        started_at: '2026-10-30T10:00:00Z',
        worktree_ref: 'C:\\Users\\someone\\repo\\.worktrees\\SA-049\\',
        branch: 'sa/task',
        log: '/runs/run.jsonl',
        reason: 'PRIVATE',
        actor: 'PRIVATE',
        prompt: 'PRIVATE',
        declaration: '{"description":"PRIVATE"}',
      },
      Date.parse('2026-10-30T10:00:10Z'),
    );
    expect(detail).toMatchObject({
      taskKey: 'SA-049',
      taskTitle: 'Panel',
      elapsed: '10 s',
      executor: 'codex',
      model: 'model',
      tier: 'deep',
      effort: 'high',
      branch: 'sa/task',
      permissions: 'branch_write (techo del rol)',
      spec: 'developer@1.0.0',
      worktree: 'SA-049',
      pr: 'desconocido',
    });
    expect(JSON.stringify(detail)).not.toContain('PRIVATE');
    expect(JSON.stringify(detail)).not.toContain('someone');
    expect(Object.keys(detail)).not.toContain('declaration');
  });
  it('explicitly reports missing facts and never infers from free text', () => {
    expect(
      new Set(
        Object.values(
          projectCharacterDetail({
            detail: 'tarea SA-049',
            prompt: 'developer@1.0.0 branch_write',
            reason: 'secret',
          }),
        ),
      ),
    ).toEqual(new Set(['desconocido']));
    expect(projectCharacterDetail({ status: 'DONE', started_at: '2026-10-30' }).elapsed).toBe(
      'desconocido',
    );
  });
});

it('redacts secrets in titles and never sends absolute log paths', () => {
  const detail = projectCharacterDetail({
    task_title:
      'Fix token=abc123 and AKIAABCDEFGHIJKLMNOP and password: hunter2 and ' + 'a'.repeat(40),
    log: String.raw`C:\Users\someone\.pixel-agents\runs\run.jsonl`,
  });
  expect(detail.taskTitle).not.toMatch(/abc123|AKIA|hunter2|a{40}/);
  expect(detail.log).toBe('run.jsonl');
});
