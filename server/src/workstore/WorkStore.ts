import type { HumanDecision, NewHumanDecision } from '../../../core/src/humanDecision.js';
import type { ModelTier } from '../../../core/src/modelTier.js';
import type { ReviewReport } from '../../../core/src/reviewReport.js';
import type { TaskDag } from '../../../core/src/taskDag.js';
import type { TestReport } from '../../../core/src/testReport.js';
import type { TaskRebase } from '../taskRebaseHistory.js';
import type { TaskStatus } from './taskStateMachine.js';

/** Operational records only. Persisting a Human Decision does not authorize an action. */
export interface ProjectRecord {
  project_id: string;
  created_at: string;
}

export interface FeatureRecord {
  title?: string | null;
  updated_at?: string | null;
  project_id: string;
  key: string;
  doc_path: string;
  git_sha: string;
  status: string;
}

/** Runtime checkpoints. Git publication is prepared here before a compare-and-swap. */
export interface FeatureRunState {
  branch: string;
  initial_main: string;
  head: string;
  request: string;
  integrated: Record<string, ReviewRef>;
  /** Legacy checkpoints only; retry authority belongs to Tasks and their history. */
  attempts?: Record<string, number>;
  pending?: { task: string; before: string; after: string; main?: string };
  active?: {
    action: string;
    task: string;
    version: number;
    publication?: { push?: { enabled: boolean; remote: string } };
  };
  publication?: { task: string; review: ReviewRef; push?: { enabled: boolean; remote: string } };
  published?: Record<string, string>;
  status: string;
  message?: string;
}

export interface FeatureRunRecord {
  owner: string | null;
  pid: number | null;
  pid_started_at: string | null;
  state: FeatureRunState;
}

export interface WorkerPublication {
  feature: string;
  task: string;
  execution: string;
  branch: string;
  worktree: string;
  before: string;
  sha: string;
  base: string;
  tree: string;
  spec?: import('../../../core/src/featureSpec.js').FeatureSpec;
  design?: { record: Omit<DesignRecord, 'project_id'>; dag: TaskDag };
  developer?: boolean;
  draft?: { files: Record<string, string>; snapshot: [string, string][]; subject: string };
}

export interface DesignRecord {
  project_id: string;
  feature_key: string;
  doc_path: string;
  dag_path: string;
  git_sha: string;
  feature_sha: string;
}

export interface DesignImport {
  design: Omit<DesignRecord, 'project_id'>;
  owner: string;
  revision?: { decisionId: string; answersHash: string; beforeCommit: () => void };
}

export interface TaskRecord {
  project_id: string;
  feature_key: string | null;
  key: string;
  type: string;
  status: TaskStatus;
  priority: number;
  agent_role: string | null;
  version: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt: number;
  max_attempts: number;
  branch: string | null;
  worktree_ref: string | null;
  pr_ref: string | null;
  review_ref?: ReviewRef | null;
  review_reports?: ReviewRecord[];
  test_reports?: TestRecord[];
  defect_context?: DefectContext | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  declaration?: string | null;
}

export interface ReviewRef {
  branch: string;
  sha: string;
  base: string;
}

export interface ReviewRecord {
  execution_id: string;
  review_ref: ReviewRef;
  developer_executor: string;
  reviewer_executor: string;
  report: ReviewReport;
}

export interface TestRecord {
  execution_id: string;
  review_ref: ReviewRef;
  report: TestReport;
  artifact_path: string;
}
export interface DefectContext {
  task: string;
  review_ref: ReviewRef;
  execution_id: string;
  ac: string;
  severity: string;
  summary: string;
  reproduction: string;
}

export interface TaskDependencyRecord {
  project_id: string;
  task_key: string;
  depends_on_key: string;
}

export interface ExecutionRecord {
  project_id: string;
  key: string;
  task_key: string;
  agent_template_version: string;
  executor: string;
  agent_role?: string | null;
  model_id: string;
  model_tier?: ModelTier | null;
  model_effort?: string | null;
  selection_reason?: string | null;
  session_id: string | null;
  pid: number | null;
  /** OS process creation identity, not the approximate Execution timestamp. */
  pid_started_at?: string | null;
  /** Recovery verified termination of the captured tree; not process containment. */
  tree_closed_at?: string | null;
  started_at: string;
  system_prompt_hash: string;
  project_brain_sha: string;
  task_version: number;
  tool_policy_version: string;
}

export interface HumanDecisionRecord {
  project_id: string;
  key: string;
  task_key: string | null;
  execution_key: string | null;
  question: string;
  answer: string;
  actor: string;
  decided_at: string;
}

export interface LeaseRecoveryRecord {
  project_id: string;
  task_key: string;
  token: string;
  task_version: number;
  reason: string;
  actor: string;
  started_at: string;
  error: string | null;
}

export type NewTask = Pick<TaskRecord, 'key' | 'type'> &
  Partial<Omit<TaskRecord, 'project_id' | 'key' | 'type' | 'created_at' | 'updated_at'>>;

export interface DomainEventRecord {
  id: number;
  project_id: string;
  task_key: string;
  type: 'TASK_TRANSITIONED';
  from_status: TaskStatus;
  to_status: TaskStatus;
  task_version: number;
  attempt: number;
  reason: string;
  actor: string;
  created_at: string;
}
/** One Project per handle; no SQL/connection escape hatch. */
export interface WorkStore {
  readonly projectId: string;
  getFeatureRun(key: string): FeatureRunRecord | undefined;
  claimFeatureRun(key: string, owner: string, initial: FeatureRunState): Promise<FeatureRunState>;
  saveFeatureRun(key: string, owner: string, state: FeatureRunState): Promise<void>;
  releaseFeatureRun(key: string, owner: string): Promise<void>;
  prepareWorkerPublication(publication: WorkerPublication, owner: string): Promise<void>;
  listWorkerPublications(feature: string): WorkerPublication[];
  claimWorkerPublication(task: string, owner: string): Promise<TaskRecord>;
  clearWorkerPublication(task: string, execution: string): Promise<void>;
  reconcileTaskRebase(
    task: string,
    version: number,
    ref: ReviewRef,
    publish: () => void,
  ): Promise<void>;
  getProject(): ProjectRecord;
  createFeature(feature: Omit<FeatureRecord, 'project_id'>): void;
  /** Trusted human feature ingress (Requirements or Architect); retains the gate during regeneration. */
  claimRequirementsRevision(
    key: string,
    gitSha: string,
    decisionId: string,
    owner: string,
  ): Promise<TaskRecord>;
  /** Register the new artifact before answering its prior decision, atomically. */
  reviseFeature(
    feature: Omit<FeatureRecord, 'project_id'>,
    previousSha: string,
    decisionId: string,
    owner: string,
    evidence: { version: string; answersHash: string },
    beforeCommit: () => void,
  ): Promise<void>;
  getFeature(key: string): FeatureRecord | undefined;
  listFeatures(): FeatureRecord[];
  getDesign(key: string): DesignRecord | undefined;
  /** Durable per-Feature reservations, unique throughout the Project, including failed materialization. */
  reserveAdrNumbers(featureKey: string, count: number, minimum: number): Promise<number[]>;
  /** Human gate: compare-and-set the reviewed revision and check pending decisions atomically. */
  approveFeature(key: string, gitSha: string, beforeCommit: () => void): Promise<void>;
  createTask(task: NewTask): void;
  getTask(key: string): TaskRecord | undefined;
  listTasks(): TaskRecord[];
  /** Validated DAG ingress. Existing keys are immutable; the entire batch is atomic. */
  importTaskDag(
    dag: TaskDag,
    feature: Omit<FeatureRecord, 'project_id'>,
    design?: DesignImport,
  ): Promise<number>;
  /** SQLite-consistent snapshot, including committed WAL pages. Destination must not exist. */
  backup(destination: string): Promise<void>;
  canStart(taskId: string): boolean;
  /** TTL in milliseconds. Owner must be unique to this worker incarnation. */
  claim(taskId: string, owner: string, ttl?: number): Promise<TaskRecord>;
  /** REVIEW/QA rework atomically acquires a new lease and enters RUNNING. */
  claimRework(
    taskId: string,
    expectedVersion: number,
    owner: string,
    ttl?: number,
  ): Promise<TaskRecord>;
  heartbeat(taskId: string, owner: string, ttl?: number): Promise<TaskRecord>;
  setTaskWorktree(taskId: string, owner: string, branch: string, worktree: string): Promise<void>;
  markVerifierInfrastructureFailure(taskId: string, owner: string): Promise<void>;
  setTaskReview(taskId: string, owner: string, review: ReviewRef): Promise<void>;
  /** Human ingress: fence all writers while publishing a prepared Git rebase. */
  rebaseTask(
    taskId: string,
    version: number,
    rebase: TaskRebase,
    publish: () => void,
    rollback: () => void,
  ): Promise<void>;
  claimReview(
    taskId: string,
    expectedVersion: number,
    owner: string,
    phase?: 'review' | 'qa',
  ): Promise<TaskRecord>;
  completeReview(
    taskId: string,
    owner: string,
    review: ReviewRecord,
    beforeCommit: () => void,
    decision?: NewHumanDecision,
  ): Promise<void>;
  completeQa(
    taskId: string,
    owner: string,
    record: TestRecord,
    beforeCommit: () => void,
    decision?: NewHumanDecision,
  ): Promise<void>;
  release(taskId: string, owner: string): Promise<TaskRecord>;
  recoverExpiredLeases(): Promise<TaskRecord[]>;
  listLeaseRecoveries(): LeaseRecoveryRecord[];
  /** Durable at-most-once invocation; uncertain effects require human reconciliation. */
  withIdempotency<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
  transition(
    taskId: string,
    expectedVersion: number,
    to: TaskStatus,
    reason: string,
    actor: string,
  ): Promise<TaskRecord>;
  listDomainEvents(taskId?: string): DomainEventRecord[];
  addTaskDependency(taskKey: string, dependsOnKey: string): void;
  listTaskDependencies(taskKey: string): TaskDependencyRecord[];
  createExecution(execution: Omit<ExecutionRecord, 'project_id' | 'tree_closed_at'>): Promise<void>;
  setExecutionSession(key: string, sessionId: string): Promise<void>;
  /** Fence supervisor registration before ACK; capture the OS creation identity. */
  setExecutionProcess(key: string, owner: string, pid: number): Promise<void>;
  /** CLI closure with the supervisor retained until this write commits, or
   * confirmed cancellation/termination from the executor event stream. */
  closeExecution(key: string, owner: string): Promise<void>;
  getExecution(key: string): ExecutionRecord | undefined;
  listExecutions(): ExecutionRecord[];
  recordHumanDecision(decision: Omit<HumanDecisionRecord, 'project_id'>): void;
  getHumanDecision(key: string): HumanDecisionRecord | undefined;
  listHumanDecisions(): HumanDecisionRecord[];
  openDecision(decision: NewHumanDecision): Promise<HumanDecision>;
  /** Atomically open/join by the first context line, suspend unleased Tasks, and
   * create missing DRAFT/unknown references. Reject active work; never stop a process. */
  openOrJoinIdleDecision(
    decision: NewHumanDecision,
  ): Promise<{ decision: HumanDecision; created: boolean; added: boolean }>;
  resolveDecision(
    id: string,
    answer: string | null,
    actor: string,
    beforeCommit: () => void,
  ): Promise<HumanDecision>;
  /** Trusted ingress only: explicitly reconcile an expired gate with an audited human answer. */
  reconcileDecision(
    id: string,
    answer: string,
    actor: string,
    beforeCommit: () => void,
  ): Promise<HumanDecision>;
  listDecisions(): HumanDecision[];
  close(): void;
}
