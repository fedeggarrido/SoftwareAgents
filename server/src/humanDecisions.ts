import { randomUUID } from 'crypto';

import type { AutonomyLevel } from '../../core/src/project.js';
import { AuditLog } from './auditLog.js';
import { evaluatePolicy, type PolicyAction, type PolicyActor } from './policy.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** Identity and privilege come from authenticated ingress, never message fields. */
export class HumanDecisions {
  constructor(
    private readonly store: WorkStore,
    private readonly audit = new AuditLog(),
  ) {}

  async answer(
    id: string,
    answer: string,
    privileged: boolean,
    answeredBy: string,
    level: AutonomyLevel,
  ) {
    const policy = evaluatePolicy('answer_decision', privileged ? 'human' : 'system', level);
    const append = (status: string) =>
      this.audit.append({
        action: 'answer_decision',
        resourceType: 'human_decision',
        resourceId: id,
        projectId: this.store.projectId,
        actorType: privileged ? 'human' : 'unknown',
        actorId: privileged ? answeredBy : null,
        policyDecision: policy,
        riskLevel: 'high',
        input: { id, answer },
        outcome: { status, detail: privileged ? JSON.stringify({ answeredBy }) : undefined },
        taskKey: null,
        executionId: null,
      });
    if (!privileged || policy.outcome !== 'allow' || !answeredBy.trim()) {
      append('rejected');
      throw new Error('Authenticated operator token required');
    }
    try {
      return await this.store.resolveDecision(id, answer, answeredBy, () => append('answered'));
    } catch (error) {
      append('rejected');
      throw error;
    }
  }

  /** Persist require_human; a later answer does not execute this action. */
  async requireHuman(
    action: PolicyAction,
    actor: PolicyActor,
    level: AutonomyLevel,
    context: string,
    blocks: string[],
  ) {
    const policy = evaluatePolicy(action, actor, level);
    if (policy.outcome !== 'require_human') return undefined;
    return this.store.openDecision({
      id: randomUUID(),
      context,
      blocks,
      requestedBy: actor,
      options: [
        {
          id: 'review',
          label: 'Revisar manualmente',
          benefit: 'Permite evaluar el cambio concreto',
          cost: 'Tiempo del operador',
          risk: 'La revisión debe comprobar el alcance',
        },
        {
          id: 'stop',
          label: 'No autorizar',
          benefit: 'Conserva el gate humano',
          cost: 'Trabajo pendiente',
          risk: 'Retraso de la tarea',
        },
      ],
      recommendation: 'Revisar manualmente antes de ejecutar la acción',
      disagreement: [],
      impact: policy.reason,
      urgency: 'high',
    });
  }
}

export async function answerProjectDecision(
  repositoryPath: string,
  projectId: string,
  level: AutonomyLevel,
  id: string,
  answer: string,
  privileged: boolean,
): Promise<string> {
  const { openWorkStore } = await import('./workstore/SqliteWorkStore.js');
  const store = await openWorkStore({ repositoryPath, projectId });
  try {
    if (!store.listDecisions().some((d) => d.id === id)) return '';
    await new HumanDecisions(store).answer(id, answer, privileged, 'operator', level);
    return `${id}: respuesta guardada; tareas restauradas. La acción requiere revisión explícita.`;
  } finally {
    store.close();
  }
}
