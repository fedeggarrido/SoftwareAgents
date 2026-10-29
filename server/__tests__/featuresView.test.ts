import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { type FeaturesSource, projectFeatures, readFeaturesView } from '../src/featuresView.js';
import { runMigrations } from '../src/workstore/migrations.js';
import { readMainAncestors } from '../src/workstore/readOnlyWorkStore.js';

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

  const ledger = (costUsd: number | null, featureKey: string | null = 'FEAT-001') => ({
    body: JSON.stringify({
      featureKey,
      taskKey: 'FEAT-001-T01',
      costUsd,
      inputTokens: 100,
      cacheReadTokens: 25,
      prompt: '<private-prompt>',
      output: '<private-output>',
      prices: { input: 'private-configured-price' },
      path: 'C:\\private\\file',
      model: 'private-model',
      quotaBefore: 'private-quota',
      executor: 'private-executor',
    }),
  });

  it('FEAT-003 AC-001/002/004/005/007 aggregates only the feature and all DONE tasks', () => {
    const data = fixture();
    data.tasks = ['T01', 'DESIGN'].map((suffix) => ({
      key: `FEAT-001-${suffix}`,
      feature_key: 'FEAT-001',
      status: 'DONE',
    }));
    data.ledger = [ledger(0.1), ledger(0.2), ledger(0.3), ledger(99, null), ledger(88, 'FEAT-002')];
    const cost = projectFeatures(data)[0].cost;
    expect(cost).toEqual({
      executions: 3,
      costKnown: 3,
      costUsd: expect.closeTo(0.6),
      costPerDoneTaskUsd: expect.closeTo(0.3),
      cacheHitRate: 0.25,
    });
    const serialized = JSON.stringify(projectFeatures(data));
    for (const secret of ['private-', 'prompt', 'quotaBefore', 'executor', 'model', 'C:'])
      expect(serialized).not.toContain(secret);
    data.ledger = [ledger(0.3), ledger(0.3), ledger(0.3), ledger(null), ledger(null)];
    expect(projectFeatures(data)[0].cost).toMatchObject({
      executions: 5,
      costKnown: 3,
      costUsd: expect.closeTo(0.9),
    });
    data.tasks = [];
    expect(projectFeatures(data)[0].cost.costPerDoneTaskUsd).toBeNull();
  });

  it('FEAT-003 AC-003 distinguishes unknown, empty and known zero costs', () => {
    const data = fixture();
    data.tasks = [{ key: 'FEAT-001-T01', feature_key: 'FEAT-001', status: 'DONE' }];
    expect(projectFeatures(data)[0].cost).toEqual({
      executions: 0,
      costKnown: 0,
      costUsd: null,
      costPerDoneTaskUsd: null,
      cacheHitRate: null,
    });
    data.ledger = Array.from({ length: 4 }, () => ledger(null));
    expect(projectFeatures(data)[0].cost).toMatchObject({
      executions: 4,
      costKnown: 0,
      costUsd: null,
      costPerDoneTaskUsd: null,
    });
    data.ledger = [
      {
        body: JSON.stringify({
          featureKey: 'FEAT-001',
          taskKey: 'FEAT-001-T01',
          costUsd: 0,
          inputTokens: null,
          cacheReadTokens: null,
        }),
      },
    ];
    expect(projectFeatures(data)[0].cost).toEqual({
      executions: 1,
      costKnown: 1,
      costUsd: 0,
      costPerDoneTaskUsd: 0,
      cacheHitRate: null,
    });
  });

  it('FEAT-003 keeps cache coverage independent and sanitizes overflowing aggregates', () => {
    const data = fixture();
    data.ledger = [
      ledger(1),
      {
        body: JSON.stringify({
          featureKey: 'FEAT-001',
          costUsd: 2,
          inputTokens: null,
          cacheReadTokens: null,
        }),
      },
    ];
    expect(projectFeatures(data)[0].cost).toMatchObject({ costUsd: 3, cacheHitRate: 0.25 });
    data.ledger = [ledger(Number.MAX_VALUE), ledger(Number.MAX_VALUE)];
    expect(projectFeatures(data)[0].cost).toMatchObject({
      executions: 2,
      costKnown: 2,
      costUsd: null,
    });
  });

  it.each([
    'broken',
    '[]',
    'null',
    JSON.stringify({ featureKey: 42 }),
    ...['costUsd', 'inputTokens', 'cacheReadTokens'].flatMap((field) =>
      [-1, '1', false].map((value) =>
        JSON.stringify({
          featureKey: 'FEAT-001',
          costUsd: null,
          inputTokens: null,
          cacheReadTokens: null,
          [field]: value,
        }),
      ),
    ),
  ])('FEAT-003 rejects malformed ledger data: %s', (body) => {
    expect(() => projectFeatures({ ...fixture(), ledger: [{ body }] })).toThrow('invalid_data');
  });

  it('FEAT-003 AC-005/006 scopes ledger reads, preserves DB bytes and supports v15', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-cost-'));
    let db: DatabaseSync | undefined;
    try {
      fs.mkdirSync(path.join(root, '.git', 'softwareagents'), { recursive: true });
      const file = path.join(root, '.git', 'softwareagents', 'work.sqlite3');
      db = new DatabaseSync(file);
      runMigrations(db);
      // This fixture tests read isolation; execution/task storage is not under test.
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(
        "INSERT INTO projects VALUES ('P','now'),('Q','now'); INSERT INTO features(project_id,key,doc_path,git_sha,status,title) VALUES ('P','FEAT-001','doc','sha','approved',NULL),('P','FEAT-002','doc','sha','approved',NULL),('Q','FEAT-001','doc','sha','approved','OTHER_PROJECT_ONLY')",
      );
      const insert = db.prepare('INSERT INTO usage_ledger VALUES (?, ?, ?)');
      for (const [project, id, cost, feature] of [
        ['P', 'a', 1, 'FEAT-001'],
        ['P', 'b', 2, 'FEAT-002'],
        ['P', 'c', 99, null],
        ['Q', 'd', 5, 'FEAT-001'],
      ] as const)
        insert.run(project, id, ledger(cost, feature).body);
      const before = fs.readFileSync(file);
      const result = await readFeaturesView(root, 'P');
      expect(result.status).toBe('ok');
      expect(result.features.map((r) => [r.key, r.cost.costUsd, r.cost.executions])).toEqual([
        ['FEAT-001', 1, 1],
        ['FEAT-002', 2, 1],
      ]);
      expect(JSON.stringify(result)).not.toContain('private-');
      expect(JSON.stringify(result)).not.toContain('OTHER_PROJECT_ONLY');
      const serialized = JSON.parse(JSON.stringify(result)) as typeof result;
      for (const feature of serialized.features)
        expect(Object.keys(feature.cost).sort()).toEqual([
          'cacheHitRate',
          'costKnown',
          'costPerDoneTaskUsd',
          'costUsd',
          'executions',
        ]);
      expect(await readFeaturesView(root, 'P')).toEqual(result);
      const otherProject = await readFeaturesView(root, 'Q');
      expect(otherProject.status).toBe('ok');
      expect(otherProject.features.map((r) => [r.key, r.cost.costUsd, r.cost.executions])).toEqual([
        ['FEAT-001', 5, 1],
      ]);
      expect(fs.readFileSync(file)).toEqual(before);
      db.exec("UPDATE usage_ledger SET body = 'broken' WHERE project_id = 'P'");
      expect(await readFeaturesView(root, 'P')).toEqual({
        status: 'read_error',
        reason: 'invalid_data',
        features: [],
      });
      db.exec('DROP TABLE usage_ledger; UPDATE schema_version SET version = 15');
      const legacyBefore = fs.readFileSync(file);
      const v15 = await readFeaturesView(root, 'P');
      expect(v15.status).toBe('ok');
      expect(v15.features).toHaveLength(2);
      for (const feature of v15.features)
        expect(feature.cost).toEqual({
          executions: 0,
          costKnown: 0,
          costUsd: null,
          costPerDoneTaskUsd: null,
          cacheHitRate: null,
        });
      expect(fs.readFileSync(file)).toEqual(legacyBefore);
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives merged only for a completed DAG with integration ancestry evidence', () => {
    const data = fixture();
    const head = 'a'.repeat(40);
    data.tasks = [
      { key: 'FEAT-001-T01', feature_key: 'FEAT-001', status: 'DONE', declaration: '{}' },
    ];
    data.runs = [{ feature_key: 'FEAT-001', state: { branch: 'sa/FEAT-001-integration', head } }];
    data.mainAncestors = new Set([head]);
    expect(projectFeatures(data)[0].state).toBe('merged');
    data.features[0].status = 'ready_to_merge';
    expect(projectFeatures(data)[0].state).toBe('merged');
    data.mainAncestors = new Set(['b'.repeat(40)]);
    expect(projectFeatures(data)[0].state).toBe('ready_to_merge');
    data.mainAncestors = new Set([head]);
    data.tasks[0].status = 'RUNNING';
    expect(projectFeatures(data)[0].state).toBe('ready_to_merge');
    data.tasks = [];
    expect(projectFeatures(data)[0].state).toBe('ready_to_merge');
  });

  it('reads merge parents, packed refs and linked worktree metadata without processes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-git-'));
    try {
      const common = path.join(root, 'common');
      const gitDir = path.join(common, 'worktrees', 'test');
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir}`);
      fs.writeFileSync(path.join(gitDir, 'commondir'), '../..');
      const commit = (parents: string[]) => {
        const body = Buffer.from(
          `tree ${'0'.repeat(40)}\n${parents.map((sha) => `parent ${sha}\n`).join('')}\nfixture\n`,
        );
        const object = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]);
        const sha = createHash('sha1').update(object).digest('hex');
        const directory = path.join(common, 'objects', sha.slice(0, 2));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, sha.slice(2)), deflateSync(object));
        return sha;
      };
      const integration = commit([]);
      const unrelated = commit(['f'.repeat(40)]);
      const main = commit([unrelated, integration]);
      fs.writeFileSync(path.join(common, 'packed-refs'), `${main} refs/heads/main\n`);
      const ancestors = readMainAncestors(root);
      expect(ancestors.has(main)).toBe(true);
      expect(ancestors.has(integration)).toBe(true);
      expect(ancestors.has('e'.repeat(40))).toBe(false);
      fs.mkdirSync(path.join(common, 'refs', 'heads'), { recursive: true });
      fs.writeFileSync(path.join(common, 'refs', 'heads', 'main'), unrelated);
      expect(readMainAncestors(root).has(integration)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC-010 ignores unrelated legacy data but rejects malformed decisions tied to this feature', () => {
    const data = fixture();
    data.tasks = [{ key: 42, feature_key: null, version: -1 }];
    data.decisions = [{ task_key: 'legacy-task', escalation: 'broken' }];
    expect(projectFeatures(data)).toHaveLength(1);
    data.decisions.push({ task_key: 'FEAT-001', escalation: 'broken' });
    expect(() => projectFeatures(data)).toThrow('invalid_data');
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
