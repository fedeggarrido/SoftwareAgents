import type { BoardItem } from '../../../core/src/messages.js';
import { pullRequestCi } from '../../../core/src/pullRequest.js';
import { es } from '../i18n/es.js';
import { knownText } from './displayText.js';

export function taskTitle(item: Pick<BoardItem, 'title' | 'id'>): string {
  return knownText(item.title) ?? knownText(item.id) ?? 'Tarea sin título registrado';
}

const PR_LABELS: Readonly<Record<string, string>> = es.pullRequest.labels;

export function pullRequestStateLabel(state: string): string {
  return PR_LABELS[state] ?? es.pullRequest.labels.unknown;
}

export function taskPrDescription(item: BoardItem): string {
  if (!item.prRef) return 'Esta tarea aún no tiene una propuesta de cambios vinculada.';
  const status = item.prStatus?.ref === item.prRef ? item.prStatus : undefined;
  if (!status) return 'Hay una propuesta de cambios vinculada, pendiente de consultar su estado.';
  return [
    pullRequestStateLabel(status.state),
    status.isDraft ? es.pullRequest.draft : undefined,
    pullRequestStateLabel(pullRequestCi(status, item.prObservation)),
    pullRequestStateLabel(status.reviewDecision),
  ]
    .filter(Boolean)
    .join(' · ');
}
