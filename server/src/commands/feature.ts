import { createHash } from 'crypto';
import * as path from 'path';

import type { ProjectConfig } from '../../../core/src/project.js';
import { architectTaskKey } from '../architect.js';
import { AuditLog } from '../auditLog.js';
import { CliUsageError } from '../cliErrors.js';
import { developerRequest, lastDeveloperFailure, pushDeveloperBranch } from '../developer.js';
import { featureDocument } from '../featureArtifacts.js';
import { confirmHumanIngress, featureIngressActor } from '../featureIngress.js';
import { assertFeatureRunIngress, runFeature } from '../featureRun.js';
import { evaluatePolicy, type PolicyActor } from '../policy.js';
import { loadProjectConfig } from '../projectConfig.js';
import {
  openRequirementsQuestions,
  requirementsDecisionContext,
  requirementsDocPath,
} from '../requirements.js';
import { lastReviewFailure } from '../reviewAttempts.js';
import { reviewerRequest } from '../reviewer.js';
import { rebaseFeatureTask } from '../taskRebase.js';
import { runWorker, type WorkerOptions } from '../worker.js';
import { openWorkStore } from '../workstore/SqliteWorkStore.js';
import type { WorkStore } from '../workstore/WorkStore.js';
import { readTaskInput, taskPath } from './taskFiles.js';

const USAGE =
  'Usage: pixel-agents feature run <FEAT-ID> [--request <file.md>] [--json] | spec <FEAT-ID> (--request <file.md> | --answers <file.md>) | design <FEAT-ID> [--answers <file.md>] | develop <FEAT-ID> [--task <KEY>] | review <FEAT-ID> [--task <KEY>] | qa <FEAT-ID> [--task <KEY>] | rebase <FEAT-ID> --task <KEY> | approve <FEAT-ID> | show <FEAT-ID> [--json]';

export { featureIngressActor } from '../featureIngress.js';

/** Actor identity is supplied by trusted ingress. No CLI flag, board or agent data can set it. */
export async function approveFeature(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  actor: PolicyActor,
  audit = new AuditLog(),
  reviewed?: { gitSha: string; beforeCommit: () => void },
) {
  actor = featureIngressActor(actor);
  const policy = evaluatePolicy('approve_featurespec', actor, config.operator.autonomyLevel);
  let reviewedSha: string | null = null;
  let intentRecorded = false;
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
    reviewedSha = reviewed?.gitSha ?? feature.git_sha;
    await store.approveFeature(key, reviewedSha, (alreadyApproved) => {
      reviewed?.beforeCommit();
      const { spec } = featureDocument(store, config, feature);
      if (spec.openQuestions.length)
        throw new Error('Feature has unresolved product questions; incorporate --answers first');
      // One pending/approved pair per transition.
      // Replays validate the revision but neither mutate nor append another entry.
      if (!alreadyApproved && !intentRecorded) {
        append('pending');
        intentRecorded = true;
      }
    });
  } catch (error) {
    append('rejected');
    throw error;
  }
  if (!intentRecorded) return; // Idempotent replay: nothing transitioned.
  // A committed approval remains committed if confirmation logging fails.
  try {
    append('approved');
  } catch (cause) {
    throw new FeatureApprovedAuditPending(cause);
  }
}

export class FeatureApprovedAuditPending extends Error {
  constructor(cause: unknown) {
    super('Feature approved; audit confirmation pending. Inspect WorkStore before retrying.', {
      cause,
    });
  }
}

export async function runFeatureCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
  workerOptions: Pick<WorkerOptions, 'binaryArgs' | 'probe'> = {},
): Promise<void> {
  if (
    ['approve', 'rebase'].includes(argv[0]) ||
    (['spec', 'design'].includes(argv[0]) && argv.includes('--answers')) ||
    (argv[0] === 'run' && featureIngressActor() === 'human')
  )
    argv = await confirmHumanIngress(argv);
  const [command, key, ...rest] = argv;
  if (
    !/^FEAT-\d{3}$/.test(key ?? '') ||
    !(
      (command === 'spec' &&
        rest.length === 2 &&
        ['--request', '--answers'].includes(rest[0]) &&
        !rest[1].startsWith('-')) ||
      (command === 'run' &&
        (rest.length === 0 ||
          (rest.length === 1 && rest[0] === '--json') ||
          (rest[0] === '--request' &&
            !!rest[1] &&
            !rest[1].startsWith('-') &&
            (rest.length === 2 || (rest.length === 3 && rest[2] === '--json'))))) ||
      (command === 'approve' && rest.length === 0) ||
      (command === 'rebase' &&
        rest.length === 2 &&
        rest[0] === '--task' &&
        /^FEAT-\d{3}-T\d{2}$/.test(rest[1])) ||
      (['develop', 'review', 'qa'].includes(command) &&
        (rest.length === 0 ||
          (rest.length === 2 && rest[0] === '--task' && /^FEAT-\d{3}-T\d{2}$/.test(rest[1])))) ||
      (command === 'design' &&
        (rest.length === 0 ||
          (rest.length === 2 && rest[0] === '--answers' && !rest[1].startsWith('-')))) ||
      (command === 'show' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--json')))
    )
  )
    throw new CliUsageError(USAGE);
  let store: WorkStore | undefined;
  try {
    const config = loadProjectConfig(cwd, true);
    if (!config) throw new Error('feature requires a bound Git Project');
    if (command === 'run') assertFeatureRunIngress(config, argv);
    store = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
    if (command === 'run') {
      const json = rest.includes('--json');
      const summary = await runFeature(
        store,
        config,
        key,
        rest[0] === '--request' ? rest[1] : undefined,
        (args) => runFeatureCommand(args, cwd, json ? console.error : log, workerOptions),
        json ? console.error : log,
      );
      process.exitCode = summary.exit_code;
      if (json) log(JSON.stringify(summary, null, 2));
      return;
    }
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
    } else if (command === 'design') {
      if (!feature || feature.status !== 'approved')
        throw new Error('Architect requires an approved FeatureSpec');
      const { spec } = featureDocument(store, config, feature);
      if (spec.openQuestions.length)
        throw new Error('Approved FeatureSpec has unresolved questions');
      if (store.getDesign(key)) {
        if (rest.length) throw new Error('Design already registered; no answers expected');
        log(`${key}: design already registered (${store.getDesign(key)!.git_sha})`);
        return;
      }
      const taskKey = architectTaskKey(key);
      const decisions = store
        .listDecisions()
        .filter(
          (d) => d.blocks.includes(taskKey) && d.context.startsWith(`feature-design/${taskKey}/`),
        );
      const decision = decisions.find((d) => d.status !== 'answered') ?? decisions.at(-1);
      let revision;
      if (rest.length) {
        if (featureIngressActor() !== 'human')
          throw new Error('Architect answers require the human operator');
        if (!decision) throw new Error('Design is not awaiting answers');
        const answers = readTaskInput(cwd, path.relative(cwd, path.resolve(cwd, rest[1])));
        if (!answers.trim()) throw new Error('Answers must not be empty');
        revision = { gitSha: feature.git_sha, decisionId: decision.id, answers };
      } else if (decision) {
        log(`${key}: design requires --answers (${decision.id})`);
        process.exitCode = 3;
        return;
      }
      await runWorker(
        { task: taskKey, selectExecutor: true },
        {
          ...workerOptions,
          cwd,
          log,
          architect: { key, spec, gitSha: feature.git_sha, revision },
        },
      );
      const design = store.getDesign(key);
      if (design) log(`${key}: design registered (${design.git_sha})`);
    } else if (command === 'rebase') {
      const result = await rebaseFeatureTask(store, config, key, rest[1]);
      log(`${rest[1]}: ${store.getTask(rest[1])!.status} ${JSON.stringify(result)}`);
    } else if (command === 'review' || command === 'qa') {
      const input = reviewerRequest(
        store,
        config,
        key,
        rest[1],
        undefined,
        command === 'qa' ? 'qa' : 'review',
      );
      await runWorker(
        { task: input.task.key, selectExecutor: true },
        {
          ...workerOptions,
          cwd,
          log,
          reviewer: input,
          qa: command === 'qa',
        },
      );
    } else if (command === 'develop') {
      const input = developerRequest(store, config, key, rest[1]);
      if (!store.getTask(input.task.key)!.review_ref) {
        await runWorker(
          { task: input.task.key, selectExecutor: true },
          {
            ...workerOptions,
            cwd,
            log,
            developer: input,
          },
        );
      }
      const review = store.getTask(input.task.key)?.review_ref;
      if (review) {
        await pushDeveloperBranch(store, config, input.task.key, review);
        log(input.task.key + ': rama lista para revisión ' + JSON.stringify(review));
      }
    } else if (command === 'approve') {
      await approveFeature(store, config, key, 'human');
      log(`${key}: approved`);
    } else {
      if (!feature) throw new Error('Unknown Feature');
      const { spec, branch } = featureDocument(store, config, feature);
      const document = { spec, branch };
      const resultTaskKeys = new Set(
        store
          .listTasks()
          .filter((task) => task.feature_key === key)
          .map((task) => task.key),
      );
      const result = {
        ...feature,
        orchestrator: store.getFeatureRun(key)?.state ?? null,
        ...document,
        design: store.getDesign(key) ?? null,
        tasks: store
          .listTasks()
          .filter((task) => task.feature_key === key)
          .map((task) => ({
            ...task,
            last_review_failure: lastReviewFailure(store!, task),
            last_developer_failure: lastDeveloperFailure(store!, task),
          })),
        decisions: store
          .listDecisions()
          .filter(
            (d) =>
              d.blocks.includes(key) ||
              d.blocks.includes(architectTaskKey(key)) ||
              d.blocks.some((block) => resultTaskKeys.has(block)),
          ),
      };
      log(
        rest[0] === '--json'
          ? JSON.stringify(result, null, 2)
          : `${key}: ${feature.status}\n${JSON.stringify(document.spec.title)}\nBranch: ${document.branch}\nDocument: ${feature.doc_path}\nSHA: ${feature.git_sha}${result.design ? `\nDesign: ${result.design.doc_path}\nDesign SHA: ${result.design.git_sha}` : ''}\nTasks: ${JSON.stringify(result.tasks.map(({ key, status, review_ref, review_reports, test_reports, defect_context, last_review_failure, last_developer_failure }) => ({ key, status, review_ref, review_reports, test_reports, defect_context, last_review_failure, last_developer_failure })))}`,
      );
    }
  } catch (error) {
    throw new CliUsageError(`feature ${command}: ${(error as Error).message}`);
  } finally {
    store?.close();
  }
}
