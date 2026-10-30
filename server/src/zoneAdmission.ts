import { zonesOverlap } from './changeZones.js';
import { isProcessRunning } from './leaseLock.js';
import type { TaskRecord, WorkStore } from './workstore/WorkStore.js';

export function taskZones(task: Pick<TaskRecord, 'declaration'>): string[] {
  if (!task.declaration) return [];
  const declaration = JSON.parse(task.declaration);
  return [...(declaration.changeZones ?? []), ...(declaration.testZones ?? [])];
}

/** Among executing feature runs, running work keeps ownership; pending work is ordered by
 * run start, then key, so the older run wins and two runs never wait on each other. */
export function zoneConflict(store: WorkStore, task: TaskRecord): string | null {
  if (!task.feature_key) return null;
  const current = store.getFeatureRun(task.feature_key);
  if (!current) return null;
  const order = (key: string) => {
    const run = store.getFeatureRun(key)!;
    return `${run.state.startedAt ?? ''}:${key}`;
  };
  for (const other of store.listTasks().sort((a, b) => a.key.localeCompare(b.key))) {
    if (!other.feature_key || other.feature_key === task.feature_key || other.status === 'DONE')
      continue;
    const run = store.getFeatureRun(other.feature_key);
    // Only a run that is executing holds its zones. A stopped run (WAITING_HUMAN, failed,
    // interrupted, ready_to_merge) would otherwise block every other feature forever;
    // its live branches are still reported by `zones check`.
    if (!run || run.state.status !== 'running') continue;
    // A dead orchestrator keeps status 'running'; only a live owner holds zones.
    if (!run.owner || !run.pid || !isProcessRunning(run.pid)) continue;
    const running =
      ['RUNNING', 'LEASED'].includes(other.status) ||
      run.state.active?.task === other.key ||
      run.state.zoneHold === other.key;
    if (!running && order(other.feature_key) >= order(task.feature_key)) continue;
    for (const zone of taskZones(task))
      if (taskZones(other).some((candidate) => zonesOverlap(zone, candidate)))
        return `zone conflict: ${other.key} of ${other.feature_key} overlaps ${zone}`;
  }
  return null;
}
