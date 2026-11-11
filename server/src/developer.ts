import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import type { FeatureSpec } from '../../core/src/featureSpec.js';
import type { CascadeVerifier } from '../../core/src/modelTier.js';
import type { ProjectConfig } from '../../core/src/project.js';
import type { DagTask } from '../../core/src/taskDag.js';
import { recordAudit } from './auditLog.js';
import { matchesChangeZone, validateChangeZone } from './changeZones.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import { EVAL_CRITERION_TIMEOUT_MS } from './constants.js';
import {
  ChangeZonesExceededError,
  DeveloperGuardError,
  developerGuardFailure,
  MissingTestError,
} from './developerFailure.js';
import { withoutOperatorToken } from './featureIngress.js';
export { ChangeZonesExceededError, MissingTestError } from './developerFailure.js';
import { validateDeveloperTests } from './developerTests.js';
import { assertEvalIntegrity, evalChangedFiles } from './evalIntegrity.js';
import { evalGit } from './evalTasks.js';
import { guardProtectedPaths } from './executors/protectedPaths.js';
import { featureDocument } from './featureArtifacts.js';
import { featureBaseBranch } from './featureRunBase.js';
import { assertDirectRef } from './gitPublication.js';
import { isReviewFailure, isSuccessfulTaskStep } from './reviewAttempts.js';
import { taskBranchBase } from './taskBranchBase.js';
import { approvedTaskDescription } from './taskChangeDecisions.js';
import {
  analyzeTaskDag,
  deferredAcceptanceCoverage,
  parseTaskDag,
  taskDeclaration,
} from './taskDag.js';
import { TASK_REBASE_REASON, taskRebaseHistory } from './taskRebaseHistory.js';
import {
  isExecutedTest,
  serverTestMirrors,
  testDiscovery,
  webviewTestMirrors,
} from './testRoots.js';
import { verifierFailure } from './verifierFeedback.js';
import { isVerifierInfrastructureFailure } from './verifierInfrastructure.js';
import type { ReviewRef, TaskRecord, WorkStore } from './workstore/WorkStore.js';

/** DAG declarations remain immutable; only the execution role is routed. */
export function isQaAuthorTask(task: Pick<DagTask, 'agentRole'>): boolean {
  return ['qa', 'test', 'qa-author'].includes(task.agentRole);
}

function isDevelopableTask(task: DagTask): boolean {
  return (
    (['code', 'doc'].includes(task.type) && task.agentRole === 'developer') ||
    (task.type !== 'doc' && isQaAuthorTask(task))
  );
}

export function isDocumentationPath(file: string): boolean {
  return file.endsWith('.md') || file.startsWith('docs/');
}

/** Fixtures/helpers belong under these test roots, never under product source directories.
 * Wider than the executed patterns on purpose (e.g. e2e/fixtures beside e2e/tests). */
export const QA_AUTHOR_TEST_ROOTS = ['e2e/', 'server/__tests__/', 'webview-ui/test/'] as const;

export function isQaAuthorPath(file: string): boolean {
  return QA_AUTHOR_TEST_ROOTS.some((prefix) => file.startsWith(prefix));
}

/** Durable failure data survives the retry claim (which clears blocked_reason). */
export function lastDeveloperFailure(store: WorkStore, task: TaskRecord) {
  if (!isDevelopableTask({ type: task.type, agentRole: task.agent_role } as DagTask)) return null;
  const event = store
    .listDomainEvents(task.key)
    .filter((event) => event.type === 'TASK_TRANSITIONED')
    .filter(
      (e) =>
        isSuccessfulTaskStep(e) ||
        ((e.to_status === 'FAILED_RETRYABLE' ||
          e.to_status === 'FAILED_FINAL' ||
          (e.to_status === 'WAITING_HUMAN' &&
            (!!developerGuardFailure(e.reason) ||
              e.reason.startsWith('Worker failed (') ||
              e.reason.startsWith('Execution failed')))) &&
          !isReviewFailure(e.reason)),
    )
    .at(-1);
  if (!event || isSuccessfulTaskStep(event)) return null;
  const diagnostic = developerGuardFailure(event.reason);
  if (diagnostic) return { ...diagnostic, reason: event.reason, created_at: event.created_at };
  return { reason: event.reason, created_at: event.created_at };
}

/** Mirror suffix variants stay in the same relative directory and source extension. */
export function developerScope(task: DagTask, root: string) {
  const directories = (task.changeZones ?? []).filter((zone) => {
    const literal = zone.replace(/\/$/, '');
    return (
      zone.endsWith('/') ||
      (!zone.includes('*') &&
        fs.statSync(taskPath(root, literal), { throwIfNoEntry: false })?.isDirectory())
    );
  });
  const mirroredTestZones = (task.changeZones ?? []).flatMap((zone) => {
    // Webview tests are flat (vitest include test/*.test.ts), named after the source file;
    // same mirror as qaTestFiles. Directories and globs imply no test files.
    if (zone.startsWith('webview-ui/src/'))
      return !directories.includes(zone) && !zone.includes('*') && /\.[cm]?[jt]sx?$/i.test(zone)
        ? webviewTestMirrors(zone, root)
        : [];
    return serverTestMirrors(zone, root, directories.includes(zone));
  });
  return {
    changeZones: task.changeZones ?? [],
    documentationOnly: task.type === 'doc',
    testZones: task.testZones ?? [],
    directoryChangeZones: directories,
    mirroredTestZones,
    ...(isQaAuthorTask(task) ? { testRoots: QA_AUTHOR_TEST_ROOTS } : {}),
    testDiscovery: testDiscovery(root),
    coreTestRule: `Tests for core/src/ belong under ${testDiscovery(root).server.join(', ')} in the core/ mirror. Use only configured suffixes. Never place tests in core/src/, even without testZones.`,
    testFrameworkRule:
      "Unit tests use Vitest (import { describe, expect, it } from 'vitest'); never node:test or another runner. The runtime only executes Vitest and Playwright specs.",
    fileWriteRule:
      'Create and edit files only with the file-edit tool (apply_patch, Edit/Write), never through shell writes (Set-Content, Out-File, >, tee, node -e). Containment rejects shell writes whose text mentions .git or .claude; use the diagnostic to correct the tool, never bypass the rule.',
    generatedFilesRule:
      'Never edit core/src/messages.ts or e2e/README.md by hand. Edit core/asyncapi.yaml or e2e specs instead; the runtime regenerates these outputs automatically before verification and includes them in its commit.',
    testTempRule:
      'Tests create scratch directories and fixture repos under os.tmpdir() (fs.mkdtempSync(path.join(os.tmpdir(), ...))) and remove them; never inside the worktree (path.resolve, process.cwd()). A leftover nested .git stops the retry.',
    colocatedTestRule: `Tests must match ${testDiscovery(root).patterns.join(', ')}; never next to sources. Webview mirrors: ${webviewTestMirrors('webview-ui/src/<basename>.ts', root).join(', ')}. Other locations never run and are rejected.`,
  };
}

/** Only an explicit failed-task retry, after claim/closure, may discard the failed edits.
 * Unlink junctions first; Git must never traverse them while resetting/cleaning. */
export function resetDeveloperWorktree(
  store: WorkStore,
  record: TaskRecord,
  config: ProjectConfig,
  tree: string,
  branch: string,
  base: string,
): void {
  assertDirectRef(config.repoRoot, `refs/heads/${branch}`);
  const expectedTree = taskPath(config.repoRoot, `.worktrees/${record.key}`);
  if (
    path.resolve(tree) !== expectedTree ||
    record.branch !== branch ||
    path.resolve(record.worktree_ref ?? '') !== expectedTree ||
    branch !== `sa/${record.key}-developer` ||
    evalGit(tree, ['symbolic-ref', '--short', 'HEAD']) !== branch
  )
    throw new Error('Developer retry worktree changed; human reconciliation required');
  const rebases = taskRebaseHistory(store, record.key);
  const refs = [...(record.review_reports ?? []), ...(record.test_reports ?? [])].map(
    (entry) => entry.review_ref,
  );
  // Rebased tips are runtime-authored rework inputs, even when their patch needs a fresh review.
  refs.push(...rebases.map((rebase) => rebase.after));
  // A prior reviewed/QA commit is valid rework input; otherwise only the pinned base is trusted.
  const lastCommit = store
    .listDomainEvents(record.key)
    .filter((event) => event.type === 'TASK_TRANSITIONED')
    .map((event) =>
      event.actor === 'operator' && event.reason.startsWith(TASK_REBASE_REASON)
        ? (JSON.parse(event.reason.slice(TASK_REBASE_REASON.length)) as { after: ReviewRef }).after
            .sha
        : /^Runtime commit ([a-f0-9]{40,64})$/.exec(event.reason)?.[1],
    )
    .filter((sha) => sha !== undefined)
    .at(-1);
  const head = lastCommit ?? base;
  if (
    refs.some(
      (ref) =>
        ref.branch !== branch ||
        (ref.base !== base && !rebases.some((rebase) => rebase.before.base === ref.base)),
    ) ||
    (lastCommit && !refs.some((ref) => ref.sha === lastCommit && ref.base === base)) ||
    evalGit(tree, ['rev-parse', 'HEAD']) !== head
  )
    throw new Error('Developer retry HEAD changed; human reconciliation required');
  const links: string[] = [];
  const inspect = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const child = path.join(directory, name);
      const stat = fs.lstatSync(child);
      if (name === '.git') {
        if (directory !== tree || !stat.isFile() || stat.nlink !== 1)
          throw new Error('Developer retry contains unexpected Git metadata');
      } else if (stat.isSymbolicLink()) links.push(child);
      else if (stat.isDirectory()) inspect(child);
      else if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Developer retry contains a special file');
    }
  };
  inspect(tree);
  for (const link of links) fs.unlinkSync(link);
  evalGit(tree, ['reset', '--hard', head]);
  evalGit(tree, ['clean', '-fdx']);
  assertEvalIntegrity(
    {
      baseCommit: base,
      expectedHead: head,
      allowTestChanges: true,
      protectedPaths: config.operator.protectedPaths,
    },
    tree,
  );
  if (evalGit(tree, ['status', '--porcelain', '--untracked-files=all']))
    throw new Error('Developer retry reset left changes');
}

export interface DeveloperRequest {
  designReviewHistory?: NonNullable<
    import('./workstore/WorkStore.js').FeatureRunState['designReviews']
  >[string]['history'];
  key: string;
  approvedSpec: FeatureSpec;
  featureSha: string;
  designSha: string;
  design: string;
  task: DagTask;
  reviewFindings?: import('../../core/src/reviewReport.js').ReviewReport['findings'];
  reworkAttempt?: number;
  qaDefects?: import('./workstore/WorkStore.js').DefectContext[];
  previousFailure?: ReturnType<typeof lastDeveloperFailure>;
  retryReason?: string | null;
  deferredCoverage?: Record<string, string[]>;
  allowedScope?: ReturnType<typeof developerScope>;
}

/** Keep the authoritative request intact for guards; only narrow the author's prompt. */
export function developerBrief(input: DeveloperRequest): string {
  if (!isQaAuthorTask(input.task)) return JSON.stringify(input);
  const { design: _design, ...scoped } = input;
  return JSON.stringify({
    ...scoped,
    approvedSpec: {
      ...input.approvedSpec,
      acceptance: input.approvedSpec.acceptance.filter((ac) =>
        input.task.acceptanceRefs.includes(ac.id),
      ),
    },
    contextRule:
      'Author only the assigned acceptance tests. Inspect the task files and their fixtures/helpers, not the whole repository. The runtime executes only authored specs; do not run suites yourself. Design is referenced by designSha; task description and assigned acceptance criteria define this scope.',
  });
}

/** Re-read registered artifacts and immutable declarations, never trust caller-supplied scope. */
export function developerRequest(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  taskKey?: string,
  owner?: string,
  reviewing = false,
): DeveloperRequest {
  const feature = store.getFeature(key);
  if (!feature || !['approved', 'ready_to_merge'].includes(feature.status))
    throw new Error('Developer requires an approved FeatureSpec');
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
      isDevelopableTask(task) &&
      (['READY', 'WAITING_QUOTA'].includes(record.status) ||
        (taskKey === task.key && record.status === 'FAILED_RETRYABLE' && !record.review_ref) ||
        (owner && record.lease_owner === owner && ['LEASED', 'RUNNING'].includes(record.status))) &&
      store.canStart(task.key)
    );
  };
  // An explicit retry returns the same review; an implicit call handles at most one READY task.
  const task = taskKey
    ? dag.tasks.find((t) => t.key === taskKey)
    : (dag.tasks.find(eligible) ??
      dag.tasks.find((t) => isDevelopableTask(t) && !!store.getTask(t.key)?.review_ref));
  if (!task || (!eligible(task) && !store.getTask(task.key)?.review_ref))
    throw new Error(
      'No eligible READY code, doc or test task; use --task to inspect a previously developed task',
    );
  const record = store.getTask(task.key)!;
  if (
    !reviewing &&
    record.review_ref &&
    (record.lease_owner || !['REVIEW', 'QA', 'DONE'].includes(record.status))
  )
    throw new Error('Developer review registration requires human reconciliation before retrying');
  if (!isDevelopableTask(task) || !task.changeZones?.length)
    throw new Error('Developer task requires a code/doc developer or qa/test role and changeZones');
  for (const zone of [...task.changeZones, ...(task.testZones ?? [])])
    validateChangeZone(config.repoRoot, zone, config.operator.protectedPaths ?? []);
  if (task.type === 'doc' && task.changeZones.some((zone) => !isDocumentationPath(zone)))
    throw new Error('Documentation tasks require documentation-only changeZones');
  return {
    key,
    approvedSpec: spec,
    featureSha: feature.git_sha,
    designSha: design.git_sha,
    design: readTaskInput(source, design.doc_path),
    task: {
      ...task,
      description: approvedTaskDescription(store.listDecisions(), record) ?? task.description,
    },
    ...(reviewing
      ? {
          deferredCoverage: deferredAcceptanceCoverage(
            dag,
            task.key,
            (key) => store.getTask(key)?.status === 'DONE',
          ),
        }
      : {}),
    previousFailure: lastDeveloperFailure(store, record),
    designReviewHistory: store.getFeatureRun(key)?.state.designReviews?.[record.key]?.history,
    retryReason:
      store
        .listDomainEvents(record.key)
        .filter((event) => event.type === 'TASK_TRANSITIONED')
        .filter((event) => event.reason.startsWith('manual_retry: '))
        .at(-1)?.reason ?? null,
    allowedScope: developerScope(task, config.repoRoot),
    ...(record.test_reports?.some((r) => r.report.verdict === 'fail')
      ? {
          qaDefects: store
            .listTasks()
            .flatMap((t) => (t.defect_context?.task === record.key ? [t.defect_context] : [])),
          reworkAttempt:
            record.attempt +
            (record.status === 'FAILED_RETRYABLE' &&
            !isVerifierInfrastructureFailure(record.blocked_reason) &&
            !developerGuardFailure(record.blocked_reason)
              ? 1
              : 0),
        }
      : {}),
    ...(record.review_reports?.length
      ? {
          reviewFindings: record.review_reports.at(-1)!.report.findings,
          reworkAttempt:
            record.attempt +
            (record.status === 'FAILED_RETRYABLE' &&
            !isVerifierInfrastructureFailure(record.blocked_reason) &&
            !developerGuardFailure(record.blocked_reason)
              ? 1
              : 0),
        }
      : {}),
  };
}

/** Standard runnable JS/TS tests; fixture/config files never satisfy test-first. */
export function isDeveloperTest(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file);
}

/** Check the complete diff (both index and disk, including ignored files) before any verifier/commit. */
/** Test runs by the agent leave Vite/Vitest caches (results.json, deps) under ignored
 * node_modules/.vite. They are data, never code: delete them (never exempt them) before
 * integrity checks. Real directories only; any link aborts so nothing is followed. */
export function removeAgentToolCaches(tree: string): void {
  for (const root of ['node_modules', 'server/node_modules', 'webview-ui/node_modules']) {
    const cache = path.join(tree, root, '.vite');
    const parent = path.join(tree, root);
    const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
    // A linked node_modules is the shared dependency tree: never touch it.
    if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) continue;
    const stat = fs.lstatSync(cache, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink() || containsLink(cache))
      throw new Error(`Refusing to remove tool cache with links: ${root}/.vite`);
    fs.rmSync(cache, { recursive: true, force: true });
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  }
  // Reporter/temp outputs of the repo's own Vitest config (gitignored, never code).
  for (const root of ['', 'server', 'webview-ui'])
    for (const name of ['allure-results', '.vitest-tmp']) {
      const output = path.join(tree, root, name);
      const stat = fs.lstatSync(output, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Refusing to remove tool output: ${path.join(root, name)}`);
      // .vitest-tmp holds eval repos whose node_modules are junctions: drop the links, never their targets.
      removeUnlinkingLinks(output);
    }
}

function removeUnlinkingLinks(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fs.unlinkSync(entryPath);
    else if (entry.isDirectory()) removeUnlinkingLinks(entryPath);
    else fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(dir);
}

function containsLink(dir: string): boolean {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && containsLink(path.join(dir, entry.name))) return true;
  }
  return false;
}

export function guardDeveloperChanges(
  input: DeveloperRequest,
  config: ProjectConfig,
  tree: string,
  base: string,
  expectedHead = base,
): string[] {
  try {
    preflightDeveloperTree(config, tree, base, expectedHead);
    return checkDeveloperChanges(input, config, tree, base);
  } catch (error) {
    if (error instanceof ChangeZonesExceededError || error instanceof MissingTestError) throw error;
    throw new DeveloperGuardError(
      verifierFailure('tests', [], [], 'fail', String(error), [
        tree,
        process.env.HOME ?? '',
        process.env.USERPROFILE ?? '',
      ]).detail,
      { cause: error },
    );
  }
}

/** Cheap, non-executing preflight shared by every Developer validation boundary. */
function preflightDeveloperTree(
  config: ProjectConfig,
  tree: string,
  base: string,
  expectedHead: string,
): void {
  removeAgentToolCaches(tree);
  assertEvalIntegrity(
    {
      baseCommit: base,
      expectedHead,
      protectedPaths: config.operator.protectedPaths,
      allowTestChanges: true,
    },
    tree,
  );
  const tracked = evalGit(tree, ['ls-tree', '-r', '--name-only', '-z', base]).split('\0');
  const inspect = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const child = path.join(directory, entry.name);
      const relative = path.relative(tree, child).replace(/\\/g, '/');
      if (
        /^(?:tmp|temp|scratch|\.tmp|\.cache|__pycache__|\.pytest_cache)(?:[-_.]|$)/i.test(
          entry.name,
        ) &&
        !tracked.some((file) => file.startsWith(relative + '/'))
      )
        throw new Error(
          `temporary_directory: ${relative}; remove scratch/tool output and create fixtures under os.tmpdir()`,
        );
      inspect(child);
    }
  };
  inspect(tree);
}

function checkDeveloperChanges(
  input: DeveloperRequest,
  config: ProjectConfig,
  tree: string,
  base: string,
): string[] {
  const files = evalChangedFiles(tree, base);
  const baseFiles = new Set(
    evalGit(tree, ['ls-tree', '-r', '--name-only', '-z', base]).split('\0'),
  );
  const committable = new Set(
    evalGit(tree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'),
  );
  const scope = developerScope(input.task, config.repoRoot);
  const qaAuthor = isQaAuthorTask(input.task);
  const offending: string[] = [];
  for (const file of files) {
    taskPath(tree, file);
    if (!committable.has(file) && fs.existsSync(taskPath(tree, file)))
      throw new Error('Developer changed an ignored file; human review required');
    if (
      (input.task.type === 'doc' && !isDocumentationPath(file)) ||
      (qaAuthor && !isQaAuthorPath(file)) ||
      // Only these roots are ever executed (server/webview Vitest include, Playwright),
      // unless the task declares the location as an explicit testZone; core/ never.
      // Deleting a misplaced test is the fix, never a violation.
      (isDeveloperTest(file) &&
        fs.existsSync(taskPath(tree, file)) &&
        (file.startsWith('core/') ||
          (!isExecutedTest(file, tree) &&
            !(input.task.testZones ?? []).some((zone) =>
              file.startsWith(zone.replace(/\*.*$/, '').replace(/\/$/, '')),
            ))))
    ) {
      offending.push(file);
      continue;
    }
    if (
      ![
        ...input.task.changeZones!,
        ...(input.task.type !== 'doc' && (qaAuthor || isDeveloperTest(file))
          ? (input.task.testZones ?? [])
          : []),
        ...(input.task.type !== 'doc' && !qaAuthor && isDeveloperTest(file)
          ? scope.mirroredTestZones
          : []),
      ].some((zone) => {
        const literal = zone.replace(/\/$/, '');
        const directory =
          zone.endsWith('/') ||
          (!zone.includes('*') &&
            fs.existsSync(taskPath(config.repoRoot, literal)) &&
            fs.statSync(taskPath(config.repoRoot, literal)).isDirectory());
        const candidates = [file];
        if (file === 'core/src/messages.ts' && files.includes('core/asyncapi.yaml'))
          candidates.push('core/asyncapi.yaml');
        if (file === 'e2e/README.md')
          candidates.push(...files.filter((changed) => changed.startsWith('e2e/')));
        if (!qaAuthor && isDeveloperTest(file)) {
          const source = file.replace(/\.(test|spec)(?=\.[cm]?[jt]sx?$)/i, '');
          candidates.push(source);
          if (source.startsWith('server/__tests__/'))
            candidates.push(source.replace('server/__tests__/', 'server/src/'));
        }
        return candidates.some((candidate) => matchesChangeZone(candidate, zone, directory));
      })
    )
      offending.push(file);
  }
  if (offending.length) throw new ChangeZonesExceededError(offending);
  if (input.task.type === 'doc') return [];
  const tests = files.filter(
    (file) =>
      isDeveloperTest(file) &&
      fs.existsSync(taskPath(tree, file)) &&
      fs.statSync(taskPath(tree, file)).size > 0 &&
      // A staged-only change or deletion is not executable acceptance evidence.
      (!baseFiles.has(file) ||
        Number(evalGit(tree, ['diff', '--numstat', base, '--', file]).split('\t')[0]) > 0),
  );
  if (!tests.length) throw new MissingTestError();
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

/** Fixed repository generators, never commands supplied by the model. A repository
 * without the generator script (other Managed Projects, test fixtures) is skipped. */
export function developerGeneratorCommands(files: readonly string[], tree: string) {
  const has = (script: string) => fs.existsSync(path.join(tree, script));
  return [
    ...(has('scripts/generate-messages.ts') &&
    files.some((file) => ['core/asyncapi.yaml', 'core/src/messages.ts'].includes(file))
      ? [
          {
            argv: [
              process.execPath,
              'node_modules/tsx/dist/cli.mjs',
              'scripts/generate-messages.ts',
            ],
            output: 'core/src/messages.ts',
          },
        ]
      : []),
    ...(has('scripts/generate-e2e-inventory.mjs') && files.some((file) => file.startsWith('e2e/'))
      ? [
          {
            argv: [process.execPath, 'scripts/generate-e2e-inventory.mjs'],
            output: 'e2e/README.md',
          },
        ]
      : []),
  ];
}

/** Mandatory for every Developer/cascade attempt, regardless of Operator verifier overrides. */
export function developerStyleCommands(
  tree: string,
  base: string,
  fix = false,
): CascadeVerifier['commands'] {
  const files = evalChangedFiles(tree, base).filter((file) => fs.existsSync(taskPath(tree, file)));
  const scripts = files.filter((file) => /\.[cm]?[jt]sx?$/i.test(file));
  const eslintConfig = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs'].find((file) =>
    fs.existsSync(taskPath(tree, file)),
  );
  // Preserve ESLint's per-file lookup for nested workspaces (e.g. webview-ui).
  const hasNestedConfig = scripts.some((file) => {
    let directory = path.posix.dirname(file);
    while (directory !== '.') {
      if (
        ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs'].some((name) =>
          fs.existsSync(taskPath(tree, `${directory}/${name}`)),
        )
      )
        return true;
      directory = path.posix.dirname(directory);
    }
    return false;
  });
  return [
    ...(files.length
      ? [
          {
            argv: [
              process.execPath,
              'node_modules/prettier/bin/prettier.cjs',
              fix ? '--write' : '--check',
              '--ignore-unknown',
              // Pin root configuration/ignore to the task checkout, never the linked CLI's repo.
              ...(fs.existsSync(taskPath(tree, '.prettierrc.json'))
                ? ['--config', '.prettierrc.json']
                : []),
              ...(fs.existsSync(taskPath(tree, '.prettierignore'))
                ? ['--ignore-path', '.prettierignore']
                : []),
              '--',
              ...files,
            ],
            timeoutMs: EVAL_CRITERION_TIMEOUT_MS,
          },
        ]
      : []),
    ...(scripts.length
      ? [
          {
            argv: [
              process.execPath,
              'node_modules/eslint/bin/eslint.js',
              '--no-cache',
              ...(eslintConfig && !hasNestedConfig ? ['--config', eslintConfig] : []),
              ...(fix ? ['--fix'] : []),
              '--',
              ...scripts,
            ],
            timeoutMs: EVAL_CRITERION_TIMEOUT_MS,
          },
        ]
      : []),
  ];
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
    taskBranchBase(
      config.repoRoot,
      review.branch,
      featureBaseBranch(store, config, store.getTask(taskKey)!.feature_key!),
    ) !== review.base
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
        {
          env: withoutOperatorToken(process.env),
          cwd: config.repoRoot,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
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
