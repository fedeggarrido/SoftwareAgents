import type { ProjectConfig } from '../../core/src/project.js';
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
