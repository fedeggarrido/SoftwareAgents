import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  DagTask,
  DagTaskType,
  TaskDag,
  TaskDagAnalysis,
  TaskDagIssue,
  TechnicalDesign,
} from '../../core/src/index.js';
import { loadFeatureSpec } from '../src/featureSpec.js';
import { SchemaValidationError } from '../src/schemaValidation.js';
import {
  analyzeTaskDag,
  deferredAcceptanceCoverage,
  parseTaskDag,
  parseTechnicalDesign,
  taskDeclaration,
} from '../src/taskDag.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const spec = {
  key: 'FEAT-001',
  acceptance: ['AC-001', 'AC-002'].map((id) => ({ id, given: 'g', when: 'w', then: 't' })),
};

function task(n: number, dependsOn: number[] = [], acceptanceRefs: string[] = []): DagTask {
  const key = (i: number) => `FEAT-001-T${String(i).padStart(2, '0')}`;
  return {
    key: key(n),
    type: 'code',
    title: `Task ${n}`,
    description: `Implements part ${n}`,
    acceptanceRefs,
    dependsOn: dependsOn.map(key),
    agentRole: 'backend-engineer',
    size: 'M',
  };
}

function dag(...tasks: DagTask[]): TaskDag {
  return { apiVersion: 'softwareagents.io/v1alpha1', kind: 'TaskDAG', feature: 'FEAT-001', tasks };
}

const covered = (...tasks: DagTask[]) => dag(task(99, [], ['AC-001', 'AC-002']), ...tasks);

it('rejects doc-only AC ownership and never defers runtime coverage to docs', () => {
  const doc = { ...task(2, [1], ['AC-001', 'AC-002']), type: 'doc' as const };
  const code = task(1, [], ['AC-001']);
  expect(analyzeTaskDag(dag(code, doc), spec).issues).toContainEqual({
    code: 'doc_only_acceptance',
    task: doc.key,
    acceptanceRef: 'AC-002',
  });
  code.acceptanceRefs.push('AC-002');
  expect(analyzeTaskDag(dag(code, doc), spec).valid).toBe(true);
  expect(deferredAcceptanceCoverage(dag(code, doc), code.key, () => false)).toEqual({
    'AC-001': [],
    'AC-002': [],
  });
  const author = {
    ...task(3, [2], ['AC-001', 'AC-002']),
    type: 'qa' as const,
    agentRole: 'qa-author',
  };
  expect(deferredAcceptanceCoverage(dag(code, doc, author), code.key, () => false)).toEqual({
    'AC-001': [author.key],
    'AC-002': [author.key],
  });
});

describe('TaskDAG schema', () => {
  it('keeps testZones optional, validates their paths and persists their immutable content', () => {
    const base = task(1);
    expect(parseTaskDag(dag(base)).tasks[0].testZones).toBeUndefined();
    for (const zone of ['server/__tests__/audit.test.ts', 'integration/**/*.test.ts'])
      expect(parseTaskDag(dag({ ...base, testZones: [zone] })).tasks[0].testZones).toEqual([zone]);
    for (const zone of ['../outside', 'C:/outside', 'tests\\file', 'tests/{a,b}'])
      expect(() => parseTaskDag(dag({ ...base, testZones: [zone] }))).toThrow(
        SchemaValidationError,
      );
    expect(taskDeclaration('FEAT-001', { ...base, testZones: ['b/', 'a/'] })).toBe(
      taskDeclaration('FEAT-001', { ...base, testZones: ['a/', 'b/'] }),
    );
    expect(taskDeclaration('FEAT-001', { ...base, testZones: ['a/'] })).not.toBe(
      taskDeclaration('FEAT-001', base),
    );
  });
  it('accepts only documented POSIX paths and simple star globs for changeZones', () => {
    for (const zone of [
      'src/file.ts',
      'src/',
      'src/audit*.ts',
      'src/**/*.ts',
      '**/*.ts',
      'src/new-dir/**',
    ])
      expect(() => parseTaskDag(dag({ ...task(1), changeZones: [zone] })), zone).not.toThrow();
    for (const zone of [
      '{..,src}/**',
      '../src',
      'src/../file',
      '/src',
      'C:/src',
      'src\\file',
      'src/{a,b}',
      'src/?.ts',
      'src/[ab].ts',
      'src/**x',
      'src/***',
      './src',
      'src//file',
    ])
      expect(() => parseTaskDag(dag({ ...task(1), changeZones: [zone] })), zone).toThrow(
        SchemaValidationError,
      );
  });

  it('accepts a well-formed DAG and every task type', () => {
    for (const type of ['spec', 'design', 'code', 'review', 'qa', 'doc', 'spike'] as const) {
      expect(parseTaskDag(dag({ ...task(1), type }))).toMatchObject({ feature: 'FEAT-001' });
    }
  });

  it('rejects malformed keys, refs, roles, sizes, types, unknown fields and empty DAGs', () => {
    const base = task(1);
    for (const bad of [
      { ...base, key: 'FEAT-001-T1' },
      { ...base, key: 'FEAT-1-T01' },
      { ...base, dependsOn: ['T02'] },
      { ...base, dependsOn: ['FEAT-001-T02', 'FEAT-001-T02'] },
      { ...base, acceptanceRefs: ['AC-1'] },
      { ...base, agentRole: 'Backend Engineer' },
      { ...base, size: 'XL' },
      { ...base, type: 'deploy' },
      { ...base, title: ' ' },
      { ...base, model: 'claude' },
    ]) {
      expect(() => parseTaskDag(dag(bad as DagTask))).toThrow(SchemaValidationError);
    }
    expect(() => parseTaskDag(dag())).toThrow('/tasks: must NOT have fewer than 1 items');
    expect(() => parseTaskDag({ ...dag(base), kind: 'FeatureSpec' })).toThrow(
      SchemaValidationError,
    );
  });

  it('requires every task field', () => {
    for (const field of Object.keys(task(1))) {
      const value: Record<string, unknown> = { ...task(1) };
      delete value[field];
      expect(() => parseTaskDag(dag(value as unknown as DagTask))).toThrow(
        `/tasks/0/${field}: must have required property`,
      );
    }
  });
});

describe('TechnicalDesign schema', () => {
  const design: TechnicalDesign = {
    apiVersion: 'softwareagents.io/v1alpha1',
    kind: 'TechnicalDesign',
    feature: 'FEAT-001',
    version: '0.1.0',
    status: 'draft',
    components: ['server/src/taskDag.ts'],
    risks: [],
    adrs: ['ADR-0002'],
  };

  it('accepts front matter with every status', () => {
    for (const status of ['draft', 'proposed', 'approved', 'superseded'] as const) {
      expect(parseTechnicalDesign({ ...design, status })).toEqual({ ...design, status });
    }
  });

  it('rejects malformed or missing fields', () => {
    for (const bad of [
      { ...design, feature: 'FEAT-1' },
      { ...design, version: '1' },
      { ...design, status: 'accepted' },
      { ...design, components: [] },
      { ...design, adrs: ['0002'] },
      { ...design, risks: [' '] },
      { ...design, unknown: true },
    ]) {
      expect(() => parseTechnicalDesign(bad)).toThrow(SchemaValidationError);
    }
    for (const field of Object.keys(design)) {
      const value: Record<string, unknown> = { ...design };
      delete value[field];
      expect(() => parseTechnicalDesign(value)).toThrow(`/${field}: must have required property`);
    }
  });
});

describe('analyzeTaskDag', () => {
  it('accepts a covered DAG and computes order and parallel levels', () => {
    const result = analyzeTaskDag(
      dag(task(1, [], ['AC-001']), task(2, [1]), task(3, []), task(4, [2, 3], ['AC-002'])),
      spec,
    );
    expect(result).toEqual({
      valid: true,
      issues: [],
      order: ['FEAT-001-T01', 'FEAT-001-T02', 'FEAT-001-T03', 'FEAT-001-T04'],
      levels: [['FEAT-001-T01', 'FEAT-001-T03'], ['FEAT-001-T02'], ['FEAT-001-T04']],
    });
  });

  it('detects a cycle and reports its path from the earliest-declared task', () => {
    const result = analyzeTaskDag(covered(task(1, [3]), task(2, [1]), task(3, [2])), spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      { code: 'cycle', path: ['FEAT-001-T01', 'FEAT-001-T03', 'FEAT-001-T02', 'FEAT-001-T01'] },
    ]);
    expect(result.order).toBeNull();
    expect(result.levels).toBeNull();
  });

  it('reports self-dependencies and separate cycles', () => {
    const result = analyzeTaskDag(
      covered(task(1, [1]), task(2, [3]), task(3, [2]), task(4, [1])),
      spec,
    );
    expect(result.issues).toEqual([
      { code: 'cycle', path: ['FEAT-001-T01', 'FEAT-001-T01'] },
      { code: 'cycle', path: ['FEAT-001-T02', 'FEAT-001-T03', 'FEAT-001-T02'] },
    ]);
  });

  it('preserves dependency visit order and rotates cycles to declaration order', () => {
    const result = analyzeTaskDag(covered(task(1, [3, 2]), task(2, [3]), task(3, [2, 1, 3])), spec);
    expect(result.issues).toEqual([
      { code: 'cycle', path: ['FEAT-001-T02', 'FEAT-001-T03', 'FEAT-001-T02'] },
      { code: 'cycle', path: ['FEAT-001-T01', 'FEAT-001-T03', 'FEAT-001-T01'] },
      { code: 'cycle', path: ['FEAT-001-T03', 'FEAT-001-T03'] },
    ]);
  });

  it('detects a dependency on a task that does not exist', () => {
    const result = analyzeTaskDag(covered(task(1), task(2, [1, 7])), spec);
    expect(result.issues).toEqual([
      { code: 'dangling_dependency', task: 'FEAT-001-T02', dependsOn: 'FEAT-001-T07' },
    ]);
    expect(result.order).toBeNull();
  });

  it('reports acceptance criteria that no task covers, and unknown references', () => {
    const result = analyzeTaskDag(dag(task(1, [], ['AC-001', 'AC-009'])), spec);
    expect(result.issues).toEqual([
      { code: 'unknown_acceptance', task: 'FEAT-001-T01', acceptanceRef: 'AC-009' },
      { code: 'uncovered_acceptance', acceptanceId: 'AC-002' },
    ]);
    // Coverage gaps do not make the graph unschedulable.
    expect(result).toMatchObject({ valid: false, order: ['FEAT-001-T01'] });
  });

  it('checks coverage against a real FeatureSpec fixture', () => {
    const feature = loadFeatureSpec(
      path.join(root, 'server/__tests__/fixtures/brain/feature-spec.valid.yaml'),
    );
    expect(analyzeTaskDag(dag(task(1)), feature).issues).toEqual(
      feature.acceptance.map(({ id }) => ({ code: 'uncovered_acceptance', acceptanceId: id })),
    );
    expect(analyzeTaskDag(dag(task(1, [], ['AC-001'])), feature).valid).toBe(true);
  });

  it('reports duplicate keys with every position and withholds the order', () => {
    const result = analyzeTaskDag(covered(task(1), task(2), task(1)), spec);
    expect(result.issues).toEqual([
      { code: 'duplicate_key', key: 'FEAT-001-T01', indices: [1, 3] },
    ]);
    expect(result.order).toBeNull();
  });

  it('reports task keys and DAGs that belong to another feature', () => {
    const foreign = { ...task(2), key: 'FEAT-002-T02' };
    const result = analyzeTaskDag(covered(task(1), foreign), { ...spec, key: 'FEAT-003' });
    expect(result.issues).toEqual([
      { code: 'foreign_key', key: 'FEAT-002-T02', feature: 'FEAT-001' },
      { code: 'feature_mismatch', dagFeature: 'FEAT-001', specFeature: 'FEAT-003' },
    ]);
  });

  it('keeps an already sorted input unchanged and breaks ties by declaration order', () => {
    const sorted = covered(task(5), task(3), task(4, [3]), task(1, [5]), task(2));
    const keys = sorted.tasks.map((t) => t.key);
    const result = analyzeTaskDag(sorted, spec);
    expect(result.order).toEqual(keys);
    expect(result.levels).toEqual([
      ['FEAT-001-T99', 'FEAT-001-T05', 'FEAT-001-T03', 'FEAT-001-T02'],
      ['FEAT-001-T04', 'FEAT-001-T01'],
    ]);
  });

  it('places a dependent after its prerequisite even when declared first', () => {
    const result = analyzeTaskDag(covered(task(2, [1]), task(3), task(1)), spec);
    expect(result.order).toEqual(['FEAT-001-T99', 'FEAT-001-T03', 'FEAT-001-T01', 'FEAT-001-T02']);
  });

  it('is deterministic and does not mutate its input', () => {
    const input = covered(task(3, [1, 2]), task(2, [1]), task(1));
    const snapshot = structuredClone(input);
    const first = analyzeTaskDag(input, spec);
    expect(analyzeTaskDag(input, spec)).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(first.levels).toEqual([
      ['FEAT-001-T99', 'FEAT-001-T01'],
      ['FEAT-001-T02'],
      ['FEAT-001-T03'],
    ]);
  });

  it('handles every task key in one feature (100 tasks in a chain)', () => {
    const chain = Array.from({ length: 100 }, (_, i) => task(i, i ? [i - 1] : [], ['AC-001']));
    chain[99].acceptanceRefs.push('AC-002');
    const result = analyzeTaskDag(dag(...chain.reverse()), spec);
    expect(result.valid).toBe(true);
    expect(result.levels).toHaveLength(100);
    expect(result.order![0]).toBe('FEAT-001-T00');
  });

  it('reports foreign keys without overflowing on a schema-valid 10,000-task chain', () => {
    const key = (i: number) =>
      `FEAT-${String(Math.floor(i / 100)).padStart(3, '0')}-T${String(i % 100).padStart(2, '0')}`;
    const chain = Array.from({ length: 10_000 }, (_, i) => ({
      ...task(i % 100, [], ['AC-001', 'AC-002']),
      key: key(i),
      dependsOn: i < 9_999 ? [key(i + 1)] : [],
    }));
    const input = parseTaskDag({ ...dag(...chain), feature: 'FEAT-000' });
    const result = analyzeTaskDag(input, { ...spec, key: 'FEAT-000' });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      chain.slice(100).map(({ key }) => ({ code: 'foreign_key', key, feature: 'FEAT-000' })),
    );
    expect(result.order).toEqual(chain.map(({ key }) => key).reverse());
    expect(result.levels).toHaveLength(10_000);
  });
});

describe('core exports', () => {
  it('exposes the new types without runtime effects', () => {
    expectTypeOf<DagTaskType>().toEqualTypeOf<DagTask['type']>();
    expectTypeOf<TaskDagAnalysis>().toEqualTypeOf<ReturnType<typeof analyzeTaskDag>>();
    expectTypeOf<TaskDagIssue>().toEqualTypeOf<TaskDagAnalysis['issues'][number]>();
    for (const file of ['core/src/taskDag.ts', 'core/src/technicalDesign.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toMatch(/^\s*(export\s+)?(const|let|var|function|class|enum)\b/m);
      expect(source).not.toMatch(/^import(?!\s+type)/m);
    }
  });
});
