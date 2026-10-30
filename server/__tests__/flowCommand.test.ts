import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { runFlowCommand } from '../src/flowCommand.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { openReadOnlyWorkStore } from '../src/workstore/readOnlyWorkStore.js';

vi.mock('../src/projectConfig.js', () => ({ loadProjectConfig: vi.fn() }));
vi.mock('../src/workstore/readOnlyWorkStore.js', () => ({
  openReadOnlyWorkStore: vi.fn(),
  readMainAncestors: () => new Set(),
}));

describe('flow CLI read projection', () => {
  it('filters metrics by feature and retains project WIP in JSON without writes', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE tasks (project_id, key, status, feature_key, declaration);
      CREATE TABLE domain_events (id, project_id, task_key, from_status, to_status, created_at);
      CREATE TABLE feature_runs (project_id, feature_key, state);
      INSERT INTO tasks VALUES ('p', 'T1', 'RUNNING', 'FEAT-001', '{}'), ('p', 'T2', 'REVIEW', 'FEAT-002', '{}'), ('other', 'secret', 'RUNNING', 'FEAT-001', '{}');
      INSERT INTO domain_events VALUES (1, 'p', 'T1', 'LEASED', 'RUNNING', '2026-01-01T00:00:00Z');
      PRAGMA query_only = ON;`);
    vi.mocked(loadProjectConfig).mockReturnValue({
      project: { id: 'p' },
      repoRoot: 'fixture',
      operator: { wip: { running: 2, review: 3 } },
    } as ReturnType<typeof loadProjectConfig>);
    vi.mocked(openReadOnlyWorkStore).mockReturnValue(db);
    const log = vi.fn();
    await runFlowCommand(['--feature', 'FEAT-001', '--json'], 'fixture', log);
    const result = JSON.parse(log.mock.calls[0][0]);
    expect(result.tasks.map((task: { task: string }) => task.task)).toEqual(['T1']);
    expect(result.wip.running.tasks).toEqual(['T1']);
    expect(result.wip.review.tasks).toEqual(['T2']);
    expect(result.wip.review.limit).toBe(3);
  });
  it.each([['--feature'], ['--json', '--json'], ['--feature', 'bad'], ['--day', '2026-01-01']])(
    'rejects invalid arguments %j',
    async (...args) => {
      await expect(runFlowCommand(args)).rejects.toThrow('Usage: pixel-agents flow');
    },
  );
});
