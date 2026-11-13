import type { TierRule } from '../../core/src/modelTier.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import type { ReviewCategory, ReviewPass, ReviewReport } from '../../core/src/reviewReport.js';
import { REVIEW_EXTRA_COST_RATIO } from './constants.js';
import { effectiveWorkInputs, type TierInputs } from './modelTiers.js';
import { addTelemetryTotals, emptyTelemetryTotals } from './telemetryCommand.js';
import { admissionBudgetReason, type UsageEntry } from './usageLedger.js';
import type { VerifierFailure } from './verifierFeedback.js';

export type ReviewPlan = ['single'] | ['bugs_security', 'quality_structure'];

/** Deterministic layer violations are blockers even if a model approves or omits them. */
export function reviewVerifierFeedback(
  report: ReviewReport,
  failures: readonly VerifierFailure[] = [],
): ReviewReport {
  const findings: ReviewReport['findings'] = failures.flatMap((failure) =>
    (failure.boundaries ?? []).map((finding) => ({
      severity: 'major',
      category: 'boundaries',
      file: finding.file,
      line: finding.line,
      summary: finding.message,
      evidence: `${failure.command.join(' ')}: ${finding.message}`,
      suggestion: 'Mueve la dependencia detrás de un puerto de la capa de aplicación.',
    })),
  );
  if (!findings.length) return report;
  return { ...report, verdict: 'request_changes', findings: [...report.findings, ...findings] };
}

export function reviewPassSelection(inputs: TierInputs, rule?: TierRule): ReviewPlan {
  return effectiveWorkInputs(inputs, rule).size === 'S'
    ? ['single']
    : ['bugs_security', 'quality_structure'];
}

const severityRank = { blocker: 0, major: 1, minor: 2, nit: 3 };
const categoryRank: Record<ReviewCategory, number> = {
  regression: 0,
  security: 1,
  simplification: 2,
  branching: 3,
  boundaries: 4,
  types: 5,
  size: 6,
  legibility: 7,
};

/** Old reports used the category as a title prefix. Preserve their compatibility. */
function findingCategory(finding: ReviewReport['findings'][number]): ReviewCategory {
  if (finding.category) return finding.category;
  const prefix = finding.summary
    .toLowerCase()
    .replace(/^\[/, '')
    .split(/[\]: —-]/)[0];
  for (const category of Object.keys(categoryRank)) {
    // SAFETY: iteration is over the own keys of the closed categoryRank object.
    if (category === prefix) return category as ReviewCategory;
  }
  return 'legibility';
}

/** Inputs have already passed validateReview, including evidence downgrades. */
export function synthesizeReviews(
  passes: NonNullable<ReviewReport['passes']>,
  notes: string[] = [],
): ReviewReport {
  if (!passes.length) throw new Error('Review synthesis requires a validated pass');
  const findings = new Map<string, ReviewReport['findings'][number]>();
  const coverage = new Map<string, NonNullable<ReviewReport['acCoverage']>[number]>();
  const coverageRank = { missing: 0, partial: 1, covered: 2 };
  for (const { report } of passes) {
    for (const finding of report.findings) {
      const category = findingCategory(finding);
      const key = JSON.stringify([finding.file, finding.line ?? null, category]);
      const existing = findings.get(key);
      if (!existing || severityRank[finding.severity] < severityRank[existing.severity])
        findings.set(key, { ...finding, category });
    }
    for (const item of report.acCoverage ?? []) {
      const existing = coverage.get(item.ac);
      if (!existing || coverageRank[item.status] < coverageRank[existing.status])
        coverage.set(item.ac, item);
    }
  }
  const merged = [...findings.values()].sort(
    (a, b) =>
      categoryRank[findingCategory(a)] - categoryRank[findingCategory(b)] ||
      severityRank[a.severity] - severityRank[b.severity],
  );
  return {
    verdict:
      passes.some(({ report }) => report.verdict === 'request_changes') ||
      merged.some((finding) => severityRank[finding.severity] <= severityRank.major)
        ? 'request_changes'
        : 'approve',
    findings: merged,
    ...(coverage.size ? { acCoverage: [...coverage.values()] } : {}),
    passes,
    runtimeNotes: [...passes.flatMap(({ report }) => report.runtimeNotes ?? []), ...notes],
  };
}

export type ReviewAllowance = { maxCostUsd: number } | { reason: string };

/** Reserve a repeat of the measured first pass within 20% of the task's observed baseline.
 * Unknown costs cannot establish an allowance. Operator budgets remain additional gates. */
export function reviewPassAllowance(
  entries: UsageEntry[],
  firstExecution: string,
  budgets: ProjectOperatorConfig['budgets'],
  executionCount: number,
  extraExecutions: string[] = [],
): ReviewAllowance {
  const first = entries.find((entry) => entry.executionId === firstExecution);
  if (!first || first.costUsd === null || first.costUsd <= 0)
    return { reason: 'cost cap unavailable because first-pass cost is unknown or zero' };
  const taskEntries = entries.filter((entry) => entry.taskKey === first.taskKey);
  if (taskEntries.some((entry) => entry.costUsd === null))
    return { reason: 'cost cap unavailable because task baseline contains unknown costs' };
  const reason = admissionBudgetReason(budgets, entries, first.taskKey, undefined, executionCount);
  if (reason) return { reason: `operator budget ${reason}` };
  const extraIds = new Set(extraExecutions);
  const extraCost = taskEntries
    .filter((entry) => extraIds.has(entry.executionId))
    .reduce((total, entry) => total + entry.costUsd!, 0);
  const cost = taskEntries.reduce((total, entry) => total + entry.costUsd!, 0);
  const allowance = Math.min(
    (cost - extraCost) * REVIEW_EXTRA_COST_RATIO - extraCost,
    budgets?.maxCostUsd === undefined ? Infinity : budgets.maxCostUsd - cost,
  );
  if (first.costUsd > allowance)
    return {
      reason: 'estimated second-pass cost exceeds the 20% extra-cost cap or operator budget',
    };
  return { maxCostUsd: allowance };
}

/** State is local to one review attempt. The second brief never includes the first report. */
export class ReviewCycle {
  readonly passes: NonNullable<ReviewReport['passes']> = [];
  private notes: string[] = [];
  allowance?: { maxCostUsd: number };

  constructor(readonly plan: ReviewPlan) {}

  /** Observations are cumulative. The CLI's current response can overshoot max-budget-usd. */
  observeCost(
    attributes: Readonly<Record<string, string | number>>,
    prices: NonNullable<ProjectOperatorConfig['telemetry']>['prices'],
  ): boolean {
    if (!this.secondPass || !this.allowance) return false;
    const totals = emptyTelemetryTotals();
    addTelemetryTotals(totals, { ...attributes }, prices);
    if (typeof totals.costUsd === 'number' && totals.costUsd < this.allowance.maxCostUsd)
      return false;
    this.notes.push(
      'Second-pass cost allowance reached or accounting became unknown; runtime requested cancellation',
    );
    return true;
  }

  get pass(): ReviewPass {
    const pass = this.plan[this.passes.length];
    if (!pass) throw new Error('Review cycle is already complete');
    return pass;
  }
  get secondPass(): boolean {
    return this.passes.length === 1 && this.plan.length === 2;
  }

  accept(report: ReviewReport, source: string, executionId: string, executor: 'claude' | 'codex') {
    this.passes.push({
      pass: this.pass,
      report,
      // SAFETY: source was parsed and schema-validated by validateReview immediately before accept.
      originalReport: JSON.parse(source) as ReviewReport,
      executionId,
      executor,
    });
  }

  fallback(reason: string): ReviewReport {
    this.notes.push(`Second review pass skipped; single-pass fallback: ${reason}`);
    return this.report();
  }

  report(): ReviewReport {
    return synthesizeReviews(this.passes, this.notes);
  }
}
