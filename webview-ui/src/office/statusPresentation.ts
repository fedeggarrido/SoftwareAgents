import type { StatusDefinition } from '../constants.js';
import { STATUS_MAP } from '../constants.js';
import { knownText } from './displayText.js';

const TASK_STATE_EXPLANATIONS: Readonly<Record<string, string>> = {
  DRAFT: 'La especificación está en borrador y aún debe prepararse para empezar.',
  ANALYSIS: 'Se están aclarando los requisitos antes de empezar la tarea.',
  READY: 'La tarea está preparada para que un agente la tome.',
  QUEUED: 'La tarea espera su turno para empezar.',
  LEASED: 'Un agente ha reservado la tarea y está preparando la ejecución.',
  RUNNING: 'Un agente está realizando el trabajo de la tarea.',
  ACTIVE: 'Un agente está realizando el trabajo de la tarea.',
  REVIEW: 'Se están revisando los cambios realizados.',
  AWAITING_REVIEW: 'Los cambios esperan una revisión antes de continuar.',
  QA: 'Se está comprobando que los cambios cumplen los criterios de aceptación.',
  WAITING_HUMAN: 'La tarea necesita una decisión humana para continuar.',
  WAITING_QUOTA: 'La tarea espera que el servicio de IA vuelva a tener capacidad disponible.',
  WAITING_DEPENDENCY: 'La tarea espera a que termine otra tarea necesaria.',
  BLOCKED: 'Hay un impedimento pendiente de resolver para continuar.',
  FAILED_RETRYABLE: 'La ejecución ha fallado y la tarea puede volver a intentarse.',
  FAILED_FINAL: 'La tarea ha agotado sus intentos y necesita revisión humana.',
  FAILED: 'La tarea ha fallado y necesita revisión humana.',
  CANCELLED: 'La tarea se ha cancelado y su trabajo queda detenido.',
  VERIFIED: 'Los cambios están verificados y esperan su integración.',
  DONE: 'El trabajo de la tarea ha terminado.',
};

export function taskStateExplanation(state: string): string | undefined {
  return TASK_STATE_EXPLANATIONS[state];
}

export function statusPresentation(state: string): StatusDefinition {
  return STATUS_MAP[state] ?? STATUS_MAP.unknown;
}

/** Human event text can contain protocol transitions; never display their raw state names. */
export function readableStateText(value: string | null | undefined): string | undefined {
  return knownText(value)?.replace(
    /\b[A-Z][A-Z_]+\b/g,
    (state) => STATUS_MAP[state]?.label ?? state,
  );
}
