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
  status: string;
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
  session_id: string | null;
  pid: number | null;
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

export type NewTask = Pick<TaskRecord, 'key' | 'type'> &
  Partial<Omit<TaskRecord, 'project_id' | 'key' | 'type' | 'created_at' | 'updated_at'>>;

/** One Project per handle; no SQL/connection escape hatch or status transitions. */
export interface WorkStore {
  readonly projectId: string;
  getProject(): ProjectRecord;
  createFeature(feature: Omit<FeatureRecord, 'project_id'>): void;
  getFeature(key: string): FeatureRecord | undefined;
  listFeatures(): FeatureRecord[];
  createTask(task: NewTask): void;
  getTask(key: string): TaskRecord | undefined;
  listTasks(): TaskRecord[];
  addTaskDependency(taskKey: string, dependsOnKey: string): void;
  listTaskDependencies(taskKey: string): TaskDependencyRecord[];
  createExecution(execution: Omit<ExecutionRecord, 'project_id'>): void;
  getExecution(key: string): ExecutionRecord | undefined;
  listExecutions(): ExecutionRecord[];
  recordHumanDecision(decision: Omit<HumanDecisionRecord, 'project_id'>): void;
  getHumanDecision(key: string): HumanDecisionRecord | undefined;
  listHumanDecisions(): HumanDecisionRecord[];
  close(): void;
}
