import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { parse } from 'yaml';

import type { FeatureSpec } from '../../core/src/featureSpec.js';
import type { CascadeVerifier } from '../../core/src/modelTier.js';
import type { ProjectConfig } from '../../core/src/project.js';
import type { DagTask } from '../../core/src/taskDag.js';
import { recordAudit } from './auditLog.js';
import { matchesChangeZone, validateChangeZone } from './changeZones.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import { EVAL_CRITERION_TIMEOUT_MS } from './constants.js';
import { validateDeveloperTests } from './developerTests.js';
import { assertEvalIntegrity, evalChangedFiles } from './evalIntegrity.js';
import { evalGit } from './evalTasks.js';
import { guardProtectedPaths } from './executors/protectedPaths.js';
import { featureDocument } from './featureArtifacts.js';
import { taskBranchBase } from './taskBranchBase.js';
import { analyzeTaskDag, parseTaskDag, taskDeclaration } from './taskDag.js';
import type { ReviewRef, WorkStore } from './workstore/WorkStore.js';

export interface DeveloperRequest {
  key: string;
  approvedSpec: FeatureSpec;
  featureSha: string;
  designSha: string;
  design: string;
  task: DagTask;
}

/** Re-read registered artifacts and immutable declarations, never trust caller-supplied scope. */
export function developerRequest(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  taskKey?: string,
  owner?: string,
): DeveloperRequest {
  const feature = store.getFeature(key);
  if (feature?.status !== 'approved') throw new Error('Developer requires an approved FeatureSpec');
  const design = store.getDesign(key);
  if (!design) throw new Error('Developer requires a registered design');
  const { spec } = featureDocument(store, config, feature);
  if (spec.openQuestions.length) throw new Error('Approved FeatureSpec has unresolved questions');
  const source = store.getTask(key)!.worktree_ref!;
  const dag = parseTaskDag(parse(readTaskInput(source, design.dag_path)));
  if (!analyzeTaskDag(dag, spec).valid)
    throw new Error('Registered design DAG does not match FeatureSpec');
  for (const declaration of dag.tasks) {
    const task = store.getTask(declaration.key);
    if (
      task?.feature_key !== key ||
      task.type !== declaration.type ||
      task.agent_role !== declaration.agentRole ||
      task.declaration !== taskDeclaration(key, declaration) ||
      JSON.stringify(
        store
          .listTaskDependencies(declaration.key)
          .map((d) => d.depends_on_key)
          .sort(),
      ) !== JSON.stringify([...declaration.dependsOn].sort())
    )
      throw new Error('Registered design and imported task declaration differ');
  }
  const eligible = (task: DagTask) => {
    const record = store.getTask(task.key)!;
    return (
      task.type === 'code' &&
      task.agentRole === 'developer' &&
      (['READY', 'WAITING_QUOTA'].includes(record.status) ||
        (owner && record.lease_owner === owner && ['LEASED', 'RUNNING'].includes(record.status))) &&
      store.canStart(task.key)
    );
  };
  // An explicit retry returns the same review; an implicit call handles at most one READY task.
  const task = taskKey
    ? dag.tasks.find((t) => t.key === taskKey)
    : (dag.tasks.find(eligible) ??
      dag.tasks.find((t) => t.type === 'code' && !!store.getTask(t.key)?.review_ref));
  if (!task || (!eligible(task) && !store.getTask(task.key)?.review_ref))
    throw new Error(
      'No eligible READY code task; use --task to inspect a previously developed task',
    );
  const record = store.getTask(task.key)!;
  if (
    record.review_ref &&
    (record.lease_owner || !['REVIEW', 'QA', 'DONE'].includes(record.status))
  )
    throw new Error('Developer review registration requires human reconciliation before retrying');
  if (task.type !== 'code' || task.agentRole !== 'developer' || !task.changeZones?.length)
    throw new Error('Developer task requires code, developer role and changeZones');
  for (const zone of [...task.changeZones, ...(task.testZones ?? [])])
    validateChangeZone(config.repoRoot, zone, config.operator.protectedPaths ?? []);
  return {
    key,
    approvedSpec: spec,
    featureSha: feature.git_sha,
    designSha: design.git_sha,
    design: readTaskInput(source, design.doc_path),
    task,
  };
}

/** Standard runnable JS/TS tests; fixture/config files never satisfy test-first. */
export function isDeveloperTest(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file);
}

/** Check the complete diff (both index and disk, including ignored files) before any verifier/commit. */
export function guardDeveloperChanges(
  input: DeveloperRequest,
  config: ProjectConfig,
  tree: string,
  base: string,
): string[] {
  assertEvalIntegrity(
    { baseCommit: base, protectedPaths: config.operator.protectedPaths, allowTestChanges: true },
    tree,
  );
  const files = evalChangedFiles(tree, base);
  const baseFiles = new Set(
    evalGit(tree, ['ls-tree', '-r', '--name-only', '-z', base]).split('\0'),
  );
  const committable = new Set(
    evalGit(tree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'),
  );
  for (const file of files) {
    taskPath(tree, file);
    if (!committable.has(file) && fs.existsSync(taskPath(tree, file)))
      throw new Error('Developer changed an ignored file; human review required');
    if (
      ![
        ...input.task.changeZones!,
        ...(isDeveloperTest(file) ? (input.task.testZones ?? []) : []),
      ].some((zone) => {
        const literal = zone.replace(/\/$/, '');
        const directory =
          zone.endsWith('/') ||
          (!zone.includes('*') &&
            fs.existsSync(taskPath(config.repoRoot, literal)) &&
            fs.statSync(taskPath(config.repoRoot, literal)).isDirectory());
        const candidates = [file];
        if (isDeveloperTest(file)) {
          const source = file.replace(/\.(test|spec)(?=\.[cm]?[jt]sx?$)/i, '');
          candidates.push(source);
          if (source.startsWith('server/__tests__/'))
            candidates.push(source.replace('server/__tests__/', 'server/src/'));
        }
        return candidates.some((candidate) => matchesChangeZone(candidate, zone, directory));
      })
    )
      throw new Error(`Developer changeZones exceeded: ${file}; human review required`);
  }
  const tests = files.filter(
    (file) =>
      isDeveloperTest(file) &&
      fs.existsSync(taskPath(tree, file)) &&
      fs.statSync(taskPath(tree, file)).size > 0 &&
      // A staged-only change or deletion is not executable acceptance evidence.
      (!baseFiles.has(file) ||
        Number(evalGit(tree, ['diff', '--numstat', base, '--', file]).split('\t')[0]) > 0),
  );
  if (!tests.length)
    throw new Error('Developer requires an added or adjusted acceptance/reproduction test');
  for (const file of tests)
    validateDeveloperTests(
      file,
      fs.readFileSync(taskPath(tree, file), 'utf8'),
      baseFiles.has(file) ? evalGit(tree, ['show', `${base}:${file}`]) : '',
    );
  return tests;
}

/** Mandatory final verification also when model escalation is disabled. */
export function developerVerifier(config: ProjectConfig, key: string): CascadeVerifier {
  const cascade = config.operator.modelTiers?.cascade;
  return (
    cascade?.verifiers[key] ??
    cascade?.defaultVerifier ?? {
      commands: [
        {
          argv: [
            process.execPath,
            'node_modules/typescript/bin/tsc',
            '--noEmit',
            '--incremental',
            'false',
          ],
          timeoutMs: EVAL_CRITERION_TIMEOUT_MS,
        },
      ],
    }
  );
}

/** Push has a fixed task destination. Neither defaultBranch nor a configured remote name is a refspec. */
export async function pushDeveloperBranch(
  store: WorkStore,
  config: ProjectConfig,
  taskKey: string,
  review: ReviewRef,
): Promise<void> {
  const push = config.operator.developer?.pushBranch;
  if (
    review.branch !== `sa/${taskKey}-developer` ||
    !/^[a-f0-9]{40,64}$/.test(review.sha) ||
    ['main', 'master', config.project.repo.defaultBranch].includes(review.branch)
  )
    throw new Error('Developer push_main = deny; invalid branch publication target');
  const tree = store.getTask(taskKey)?.worktree_ref;
  if (
    taskBranchBase(config.repoRoot, review.branch, config.project.repo.defaultBranch) !==
    review.base
  )
    throw new Error('Review base differs from registered trusted base');
  if (
    !tree ||
    evalGit(tree, ['rev-parse', 'HEAD']) !== review.sha ||
    evalGit(tree, ['symbolic-ref', '--short', 'HEAD']) !== review.branch ||
    evalGit(tree, ['status', '--porcelain'])
  )
    throw new Error('Review branch changed before publication');
  if (!push?.enabled) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(push.remote))
    throw new Error('Invalid configured remote name');
  const url = evalGit(config.repoRoot, ['remote', 'get-url', '--push', push.remote]);
  if (!url || /[\r\n]/.test(url) || url.startsWith('-'))
    throw new Error('Invalid resolved push URL');
  await store.withIdempotency(`developer-push/${taskKey}/${review.sha}/${push.remote}`, () => {
    const gate = guardProtectedPaths({
      cwd: tree,
      base: review.base,
      operator: config.operator,
      projectId: store.projectId,
      taskKey,
    });
    if (gate.decision.outcome !== 'allow')
      throw new Error('Protected paths require human review before push');
    const audit = (status: string) =>
      recordAudit(
        'push_branch',
        'task',
        taskKey,
        { status, detail: JSON.stringify(review) },
        { projectId: store.projectId, actorType: 'system', taskKey },
      );
    audit('pending');
    try {
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=', 'push', '--', url, `${review.sha}:refs/heads/${review.branch}`],
        { cwd: config.repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      audit('failed');
      // Git errors may contain credentials embedded in the resolved remote URL.
      throw new Error(
        'Runtime branch push failed; local review_ref retained. Reconcile publication before retrying.',
      );
    }
    audit('published');
  });
}
