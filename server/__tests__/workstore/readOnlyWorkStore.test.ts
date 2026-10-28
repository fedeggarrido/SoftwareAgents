import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { readFeaturesView } from '../../src/featuresView.js';
import { runMigrations } from '../../src/workstore/migrations.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));

describe('read-only WorkStore acceptance', () => {
  it('AC-010 accepts the current schema and rejects older or unknown schemas', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-schema-'));
    let db: DatabaseSync | undefined;
    try {
      const directory = path.join(root, '.git', 'softwareagents');
      fs.mkdirSync(directory, { recursive: true });
      db = new DatabaseSync(path.join(directory, 'work.sqlite3'));
      runMigrations(db);
      const currentVersion = Number(
        db.prepare('SELECT version FROM schema_version WHERE singleton = 1').get()?.version,
      );
      for (const version of [14, 15, currentVersion, currentVersion + 1]) {
        db.prepare('UPDATE schema_version SET version = ?').run(version);
        const result = await readFeaturesView(root, 'P');
        expect(result).toEqual(
          version >= 15 && version <= currentVersion
            ? { status: 'empty', reason: null, features: [] }
            : { status: 'read_error', reason: 'schema_incompatible', features: [] },
        );
      }
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC-006/011 resolves gitdir and commondir; concurrent WAL reads preserve bytes and project isolation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-reader-'));
    let db: DatabaseSync | undefined;
    try {
      const project = path.join(root, 'project');
      const common = path.join(root, 'common');
      const metadata = path.join(common, 'worktrees', 'linked');
      fs.mkdirSync(project);
      fs.mkdirSync(metadata, { recursive: true });
      fs.mkdirSync(path.join(common, 'softwareagents'));
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: ../common/worktrees/linked\n');
      fs.writeFileSync(path.join(metadata, 'commondir'), '../..\n');
      const file = path.join(common, 'softwareagents', 'work.sqlite3');
      db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode = WAL');
      runMigrations(db);
      db.exec(
        "INSERT INTO projects VALUES ('P','now'),('Q','now'); INSERT INTO features(project_id,key,doc_path,git_sha,status,title) VALUES ('P','FEAT-001','/private/doc','sha','approved','P title'),('Q','FEAT-002','/other/doc','sha','approved','Q title')",
      );
      const hashes = () =>
        [file, `${file}-wal`].map((f) =>
          createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
        );
      const before = hashes();
      db.exec('BEGIN IMMEDIATE');
      db.exec("UPDATE features SET title = 'uncommitted' WHERE project_id = 'P'");
      const result = await readFeaturesView(project, 'P');
      expect(result.status).toBe('ok');
      expect(result.features.map((f) => [f.key, f.title])).toEqual([['FEAT-001', 'P title']]);
      expect(JSON.stringify(result)).not.toMatch(/Q title|private|other\/doc/);
      expect((await readFeaturesView(project, 'missing')).status).toBe('empty');
      expect(hashes()).toEqual(before);
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(childProcess.execFileSync).not.toHaveBeenCalled();
      db.exec('ROLLBACK');
      db.exec(
        "INSERT INTO feature_runs(project_id,feature_key,state) VALUES ('P','FEAT-001','broken /private/trace')",
      );
      expect(await readFeaturesView(project, 'P')).toEqual({
        status: 'read_error',
        reason: 'invalid_data',
        features: [],
      });
      db.exec('DROP TABLE technical_designs');
      expect(await readFeaturesView(project, 'P')).toEqual({
        status: 'read_error',
        reason: 'query_failed',
        features: [],
      });
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
