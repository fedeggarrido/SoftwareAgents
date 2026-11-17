import { createHash, randomUUID } from 'node:crypto';

import type { DagTask } from '../../core/src/taskDag.js';
import { featureIngressActor } from './featureIngress.js';
import type { IntegrationEntry } from './integrationCatalog.js';
import { INTEGRATION_DECISION_PREFIX } from './integrationConstants.js';
import { taskDeclaration } from './taskDag.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** One atomic decision per immutable task/design, covering all declared new services. */
export async function requireIntegrationAccess(
  store: Pick<WorkStore, 'listDecisions' | 'openOrJoinIdleDecision'>,
  feature: string,
  task: DagTask,
  designSha: string,
  catalog: readonly IntegrationEntry[],
): Promise<boolean> {
  if (task.agentRole !== 'integrations') return true;
  const hash = createHash('sha256')
    .update(designSha)
    .update(taskDeclaration(feature, task))
    .digest('hex');
  const context = `${INTEGRATION_DECISION_PREFIX}${task.key}/${hash}`;
  const decision = store.listDecisions().find((entry) => entry.context.split('\n')[0] === context);
  // A denial/pending decision continues to gate the task even if the catalog later changes.
  if (decision)
    return (
      decision.status === 'answered' &&
      decision.answer === 'allow' &&
      !!decision.answeredBy &&
      !!decision.answeredAt
    );
  const services = (task.externalServices ?? []).filter(
    (service) => !catalog.some((entry) => entry.service === service),
  );
  if (!services.length) return true;
  await store.openOrJoinIdleDecision({
    id: randomUUID(),
    context: `${context}\nServicios nuevos · ${services.join(', ')}\n\n${task.title}\n${task.description}`,
    blocks: [task.key],
    requestedBy: 'integrations',
    options: [
      {
        id: 'allow',
        label: 'Autorizar los servicios indicados',
        benefit: 'Permite implementar la integración declarada',
        cost: 'Revisar las condiciones de acceso y sus límites',
        risk: 'El servicio externo puede recibir datos del proyecto',
      },
      {
        id: 'deny',
        label: 'Denegar el acceso',
        benefit: 'Conserva el alcance de acceso actual',
        cost: 'Requiere replantear la tarea',
        risk: 'La integración queda pendiente',
      },
    ],
    recommendation: 'Revisa los servicios y el alcance de datos antes de autorizar el acceso.',
    disagreement: [],
    impact: 'La tarea de integraciones queda bloqueada hasta tu autorización.',
    urgency: 'high',
  });
  return false;
}

export function assertIntegrationAnswer(store: Pick<WorkStore, 'listDecisions'>, id: string): void {
  const decision = store.listDecisions().find((entry) => entry.id === id);
  if (
    decision?.context.startsWith(INTEGRATION_DECISION_PREFIX) &&
    featureIngressActor() !== 'human'
  )
    throw new Error('El acceso a servicios externos requiere una decisión del humano.');
}
