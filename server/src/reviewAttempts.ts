import type { DomainEventRecord, TaskRecord, WorkStore } from './workstore/WorkStore.js';

export const REVIEW_FAILURE_PREFIX = 'Reviewer failed: ';
export const QA_FAILURE_PREFIX = 'QA failed: ';

export function isReviewFailure(reason: string): boolean {
  return [REVIEW_FAILURE_PREFIX, QA_FAILURE_PREFIX].some((prefix) => reason.startsWith(prefix));
}

/** Success supersedes visible diagnostics; the original events remain in the audit history. */
export function isSuccessfulTaskStep(event: DomainEventRecord): boolean {
  return (
    event.type === 'TASK_TRANSITIONED' &&
    (['Reviewer report persisted', 'QA report persisted'].includes(event.reason) ||
      (event.to_status === 'REVIEW' &&
        (event.reason.startsWith('Runtime commit ') ||
          event.reason === 'Execution finished without changes')))
  );
}

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
    .filter((event) => event.type === 'TASK_TRANSITIONED')
    .filter(
      (e) =>
        isReviewFailure(e.reason) ||
        isSuccessfulTaskStep(e) ||
        ['READY', 'FAILED_RETRYABLE'].includes(e.to_status),
    )
    .at(-1);
  return event && isReviewFailure(event.reason)
    ? { reason: event.reason, created_at: event.created_at }
    : null;
}

/** Only validated negative reports consume shared rework rounds; historical infrastructure attempts do not. */
export function reviewReworkRounds(task: TaskRecord): number {
  return (
    (task.review_reports?.filter((r) => r.report.verdict === 'request_changes').length ?? 0) +
    (task.test_reports?.filter((r) => r.report.verdict === 'fail').length ?? 0)
  );
}
