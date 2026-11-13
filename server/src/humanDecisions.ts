import { randomUUID } from 'crypto';

import type { AutonomyLevel, ProjectConfig } from '../../core/src/project.js';
import { assertArchitectureAnswer } from './architectureDecisions.js';
import { AuditLog } from './auditLog.js';
import { featureIngressActor } from './featureIngress.js';
import { evaluatePolicy, type PolicyAction, type PolicyActor } from './policy.js';
import { loadProjectConfig } from './projectConfig.js';
import { materializeStackAdr } from './projectStack.js';
import { assertTaskChangeAnswer } from './taskChangeDecisions.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** Identity and privilege come from authenticated ingress, never message fields. */
export class HumanDecisions {
  constructor(
    private readonly store: WorkStore,
    private readonly audit = new AuditLog(),
    private readonly project?: ProjectConfig,
  ) {}

  async answer(
    id: string,
    answer: string,
    privileged: boolean,
    answeredBy: string,
    level: AutonomyLevel,
  ) {
    return this.respond(id, answer, privileged, answeredBy, level, false);
  }

  /** Expiry is released only by a new, explicit authenticated operator action. */
  async reconcile(
    id: string,
    answer: string,
    privileged: boolean,
    answeredBy: string,
    level: AutonomyLevel,
  ) {
    return this.respond(id, answer, privileged, answeredBy, level, true);
  }

  private async respond(
    id: string,
    answer: string,
    privileged: boolean,
    answeredBy: string,
    level: AutonomyLevel,
    reconcile: boolean,
  ) {
    assertTaskChangeAnswer(this.store, id);
    assertArchitectureAnswer(this.store, id);
    const policy = evaluatePolicy('answer_decision', privileged ? 'human' : 'system', level);
    const attemptId = randomUUID();
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
        input: { id, answer, reconcile },
        outcome: {
          status,
          detail: JSON.stringify({
            attemptId,
            reconcile,
            answeredBy: privileged ? answeredBy : null,
          }),
        },
        taskKey: null,
        executionId: null,
      });
    if (!privileged || policy.outcome !== 'allow' || !answeredBy.trim()) {
      append('rejected');
      throw new Error('Authenticated operator token required');
    }
    const stack = this.store.listDecisions().find((decision) => decision.id === id)?.projectStack;
    // Choosing the stack unblocks the Architect: only a human may answer, never a managed agent.
    if (stack && featureIngressActor() !== 'human') {
      append('rejected');
      throw new Error('Stack decisions require the human operator');
    }
    const config = stack ? (this.project ?? loadProjectConfig(process.cwd())) : undefined;
    if (stack && config?.project.id !== this.store.projectId)
      throw new Error('Stack decision requires its bound Project');
    if (stack && this.store.getFeature(stack.feature)?.git_sha !== stack.specSha)
      throw new Error('Stack decision requirements changed');
    let decision;
    try {
      decision = await (reconcile
        ? this.store.reconcileDecision(id, answer, answeredBy, () => append('pending'))
        : this.store.resolveDecision(id, answer, answeredBy, () => append('pending')));
    } catch (error) {
      append('rejected');
      throw error;
    }
    // A durable intent is not success. Only append confirmation after SQLite COMMIT.
    // Failure here must never produce a rejected record for an already committed answer.
    try {
      if (config) materializeStackAdr(config, decision, this.store);
      append('answered');
    } catch (cause) {
      throw new Error(
        config
          ? 'Decision committed; ADR or audit confirmation pending. Inspect WorkStore before retrying.'
          : 'Decision committed; audit confirmation pending. Inspect WorkStore before retrying.',
        { cause },
      );
    }
    return decision;
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
    const config = loadProjectConfig(repositoryPath);
    await new HumanDecisions(store, undefined, config ?? undefined).answer(
      id,
      answer,
      privileged,
      'operator',
      level,
    );
    return `${id}: respuesta guardada; tareas restauradas. La acción requiere revisión explícita.`;
  } finally {
    store.close();
  }
}
