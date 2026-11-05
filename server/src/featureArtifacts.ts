import { execFileSync } from 'child_process';

import type { ProjectConfig } from '../../core/src/project.js';
import { architectPaths } from './architect.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import { withoutOperatorToken } from './featureIngress.js';
import { requirementsDocPath, validateRequirements } from './requirements.js';
import type { FeatureRecord, WorkStore } from './workstore/WorkStore.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    env: withoutOperatorToken(process.env),
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

/** The feature document lives in its worker branch, even before integration. */
export function featureDocument(
  store: Pick<WorkStore, 'getTask' | 'getDesign'>,
  config: ProjectConfig,
  feature: FeatureRecord,
) {
  const task = store.getTask(feature.key);
  const relative = requirementsDocPath(config.project.brain.path, feature.key);
  const expectedTree = taskPath(config.repoRoot, `.worktrees/${feature.key}`);
  if (
    feature.doc_path !== relative ||
    task?.worktree_ref !== expectedTree ||
    !task.branch ||
    git(expectedTree, ['symbolic-ref', '--short', 'HEAD']).trim() !== task.branch
  )
    throw new Error('Feature branch or document binding changed');
  const source = readTaskInput(expectedTree, relative);
  const design = store.getDesign(feature.key);
  const sources = {
    requirements: source,
    design: null as string | null,
    dag: null as string | null,
  };
  const head = design?.git_sha ?? feature.git_sha;
  if (
    git(expectedTree, ['rev-parse', 'HEAD']).trim() !== head ||
    git(expectedTree, ['rev-parse', `refs/heads/${task.branch}`]).trim() !== head ||
    git(expectedTree, ['show', `${feature.git_sha}:${relative}`]) !== source ||
    git(expectedTree, ['show', `refs/heads/${task.branch}:${relative}`]) !== source ||
    git(expectedTree, ['show', `:${relative}`]) !== source
  )
    throw new Error('Feature SHA no longer matches the branch file');
  if (design) {
    const paths = architectPaths(config.project.brain.path, feature.key);
    if (
      design.feature_sha !== feature.git_sha ||
      design.doc_path !== paths.doc ||
      design.dag_path !== paths.dag
    )
      throw new Error('Design binding changed');
    for (const relative of [paths.doc, paths.dag]) {
      const content = readTaskInput(expectedTree, relative);
      if (
        git(expectedTree, ['show', `${head}:${relative}`]) !== content ||
        git(expectedTree, ['show', `:${relative}`]) !== content
      )
        throw new Error('Design SHA no longer matches the branch file');
      if (relative === paths.doc) sources.design = content;
      else sources.dag = content;
    }
  }
  return { spec: validateRequirements(source, feature.key), branch: task.branch, sources };
}
