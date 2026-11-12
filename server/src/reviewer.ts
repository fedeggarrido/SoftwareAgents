import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

import * as contract from '../../core/schemas/review-report.schema.json';
import type { NewHumanDecision } from '../../core/src/humanDecision.js';
import type { ProjectConfig } from '../../core/src/project.js';
import type { ReviewPass, ReviewReport } from '../../core/src/reviewReport.js';
import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { type DeveloperRequest, developerRequest, isDeveloperTest } from './developer.js';
import { evalGit } from './evalTasks.js';
import { excludeCandidate, launchBlock, type SelectionSnapshot } from './executorSelection.js';
import { withoutOperatorToken } from './featureIngress.js';
import { featureBaseBranch } from './featureRunBase.js';
import { isFailedReview } from './reviewAttempts.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';
import { taskBranchBase } from './taskBranchBase.js';
import { hasCurrentApproval } from './taskRebaseHistory.js';
import { isExecutedTest } from './testRoots.js';
import type { ReviewRef, WorkStore } from './workstore/WorkStore.js';

// Stored audit fields are runtime-owned. Models can only submit content fields.
const { originalReport, runtimeNotes, passes, ...contentProperties } = contract.properties;
const { downgradeReasons, ...findingProperties } = contentProperties.findings.items.properties;
const modelContract = {
  ...contract,
  properties: {
    ...contentProperties,
    findings: {
      ...contentProperties.findings,
      items: { ...contentProperties.findings.items, properties: findingProperties },
    },
  },
};
const validateReport = compileSchema<ReviewReport>(modelContract);

export interface ReviewerRequest extends DeveloperRequest {
  reviewRef: ReviewRef;
  developerExecutor: 'claude' | 'codex';
  worktree: string;
  files: string[];
  /** Runtime Git AM selection excludes removed tests from the execution contract. */
  changedTestFiles?: string[];
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
    taskBranchBase(config.repoRoot, ref.branch, featureBaseBranch(store, config, key)) !==
      ref.base ||
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
        env: withoutOperatorToken(process.env),
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
    changedTestFiles: readDiff(['--name-only', '--no-renames', '--diff-filter=AM', '-z'])
      .split('\0')
      .filter((file) => isDeveloperTest(file)),
    diff,
  };
}

export function reviewerBrief(
  input: ReviewerRequest,
  errors: string[] = [],
  pass: ReviewPass = 'single',
): string {
  return JSON.stringify({
    ...input,
    taskTests: (input.changedTestFiles ?? input.files)
      .filter((file) => isDeveloperTest(file))
      .map((file) => ({
        file,
        executed: isExecutedTest(file, input.worktree),
      })),
    testExecutionRule:
      'Request changes if any taskTests entry has executed=false. This flag is calculated by the runtime from test discovery configuration; do not infer or override it.',
    contract: modelContract,
    reviewPass: pass,
    passRule: {
      single: 'Review all thermos categories.',
      bugs_security:
        'Independently review the diff, prioritizing regressions and security. Include any supported blocking finding. The runtime may use this as the single review if the additional pass is unavailable.',
      quality_structure:
        'Independently review missed simplification, branching growth, boundaries, types, size and legibility. You have no access to the other pass. Trace each finding end to end.',
    }[pass],
    categoryRule: 'Set category to the thermos category of each finding.',
    evidenceRule:
      'Every blocker/major requires a line in a changed file and concrete evidence (reproduction, input and incorrect output, or failing test). Unsupported findings are downgraded by the runtime.',
    validationErrors: errors,
  });
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
  const original = structuredClone(report);
  const lineCount = (rev: string, file: string) => {
    try {
      const content = execFileSync('git', ['show', `${rev}:${file}`], {
        env: withoutOperatorToken(process.env),
        cwd: input.worktree,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: TASK_CLI_INPUT_BYTES,
      });
      return content.length ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
    } catch {
      return 0; // Absent at that revision (added, deleted or renamed).
    }
  };
  for (const finding of report.findings) {
    // Models on Windows may answer with backslashes or a ./ prefix.
    finding.file = finding.file.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (finding.evidence !== undefined) finding.evidence = finding.evidence.trim();
    if (!['blocker', 'major'].includes(finding.severity)) continue;
    const reasons: string[] = [];
    if (!finding.evidence) reasons.push('missing evidence');
    if (!input.files.includes(finding.file)) reasons.push('file not in diff');
    if (!finding.line) reasons.push('missing line');
    // A finding may point at a removed line: accept the base or the reviewed revision.
    else if (
      input.files.includes(finding.file) &&
      finding.line >
        Math.max(
          lineCount(input.reviewRef.sha, finding.file),
          lineCount(input.reviewRef.base, finding.file),
        )
    )
      reasons.push('line out of range');
    if (reasons.length) {
      finding.severity = 'minor';
      finding.downgradeReasons = reasons;
      finding.summary += ` [downgraded: ${reasons.join('|')}]`;
    }
  }
  if (
    report.findings.some((finding) => finding.downgradeReasons) ||
    (report.verdict === 'request_changes' &&
      !report.findings.some((finding) => ['blocker', 'major'].includes(finding.severity)))
  ) {
    report.originalReport = original;
    // Runtime-known blockers never depend on model evidence: an unexecuted task test
    // or an AC the Reviewer marked missing keeps request_changes.
    const runtimeBlock =
      (input.changedTestFiles ?? input.files).some(
        (file) => isDeveloperTest(file) && !isExecutedTest(file, input.worktree),
      ) || (report.acCoverage ?? []).some((coverage) => coverage.status === 'missing');
    if (
      report.verdict === 'request_changes' &&
      !runtimeBlock &&
      !report.findings.some((finding) => ['blocker', 'major'].includes(finding.severity))
    ) {
      report.verdict = 'approve';
      report.runtimeNotes = [
        'Effective verdict: approve; request_changes had no supported blocking findings after downgrade',
      ];
    }
  }
  const seen = new Set<string>();
  for (const coverage of report.acCoverage ?? []) {
    if (!input.task.acceptanceRefs.includes(coverage.ac) || seen.has(coverage.ac))
      errors.push(`Unknown or duplicate task AC: ${coverage.ac}`);
    seen.add(coverage.ac);
  }
  // Judge the model's own contradiction, not the downgraded copy: an approve that still
  // lists blockers is rejected as before, whatever their evidence.
  if (
    original.verdict === 'approve' &&
    original.findings.some((f) => ['blocker', 'major'].includes(f.severity))
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
