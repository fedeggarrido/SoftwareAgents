import type { WorkSize } from './modelTier.js';

export type DagTaskType = 'spec' | 'design' | 'code' | 'review' | 'qa' | 'doc' | 'spike';

export interface DagTask {
  /** `FEAT-###-T##`, prefixed by the DAG's feature key. */
  key: string;
  type: DagTaskType;
  title: string;
  description: string;
  /** FeatureSpec acceptance ids (`AC-###`) this task covers. */
  acceptanceRefs: string[];
  /** Keys of tasks that must finish before this one may start. */
  dependsOn: string[];
  /** AgentSpec `metadata.id`; a role reference, never a permission grant. */
  agentRole: string;
  size: WorkSize;
  /** Declarative repository-relative paths/globs; required for new Architect output. */
  changeZones?: string[];
  /** A scheduling hint, never authorization to run concurrently. */
  parallelizable?: boolean;
}

/** Task DAG produced by the Architect for one FeatureSpec. Not persisted by itself. */
export interface TaskDag {
  apiVersion: 'softwareagents.io/v1alpha1';
  kind: 'TaskDAG';
  feature: string;
  tasks: DagTask[];
}

export type TaskDagIssue =
  /** Same key declared more than once; `indices` are positions in `tasks`. */
  | { code: 'duplicate_key'; key: string; indices: number[] }
  /** Task key whose `FEAT-###` prefix is not the DAG's feature. */
  | { code: 'foreign_key'; key: string; feature: string }
  | { code: 'dangling_dependency'; task: string; dependsOn: string }
  /** Dependency path that returns to its start: `[A, B, A]` reads "A depends on B depends on A". */
  | { code: 'cycle'; path: string[] }
  | { code: 'feature_mismatch'; dagFeature: string; specFeature: string }
  | { code: 'unknown_acceptance'; task: string; acceptanceRef: string }
  | { code: 'uncovered_acceptance'; acceptanceId: string };

export interface TaskDagAnalysis {
  valid: boolean;
  issues: TaskDagIssue[];
  /** Stable topological order; null when duplicates, dangling dependencies or cycles exist. */
  order: string[] | null;
  /** Level n holds tasks whose dependencies all lie in levels < n; they may run in parallel. */
  levels: string[][] | null;
}
