import type { ReviewRef, WorkStore } from './workstore/WorkStore.js';

export const TASK_REBASE_REASON = 'Task rebase ';

export interface TaskRebase {
  before: ReviewRef;
  after: ReviewRef;
  oldPatchId: string;
  newPatchId: string;
}

export const sameReviewRef = (a: ReviewRef | null | undefined, b: ReviewRef) =>
  !!a && a.branch === b.branch && a.sha === b.sha && a.base === b.base;

export function taskRebaseHistory(store: WorkStore, key: string): TaskRebase[] {
  return store
    .listDomainEvents(key)
    .flatMap((event) =>
      event.actor === 'operator' && event.reason.startsWith(TASK_REBASE_REASON)
        ? [JSON.parse(event.reason.slice(TASK_REBASE_REASON.length)) as TaskRebase]
        : [],
    );
}

/** Reports remain immutable. Only a complete chain of equivalent patches carries approval. */
export function currentReviewRef(store: WorkStore, key: string, ref: ReviewRef): ReviewRef {
  for (const rebase of taskRebaseHistory(store, key)) {
    if (sameReviewRef(ref, rebase.before) && rebase.oldPatchId === rebase.newPatchId)
      ref = rebase.after;
  }
  return ref;
}

export function hasCurrentApproval(store: WorkStore, key: string): boolean {
  const task = store.getTask(key);
  const review = task?.review_reports?.at(-1);
  return !!(
    task?.review_ref &&
    review?.report.verdict === 'approve' &&
    sameReviewRef(currentReviewRef(store, key, review.review_ref), task.review_ref)
  );
}
