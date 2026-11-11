export type TaskChangeKind = 'revise_spec' | 'safe_point' | 'follow_up';

const CHANGE_KIND: Readonly<Record<string, TaskChangeKind>> = {
  DRAFT: 'revise_spec',
  ANALYSIS: 'revise_spec',
  READY: 'revise_spec',
  QUEUED: 'revise_spec',
  LEASED: 'safe_point',
  RUNNING: 'safe_point',
  ACTIVE: 'safe_point',
  REVIEW: 'safe_point',
  AWAITING_REVIEW: 'safe_point',
  QA: 'safe_point',
  BLOCKED: 'safe_point',
  WAITING_DEPENDENCY: 'safe_point',
  WAITING_HUMAN: 'safe_point',
  WAITING_QUOTA: 'safe_point',
  FAILED_RETRYABLE: 'safe_point',
  FAILED_FINAL: 'follow_up',
  FAILED: 'follow_up',
  CANCELLED: 'follow_up',
  VERIFIED: 'follow_up',
  DONE: 'follow_up',
};

/** Unknown phases cannot authorize a write. Both server and office use this policy. */
export function taskChangePolicy(phase: string): TaskChangeKind | undefined {
  return CHANGE_KIND[phase];
}

export const TASK_CHANGE_TEXT: Readonly<Record<TaskChangeKind, string>> = {
  revise_spec: 'Editarás la especificación y quedará pendiente de aprobación antes de empezar.',
  safe_point:
    'La solicitud quedará registrada para revisarla en el próximo punto seguro, conservando el trabajo realizado.',
  follow_up: 'Se creará una tarea de seguimiento vinculada a esta, pendiente de planificar.',
};

export const TASK_CHANGE_MAX_CHARS = 16000;

export interface ImpactTask {
  id: string;
  epic?: string;
  dependsOn?: readonly string[];
}

/** Includes transitive dependants, deduplicated with feature peers in stable key order. */
export function taskChangeImpact<T extends ImpactTask>(task: T, tasks: readonly T[]): T[] {
  const dependants = new Set([task.id]);
  let previousSize = 0;
  while (previousSize !== dependants.size) {
    previousSize = dependants.size;
    for (const candidate of tasks)
      if (candidate.dependsOn?.some((key) => dependants.has(key))) dependants.add(candidate.id);
  }
  return tasks
    .filter(
      (candidate) =>
        candidate.id !== task.id &&
        (dependants.has(candidate.id) || (!!task.epic && candidate.epic === task.epic)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}
