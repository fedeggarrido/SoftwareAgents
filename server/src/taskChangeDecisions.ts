import { createHash } from 'node:crypto';

import type { HumanDecision } from '../../core/src/humanDecision.js';
import { featureIngressActor } from './featureIngress.js';
import type { TaskRecord, WorkStore } from './workstore/WorkStore.js';

export function taskSpecPrefix(task: Pick<TaskRecord, 'key' | 'declaration'>): string {
  const hash = createHash('sha256')
    .update(task.declaration ?? '')
    .digest('hex');
  return `task-spec/${task.key}/${hash}/`;
}

/** Approved text overlays only the description. The imported DAG and scope stay bound. */
export function approvedTaskDescription(
  decisions: readonly HumanDecision[],
  task: Pick<TaskRecord, 'key' | 'declaration'>,
): string | undefined {
  const prefix = taskSpecPrefix(task);
  const approved = decisions
    .filter(
      (decision) =>
        decision.context.startsWith(prefix) &&
        decision.status === 'answered' &&
        decision.answer === 'approve',
    )
    .sort((a, b) => (a.answeredAt ?? '').localeCompare(b.answeredAt ?? ''))
    .at(-1);
  return approved?.context.slice(approved.context.indexOf('\n') + 1);
}

export function taskDecisionText(context: string): string {
  return /^(task-spec|task-change)\//.test(context)
    ? context.slice(context.indexOf('\n') + 1)
    : context;
}

export function assertTaskChangeAnswer(store: WorkStore, id: string): void {
  const request = store.listDecisions().find((decision) => decision.id === id);
  if (!request || !/^task-(spec|change)\//.test(request.context)) return;
  if (featureIngressActor() !== 'human')
    throw new Error('La confirmación requiere una oficina abierta por una persona.');
  const key = request.context.split('/')[1];
  if (
    store.getTask(key)?.lease_owner ||
    store
      .listExecutions()
      .some(
        (execution) =>
          execution.task_key === key && execution.pid !== null && !execution.tree_closed_at,
      )
  )
    throw new Error('La solicitud espera al próximo punto seguro de la tarea.');
}

/** A request never interrupts an Execution. Attach its existing decision once work is idle. */
export async function taskChangeSafePoint(store: WorkStore, key: string): Promise<void> {
  const task = store.getTask(key);
  if (
    !task ||
    task.lease_owner ||
    ['LEASED', 'RUNNING', 'DONE', 'FAILED_FINAL', 'CANCELLED', 'WAITING_HUMAN'].includes(
      task.status,
    ) ||
    store.listExecutions().some((e) => e.task_key === key && e.pid !== null && !e.tree_closed_at)
  )
    return;
  if (
    store
      .listDecisions()
      .some((decision) => decision.status !== 'answered' && decision.blocks.includes(key))
  )
    return;
  const decision = store
    .listDecisions()
    .find(
      (candidate) =>
        candidate.status === 'open' &&
        candidate.context.startsWith(`task-change/${key}/`) &&
        !candidate.blocks.includes(key),
    );
  if (decision) await store.openOrJoinIdleDecision({ ...decision, blocks: [key] });
}
