import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

import * as contract from '../../core/schemas/review-report.schema.json';
import type { NewHumanDecision } from '../../core/src/humanDecision.js';
import type { ProjectConfig } from '../../core/src/project.js';
import type { ReviewReport } from '../../core/src/reviewReport.js';
import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { type DeveloperRequest, developerRequest } from './developer.js';
import { evalGit } from './evalTasks.js';
import { excludeCandidate, launchBlock, type SelectionSnapshot } from './executorSelection.js';
import { isFailedReview } from './reviewAttempts.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';
import { taskBranchBase } from './taskBranchBase.js';
import { hasCurrentApproval } from './taskRebaseHistory.js';
import type { ReviewRef, WorkStore } from './workstore/WorkStore.js';

const validateReport = compileSchema<ReviewReport>(contract);

export interface ReviewerRequest extends DeveloperRequest {
  reviewRef: ReviewRef;
  developerExecutor: 'claude' | 'codex';
  worktree: string;
  files: string[];
  diff: string;
}

/** Bound Git output, no external diff/textconv, paths come exclusively from the registered commits. */
export function reviewerRequest(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  taskKey?: string,
  owner?: string,
  phase: 'review' | 'qa' = 'review',
): ReviewerRequest {
  const label = phase === 'qa' ? 'QA' : 'Reviewer';
  const availabilityWaiting = (task: { key: string; status: string }) => {
    const gates = store
      .listDecisions()
      .filter((d) => d.status !== 'answered' && d.blocks.includes(task.key));
    return (
      task.status === 'WAITING_HUMAN' &&
      gates.length > 0 &&
      gates.every((d) => d.context.startsWith('executor-availability/'))
    );
  };
  const record = taskKey
    ? store.getTask(taskKey)
    : store
        .listTasks()
        .find(
          (t) =>
            t.feature_key === key &&
            t.review_ref &&
            (availabilityWaiting(t) ||
              (phase === 'qa'
                ? t.status === 'QA'
                : ['REVIEW', 'WAITING_QUOTA'].includes(t.status) || isFailedReview(store, t))),
        );
  const availabilityWait = record ? availabilityWaiting(record) : false;
  if (
    !record?.review_ref ||
    record.feature_key !== key ||
    !(owner && record.lease_owner === owner && record.status === 'RUNNING'
      ? true
      : !record.lease_owner &&
        (phase === 'qa'
          ? record.status === 'QA' || availabilityWait
          : availabilityWait ||
            ['REVIEW', 'WAITING_QUOTA'].includes(record.status) ||
            isFailedReview(store, record)))
  )
    throw new Error(
      phase === 'qa'
        ? 'QA requires a QA task with a valid review_ref'
        : 'Reviewer requires a REVIEW task with a valid review_ref',
    );
  if (phase === 'qa') {
    if (!hasCurrentApproval(store, record.key))
      throw new Error('QA requires an approved review for the matching SHA');
  }
  // Same artifact/declaration validation as Developer; reviewer-owned runs may retain review_ref.
  const input = developerRequest(store, config, key, record.key, owner, true);
  const ref = record.review_ref;
  const tree = record.worktree_ref;
  if (
    !tree ||
    ref.branch !== `sa/${record.key}-developer` ||
    !/^[a-f0-9]{40,64}$/.test(ref.sha) ||
    !/^[a-f0-9]{40,64}$/.test(ref.base) ||
    taskBranchBase(config.repoRoot, ref.branch, config.project.repo.defaultBranch) !== ref.base ||
    evalGit(config.repoRoot, ['rev-parse', `refs/heads/${ref.branch}`]) !== ref.sha ||
    evalGit(tree, ['rev-parse', 'HEAD']) !== ref.sha ||
    evalGit(tree, ['symbolic-ref', '--short', 'HEAD']) !== ref.branch ||
    evalGit(tree, ['status', '--porcelain', '--untracked-files=all'])
  )
    throw new Error(`${label} review_ref SHA/base/branch changed or worktree is dirty`);
  const readDiff = (args: string[]) =>
    execFileSync(
      'git',
      [
        '--no-pager',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        ...args,
        `${ref.base}..${ref.sha}`,
        '--',
      ],
      {
        cwd: tree,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: TASK_CLI_INPUT_BYTES,
      },
    );
  const files = readDiff(['--name-only', '--no-renames', '-z']).split('\0').filter(Boolean);
  const diff = readDiff(['--no-renames', '--unified=3']);
  if (!files.length || Buffer.byteLength(diff) > TASK_CLI_INPUT_BYTES)
    throw new Error(`${label} requires a nonempty diff of at most 1 MiB`);
  const execution = store
    .listExecutions()
    .filter(
      (e) => e.task_key === record.key && e.agent_role !== 'reviewer' && e.agent_role !== 'qa',
    )
    .sort((a, b) => a.task_version - b.task_version || a.started_at.localeCompare(b.started_at))
    .at(-1);
  if (!execution || !['claude', 'codex'].includes(execution.executor))
    throw new Error(`${label} requires the last Developer executor`);
  return {
    ...input,
    reviewRef: ref,
    developerExecutor: execution.executor as 'claude' | 'codex',
    worktree: tree,
    files,
    diff,
  };
}

export function reviewerBrief(input: ReviewerRequest, errors: string[] = []): string {
  return JSON.stringify({ ...input, contract, validationErrors: errors });
}

export function validateReview(source: string, input: ReviewerRequest): ReviewReport {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new SchemaValidationError(['ReviewReport exceeds 1 MiB']);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new SchemaValidationError(['Reviewer must return a JSON object']);
  }
  const report = validateSchema(validateReport, value);
  const errors: string[] = [];
  for (const finding of report.findings)
    if (!input.files.includes(finding.file))
      errors.push(`Finding file outside diff: ${finding.file}`);
  const seen = new Set<string>();
  for (const coverage of report.acCoverage ?? []) {
    if (!input.task.acceptanceRefs.includes(coverage.ac) || seen.has(coverage.ac))
      errors.push(`Unknown or duplicate task AC: ${coverage.ac}`);
    seen.add(coverage.ac);
  }
  if (
    report.verdict === 'approve' &&
    report.findings.some((f) => ['blocker', 'major'].includes(f.severity))
  )
    errors.push('approve cannot contain blocker/major findings');
  if (errors.length) throw new SchemaValidationError(errors);
  return report;
}

/** Change preference only, never authorization, quota gates, or model identity. */
export function preferCrossExecutor<T extends { executor: 'claude' | 'codex' }>(
  candidates: T[],
  developer: string,
  snapshot: SelectionSnapshot,
  tier?: 'economy' | 'standard' | 'deep',
): T[] {
  const cross = (candidate: T) =>
    candidate.executor !== developer &&
    !excludeCandidate(candidate.executor, snapshot, tier) &&
    !launchBlock(snapshot.availability?.[candidate.executor], snapshot.nowS);
  const rank = (candidate: T) => (cross(candidate) ? 0 : candidate.executor === developer ? 1 : 2);
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

export function reviewerDecision(task: string, cause: string): NewHumanDecision {
  return {
    id: randomUUID(),
    context: `feature-review/${task}/${cause}`,
    blocks: [task],
    requestedBy: 'reviewer',
    options: [
      {
        id: 'inspect',
        label: 'Revisar y reconciliar',
        benefit: 'Resolver la revisión',
        cost: 'Tiempo del operador',
        risk: 'Inspeccionar cambios y findings',
      },
    ],
    recommendation: 'Inspeccionar ReviewReports y reconciliar la tarea antes de continuar',
    disagreement: [],
    impact: 'Bloquea el ciclo de revisión',
    urgency: 'medium',
  };
}
