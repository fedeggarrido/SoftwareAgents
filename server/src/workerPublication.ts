import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { ProjectConfig } from '../../core/src/project.js';
import { AuditLog } from './auditLog.js';
import { taskDirectory, taskPath } from './commands/taskFiles.js';
import { evalGit } from './evalTasks.js';
import { guardProtectedPaths } from './executors/protectedPaths.js';
import { withoutOperatorToken } from './featureIngress.js';
import { assertDirectRef, publishDirectRef } from './gitPublication.js';
import { guardRequirementsWrites, openRequirementsQuestions } from './requirements.js';
import { WorkerLifecycle } from './workerLifecycle.js';
import type { WorkerPublication, WorkStore } from './workstore/WorkStore.js';

/** Replay only a prevalidated, runtime-owned commit intent. No model is rerun. */
export async function publishWorkerResult(
  store: WorkStore,
  config: ProjectConfig,
  pending: WorkerPublication,
  lifecycle: WorkerLifecycle,
): Promise<void> {
  lifecycle.assertOwned();
  const root = config.repoRoot;
  assertDirectRef(root, `refs/heads/${pending.branch}`);
  const tree = taskPath(root, `.worktrees/${pending.developer ? pending.task : pending.feature}`);
  const git = (args: string[]) =>
    evalGit(tree, ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args]);
  if (pending.draft) {
    if (
      git(['rev-parse', 'HEAD']) !== pending.before ||
      git(['symbolic-ref', '--short', 'HEAD']) !== pending.branch
    )
      throw new Error('Runtime artifact draft HEAD changed');
    const draft = pending.draft;
    guardRequirementsWrites(tree, new Map(draft.snapshot), Object.keys(draft.files));
    for (const [relative, content] of Object.entries(draft.files)) {
      const file = taskPath(tree, relative);
      taskDirectory(tree, path.dirname(relative));
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !Buffer.from(content).subarray(0, stat.size).equals(fs.readFileSync(file))
        )
          throw new Error('Runtime artifact draft content changed');
        fs.writeFileSync(file, content, { flag: 'r+' });
      } else fs.writeFileSync(file, content, { flag: 'wx' });
    }
    guardRequirementsWrites(tree, new Map(draft.snapshot), Object.keys(draft.files));
    git(['add', '--', ...Object.keys(draft.files)]);
    pending.tree = git(['write-tree']);
    pending.sha = execFileSync(
      'git',
      ['-c', 'commit.gpgSign=false', 'commit-tree', pending.tree, '-p', pending.before],
      {
        env: withoutOperatorToken(process.env),
        cwd: tree,
        input: `${draft.subject}\n\nSoftwareAgents-Execution: ${pending.execution}\n`,
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();
    if (pending.design) pending.design.record.git_sha = pending.sha;
    delete pending.draft;
    await store.prepareWorkerPublication(pending, lifecycle.owner);
  }
  if (
    path.resolve(pending.worktree) !== tree ||
    pending.branch !==
      `sa/${pending.developer ? pending.task + '-developer' : pending.feature + '-worker'}` ||
    git(['symbolic-ref', '--short', 'HEAD']) !== pending.branch ||
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']) !==
      evalGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']) ||
    ![pending.before, pending.sha].includes(git(['rev-parse', 'HEAD'])) ||
    git(['write-tree']) !== pending.tree ||
    git(['diff-files', '--name-only']) ||
    git(['ls-files', '--others', '--exclude-standard'])
  )
    throw new Error('Verified worker publication changed; human reconciliation required');
  if (
    guardProtectedPaths({
      cwd: tree,
      base: pending.base,
      staged: true,
      operator: config.operator,
      projectId: store.projectId,
      taskKey: pending.task,
      executionId: pending.execution,
    }).decision.outcome !== 'allow'
  )
    throw new Error(
      'Verified worker publication blocked by current protected-path policy; human review required',
    );
  if (git(['rev-parse', 'HEAD']) === pending.before)
    publishDirectRef(root, `refs/heads/${pending.branch}`, pending.sha, pending.before);
  if (
    git(['rev-parse', 'HEAD']) !== pending.sha ||
    git(['status', '--porcelain', '--untracked-files=all'])
  )
    throw new Error('Worker commit publication verification failed');
  if (pending.developer) {
    const current = store.getTask(pending.task)!.review_ref;
    const review = { branch: pending.branch, sha: pending.sha, base: pending.base };
    if (current && JSON.stringify(current) !== JSON.stringify(review))
      throw new Error('Worker review_ref changed');
    if (!current) await store.setTaskReview(pending.task, lifecycle.owner, review);
  }
  if (pending.spec && !store.getFeature(pending.feature))
    store.createFeature({
      key: pending.feature,
      title: pending.spec.title,
      doc_path: `${config.project.brain.path}/features/${pending.feature}.yaml`,
      git_sha: pending.sha,
      status: 'in_review',
    });
  if (pending.design && !store.getDesign(pending.feature))
    await store.importTaskDag(pending.design.dag, store.getFeature(pending.feature)!, {
      design: pending.design.record,
      owner: lifecycle.owner,
    });
  await lifecycle.finish('REVIEW', `Runtime commit ${pending.sha}`);
  if (pending.spec)
    await openRequirementsQuestions(
      store,
      pending.feature,
      pending.spec.openQuestions,
      pending.spec.version,
    );
  new AuditLog().append({
    projectId: store.projectId,
    action: 'worker_publication',
    resourceType: 'task',
    resourceId: pending.task,
    actorType: 'system',
    actorId: lifecycle.owner,
    policyDecision: null,
    riskLevel: 'high',
    taskKey: pending.task,
    executionId: pending.execution,
    outcome: {
      status: 'persisted',
      detail: JSON.stringify({ sha: pending.sha, branch: pending.branch }),
    },
  });
  await store.clearWorkerPublication(pending.task, pending.execution);
}

export async function recoverWorkerResults(
  store: WorkStore,
  config: ProjectConfig,
  feature: string,
): Promise<void> {
  for (const pending of store.listWorkerPublications(feature)) {
    const task = store.getTask(pending.task)!;
    if (
      task.lease_owner ||
      ['WAITING_HUMAN', 'FAILED_FINAL', 'CANCELLED', 'BLOCKED'].includes(task.status)
    )
      continue; // SA-026 is the sole process-closure authority.
    const completed = pending.developer
      ? task.review_ref?.sha === pending.sha
      : pending.design
        ? store.getDesign(feature)?.git_sha === pending.sha
        : store.getFeature(feature)?.git_sha === pending.sha;
    const recordedCommit = store
      .listDomainEvents(task.key)
      .some((event) => event.reason === `Runtime commit ${pending.sha}`);
    if (
      completed &&
      task.status !== 'FAILED_RETRYABLE' &&
      task.status !== 'FAILED_FINAL' &&
      (!pending.developer || recordedCommit || ['QA', 'DONE'].includes(task.status))
    ) {
      if (pending.spec)
        await openRequirementsQuestions(
          store,
          feature,
          pending.spec.openQuestions,
          pending.spec.version,
        );
      await store.clearWorkerPublication(pending.task, pending.execution);
      continue;
    }
    const lifecycle = new WorkerLifecycle(store, pending.task);
    try {
      await lifecycle.claim(undefined, false, true);
      await publishWorkerResult(store, config, pending, lifecycle);
    } finally {
      await lifecycle.stopHeartbeat();
    }
  }
}
