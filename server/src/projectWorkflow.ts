import type { HumanDecision } from '../../core/src/humanDecision.js';
import type {
  FeatureGateKind,
  FeatureRow,
  FeatureState,
  FeatureTaskStep,
  WorkflowStage,
  WorkflowStageId,
  WorkflowState,
} from '../../core/src/messages.js';
import type { FeaturesSource } from './featuresView.js';
import type { SummaryContext } from './projectSummaryContext.js';
import { summaryText } from './projectSummaryContext.js';
import { FeaturesReadFailure } from './workstore/readOnlyWorkStore.js';
import { isTaskStatus, type TaskStatus } from './workstore/taskStateMachine.js';

const STAGES: { id: WorkflowStageId; label: string }[] = [
  { id: 'idea', label: 'Idea' },
  { id: 'requirements', label: 'Requisitos' },
  { id: 'plan', label: 'Plan' },
  { id: 'approval', label: 'Aprobación' },
  { id: 'development', label: 'Desarrollo' },
  { id: 'qa', label: 'QA' },
  { id: 'review', label: 'Revisión' },
  { id: 'delivery', label: 'Entrega' },
];

const FEATURE_STAGE: Record<FeatureState, WorkflowStageId> = {
  unknown: 'requirements',
  in_review: 'approval',
  in_design: 'plan',
  in_development: 'development',
  ready_to_merge: 'delivery',
  merged: 'delivery',
};
const FEATURE_COMPLETED_STAGES: Record<FeatureState, WorkflowStageId[]> = {
  unknown: ['idea'],
  in_review: ['idea'],
  in_design: ['idea', 'requirements'],
  in_development: ['idea', 'requirements', 'plan'],
  ready_to_merge: ['idea', 'requirements', 'plan', 'approval'],
  merged: ['idea', 'requirements', 'plan', 'approval', 'development', 'qa', 'review'],
};
const TASK_COMPLETED_STAGES: Partial<Record<TaskStatus, WorkflowStageId[]>> = {
  REVIEW: ['development'],
  QA: ['development', 'review'],
  DONE: ['development'],
};
const ROLE_STAGE: Readonly<Record<string, WorkflowStageId>> = {
  requirements: 'requirements',
  architect: 'plan',
  developer: 'development',
  'qa-author': 'qa',
  qa: 'qa',
  reviewer: 'review',
};
const STEP_STAGE: Record<FeatureTaskStep, WorkflowStageId> = {
  develop: 'development',
  qa: 'qa',
  review: 'review',
};
const FIXED_TASK_STAGE: Partial<Record<TaskStatus, WorkflowStageId>> = {
  DONE: 'delivery',
  REVIEW: 'review',
  QA: 'qa',
};
const TASK_SUFFIX_STAGE: Readonly<Record<string, WorkflowStageId>> = {
  '-REQUIREMENTS': 'requirements',
  '-DESIGN': 'plan',
};
const TASK_POLICY: Record<TaskStatus, { stage: WorkflowStageId; state: WorkflowState }> = {
  DRAFT: { stage: 'requirements', state: 'workflow_active' },
  READY: { stage: 'development', state: 'workflow_active' },
  QUEUED: { stage: 'development', state: 'workflow_active' },
  LEASED: { stage: 'development', state: 'workflow_active' },
  RUNNING: { stage: 'development', state: 'workflow_active' },
  REVIEW: { stage: 'review', state: 'workflow_active' },
  QA: { stage: 'qa', state: 'workflow_active' },
  WAITING_HUMAN: { stage: 'development', state: 'workflow_human' },
  WAITING_QUOTA: { stage: 'development', state: 'workflow_blocked' },
  BLOCKED: { stage: 'development', state: 'workflow_blocked' },
  FAILED_RETRYABLE: { stage: 'development', state: 'workflow_blocked' },
  FAILED_FINAL: { stage: 'development', state: 'workflow_blocked' },
  DONE: { stage: 'delivery', state: 'workflow_done' },
  CANCELLED: { stage: 'delivery', state: 'workflow_empty' },
};
const GATE_POLICY: Record<FeatureGateKind, { stage?: WorkflowStageId; state: WorkflowState }> = {
  requirements_questions: { stage: 'requirements', state: 'workflow_human' },
  design_questions: { stage: 'plan', state: 'workflow_human' },
  spec_approval: { stage: 'approval', state: 'workflow_human' },
  human_decision: { state: 'workflow_human' },
  waiting_human: { state: 'workflow_human' },
  quota: { state: 'workflow_blocked' },
  qa_not_tested: { stage: 'qa', state: 'workflow_human' },
  zone_overlap: { state: 'workflow_blocked' },
};
// An impediment takes precedence even when other work in the same stage is active.
const STATE_PRIORITY: Record<WorkflowState, number> = {
  workflow_empty: 0,
  workflow_done: 1,
  workflow_active: 2,
  workflow_human: 3,
  workflow_blocked: 4,
};

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new FeaturesReadFailure('invalid_data');
  return value;
}

function taskStage(
  key: string,
  status: TaskStatus,
  step: FeatureTaskStep | null,
  role: string | null,
  previous: string | null,
): WorkflowStageId {
  const suffix = Object.entries(TASK_SUFFIX_STAGE).find(([suffix]) => key.endsWith(suffix));
  const interrupted = ['workflow_human', 'workflow_blocked'].includes(TASK_POLICY[status].state);
  return (
    suffix?.[1] ??
    FIXED_TASK_STAGE[status] ??
    (step ? STEP_STAGE[step] : undefined) ??
    (role ? ROLE_STAGE[role] : undefined) ??
    (interrupted && previous && isTaskStatus(previous) ? FIXED_TASK_STAGE[previous] : undefined) ??
    TASK_POLICY[status].stage
  );
}

/** Use the same lease-window boundaries as domainEventRelay's execution attribution. */
function taskExecution(
  source: FeaturesSource,
  key: string,
  version: number,
  status: TaskStatus,
  previous: string | null,
) {
  if (!['LEASED', 'RUNNING'].includes(status) && !['LEASED', 'RUNNING'].includes(previous ?? ''))
    return undefined;
  const starts = source.events.filter(
    (event) =>
      event.task_key === key &&
      typeof event.task_version === 'number' &&
      event.task_version <= version &&
      (event.to_status === 'LEASED' ||
        (event.to_status === 'RUNNING' && ['REVIEW', 'QA'].includes(String(event.from_status)))),
  );
  const windowStart = starts.length
    ? Math.max(...starts.map((event) => Number(event.task_version)))
    : version;
  return source.executions
    .filter(
      (execution) =>
        execution.task_key === key &&
        typeof execution.task_version === 'number' &&
        execution.task_version >= windowStart &&
        execution.task_version <= version,
    )
    .sort(
      (a, b) =>
        Number(b.task_version) - Number(a.task_version) ||
        requiredText(b.started_at).localeCompare(requiredText(a.started_at)),
    )[0];
}

/** One policy projects current membership. Clients filter by these exact keys. */
export function projectWorkflow(
  source: FeaturesSource,
  features: FeatureRow[],
  context: Pick<SummaryContext, 'ideas' | 'approvals'>,
  decisions: HumanDecision[],
): WorkflowStage[] {
  const stages = STAGES.map((stage): WorkflowStage => ({
    ...stage,
    state: 'workflow_empty',
    taskKeys: [],
    featureKeys: [],
    agents: [],
  }));
  const add = (
    id: WorkflowStageId,
    state: WorkflowState,
    feature?: string,
    task?: string,
    session?: string,
  ) => {
    const stage = stages.find((stage) => stage.id === id);
    if (!stage) throw new Error(`Missing workflow stage ${id}`);
    if (STATE_PRIORITY[state] > STATE_PRIORITY[stage.state]) stage.state = state;
    if (feature && !stage.featureKeys.includes(feature)) stage.featureKeys.push(feature);
    if (task && !stage.taskKeys.includes(task)) stage.taskKeys.push(task);
    if (session && !stage.agents.includes(session)) stage.agents.push(session);
  };
  for (const idea of context.ideas) add('idea', 'workflow_human', idea);
  for (const feature of features) {
    for (const completed of FEATURE_COMPLETED_STAGES[feature.state])
      add(completed, 'workflow_done', feature.key);
    const approval = context.approvals.find((plan) => plan.key === feature.key);
    if (approval && ['approved', 'finished', 'merged'].includes(approval.state))
      add('approval', 'workflow_done', feature.key);
    const featureStage =
      approval && ['pending', 'changed', 'unbound'].includes(approval.state)
        ? 'approval'
        : FEATURE_STAGE[feature.state];
    const directedGate = feature.gates.find((gate) => GATE_POLICY[gate.kind].stage);
    const stage = directedGate
      ? (GATE_POLICY[directedGate.kind].stage ?? featureStage)
      : featureStage;
    const state =
      feature.state === 'merged'
        ? 'workflow_done'
        : stage === 'approval' || feature.state === 'ready_to_merge'
          ? 'workflow_human'
          : 'workflow_active';
    // Operational tasks carry their feature into their actual stages. A feature
    // waiting in QA must not light up Development merely because it has a DAG.
    if (
      stage !== 'development' ||
      !source.tasks.some((task) => task.feature_key === feature.key && task.status !== 'CANCELLED')
    )
      add(stage, state, feature.key);
    for (const gate of feature.gates) {
      const policy = GATE_POLICY[gate.kind];
      // Task-specific gates are applied with the task's actual execution step below.
      if (!gate.task) add(policy.stage ?? stage, policy.state, feature.key);
    }
  }
  for (const task of source.tasks) {
    const key = requiredText(task.key);
    const status = requiredText(task.status);
    if (!isTaskStatus(status)) throw new FeaturesReadFailure('invalid_data');
    if (status === 'CANCELLED') continue;
    if (typeof task.version !== 'number' || !Number.isSafeInteger(task.version) || task.version < 1)
      throw new FeaturesReadFailure('invalid_data');
    const featureKey = typeof task.feature_key === 'string' ? task.feature_key : undefined;
    const feature = features.find((feature) => feature.key === featureKey);
    const previousStage = source.events
      .filter((event) => event.task_key === key && event.to_status === status)
      .sort((a, b) => requiredText(b.created_at).localeCompare(requiredText(a.created_at)))[0];
    const execution = taskExecution(
      source,
      key,
      task.version,
      status,
      typeof previousStage?.from_status === 'string' ? previousStage.from_status : null,
    );
    const policy = TASK_POLICY[status];
    const step = feature?.currentTask?.key === key ? feature.currentTask.step : null;
    const role =
      !['DRAFT', 'READY', 'QUEUED'].includes(status) && typeof execution?.agent_role === 'string'
        ? execution.agent_role
        : typeof task.agent_role === 'string'
          ? task.agent_role
          : null;
    const gates = feature?.gates.filter((gate) => gate.task === key) ?? [];
    const directedGate = gates.find((gate) => GATE_POLICY[gate.kind].stage);
    const stage =
      (directedGate && GATE_POLICY[directedGate.kind].stage) ??
      taskStage(
        key,
        status,
        step,
        role,
        typeof previousStage?.from_status === 'string' ? previousStage.from_status : null,
      );
    if (!Object.keys(TASK_SUFFIX_STAGE).some((suffix) => key.endsWith(suffix))) {
      for (const completed of TASK_COMPLETED_STAGES[status] ?? [])
        add(completed, 'workflow_done', featureKey, key);
      if (status === 'DONE' && previousStage?.from_status === 'QA')
        add('qa', 'workflow_done', featureKey, key);
      if (status === 'DONE' && (previousStage?.from_status === 'REVIEW' || task.review_ref))
        add('review', 'workflow_done', featureKey, key);
    }
    const session =
      ['LEASED', 'RUNNING'].includes(status) &&
      (execution?.tree_closed_at ?? null) === null &&
      typeof execution?.session_id === 'string' &&
      execution.session_id.trim()
        ? summaryText(execution.session_id)
        : undefined;
    add(stage, policy.state, featureKey, key, session);
    for (const gate of gates) {
      const gatePolicy = GATE_POLICY[gate.kind];
      add(stage, gatePolicy.state, featureKey, key);
    }
    if (
      decisions.some(
        (decision) =>
          decision.status !== 'answered' &&
          (decision.blocks.includes(key) || (!!featureKey && decision.blocks.includes(featureKey))),
      )
    )
      add(stage, 'workflow_human', featureKey, key);
  }
  return stages;
}
