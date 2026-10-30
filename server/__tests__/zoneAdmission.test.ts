import { describe, expect, it } from 'vitest';

import type { FeatureRunRecord, TaskRecord, WorkStore } from '../src/workstore/WorkStore.js';
import { zoneConflict } from '../src/zoneAdmission.js';

function fixture(zone: string) {
  const tasks = ['FEAT-001', 'FEAT-002'].map((key) => ({
    key: `${key}-T01`,
    feature_key: key,
    status: 'READY',
    declaration: JSON.stringify({ changeZones: [zone] }),
  })) as TaskRecord[];
  const runs = Object.fromEntries(
    tasks.map((task, i) => [
      task.feature_key,
      {
        owner: `feature-run-${i}`,
        pid: process.pid,
        state: { status: 'running', startedAt: `2026-10-30T00:00:0${i}Z` },
      },
    ]),
  ) as unknown as Record<string, FeatureRunRecord>;
  const store = { listTasks: () => tasks, getFeatureRun: (key: string) => runs[key] } as WorkStore;
  return { tasks, runs, store };
}
describe('cross-feature admission', () => {
  it('a dead orchestrator (status still running) holds no zones', () => {
    const { tasks, runs, store } = fixture('server/src');
    runs['FEAT-001'].pid = 2 ** 22 + 12345; // no such process
    expect(zoneConflict(store, tasks[1])).toBeNull();
    runs['FEAT-001'].owner = null;
    runs['FEAT-001'].pid = process.pid;
    expect(zoneConflict(store, tasks[1])).toBeNull();
  });
  it('a newer run holding an admitted task blocks a resumed older run', () => {
    const { tasks, runs, store } = fixture('core/asyncapi.yaml');
    runs['FEAT-002'].state.zoneHold = 'FEAT-002-T01';
    expect(zoneConflict(store, tasks[0])).toContain('FEAT-002-T01 of FEAT-002');
  });
  it.each(['server/src', 'core/asyncapi.yaml', 'core/**'])(
    'oldest advances without deadlock for %s',
    (zone) => {
      const { tasks, store } = fixture(zone);
      expect(zoneConflict(store, tasks[0])).toBeNull();
      expect(zoneConflict(store, tasks[1])).toContain(
        'zone conflict: FEAT-001-T01 of FEAT-001 overlaps',
      );
      tasks[0].status = 'DONE';
      expect(zoneConflict(store, tasks[1])).toBeNull();
    },
  );
  it('never preempts already running work, even for an older run', () => {
    const { tasks, store } = fixture('core/asyncapi.yaml');
    tasks[1].status = 'RUNNING';
    expect(zoneConflict(store, tasks[0])).not.toBeNull();
  });
  it('ignores same-feature work and finished runs; includes test zones', () => {
    const { tasks, runs, store } = fixture('server/src');
    tasks[1].declaration = JSON.stringify({ testZones: ['server/**'] });
    expect(zoneConflict(store, tasks[1])).not.toBeNull();
    // A stopped run holds no zones, or a run parked on a human would block others forever.
    for (const status of ['ready_to_merge', 'WAITING_HUMAN', 'failed', 'interrupted']) {
      runs['FEAT-001'].state.status = status;
      expect(zoneConflict(store, tasks[1])).toBeNull();
    }
    runs['FEAT-001'].state.status = 'running';
    tasks[1].feature_key = tasks[0].feature_key;
    expect(zoneConflict(store, tasks[1])).toBeNull();
  });
  it('uses feature keys to break identical creation timestamps', () => {
    const { tasks, runs, store } = fixture('docs/**');
    runs['FEAT-002'].state.startedAt = runs['FEAT-001'].state.startedAt;
    expect(zoneConflict(store, tasks[0])).toBeNull();
    expect(zoneConflict(store, tasks[1])).not.toBeNull();
  });
});
