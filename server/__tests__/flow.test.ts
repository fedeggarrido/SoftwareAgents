import { describe, expect, it } from 'vitest';

import { parseProjects, projectConfigError } from '../src/configPersistence.js';
import {
  distribution,
  type FlowEvent,
  flowMetrics,
  wipConflict,
  wipSnapshot,
} from '../src/flow.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

describe('registered flow', () => {
  it('validates optional positive integer operator WIP limits', () => {
    const base = { autonomyLevel: 'A1', allowedExecutors: ['claude'] };
    expect(parseProjects({ p: { ...base, wip: { running: 2, review: 3 } } }).p.wip).toEqual({
      running: 2,
      review: 3,
    });
    expect(parseProjects({ p: base }).p.wip).toBeUndefined();
    for (const running of [0, -1, 1.5, '2']) {
      const projects = parseProjects({ p: { ...base, wip: { running } } });
      expect(projectConfigError(projects, 'p')).toBeDefined();
    }
  });
  const timestamp = (hour: number) => new Date(Date.UTC(2026, 0, 1, hour)).toISOString();
  it('computes exact median and nearest-rank p85, and reports unknown tasks', () => {
    const tasks = [1, 2, 3, 4].map((n) => ({
      key: `T${n}`,
      status: 'DONE',
      feature_key: 'FEAT-001',
    }));
    const events: FlowEvent[] = tasks.flatMap((task, i) => [
      { task_key: task.key, from_status: 'LEASED', to_status: 'RUNNING', created_at: timestamp(0) },
      {
        task_key: task.key,
        from_status: 'RUNNING',
        to_status: 'REVIEW',
        created_at: timestamp(i + 1),
      },
      { task_key: task.key, from_status: 'REVIEW', to_status: 'QA', created_at: timestamp(i + 2) },
      { task_key: task.key, from_status: 'QA', to_status: 'DONE', created_at: timestamp(i + 3) },
    ]);
    const result = flowMetrics(
      [...tasks, { key: 'unknown', status: 'DONE', feature_key: null }],
      events,
    );
    expect(result.cycle).toEqual({ n: 4, medianMs: 16200000, p85Ms: 21600000 });
    expect(result.reviewWait).toEqual({ n: 4, medianMs: 7200000, p85Ms: 7200000 });
    expect(result.throughput).toEqual({ '2026-01-01': 4 });
    expect(result.unknown).toContainEqual({ task: 'unknown', metric: 'cycle' });
    expect(distribution([])).toEqual({ n: 0, medianMs: null, p85Ms: null });
  });
  it('ages WIP from the last actual entry, includes current human waiting', () => {
    const result = flowMetrics(
      [{ key: 'T', status: 'WAITING_HUMAN', feature_key: null }],
      [
        {
          task_key: 'T',
          from_status: 'RUNNING',
          to_status: 'WAITING_HUMAN',
          created_at: timestamp(1),
        },
        {
          task_key: 'T',
          from_status: 'WAITING_HUMAN',
          to_status: 'WAITING_HUMAN',
          created_at: timestamp(2),
        },
      ],
      Date.parse(timestamp(3)),
    );
    expect(result.wipAge.medianMs).toBe(7200000);
    expect(result.reviewWait.medianMs).toBe(7200000);
    expect(result.tasks[0].wipAgeMs).toBe(7200000);
  });
  it('counts DAG review work and each feature awaiting merge once; absent limits admit', () => {
    const tasks = [
      { key: 'T1', status: 'REVIEW', feature_key: 'F1', declaration: '{}' },
      { key: 'T2', status: 'QA', feature_key: 'F1', declaration: '{}' },
      { key: 'T3', status: 'DONE', feature_key: 'F2', declaration: '{}' },
      { key: 'T4', status: 'DONE', feature_key: 'F2', declaration: '{}' },
      // Spec/design documents stay in REVIEW after merge and never count.
      { key: 'F1', status: 'REVIEW', feature_key: 'F1', declaration: null },
      { key: 'F1-DESIGN', status: 'REVIEW', feature_key: 'F1' },
    ];
    const store = {
      listTasks: () => tasks,
      getFeatureRun: (key: string) =>
        key === 'F2' ? { state: { status: 'ready_to_merge', head: 'sha' } } : undefined,
    } as unknown as WorkStore;
    expect(wipConflict(store, 'new')).toBeNull();
    expect(wipConflict(store, 'new', { review: 3 })).toBe(
      'WIP limit: review 3/3 (F2 (merge), T1, T2)',
    );
    expect(wipConflict(store, 'new', { review: 3 }, new Set(['sha']))).toBeNull();
    expect(wipSnapshot(tasks, new Set(['F2'])).review.tasks).toHaveLength(3);
  });
  it('counts a live pre-lease reservation against running, but releases terminal work', () => {
    const task = { key: 'T1', feature_key: 'F1', status: 'READY', declaration: '{}' };
    const store = {
      listTasks: () => [task],
      getFeatureRun: () => ({
        owner: 'owner',
        pid: process.pid,
        state: { status: 'running', zoneHold: 'T1' },
      }),
    } as unknown as WorkStore;
    expect(wipConflict(store, 'T2', { running: 1 })).toBe('WIP limit: running 1/1 (T1)');
    task.status = 'DONE';
    expect(wipConflict(store, 'T2', { running: 1 })).toBeNull();
  });
});
