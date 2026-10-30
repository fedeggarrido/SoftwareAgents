import type { DomainEventPayload, WorkSnapshot, WorkTask } from '../../../core/src/messages.js';
import {
  WORK_PLANNING_ROLES,
  WORK_PLANNING_TYPES,
  WORK_REVIEW_TYPES,
  WORK_STATE,
  WORK_TASK_DETAIL_PREFIX,
  WORK_TEST_TYPES,
} from '../constants.js';

export type WorkState = (typeof WORK_STATE)[keyof typeof WORK_STATE];
export interface WorkCharacter {
  id: number;
  detail?: string;
  /** Project the Session belongs to, when the transport reported it. */
  projectId?: string;
}
type ProjectedTask = Pick<WorkTask, 'key'> & Partial<WorkTask>;

/** Exact recorded task key of a Session in the snapshot's Project. A role label or
 * execution id alone cannot identify a Session in the current wire protocol. When
 * several open Sessions recorded the same task (Developer, then Reviewer), only the
 * newest one (highest id) is doing its current step; older ones get no badge. */
export function deriveWorkStates(
  snapshot: WorkSnapshot | null,
  events: readonly DomainEventPayload[],
  characters: readonly WorkCharacter[],
): Map<number, WorkState> {
  const result = new Map(characters.map((ch) => [ch.id, WORK_STATE.AVAILABLE as WorkState]));
  // 'missing' is a real, empty WorkStore: events after it still describe new work.
  if (!snapshot || (snapshot.source !== 'ok' && snapshot.source !== 'missing')) return result;
  const tasks = new Map<string, ProjectedTask>(
    snapshot.tasks.map((task) => [task.key, { ...task }]),
  );
  for (const event of [...events].sort((a, b) => a.eventId - b.eventId)) {
    if (event.projectId !== snapshot.projectId || event.eventId <= (snapshot.lastEventId ?? 0))
      continue;
    const task = tasks.get(event.taskKey) ?? { key: event.taskKey };
    if (
      event.taskVersion !== undefined &&
      task.version !== undefined &&
      event.taskVersion < task.version
    )
      continue;
    tasks.set(event.taskKey, task);
    if (event.agentRole !== null) task.agentRole = event.agentRole;
    if (event.toStatus) task.status = event.toStatus;
    else if (event.kind === 'human.decision.required') task.status = 'WAITING_HUMAN';
    else if (event.kind === 'human.decision.answered') task.status = 'READY';
    else if (event.kind === 'quota.waiting' || event.kind === 'quota.exhausted')
      task.status = 'WAITING_QUOTA';
    else if (event.kind === 'execution.started') task.status = 'RUNNING';
    else if (event.kind === 'execution.finished') task.status = 'READY';
    else if (event.kind === 'review.requested') task.status = 'REVIEW';
    else if (event.kind === 'qa.requested') task.status = 'QA';
    if (event.taskVersion !== undefined) task.version = event.taskVersion;
  }
  const newest = new Map<string, number>();
  for (const ch of characters) {
    if (ch.projectId !== undefined && ch.projectId !== snapshot.projectId) continue;
    if (!ch.detail?.startsWith(WORK_TASK_DETAIL_PREFIX)) continue;
    const key = ch.detail.slice(WORK_TASK_DETAIL_PREFIX.length);
    newest.set(key, Math.max(newest.get(key) ?? ch.id, ch.id));
  }
  for (const [key, id] of newest) {
    const task = tasks.get(key);
    if (task) result.set(id, taskState(task, tasks));
  }
  return result;
}

function taskState(task: ProjectedTask, tasks: ReadonlyMap<string, ProjectedTask>): WorkState {
  switch (task.status) {
    case 'WAITING_HUMAN':
      return WORK_STATE.WAITING_HUMAN;
    case 'WAITING_QUOTA':
      return WORK_STATE.WAITING_QUOTA;
    case 'BLOCKED':
      return WORK_STATE.BLOCKED;
    case 'FAILED_RETRYABLE':
    case 'FAILED_FINAL':
      return WORK_STATE.FAILED;
    case 'REVIEW':
      return WORK_STATE.REVIEWING;
    case 'QA':
      return WORK_STATE.TESTING;
    case 'LEASED':
    case 'RUNNING':
      if (
        (task.type !== undefined && WORK_PLANNING_TYPES.includes(task.type)) ||
        (typeof task.agentRole === 'string' && WORK_PLANNING_ROLES.includes(task.agentRole))
      )
        return WORK_STATE.PLANNING;
      if (task.type !== undefined && WORK_REVIEW_TYPES.includes(task.type))
        return WORK_STATE.REVIEWING;
      if (task.type !== undefined && WORK_TEST_TYPES.includes(task.type)) return WORK_STATE.TESTING;
      return WORK_STATE.CODING;
    case 'DRAFT':
    case 'READY':
    case 'QUEUED':
      return task.dependsOn?.some((key) => tasks.has(key) && tasks.get(key)?.status !== 'DONE')
        ? WORK_STATE.WAITING_DEPENDENCY
        : WORK_STATE.AVAILABLE;
    default:
      return WORK_STATE.AVAILABLE;
  }
}
