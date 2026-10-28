import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { type FeaturesSource, projectFeatures, readFeaturesView } from '../src/featuresView.js';
import { runMigrations } from '../src/workstore/migrations.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));

describe('features view acceptance', () => {
  const fixture = (): FeaturesSource => ({
    features: [{ key: 'FEAT-001', status: 'approved' }],
    designs: [],
    tasks: [],
    runs: [],
    decisions: [],
    executions: [],
    events: [],
  });

  it('AC-001 derives design, ready and unknown states; AC-008 breaks ties by key', () => {
    const data = fixture();
    data.features.push(
      { key: 'FEAT-003', status: 'ready_to_merge' },
      { key: 'FEAT-002', status: 'legacy' },
    );
    expect(projectFeatures(data).map((r) => [r.key, r.state, r.rawStatus])).toEqual([
      ['FEAT-001', 'in_design', null],
      ['FEAT-002', 'unknown', 'legacy'],
      ['FEAT-003', 'ready_to_merge', null],
    ]);
  });

  it('AC-004 uses latest execution for the current version and counts other active tasks', () => {
    const data = fixture();
    data.tasks = [1, 2].map((n) => ({
      key: `FEAT-001-T0${n}`,
      feature_key: 'FEAT-001',
      status: 'RUNNING',
      version: 2,
      updated_at: `2026-01-0${n}T00:00:00Z`,
    }));
    data.executions = [
      {
        task_key: 'FEAT-001-T02',
        task_version: 1,
        agent_role: 'qa',
        started_at: '2026-01-03T00:00:00Z',
      },
      {
        task_key: 'FEAT-001-T02',
        task_version: 2,
        agent_role: 'developer',
        started_at: '2026-01-02T00:00:00Z',
      },
    ];
    expect(projectFeatures(data)[0].currentTask).toEqual({
      key: 'FEAT-001-T02',
      step: 'develop',
      others: 1,
    });
  });

  it('AC-005 lists all decisions, quota and QA gates without leaking messages', () => {
    const data = fixture();
    data.features[0].status = 'in_review';
    data.tasks = [
      { key: 'FEAT-001-T01', feature_key: 'FEAT-001', status: 'WAITING_HUMAN' },
      { key: 'FEAT-001-T02', feature_key: 'FEAT-001', status: 'WAITING_QUOTA' },
    ];
    data.decisions = [
      {
        escalation: {
          blocks: ['FEAT-001'],
          context: 'feature-requirements/FEAT-001/1',
          status: 'open',
          answer: 'secret',
        },
      },
      {
        decided_at: '',
        escalation: {
          blocks: ['FEAT-001-T01'],
          context: 'feature-design/FEAT-001-DESIGN/1',
          status: 'expired',
        },
      },
      { escalation: { blocks: ['FEAT-001'], context: 'other', status: 'open' } },
    ];
    data.runs = [
      {
        feature_key: 'FEAT-001',
        state: { status: 'WAITING_HUMAN', message: 'QA not_tested secret' },
      },
    ];
    const row = projectFeatures(data)[0];
    expect(row.gates).toEqual([
      {
        kind: 'requirements_questions',
        task: null,
        expired: false,
        command: 'pixel-agents feature spec FEAT-001 --answers <fichero-de-respuestas>',
      },
      {
        kind: 'design_questions',
        task: 'FEAT-001-T01',
        expired: true,
        command: 'pixel-agents feature design FEAT-001 --answers <fichero-de-respuestas>',
      },
      {
        kind: 'human_decision',
        task: null,
        expired: false,
        command: 'pixel-agents feature show FEAT-001',
      },
      {
        kind: 'quota',
        task: 'FEAT-001-T02',
        expired: false,
        command: 'pixel-agents feature run FEAT-001',
      },
      {
        kind: 'qa_not_tested',
        task: null,
        expired: false,
        command: 'pixel-agents feature run FEAT-001',
      },
    ]);
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('AC-008 includes decisions and domain events; AC-013 redacts display paths', () => {
    const data = fixture();
    data.features[0].title = 'title C:\\private\\file https://host/repo sk-secret';
    data.tasks = [{ key: 'FEAT-001-T01', feature_key: 'FEAT-001' }];
    data.events = [{ task_key: 'FEAT-001-T01', created_at: '2026-01-03T00:00:00Z' }];
    data.decisions = [{ task_key: 'FEAT-001-T01', decided_at: '2026-01-04T00:00:00Z' }];
    const row = projectFeatures(data)[0];
    expect(row.lastActivityAt).toBe('2026-01-04T00:00:00.000Z');
    expect(row.title).toBe('title [redacted] [redacted] [redacted]');
  });
  it('AC-001/002/003/005/007/008 projects only display fields', () => {
    const rows = projectFeatures({
      features: [
        { key: 'FEAT-001', title: '<b>Title</b>', status: 'in_review', updated_at: null },
        { key: 'FEAT-002', title: null, status: 'approved', updated_at: null },
      ],
      designs: [{ feature_key: 'FEAT-002' }],
      tasks: [
        {
          key: 'FEAT-002-T01',
          feature_key: 'FEAT-002',
          status: 'DONE',
          declaration: '{}',
          version: 1,
          review_ref: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          key: 'FEAT-002-T01-D1',
          feature_key: 'FEAT-002',
          status: 'DRAFT',
          declaration: '{}',
          version: 1,
          review_ref: null,
          updated_at: null,
        },
      ],
      runs: [
        {
          feature_key: 'FEAT-002',
          updated_at: null,
          state: {
            active: { task: 'FEAT-002-T01', action: 'review' },
            branch: 'sa/FEAT-002-integration',
            head: 'a'.repeat(40),
          },
        },
      ],
      decisions: [],
      executions: [],
      events: [],
    });
    expect(rows.map((r) => r.key)).toEqual(['FEAT-002', 'FEAT-001']);
    expect(rows[0]).toMatchObject({
      state: 'in_development',
      progress: { done: 1, total: 1 },
      currentTask: { key: 'FEAT-002-T01', step: 'review', others: 0 },
      integration: { branch: 'sa/FEAT-002-integration', sha: 'aaaaaaa' },
    });
    expect(rows[1]).toMatchObject({
      title: '<b>Title</b>',
      state: 'in_review',
      progress: null,
      gates: [{ kind: 'spec_approval', command: 'pixel-agents feature approve FEAT-001' }],
    });
  });

  it('AC-006/009/010/011/013 reads a migrated database without writes or processes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-view-'));
    const { spawn, execFileSync: exec } = await import('node:child_process');
    try {
      expect(await readFeaturesView(root, 'P')).toMatchObject({
        status: 'read_error',
        reason: 'unavailable',
        features: [],
      });
      fs.mkdirSync(path.join(root, '.git', 'softwareagents'), { recursive: true });
      const file = path.join(root, '.git', 'softwareagents', 'work.sqlite3');
      const db = new DatabaseSync(file);
      runMigrations(db);
      db.exec(
        "INSERT INTO projects VALUES ('P', 'now'), ('Q', 'now'); INSERT INTO features(project_id,key,doc_path,git_sha,status,title) VALUES ('Q','FEAT-090','secret-path','sha','approved','other project')",
      );
      const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const before = hash();
      expect(await readFeaturesView(root, 'P')).toEqual({
        status: 'empty',
        reason: null,
        features: [],
      });
      expect(hash()).toBe(before);
      expect(spawn).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      db.exec('UPDATE schema_version SET version = 1');
      expect(await readFeaturesView(root, 'P')).toMatchObject({
        status: 'read_error',
        reason: 'schema_incompatible',
      });
      db.close();
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
