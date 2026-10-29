import { randomUUID } from 'node:crypto';

import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { recordAudit } from './auditLog.js';
import {
  USAGE_BUDGET_MINUTE_MS,
  USAGE_BUDGET_POLL_MS,
  USAGE_BUDGET_SECOND_MS,
} from './constants.js';
import type { WorkStore } from './workstore/WorkStore.js';

export class UsageBudgetExceeded extends Error {}

/** Cancel through the existing executor handle; the caller must still drain and verify closure. */
export function watchExecutionBudget(
  budgets: ProjectOperatorConfig['budgets'],
  cancel: () => void,
  exceeded: () => void,
): () => void {
  const limits = [
    budgets?.maxExecutionMinutes === undefined
      ? undefined
      : budgets.maxExecutionMinutes * USAGE_BUDGET_MINUTE_MS,
    budgets?.maxExecutionSeconds === undefined
      ? undefined
      : budgets.maxExecutionSeconds * USAGE_BUDGET_SECOND_MS,
  ].filter((n): n is number => n !== undefined);
  if (!limits.length) return () => {};
  const deadline = Date.now() + Math.min(...limits);
  const timer = setInterval(
    () => {
      if (Date.now() < deadline) return;
      clearInterval(timer);
      exceeded();
      cancel();
    },
    Math.min(USAGE_BUDGET_POLL_MS, Math.max(1, Math.min(...limits))),
  );
  timer.unref();
  return () => clearInterval(timer);
}

export async function openBudgetDecision(store: WorkStore, task: string, reason: string) {
  recordAudit(
    'launch_execution',
    'task',
    task,
    { status: 'budget_exceeded', reason },
    {
      projectId: store.projectId,
      actorType: 'system',
      actorId: 'worker',
      taskKey: task,
    },
  );
  return store.openOrJoinIdleDecision({
    id: randomUUID(),
    context: `usage-budget/${task}/${reason}\n¿ampliar presupuesto?\nTope alcanzado: ${reason}. Ajusta budgets en la config del operador antes de reintentar.`,
    options: [
      {
        id: 'reevaluate',
        label: 'Reevaluar presupuesto',
        benefit: 'Permite reintentar tras ajustar la config',
        cost: 'Puede consumir más recursos',
        risk: 'La respuesta no amplía límites ni lanza ejecuciones',
      },
    ],
    recommendation: 'Revisar el uso y ajustar el presupuesto si procede',
    disagreement: [],
    impact: 'La tarea espera al operador',
    urgency: 'high',
    requestedBy: 'system',
    blocks: [task],
  });
}
