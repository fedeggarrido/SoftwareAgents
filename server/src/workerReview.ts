import type { ProjectConfig } from '../../core/src/project.js';
import type { ReviewReport } from '../../core/src/reviewReport.js';
import type { AgentCompilerTask } from './agentCompiler.js';
import type { AuditEntry } from './auditLog.js';
import { REVIEW_MAX_REWORK_ROUNDS } from './constants.js';
import { proposeLearnings } from './learnings.js';
import { guardRequirementsWrites } from './requirements.js';
import { reviewReworkRounds } from './reviewAttempts.js';
import { reviewerDecision, type ReviewerRequest, reviewerRequest } from './reviewer.js';
import type { WorkerLifecycle } from './workerLifecycle.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** One atomic outcome for all independent passes, under the original review lease. */
export async function persistWorkerReview(
  input: ReviewerRequest,
  config: ProjectConfig,
  store: WorkStore,
  lifecycle: WorkerLifecycle,
  report: ReviewReport,
  binding: { executionId: string; executor: 'claude' | 'codex' },
  before: Map<string, string>,
  taskData: AgentCompilerTask,
  audit: (status: string, details?: Omit<AuditEntry['outcome'], 'status'>) => void,
): Promise<boolean> {
  const task = input.task.key;
  const capped =
    report.verdict === 'request_changes' &&
    reviewReworkRounds(store.getTask(task)!) >= REVIEW_MAX_REWORK_ROUNDS;
  const review = {
    execution_id: binding.executionId,
    review_ref: input.reviewRef,
    developer_executor: input.developerExecutor,
    reviewer_executor: binding.executor,
    report,
  };
  await lifecycle.completeReview(() =>
    store.completeReview(
      task,
      lifecycle.owner,
      review,
      () => {
        guardRequirementsWrites(input.worktree, before);
        if (
          JSON.stringify(reviewerRequest(store, config, input.key, task, lifecycle.owner)) !==
          JSON.stringify(input)
        )
          throw new Error('Reviewer SHA/context changed before report persistence');
        audit('review_report_pending', { detail: JSON.stringify(review) });
      },
      capped ? reviewerDecision(task, 'rework_limit') : undefined,
    ),
  );
  audit('review_report_persisted', { detail: JSON.stringify(review) });
  proposeLearnings(
    config.repoRoot,
    { zones: input.task.changeZones ?? [], role: input.task.agentRole, taskType: input.task.type },
    task,
    binding.executionId,
    report,
    store.listFindingDecisions(),
    taskData,
  );
  if (input.task.type === 'doc' && report.verdict === 'approve')
    audit('qa_not_applicable', { detail: 'QA no aplicable: tarea doc' });
  return capped;
}
