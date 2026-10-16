import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';

import type { ProjectConfig } from '../../../core/src/project.js';
import { AuditLog } from '../auditLog.js';
import { CliUsageError } from '../cliErrors.js';
import { evaluatePolicy, type PolicyActor } from '../policy.js';
import { loadProjectConfig } from '../projectConfig.js';
import {
  openRequirementsQuestions,
  readRequirements,
  requirementsDecisionContext,
  requirementsDocPath,
} from '../requirements.js';
import { runWorker, type WorkerOptions } from '../worker.js';
import { openWorkStore } from '../workstore/SqliteWorkStore.js';
import type { FeatureRecord, WorkStore } from '../workstore/WorkStore.js';
import { readTaskInput, taskPath } from './taskFiles.js';

const USAGE =
  'Usage: pixel-agents feature spec <FEAT-ID> (--request <file.md> | --answers <file.md>) | approve <FEAT-ID> | show <FEAT-ID> [--json]';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** The feature document lives in its worker branch, even before integration. */
function featureDocument(store: WorkStore, config: ProjectConfig, feature: FeatureRecord) {
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
  if (
    git(expectedTree, ['rev-parse', 'HEAD']).trim() !== feature.git_sha ||
    git(expectedTree, ['rev-parse', `refs/heads/${task.branch}`]).trim() !== feature.git_sha ||
    git(expectedTree, ['show', `${feature.git_sha}:${relative}`]) !== source ||
    git(expectedTree, ['show', `refs/heads/${task.branch}:${relative}`]) !== source ||
    git(expectedTree, ['show', `:${relative}`]) !== source
  )
    throw new Error('Feature SHA no longer matches the branch file');
  return { spec: readRequirements(expectedTree, relative, feature.key), branch: task.branch };
}

export function featureIngressActor(actor: PolicyActor = 'human'): PolicyActor {
  return ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'].some(
    (key) => process.env[key] !== undefined,
  )
    ? 'agent'
    : actor;
}

/** Actor identity is supplied by trusted ingress. No CLI flag, board or agent data can set it. */
export async function approveFeature(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  actor: PolicyActor,
  audit = new AuditLog(),
) {
  actor = featureIngressActor(actor);
  const policy = evaluatePolicy('approve_featurespec', actor, config.operator.autonomyLevel);
  let reviewedSha: string | null = null;
  const append = (status: string) =>
    audit.append({
      projectId: store.projectId,
      action: 'approve_featurespec',
      resourceType: 'feature',
      resourceId: key,
      actorType: actor,
      actorId: actor === 'human' ? 'operator' : null,
      policyDecision: policy,
      riskLevel: 'high',
      taskKey: key,
      executionId: null,
      outcome: { status, detail: JSON.stringify({ gitSha: reviewedSha }) },
    });
  try {
    if (actor !== 'human' || policy.outcome !== 'allow')
      throw new Error('FeatureSpec approval requires the human operator');
    const feature = store.getFeature(key);
    if (!feature) throw new Error('Unknown Feature');
    reviewedSha = feature.git_sha;
    await store.approveFeature(key, feature.git_sha, () => {
      const { spec } = featureDocument(store, config, feature);
      if (spec.openQuestions.length)
        throw new Error('Feature has unresolved product questions; incorporate --answers first');
      append('pending');
    });
  } catch (error) {
    append('rejected');
    throw error;
  }
  // A committed approval remains committed if confirmation logging fails.
  try {
    append('approved');
  } catch (cause) {
    throw new Error(
      'Feature approved; audit confirmation pending. Inspect WorkStore before retrying.',
      { cause },
    );
  }
}

export async function runFeatureCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
  workerOptions: Pick<WorkerOptions, 'binaryArgs' | 'probe'> = {},
): Promise<void> {
  const [command, key, ...rest] = argv;
  if (
    !/^FEAT-\d{3}$/.test(key ?? '') ||
    !(
      (command === 'spec' &&
        rest.length === 2 &&
        ['--request', '--answers'].includes(rest[0]) &&
        !rest[1].startsWith('-')) ||
      (command === 'approve' && rest.length === 0) ||
      (command === 'show' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--json')))
    )
  )
    throw new CliUsageError(USAGE);
  let store: WorkStore | undefined;
  try {
    const config = loadProjectConfig(cwd, true);
    if (!config) throw new Error('feature requires a bound Git Project');
    store = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
    let feature = store.getFeature(key);
    if (command === 'spec') {
      taskPath(cwd, requirementsDocPath(config.project.brain.path, key));
      if (rest[0] === '--answers') {
        const actor = featureIngressActor();
        const audit = new AuditLog();
        let answersHash: string | null = null;
        const append = (status: string) =>
          audit.append({
            projectId: store!.projectId,
            action: 'answer_decision',
            resourceType: 'feature',
            resourceId: key,
            actorType: actor,
            actorId: actor === 'human' ? 'operator' : null,
            policyDecision: evaluatePolicy('answer_decision', actor, config.operator.autonomyLevel),
            riskLevel: 'high',
            taskKey: key,
            executionId: null,
            outcome: { status, detail: JSON.stringify({ answersHash }) },
          });
        if (actor !== 'human') {
          append('rejected');
          throw new Error('FeatureSpec answers require the human operator');
        }
        if (!feature || feature.status === 'approved')
          throw new Error('Feature is not awaiting answers');
        const { spec } = featureDocument(store, config, feature);
        if (!spec.openQuestions.length) throw new Error('Feature has no open product questions');
        await openRequirementsQuestions(store, key, spec.openQuestions, spec.version);
        const decision = store
          .listDecisions()
          .find(
            (d) =>
              d.blocks.includes(key) &&
              (d.context === requirementsDecisionContext(key, spec.openQuestions, spec.version) ||
                (d.context === requirementsDecisionContext(key, spec.openQuestions) &&
                  !d.answer?.startsWith('{'))),
          );
        if (!decision) throw new Error('Missing Requirements decision');
        const answers = readTaskInput(cwd, path.relative(cwd, path.resolve(cwd, rest[1])));
        if (!answers.trim()) throw new Error('Answers must not be empty');
        answersHash = createHash('sha256').update(answers).digest('hex');
        append('pending');
        await runWorker(
          { task: key, selectExecutor: true },
          {
            ...workerOptions,
            cwd,
            log,
            requirements: {
              key,
              request: 'Revise the current FeatureSpec using the operator answers.',
              revision: { spec, gitSha: feature.git_sha, decisionId: decision.id, answers },
            },
          },
        );
        feature = store.getFeature(key);
        log(`${key}: ${feature!.status} (${feature!.git_sha})`);
        return;
      }
      if (feature) {
        const { spec } = featureDocument(store, config, feature);
        if (feature.status !== 'approved')
          await openRequirementsQuestions(store, key, spec.openQuestions, spec.version);
        log(`${key}: already registered (${feature.status}, ${feature.git_sha})`);
        return;
      }
      const request = readTaskInput(cwd, path.relative(cwd, path.resolve(cwd, rest[1])));
      await runWorker(
        { task: key, selectExecutor: true },
        {
          ...workerOptions,
          cwd,
          log,
          requirements: { key, request },
        },
      );
      feature = store.getFeature(key);
      if (feature) log(`${key}: ${feature.status} (${feature.git_sha})`);
    } else if (command === 'approve') {
      await approveFeature(store, config, key, 'human');
      log(`${key}: approved`);
    } else {
      if (!feature) throw new Error('Unknown Feature');
      const document = featureDocument(store, config, feature);
      const result = {
        ...feature,
        ...document,
        decisions: store.listDecisions().filter((d) => d.blocks.includes(key)),
      };
      log(
        rest[0] === '--json'
          ? JSON.stringify(result, null, 2)
          : `${key}: ${feature.status}\n${JSON.stringify(document.spec.title)}\nBranch: ${document.branch}\nDocument: ${feature.doc_path}\nSHA: ${feature.git_sha}`,
      );
    }
  } catch (error) {
    throw new CliUsageError(`feature ${command}: ${(error as Error).message}`);
  } finally {
    store?.close();
  }
}
