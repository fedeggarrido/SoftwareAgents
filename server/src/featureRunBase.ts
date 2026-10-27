import type { ProjectConfig } from '../../core/src/project.js';
import { evalGit } from './evalTasks.js';
import { assertDirectRef } from './gitPublication.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** Only runtime-owned WorkStore state may replace the Project base. */
export function featureBaseBranch(
  store: WorkStore,
  config: ProjectConfig,
  feature: string,
): string {
  const run = store.getFeatureRun(feature);
  if (run && run.state.branch !== `sa/${feature}-integration`)
    throw new Error('Invalid feature integration branch');
  return run?.state.branch ?? config.project.repo.defaultBranch;
}

/** Check the actual launch HEAD on every attempt, never just the recorded base. */
export function assertTaskDependencies(
  store: WorkStore,
  repository: string,
  task: string,
  head: string,
): void {
  for (const dependency of store.listTaskDependencies(task)) {
    const done = store.getTask(dependency.depends_on_key);
    const review = done?.review_ref;
    if (review) assertDirectRef(repository, `refs/heads/${review.branch}`);
    if (
      !done ||
      done.status !== 'DONE' ||
      !review ||
      evalGit(repository, ['merge-base', review.sha, head]) !== review.sha
    )
      throw new Error(
        `Dependency ${dependency.depends_on_key} is absent from ${task} launch HEAD; human reconciliation required`,
      );
  }
}
