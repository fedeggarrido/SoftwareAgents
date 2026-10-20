import type { TaskRecord, WorkStore } from './workstore/WorkStore.js';

export const REVIEW_FAILURE_PREFIX = 'Reviewer failed: ';

/** Legacy failures are resumable only when the last execution belongs to Reviewer. */
export function isFailedReview(store: WorkStore, task: TaskRecord): boolean {
  return (
    !!task.review_ref &&
    task.status === 'FAILED_RETRYABLE' &&
    store
      .listExecutions()
      .filter((e) => e.task_key === task.key)
      .sort((a, b) => a.task_version - b.task_version || a.started_at.localeCompare(b.started_at))
      .at(-1)?.agent_role === 'reviewer'
  );
}

/** Project the durable transition history without adding another mutable status field. */
export function lastReviewFailure(store: WorkStore, task: TaskRecord) {
  const event = store
    .listDomainEvents(task.key)
    .filter((e) => e.reason.startsWith(REVIEW_FAILURE_PREFIX))
    .at(-1);
  return event ? { reason: event.reason, created_at: event.created_at } : null;
}
