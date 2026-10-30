import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { FLOW_P85 } from './constants.js';
import { isProcessRunning } from './leaseLock.js';
import type { WorkStore } from './workstore/WorkStore.js';

export interface FlowTask {
  key: string;
  status: string;
  feature_key: string | null;
  /** DAG work items carry a declaration; feature spec/design documents do not. */
  declaration?: string | null;
}
export interface FlowEvent {
  task_key: string;
  from_status: string;
  to_status: string;
  created_at: string;
}
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    medianMs: sorted.length
      ? sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2
      : null,
    p85Ms: sorted.length ? sorted[Math.ceil(sorted.length * FLOW_P85) - 1] : null,
  };
}

export function flowMetrics(
  tasks: FlowTask[],
  events: FlowEvent[],
  now = Date.now(),
  ready: ReadonlySet<string> = new Set(),
) {
  const cycle: number[] = [],
    age: number[] = [],
    review: number[] = [];
  const throughput: Record<string, number> = {};
  const unknown: { task: string; metric: string }[] = [];
  const taskMetrics: {
    task: string;
    cycleMs: number | null;
    wipAgeMs: number | null;
    reviewWaitMs: number | null;
  }[] = [];
  for (const task of tasks) {
    const measured = {
      task: task.key,
      cycleMs: null as number | null,
      wipAgeMs: null as number | null,
      reviewWaitMs: null as number | null,
    };
    const history = events
      .filter((e) => e.task_key === task.key && e.from_status !== e.to_status)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const start = history.find((e) => e.to_status === 'RUNNING');
    const done = history.at(-1)?.to_status === 'DONE' ? history.at(-1) : undefined;
    if (task.status === 'DONE') {
      if (done && Number.isFinite(Date.parse(done.created_at))) {
        const day = new Date(done.created_at).toISOString().slice(0, 10);
        throughput[day] = (throughput[day] ?? 0) + 1;
      } else unknown.push({ task: task.key, metric: 'throughput' });
      const duration =
        start && done ? Date.parse(done.created_at) - Date.parse(start.created_at) : NaN;
      if (Number.isFinite(duration) && duration >= 0) {
        cycle.push(duration);
        measured.cycleMs = duration;
      } else unknown.push({ task: task.key, metric: 'cycle' });
    } else unknown.push({ task: task.key, metric: 'cycle' });
    if (
      ['LEASED', 'RUNNING', 'REVIEW', 'QA', 'WAITING_HUMAN'].includes(task.status) ||
      (task.feature_key && ready.has(task.feature_key))
    ) {
      const last = history.at(-1);
      const duration = last?.to_status === task.status ? now - Date.parse(last.created_at) : NaN;
      if (Number.isFinite(duration) && duration >= 0) {
        age.push(duration);
        measured.wipAgeMs = duration;
      } else unknown.push({ task: task.key, metric: 'wipAge' });
    }
    let total = 0,
      known = true,
      observed = false;
    history.forEach((event, index) => {
      if (
        ['REVIEW', 'QA', 'WAITING_HUMAN'].includes(event.from_status) &&
        history[index - 1]?.to_status !== event.from_status
      )
        known = false;
      if (!['REVIEW', 'QA', 'WAITING_HUMAN'].includes(event.to_status)) return;
      observed = true;
      const next = history[index + 1];
      if (next && next.from_status !== event.to_status) known = false;
      const end = next ? Date.parse(next.created_at) : event.to_status === task.status ? now : NaN;
      const duration = end - Date.parse(event.created_at);
      if (!Number.isFinite(duration) || duration < 0) known = false;
      else total += duration;
    });
    if (observed && known) {
      review.push(total);
      measured.reviewWaitMs = total;
    } else unknown.push({ task: task.key, metric: 'reviewWait' });
    taskMetrics.push(measured);
  }
  return {
    cycle: distribution(cycle),
    wipAge: distribution(age),
    reviewWait: distribution(review),
    throughput,
    unknown,
    tasks: taskMetrics,
  };
}

export function wipSnapshot(
  tasks: FlowTask[],
  ready: ReadonlySet<string>,
  limits?: ProjectOperatorConfig['wip'],
) {
  // Only DAG work counts: FEAT-x and FEAT-x-DESIGN documents stay in REVIEW after merge
  // and would otherwise fill the review limit forever.
  const work = tasks.filter((t) => !!t.declaration);
  const running = work.filter((t) => ['LEASED', 'RUNNING'].includes(t.status)).map((t) => t.key);
  const review = [
    ...work.filter((t) => ['REVIEW', 'QA'].includes(t.status)).map((t) => t.key),
    // A feature awaiting the human merge is one review item, not one per DONE task.
    ...[...ready].sort().map((feature) => `${feature} (merge)`),
  ];
  return {
    running: { tasks: running, limit: limits?.running ?? null },
    review: { tasks: review, limit: limits?.review ?? null },
  };
}

/** Called inside the same serialized reservation as zone admission. */
export function wipConflict(
  store: WorkStore,
  task: string,
  limits?: ProjectOperatorConfig['wip'],
  merged: ReadonlySet<string> = new Set(),
): string | null {
  const tasks = store.listTasks();
  const ready = new Set(
    tasks
      .map((t) => t.feature_key)
      .filter((key): key is string => {
        const run = key ? store.getFeatureRun(key) : undefined;
        return !!key && run?.state.status === 'ready_to_merge' && !merged.has(run.state.head);
      }),
  );
  const snapshot = wipSnapshot(tasks, ready, limits);
  // Reservations cover the gap before the worker transitions to LEASED.
  for (const candidate of tasks) {
    if (
      !candidate.feature_key ||
      candidate.key === task ||
      !['READY', 'QUEUED', 'FAILED_RETRYABLE', 'WAITING_QUOTA'].includes(candidate.status) ||
      snapshot.running.tasks.includes(candidate.key)
    )
      continue;
    const run = store.getFeatureRun(candidate.feature_key);
    if (
      run?.owner &&
      run.pid &&
      isProcessRunning(run.pid) &&
      run.state.status === 'running' &&
      run.state.zoneHold === candidate.key &&
      !candidate.review_ref
    )
      snapshot.running.tasks.push(candidate.key);
  }
  for (const kind of ['review', 'running'] as const) {
    const bucket = snapshot[kind];
    if (bucket.limit !== null && bucket.tasks.length >= bucket.limit)
      return `WIP limit: ${kind} ${bucket.tasks.length}/${bucket.limit} (${bucket.tasks.sort().join(', ')})`;
  }
  return null;
}
