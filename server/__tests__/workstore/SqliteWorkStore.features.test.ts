import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../src/workstore/migrations.js';
import { openWorkStore } from '../../src/workstore/SqliteWorkStore.js';
import type { FeatureRunState } from '../../src/workstore/WorkStore.js';

vi.mock('../../src/workstore/processRecovery.js', () => ({
  processStartIdentity: vi.fn(async () => 'test-identity'),
  terminateExecutionTree: vi.fn(),
}));

describe('FEAT-002 AC-001/AC-008 persisted feature metadata', () => {
  it('migrates the previous schema without backfilling or changing existing data', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE schema_version (singleton INTEGER PRIMARY KEY, version INTEGER);
        INSERT INTO schema_version VALUES (1, 14);
        CREATE TABLE features (project_id TEXT, key TEXT, doc_path TEXT, git_sha TEXT, status TEXT);
        INSERT INTO features VALUES ('p', 'FEAT-001', 'feature.yaml', 'sha', 'approved');
        CREATE TABLE feature_runs (project_id TEXT, feature_key TEXT, owner TEXT, pid INTEGER, state TEXT, pid_started_at TEXT);
        INSERT INTO feature_runs VALUES ('p', 'FEAT-001', NULL, NULL, '{}', NULL);
        CREATE TABLE tasks (project_id TEXT, key TEXT, PRIMARY KEY(project_id, key));
        CREATE TABLE domain_events (id INTEGER, project_id TEXT, task_key TEXT, type TEXT, from_status TEXT, to_status TEXT, task_version INTEGER, attempt INTEGER, reason TEXT, actor TEXT, created_at TEXT);
        CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON domain_events BEGIN SELECT 1; END;
        CREATE TRIGGER domain_events_no_delete BEFORE DELETE ON domain_events BEGIN SELECT 1; END;`);
      runMigrations(db);
      expect(db.prepare('SELECT * FROM features').get()).toEqual({
        project_id: 'p',
        key: 'FEAT-001',
        doc_path: 'feature.yaml',
        git_sha: 'sha',
        status: 'approved',
        title: null,
        updated_at: null,
      });
      expect(db.prepare('SELECT state, updated_at FROM feature_runs').get()).toEqual({
        state: '{}',
        updated_at: null,
      });
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()?.version).toBe(19);
    } finally {
      db.close();
    }
  });

  it('creates feature titles and advances feature/run activity on writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-metadata-'));
    execFileSync('git', ['init', root], { windowsHide: true, stdio: 'pipe' });
    const store = await openWorkStore({ repositoryPath: root, projectId: 'p' });
    const db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
    const clock = vi.spyOn(Date.prototype, 'toISOString');
    try {
      clock.mockReturnValue('2026-01-01T01:00:00.000Z');
      store.createFeature({
        key: 'FEAT-001',
        title: 'Title',
        doc_path: 'feature.yaml',
        git_sha: 'sha',
        status: 'in_review',
      });
      expect(store.getFeature('FEAT-001')).toMatchObject({
        title: 'Title',
        updated_at: '2026-01-01T01:00:00.000Z',
      });
      clock.mockReturnValue('2026-01-01T02:00:00.000Z');
      await store.approveFeature('FEAT-001', 'sha', () => {});
      expect(store.getFeature('FEAT-001')).toMatchObject({
        status: 'approved',
        updated_at: '2026-01-01T02:00:00.000Z',
      });
      const state: FeatureRunState = {
        branch: 'sa/FEAT-001-integration',
        initial_main: 'sha',
        head: 'sha',
        request: 'run',
        integrated: {},
        attempts: {},
        status: 'running',
      };
      await store.claimFeatureRun('FEAT-001', 'owner', state);
      expect(db.prepare('SELECT updated_at FROM feature_runs').get()?.updated_at).toBe(
        '2026-01-01T02:00:00.000Z',
      );
      clock.mockReturnValue('2026-01-01T03:00:00.000Z');
      await store.saveFeatureRun('FEAT-001', 'owner', { ...state, status: 'WAITING_QUOTA' });
      expect(db.prepare('SELECT updated_at FROM feature_runs').get()?.updated_at).toBe(
        '2026-01-01T03:00:00.000Z',
      );
      clock.mockReturnValue('2026-01-01T04:00:00.000Z');
      await store.releaseFeatureRun('FEAT-001', 'owner');
      expect(db.prepare('SELECT owner, updated_at FROM feature_runs').get()).toMatchObject({
        owner: null,
        updated_at: '2026-01-01T04:00:00.000Z',
      });
    } finally {
      clock.mockRestore();
      store.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
