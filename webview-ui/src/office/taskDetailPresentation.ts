import type { BoardItem } from '../../../core/src/messages.js';
import { pullRequestCi } from '../../../core/src/pullRequest.js';
import { knownText } from './displayText.js';

export function taskTitle(item: Pick<BoardItem, 'title' | 'id'>): string {
  return knownText(item.title) ?? knownText(item.id) ?? 'Tarea sin título registrado';
}

const PR_LABELS: Readonly<Record<string, string>> = {
  OPEN: 'Propuesta abierta',
  CLOSED: 'Propuesta cerrada',
  MERGED: 'Cambios integrados',
  pending: 'Pruebas pendientes',
  success: 'Pruebas correctas',
  failure: 'Pruebas con fallos',
  APPROVED: 'Revisión aprobada',
  CHANGES_REQUESTED: 'Revisión con cambios solicitados',
  REVIEW_REQUIRED: 'Revisión pendiente',
  stale: 'Resultado de pruebas pendiente de actualizar',
};

export function taskPrDescription(item: BoardItem): string {
  if (!item.prRef) return 'Esta tarea aún no tiene una propuesta de cambios vinculada.';
  const status = item.prStatus?.ref === item.prRef ? item.prStatus : undefined;
  if (!status) return 'Hay una propuesta de cambios vinculada, pendiente de consultar su estado.';
  return [
    PR_LABELS[status.state],
    status.isDraft ? 'Borrador' : undefined,
    PR_LABELS[pullRequestCi(status, item.prObservation)],
    PR_LABELS[status.reviewDecision],
  ]
    .filter(Boolean)
    .join(' · ');
}
