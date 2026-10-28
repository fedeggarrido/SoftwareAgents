import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

import type { ProjectConfig } from '../../core/src/project.js';
import { AuditLog } from './auditLog.js';
import { companyAutopilotKey, readConfig } from './configPersistence.js';
import { FEATURE_RUN_POLL_MS } from './constants.js';
import { pushDeveloperBranch } from './developer.js';
import { evalGit } from './evalTasks.js';
import { featureIngressActor } from './featureIngress.js';
import { assertTaskDependencies } from './featureRunBase.js';
import { assertDirectRef, publishDirectRef } from './gitPublication.js';
import { lastReviewFailure } from './reviewAttempts.js';
import { rebaseFeatureTask, recoverFeatureTaskRebase } from './taskRebase.js';
import { isVerifierInfrastructureFailure } from './verifierInfrastructure.js';
import { recoverWorkerResults } from './workerPublication.js';
import type { TaskRecord, WorkStore } from './workstore/WorkStore.js';

export function assertFeatureRunIngress(config: ProjectConfig, argv: string[]): void {
  if (featureIngressActor() === 'human') return;
  const allowed = readConfig().companyAutopilot[companyAutopilotKey(config.repoRoot)]?.command;
  const actual = process.argv;
  if (
    allowed &&
    JSON.stringify(allowed) === JSON.stringify(actual) &&
    JSON.stringify(actual.slice(-argv.length - 1)) === JSON.stringify(['feature', ...argv])
  )
    return;
  throw new Error(
    'feature run requires human ingress or the exact Operator companyAutopilot argv allowlist (SA-003)',
  );
}

export interface FeatureRunSummary {
  feature: string;
  status: string;
  integration_branch: string;
  integration_sha: string;
  tasks: { key: string; status: string; integrated: boolean }[];
  message: string;
  resume: string;
  exit_code: number;
}

/** Deterministic scheduler; role execution uses the existing feature commands. */
export async function runFeature(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  request: string | undefined,
  invoke: (argv: string[]) => Promise<void>,
  progress: (line: string) => void,
): Promise<FeatureRunSummary> {
  if ((config.operator.orchestrator?.maxConcurrentTasks ?? 1) !== 1)
    throw new Error(
      'orchestrator.maxConcurrentTasks > 1 requires SA-037; this runner only accepts 1',
    );
  const git = (args: string[]) =>
    evalGit(config.repoRoot, ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args]);
  const main = git(['rev-parse', 'refs/heads/main^{commit}']);
  const owner = `feature-run-${randomUUID()}`;
  const state = await store.claimFeatureRun(key, owner, {
    branch: `sa/${key}-integration`,
    initial_main: main,
    head: main,
    request: request ?? `${config.project.brain.path}/features/requests/${key}.md`,
    integrated: {},
    status: 'running',
  });
  // Retire the old independent budget, including exhausted checkpoints from older versions.
  delete state.attempts;
  const audit = new AuditLog();
  // Worker diagnostics (including historical ones) are not evidence that this
  // runner received an operator signal. Keep that authority local to this run.
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  const save = () => store.saveFeatureRun(key, owner, state);
  const append = (action: string, task: string, status: string) => {
    audit.append({
      projectId: store.projectId,
      action: 'feature_run',
      resourceType: 'feature',
      resourceId: key,
      actorType: 'system',
      actorId: owner,
      policyDecision: null,
      riskLevel: 'high',
      taskKey: task,
      executionId: null,
      outcome: { status, detail: JSON.stringify({ action, task, branch: state.branch }) },
    });
    progress(`${action} ${task}: ${status}`);
  };
  const tasks = () => store.listTasks().filter((t) => t.feature_key === key && t.declaration);
  const stop = async (
    status: string,
    message: string,
    exit_code: number,
  ): Promise<FeatureRunSummary> => {
    state.status = status;
    state.message = message;
    await save();
    const resume = `pixel-agents feature run ${key}`;
    progress(`${key}: ${status}; ${message}; continuar: ${resume}`);
    return {
      feature: key,
      status,
      integration_branch: state.branch,
      integration_sha: state.head,
      tasks: tasks().map((t) => ({
        key: t.key,
        status: t.status,
        integrated: !!state.integrated[t.key],
      })),
      message,
      resume,
      exit_code,
    };
  };
  const ref = `refs/heads/${state.branch}`;
  const stopInterrupted = () =>
    stop('interrupted', `Operator interrupted feature run ${key}; partial work retained`, 130);
  const branchHead = () => git(['for-each-ref', '--format=%(objectname)', ref]);
  const ancestor = (a: string, b: string) => git(['merge-base', a, b]) === a;
  const assertUnchecked = () => {
    if (git(['worktree', 'list', '--porcelain']).split('\n').includes(`branch ${ref}`))
      throw new Error('Integration branch is checked out; release it before feature run');
  };
  const publishPending = async () => {
    const pending = state.pending!;
    assertDirectRef(config.repoRoot, ref);
    if (!pending.main) {
      const review = store.getTask(pending.task)?.review_ref;
      if (review) assertDirectRef(config.repoRoot, `refs/heads/${review.branch}`);
    }
    assertUnchecked();
    const head = branchHead();
    if (head === pending.before)
      publishDirectRef(config.repoRoot, ref, pending.after, pending.before);
    else if (head !== pending.after)
      throw new Error('Integration branch changed outside the orchestrator');
    if (branchHead() !== pending.after || !ancestor(pending.before, pending.after))
      throw new Error('Integration verification failed');
    if (pending.main) {
      if (!ancestor(pending.main, pending.after))
        throw new Error('Main reconciliation verification failed');
      state.initial_main = pending.main;
    } else {
      const task = store.getTask(pending.task)!;
      if (
        task.status !== 'DONE' ||
        !task.review_ref ||
        !ancestor(task.review_ref.sha, pending.after)
      )
        throw new Error('Integrated task no longer matches DONE review_ref');
      state.integrated[pending.task] = task.review_ref;
    }
    state.head = pending.after;
    delete state.pending;
    await save();
    append('integrate', pending.task, 'DONE');
  };
  const merge = (left: string, right: string, subject: string) => {
    // merge-tree fails before any ref changes when a conflict needs human input.
    let tree: string;
    try {
      tree = git(['merge-tree', '--write-tree', left, right]).split('\n')[0];
    } catch {
      throw new Error('Main/integration merge conflict; human reconciliation required');
    }
    if (ancestor(left, right)) return right;
    if (ancestor(right, left)) return left;
    return execFileSync(
      'git',
      ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', left, '-p', right],
      {
        cwd: config.repoRoot,
        input: subject + '\n',
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();
  };
  const reconcileMain = async () => {
    assertDirectRef(config.repoRoot, ref);
    if (branchHead() !== state.head)
      throw new Error('Integration branch changed outside the orchestrator');
    const current = git(['rev-parse', 'refs/heads/main^{commit}']);
    if (current === state.initial_main) return;
    if (!ancestor(state.initial_main, current))
      throw new Error('main history changed; human reconciliation required');
    state.pending = {
      task: 'main',
      before: state.head,
      after: merge(state.head, current, `feat(${key}): reconciliar main`),
      main: current,
    };
    await save();
    await publishPending();
  };
  const publishBranches = async () => {
    // Revisit durable review_refs even after a crash between worker completion
    // and the command's push. withIdempotency retains uncertain external effects.
    const publish = async () => {
      const pending = state.publication!;
      try {
        await pushDeveloperBranch(
          store,
          {
            ...config,
            operator: {
              ...config.operator,
              developer: pending.push
                ? {
                    ...config.operator.developer,
                    pushBranch: pending.push,
                  }
                : undefined,
            },
          },
          pending.task,
          pending.review,
        );
      } catch (error) {
        throw new Error(
          `Developer branch publication unresolved for ${pending.task}; human reconciliation required: ${(error as Error).message}`,
        );
      }
      (state.published ??= {})[pending.task] = pending.review.sha;
      delete state.publication;
      await save();
    };
    if (!state.publication && state.active?.action === 'develop') {
      const review = store.getTask(state.active.task)?.review_ref;
      if (review) {
        if (!state.active.publication)
          throw new Error(
            'Interrupted Developer push policy unknown; human reconciliation required',
          );
        state.publication = {
          task: state.active.task,
          review,
          push: state.active.publication.push,
        };
        delete state.active;
        await save();
      }
    }
    if (state.publication) await publish();
    for (const task of tasks()) {
      const review = task.review_ref;
      if (review) assertDirectRef(config.repoRoot, `refs/heads/${review.branch}`);
      if (!review || state.published?.[task.key] === review.sha) continue;
      state.publication = { task: task.key, review, push: config.operator.developer?.pushBranch };
      await save();
      await publish();
    }
  };
  const execute = async (action: string, taskKey: string, args: string[]) => {
    const task = store.getTask(taskKey);
    // Developer's WorkStore claim enforces tasks.attempt/max_attempts. Review and QA
    // already share validated rework rounds. Non-code proposals use task history,
    // since their explicit retry transitions do not increment tasks.attempt.
    const events = store.listDomainEvents(taskKey);
    const reset = events
      .map(
        (event) =>
          event.to_status === 'READY' &&
          !['Retry lease', 'Explicit Requirements retry'].includes(event.reason),
      )
      .lastIndexOf(true);
    const proposalFailures = events
      .slice(reset + 1)
      .filter(
        (event) =>
          event.to_status === 'FAILED_RETRYABLE' && !isVerifierInfrastructureFailure(event.reason),
      ).length;
    if (task && ['spec', 'design'].includes(action) && proposalFailures >= task.max_attempts)
      return stop(
        'failed',
        `${action} ${taskKey}: max_attempts exhausted; inspect feature show ${key}`,
        1,
      );
    state.active = {
      action,
      task: taskKey,
      version: task?.version ?? 0,
      ...(action === 'develop'
        ? { publication: { push: config.operator.developer?.pushBranch } }
        : {}),
    };
    await save();
    append(action, taskKey, 'started');
    if (interrupted) return stopInterrupted();
    process.exitCode = 0;
    let error: unknown;
    try {
      await invoke(args);
    } catch (cause) {
      error = cause;
    }
    const exit = process.exitCode;
    process.exitCode = 0;
    const current = store.getTask(taskKey);
    if (action === 'develop' && current?.review_ref) {
      state.publication = {
        task: taskKey,
        review: current.review_ref,
        push: state.active!.publication!.push,
      };
    }
    delete state.active;
    await save();
    append(action, taskKey, current?.status ?? (error ? 'failed' : 'finished'));
    if (interrupted) return stopInterrupted();
    if (isVerifierInfrastructureFailure(current?.blocked_reason))
      return stop('WAITING_HUMAN', `${taskKey}: ${current!.blocked_reason}`, 3);
    if (current?.status === 'WAITING_HUMAN')
      return stop(
        'WAITING_HUMAN',
        `${taskKey}: ${current.blocked_reason ?? 'human review required'}`,
        3,
      );
    if (current?.status === 'FAILED_RETRYABLE' && !current.review_ref) return;
    if (exit === 3 || current?.status === 'WAITING_QUOTA')
      return stop(
        current && lastReviewFailure(store, current)?.reason.includes('category=invalid_report')
          ? 'WAITING_HUMAN'
          : 'WAITING_QUOTA',
        `${taskKey}: ${current?.blocked_reason ?? (current && lastReviewFailure(store, current)?.reason) ?? 'worker waiting; inspect feature show ' + key}`,
        3,
      );
    // A read-only worker failure retains its approval; retry only on explicit resume.
    if (current && ['review', 'qa'].includes(action) && lastReviewFailure(store, current))
      return stop('WAITING_HUMAN', `${taskKey}: ${lastReviewFailure(store, current)!.reason}`, 3);
    if (error) return stop('failed', (error as Error).message, 1);
    if (
      (!current &&
        !(action === 'spec'
          ? store.getFeature(key)
          : action === 'design'
            ? store.getDesign(key)
            : false)) ||
      (current && current.status === task?.status && current.version === task.version)
    )
      return stop('WAITING_HUMAN', `${action} made no progress; inspect feature show ${key}`, 3);
    if (action === 'qa' && current?.status === 'QA')
      return stop(
        'WAITING_HUMAN',
        `QA not_tested; inspect feature show ${key} and resolve runtime test evidence: ${
          current.test_reports
            ?.at(-1)
            ?.report.commands.filter((command) => command.result === 'not_tested')
            .map((command) => command.reason)
            .join('; ') || 'acceptance criteria remain untested'
        }`,
        3,
      );
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    if (state.branch !== `sa/${key}-integration`)
      throw new Error('Invalid runtime integration branch; main is never a publication target');
    if (request && request !== state.request)
      throw new Error('Run request already pinned; use the original request');
    state.status = 'running';
    await save();
    if (state.pending) await publishPending();
    assertDirectRef(config.repoRoot, ref);
    assertUnchecked();
    const head = branchHead();
    if (!head) {
      if (state.head !== state.initial_main || Object.keys(state.integrated).length)
        throw new Error('Integration branch disappeared; human reconciliation required');
      publishDirectRef(
        config.repoRoot,
        ref,
        state.initial_main,
        '0'.repeat(state.initial_main.length),
      );
    } else if (head !== state.head)
      throw new Error('Integration branch changed outside the orchestrator');
    state.status = 'running';
    await save();
    for (;;) {
      if (interrupted) return await stopInterrupted();
      const recovered = await store.recoverExpiredLeases();
      if (interrupted) return await stopInterrupted();
      const infrastructure = recovered.find(
        (task) =>
          (task.key === key || task.key === `${key}-DESIGN` || task.feature_key === key) &&
          isVerifierInfrastructureFailure(
            task.blocked_reason ?? lastReviewFailure(store, task)?.reason,
          ),
      );
      if (infrastructure)
        return await stop(
          'WAITING_HUMAN',
          `${infrastructure.key}: ${infrastructure.blocked_reason ?? lastReviewFailure(store, infrastructure)?.reason}`,
          3,
        );
      await recoverWorkerResults(store, config, key);
      if (interrupted) return await stopInterrupted();
      for (const task of tasks()) {
        if (interrupted) return await stopInterrupted();
        if (['REVIEW', 'QA'].includes(task.status))
          await recoverFeatureTaskRebase(store, config, task.key);
      }
      if (interrupted) return await stopInterrupted();
      const feature = store.getFeature(key);
      let all = tasks();
      const related = [store.getTask(key), store.getTask(`${key}-DESIGN`), ...all].filter(
        (t): t is TaskRecord => !!t,
      );
      const active = related.find((t) => ['RUNNING', 'LEASED'].includes(t.status));
      if (active) {
        const recovery = store.listLeaseRecoveries().find((r) => r.task_key === active.key);
        if (recovery)
          return await stop(
            'WAITING_HUMAN',
            `SA-026 recovery: ${recovery.error ?? 'reserved'} (${active.key})`,
            3,
          );
        progress(`recover ${active.key}: waiting for lease expiry (${active.lease_expires_at})`);
        await new Promise((resolve) => setTimeout(resolve, FEATURE_RUN_POLL_MS));
        continue;
      }
      const gatedKeys = new Set([key, `${key}-DESIGN`, ...all.map((t) => t.key)]);
      const decision = store
        .listDecisions()
        .find((d) => d.status !== 'answered' && d.blocks.some((b) => gatedKeys.has(b)));
      const human = related.find((t) => t.status === 'WAITING_HUMAN');
      if (decision || human) {
        const response = decision?.context.startsWith('feature-requirements/')
          ? `pixel-agents feature spec ${key} --answers <file.md>`
          : decision?.context.startsWith('feature-design/')
            ? `pixel-agents feature design ${key} --answers <file.md>`
            : 'Respond in the office and inspect';
        return await stop(
          'WAITING_HUMAN',
          `Human Decision ${decision?.id ?? human!.key}: ${human?.blocked_reason ?? decision?.context ?? response}; ${response}; pixel-agents feature show ${key}`,
          3,
        );
      }
      const failed = related.find((t) =>
        ['FAILED_FINAL', 'CANCELLED', 'BLOCKED'].includes(t.status),
      );
      if (failed)
        return await stop(
          'failed',
          `${failed.key}: ${failed.status}; ${failed.blocked_reason ?? 'operator intervention required'}`,
          1,
        );
      await publishBranches();
      await reconcileMain();
      // Rebase every affected approval, not only the next schedulable task.
      for (const task of tasks()) {
        if (
          task.review_ref &&
          ['REVIEW', 'QA'].includes(task.status) &&
          task.review_ref.base !== state.head
        ) {
          try {
            await rebaseFeatureTask(store, config, key, task.key, audit, owner);
          } catch (error) {
            throw new Error(
              `Task ${task.key} rebase blocked; human reconciliation required: ${(error as Error).message}`,
            );
          }
        }
      }
      all = tasks();
      let result: FeatureRunSummary | undefined;
      if (!feature) result = await execute('spec', key, ['spec', key, '--request', state.request]);
      else if (!['approved', 'ready_to_merge'].includes(feature.status))
        return await stop(
          'WAITING_HUMAN',
          `Review the spec, then run pixel-agents feature approve ${key}`,
          3,
        );
      else if (!store.getDesign(key))
        result = await execute('design', `${key}-DESIGN`, ['design', key]);
      else {
        // Integrate dependencies before admitting consumers, including on restart after QA.
        const done = all.find((t) => t.status === 'DONE' && !state.integrated[t.key]);
        if (done) {
          const review = done.review_ref;
          if (review) assertDirectRef(config.repoRoot, `refs/heads/${review.branch}`);
          if (!review || git(['rev-parse', `refs/heads/${review.branch}`]) !== review.sha)
            throw new Error('DONE task has no matching review_ref branch');
          append('integrate', done.key, 'started');
          let after = review.sha;
          if (ancestor(review.sha, state.head)) after = state.head;
          else if (!ancestor(state.head, review.sha)) {
            // Plumbing merge leaves main and every checkout untouched; conflicts prevent publication.
            const tree = git(['merge-tree', '--write-tree', state.head, review.sha]).split('\n')[0];
            after = execFileSync(
              'git',
              [
                '-c',
                'commit.gpgSign=false',
                'commit-tree',
                tree,
                '-p',
                state.head,
                '-p',
                review.sha,
              ],
              {
                cwd: config.repoRoot,
                input: `feat(${key}): integrar ${done.key.toLowerCase()}\n`,
                encoding: 'utf8',
                windowsHide: true,
              },
            ).trim();
          }
          state.pending = { task: done.key, before: state.head, after };
          await save();
          await publishPending();
          continue;
        }
        if (all.length && all.every((t) => t.status === 'DONE')) {
          await reconcileMain();
          if (!ancestor(git(['rev-parse', 'refs/heads/main^{commit}']), state.head)) continue;
          return await stop('ready_to_merge', `Human merge required: ${state.branch} → main`, 0);
        }
        const task = all.find(
          (t) =>
            t.status !== 'DONE' &&
            store.canStart(t.key) &&
            store.listTaskDependencies(t.key).every((d) => !!state.integrated[d.depends_on_key]),
        );
        if (!task)
          return await stop(
            'WAITING_HUMAN',
            'No DAG task canStart; inspect dependencies and task states',
            3,
          );
        if (
          task.review_ref &&
          ['REVIEW', 'QA'].includes(task.status) &&
          task.review_ref.base !== state.head
        ) {
          append('rebase', task.key, 'started');
          await rebaseFeatureTask(store, config, key, task.key, audit, owner);
          append('rebase', task.key, store.getTask(task.key)!.status);
          continue;
        }
        // Approved doc tasks are DONE atomically in completeReview; publish them above
        // exactly like runtime-QA tasks, without scheduling a synthetic QA execution.
        const action = task.review_ref ? (task.status === 'QA' ? 'qa' : 'review') : 'develop';
        if (action === 'develop') {
          const branch = `refs/heads/sa/${task.key}-developer`;
          assertDirectRef(config.repoRoot, branch);
          const head = git(['for-each-ref', '--format=%(objectname)', branch]) || state.head;
          assertTaskDependencies(store, config.repoRoot, task.key, head);
        }
        result = await execute(action, task.key, [action, key, '--task', task.key]);
      }
      if (result) return result;
    }
  } catch (error) {
    if (interrupted) return await stopInterrupted();
    append('run', key, 'failed');
    const human = (error as Error).message.includes('human reconciliation required');
    return await stop(human ? 'WAITING_HUMAN' : 'failed', (error as Error).message, human ? 3 : 1);
  } finally {
    try {
      await store.releaseFeatureRun(key, owner);
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}
