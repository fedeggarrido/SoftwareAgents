import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type { HumanDecision } from '../../core/src/humanDecision.js';
import { featureIngressActor } from './featureIngress.js';
import {
  ARCHITECTURE_DECISION_PREFIX,
  ARCHITECTURE_PROPOSAL_ERROR,
} from './projectArchitectureConstants.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';
import type { WorkStore } from './workstore/WorkStore.js';

export type ArchitectureChoice =
  | { kind: 'hexagonal' }
  | { kind: 'alternative'; name: string; rationale: string; alternatives: string[] };

const text = { type: 'string', minLength: 1, pattern: '\\S' };
export const architectureChoiceContract = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'hexagonal' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'name', 'rationale', 'alternatives'],
      properties: {
        kind: { const: 'alternative' },
        name: text,
        rationale: text,
        alternatives: { type: 'array', minItems: 2, uniqueItems: true, items: text },
      },
    },
  ],
};
interface ArchitectureBinding {
  choice: Extract<ArchitectureChoice, { kind: 'alternative' }>;
  specSha: string;
  adrPath: string;
}
const validateBinding = compileSchema<ArchitectureBinding>({
  type: 'object',
  additionalProperties: false,
  required: ['choice', 'specSha', 'adrPath'],
  properties: { choice: architectureChoiceContract.oneOf[1], specSha: text, adrPath: text },
});

function contextKey(key: string, binding: ArchitectureBinding): string {
  const hash = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  return `${ARCHITECTURE_DECISION_PREFIX}${key}/${binding.specSha}/${hash}`;
}

export function architectureAdr(binding: ArchitectureBinding, decision?: HumanDecision): string {
  const literal = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) => `    ${line}`)
      .join('\n');
  return [
    `# ADR-${path.posix.basename(binding.adrPath).slice(0, 4)}: Arquitectura del proyecto`,
    `Estado · ${decision ? 'Aceptado por el humano' : 'Propuesto; decisión humana pendiente'}`,
    `Requisitos · ${binding.specSha}`,
    ...(decision ? [`Decisión · ${decision.id} · ${decision.answeredBy}`] : []),
    '## Propuesta',
    literal(binding.choice.name),
    '## Justificación',
    literal(binding.choice.rationale),
    '## Alternativas',
    ...binding.choice.alternatives.map(literal),
    '',
  ].join('\n\n');
}

/** Run after the worker released its lease; the proposed ADR is reviewable in Decisions.
 * The accepted ADR is published atomically with TechnicalDesign through architectArtifacts. */
export async function openArchitectureAlternative(
  store: Pick<WorkStore, 'getFeature' | 'openOrJoinIdleDecision'>,
  key: string,
  error: string,
) {
  const value: unknown = JSON.parse(error.slice(ARCHITECTURE_PROPOSAL_ERROR.length));
  const binding = validateSchema(validateBinding, value);
  if (store.getFeature(key)?.git_sha !== binding.specSha)
    throw new Error('Architecture proposal requirements changed');
  return store.openOrJoinIdleDecision({
    id: randomUUID(),
    context: `${contextKey(key, binding)}\nADR · ${binding.adrPath}\n\n${architectureAdr(binding)}`,
    blocks: [`${key}-DESIGN`],
    requestedBy: 'architect',
    options: [
      {
        id: 'alternative',
        label: binding.choice.name,
        benefit: binding.choice.rationale,
        cost: 'Renuncia a la plantilla hexagonal',
        risk: 'Revisar los límites y sus verificadores',
      },
      {
        id: 'hexagonal',
        label: 'Mantener arquitectura hexagonal',
        benefit: 'Conserva los puertos y adaptadores',
        cost: 'Rehacer la propuesta',
        risk: 'Revisar el nuevo diseño',
      },
    ],
    recommendation:
      'Revisar el ADR y elegir la arquitectura; la recomendación del agente no autoriza el diseño.',
    disagreement: [],
    impact: 'TechnicalDesign y TaskDAG bloqueados hasta tu respuesta.',
    urgency: 'medium',
  });
}

export function requireArchitectureChoice(
  store: Pick<WorkStore, 'getFeature' | 'listDecisions'>,
  key: string,
  choice: ArchitectureBinding['choice'],
  adrPath: string,
): string {
  const feature = store.getFeature(key);
  if (!feature) throw new Error('Architecture requires approved requirements');
  const binding = { choice, specSha: feature.git_sha, adrPath };
  const context = contextKey(key, binding);
  const decision = store.listDecisions().find((entry) => entry.context.split('\n')[0] === context);
  if (!decision || decision.status !== 'answered' || !decision.answeredBy || !decision.answeredAt)
    throw new SchemaValidationError([`${ARCHITECTURE_PROPOSAL_ERROR}${JSON.stringify(binding)}`]);
  if (decision.answer !== 'alternative')
    throw new SchemaValidationError([
      'El humano eligió arquitectura hexagonal. Rehaz el diseño desde la plantilla.',
    ]);
  return architectureAdr(binding, decision);
}

/** Same gate for CLI, orchestrator and direct worker calls, before any execution. */
export function requireArchitectureDecision(
  store: Pick<WorkStore, 'getFeature' | 'listDecisions'>,
  key: string,
): void {
  const prefix = `${ARCHITECTURE_DECISION_PREFIX}${key}/${store.getFeature(key)?.git_sha}/`;
  if (
    store
      .listDecisions()
      .some((entry) => entry.context.startsWith(prefix) && entry.status !== 'answered')
  )
    throw new Error('El diseño espera la decisión humana sobre la arquitectura.');
}

export function assertArchitectureAnswer(
  store: Pick<WorkStore, 'getFeature' | 'listDecisions'>,
  id: string,
): void {
  const decision = store.listDecisions().find((entry) => entry.id === id);
  if (!decision?.context.startsWith(ARCHITECTURE_DECISION_PREFIX)) return;
  if (featureIngressActor() !== 'human')
    throw new Error('La arquitectura requiere una decisión del humano.');
  const [, key, sha] = decision.context.split('\n')[0].split('/');
  if (store.getFeature(key)?.git_sha !== sha)
    throw new Error('Architecture decision requirements changed');
}
