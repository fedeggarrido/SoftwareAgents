import type { DesignReport } from '../../core/src/designReport.js';
import type { TaskDag } from '../../core/src/taskDag.js';

export const DESIGN_MAX_ROUNDS = 3;
export const DESIGN_MAX_TOKENS = 100_000;
export function needsDesignReview(
  task: Pick<TaskDag['tasks'][number], 'needsDesignReview' | 'changeZones'>,
): boolean {
  return (
    task.needsDesignReview === true ||
    !!task.changeZones?.some((z) => z === 'webview-ui' || z.startsWith('webview-ui/'))
  );
}
/** Stable ids are mandatory in the loop; new majors require an explicit rationale.
 * Regression assertions are evidence to review, never permission to relabel accepted minors. */
export function validateDesignRound(
  report: DesignReport,
  previous: DesignReport['findings'],
): void {
  const ids = new Set<string>();
  for (const finding of report.findings) {
    if (!finding.id?.trim() || ids.has(finding.id))
      throw new Error('Design loop requires unique stable finding ids');
    ids.add(finding.id);
    const old = previous.find(
      (f) =>
        f.id === finding.id ||
        (f.screen === finding.screen && f.area === finding.area && f.problem === finding.problem),
    );
    if (
      old &&
      ['minor', 'nit'].includes(old.severity) &&
      ['major', 'blocker'].includes(finding.severity) &&
      (!finding.regression || !finding.majorJustification?.trim())
    )
      throw new Error('Accepted minor escalation requires justified regression');
    if (
      previous.length &&
      finding.severity === 'major' &&
      !old &&
      !finding.regression &&
      !finding.majorJustification?.trim()
    )
      throw new Error('New non-regression major requires explicit justification');
  }
}
