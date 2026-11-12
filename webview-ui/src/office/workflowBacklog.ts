import type {
  BoardItem,
  ProjectSummarySnapshot,
  WorkflowStageId,
} from '../../../core/src/messages.js';

const READ_MESSAGES = {
  denied: 'Acceso denegado al flujo del proyecto.',
  unknown_project: 'El proyecto seleccionado ya no está vinculado a esta oficina.',
  read_error: 'No se pudo actualizar la etapa.',
  ok: 'Etapa no disponible.',
  empty: 'Etapa no disponible.',
};

/** Membership comes entirely from the server projection, including empty stages. */
export function workflowBacklog(
  items: BoardItem[],
  snapshot: ProjectSummarySnapshot | null,
  projectId: string | null,
  stageId: WorkflowStageId | null,
) {
  if (!stageId) return { items, stage: null, message: null };
  const stage =
    snapshot?.projectId === projectId
      ? (snapshot.summary?.workflow.find((stage) => stage.id === stageId) ?? null)
      : null;
  const message =
    snapshot?.projectId === projectId ? READ_MESSAGES[snapshot.status] : 'Cargando la etapa…';
  return {
    items: stage ? items.filter((item) => stage.taskKeys.includes(item.id)) : [],
    stage,
    message,
  };
}
