export const TASK_TRANSITIONS = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['QUEUED', 'BLOCKED', 'WAITING_HUMAN', 'WAITING_QUOTA', 'CANCELLED'],
  QUEUED: ['LEASED', 'BLOCKED', 'WAITING_HUMAN', 'WAITING_QUOTA', 'CANCELLED'],
  LEASED: [
    'RUNNING',
    'FAILED_RETRYABLE',
    'FAILED_FINAL',
    'WAITING_HUMAN',
    'WAITING_QUOTA',
    'CANCELLED',
  ],
  RUNNING: [
    'REVIEW',
    'BLOCKED',
    'FAILED_RETRYABLE',
    'FAILED_FINAL',
    'WAITING_HUMAN',
    'WAITING_QUOTA',
    'CANCELLED',
  ],
  REVIEW: [
    'DONE',
    'QA',
    'READY',
    'RUNNING',
    'BLOCKED',
    'FAILED_FINAL',
    'WAITING_HUMAN',
    'CANCELLED',
  ],
  QA: ['READY', 'DONE', 'RUNNING', 'BLOCKED', 'FAILED_FINAL', 'WAITING_HUMAN', 'CANCELLED'],
  BLOCKED: ['READY', 'FAILED_FINAL', 'CANCELLED'],
  FAILED_RETRYABLE: ['READY', 'FAILED_FINAL', 'CANCELLED'],
  WAITING_HUMAN: ['READY', 'FAILED_FINAL', 'CANCELLED'],
  WAITING_QUOTA: ['READY', 'CANCELLED'],
  DONE: [],
  FAILED_FINAL: [],
  CANCELLED: [],
} as const;

export type TaskStatus = keyof typeof TASK_TRANSITIONS;

export function isTaskStatus(value: string): value is TaskStatus {
  return Object.hasOwn(TASK_TRANSITIONS, value);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** Missing dependencies fail closed; an empty dependency set is eligible. */
export function canStart(task: {
  dependencies: readonly ({ status: string } | undefined)[];
}): boolean {
  return task.dependencies.every((dependency) => dependency?.status === 'DONE');
}

export function attemptIncrement(from: TaskStatus, to: TaskStatus): number {
  return (from === 'REVIEW' || from === 'QA') && (to === 'RUNNING' || to === 'READY') ? 1 : 0;
}

export class TaskVersionConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`Task ${taskId}: expected version ${expectedVersion}, actual ${actualVersion}`);
    this.name = 'TaskVersionConflictError';
  }
}

export class TaskTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly code: 'NOT_FOUND' | 'INVALID_TRANSITION' | 'DEPENDENCIES_NOT_DONE',
  ) {
    super(`Task ${taskId}: ${code}`);
    this.name = 'TaskTransitionError';
  }
}
