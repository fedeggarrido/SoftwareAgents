import type { HumanDecision, NewHumanDecision } from '../../../core/src/humanDecision.js';
import type { ModelTier } from '../../../core/src/modelTier.js';
import type { TaskStatus } from './taskStateMachine.js';

/** Operational records only. Persisting a Human Decision does not authorize an action. */
export interface ProjectRecord {
  project_id: string;
  created_at: string;
}

export interface FeatureRecord {
  project_id: string;
  key: string;
  doc_path: string;
  git_sha: string;
  status: string;
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
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
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
  getProject(): ProjectRecord;
  createFeature(feature: Omit<FeatureRecord, 'project_id'>): void;
  getFeature(key: string): FeatureRecord | undefined;
  listFeatures(): FeatureRecord[];
  createTask(task: NewTask): void;
  getTask(key: string): TaskRecord | undefined;
  listTasks(): TaskRecord[];
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
