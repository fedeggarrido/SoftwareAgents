import { useSyncExternalStore } from 'react';

import type {
  IdeaAnswer,
  IdeaErrorCode,
  IdeasSnapshot,
  PrepareProjectResult,
  SubmitIdea,
  SubmitIdeaResult,
} from '../../../core/src/messages.js';
import type { MessageTransport } from '../../../core/src/transport.js';

export interface IdeasStore {
  requestId: string | null;
  snapshot: IdeasSnapshot | null;
  pending: { requestId: string; projectId: string } | null;
  result: SubmitIdeaResult | null;
  uncertain: boolean;
  preparationPending?: string;
  preparationResult?: PrepareProjectResult;
}

export const emptyIdeasStore = (): IdeasStore => ({
  requestId: null,
  snapshot: null,
  pending: null,
  result: null,
  uncertain: false,
});

export function applyIdeasSnapshot(store: IdeasStore, message: IdeasSnapshot): IdeasStore {
  if (store.requestId !== message.requestId) return store;
  const bound =
    store.snapshot?.projectId ??
    store.pending?.projectId ??
    store.result?.projectId ??
    store.preparationResult?.projectId;
  const changed = bound && bound !== message.projectId;
  return {
    ...store,
    snapshot: message,
    ...(changed
      ? {
          pending: null,
          result: null,
          uncertain: !!store.pending,
          preparationPending: undefined,
          preparationResult: undefined,
        }
      : {}),
  };
}

export function beginIdeaSubmit(store: IdeasStore, requestId: string): IdeasStore {
  if (!store.snapshot?.canSubmit || !store.snapshot.projectId || store.pending || store.uncertain)
    return store;
  return { ...store, pending: { requestId, projectId: store.snapshot.projectId }, result: null };
}

export function applyIdeaResult(store: IdeasStore, result: SubmitIdeaResult): IdeasStore {
  if (store.pending?.requestId !== result.requestId || store.pending.projectId !== result.projectId)
    return store;
  const snapshot =
    store.snapshot && result.status === 'saved' && result.idea
      ? {
          ...store.snapshot,
          ideas: [
            ...store.snapshot.ideas.filter((idea) => idea.key !== result.idea!.key),
            result.idea,
          ],
        }
      : store.snapshot;
  return {
    ...store,
    snapshot,
    pending: null,
    result,
    ...(result.status === 'saved' ? { requestId: null } : {}),
  };
}

export function invalidateIdeas(store: IdeasStore): IdeasStore {
  return {
    ...emptyIdeasStore(),
    uncertain: store.uncertain || !!store.pending,
    preparationResult: store.preparationResult,
  };
}

export function applyPreparationResult(
  store: IdeasStore,
  result: PrepareProjectResult,
): IdeasStore {
  if (store.preparationPending !== result.requestId) return store;
  return { ...store, preparationPending: undefined, preparationResult: result };
}

export function receiveProjectPreparationResult(
  result: PrepareProjectResult,
  transport: MessageTransport,
): void {
  const previous = current;
  const next = applyPreparationResult(previous, result);
  setIdeasStore(next);
  if (next !== previous && (result.status === 'created' || result.errorCode === 'already_exists'))
    requestIdeas(transport);
}

export function sendProjectPreparation(name: string, transport: MessageTransport): void {
  if (
    transport.state !== 'connected' ||
    !current.snapshot?.preparation ||
    current.preparationPending
  )
    return;
  const requestId = `project-prepare-${++sequence}`;
  setIdeasStore({ ...current, preparationPending: requestId, preparationResult: undefined });
  try {
    transport.send({ type: 'prepareProject', requestId, name });
  } catch {
    setIdeasStore(invalidateIdeas(current));
  }
}

export function ideaErrorText(code: IdeaErrorCode | null | undefined): string {
  switch (code) {
    case 'denied':
      return 'Solo lectura. Abre la URL de la oficina con el token del operador para preparar el proyecto y guardar ideas.';
    case 'unsupported_adapter':
      return 'Nueva idea no está disponible en VS Code: este control aún no tiene selección de Project. Abre la oficina standalone del Project.';
    case 'no_project':
      return 'El proyecto no está preparado: no hay un Project vinculado a la oficina.';
    case 'missing_manifest':
      return 'El proyecto no está preparado: falta .softwareagents/project.yaml.';
    case 'invalid_manifest':
      return 'El proyecto no está preparado: .softwareagents/project.yaml no es válido o no se puede leer.';
    case 'unknown_project':
      return 'El Project ha cambiado. Vuelve a abrir el diálogo.';
    case 'empty_text':
      return 'Escribe una idea antes de guardarla.';
    case 'too_large':
      return 'La idea y la entrevista superan el límite de 1 MiB en UTF-8 del archivo final.';
    case 'invalid_request':
      return 'Responde cada pregunta o marca «Decide tú» antes de guardar.';
    case 'unsafe_storage':
      return 'No se puede guardar: la ruta de ideas contiene un enlace o no es un archivo regular seguro.';
    case 'ids_exhausted':
      return 'No quedan ids FEAT-NNN libres.';
    case 'audit_failed':
      return 'La idea está guardada, pero falta confirmar su auditoría. No la envíes otra vez.';
    default:
      return 'No se pudieron leer o guardar las ideas. Actualiza la lista antes de reintentar.';
  }
}

export function ideaDialogState(store: IdeasStore, connected: boolean) {
  if (store.result?.status === 'saved') return 'saved';
  if (store.uncertain) return 'uncertain';
  if (!connected) return 'offline';
  if (store.pending) return 'saving';
  if (!store.snapshot) return 'loading';
  if (!store.snapshot.canSubmit) return 'disabled';
  return store.result ? 'error' : 'editing';
}

let current = emptyIdeasStore();
const listeners = new Set<() => void>();
export const getIdeasStore = () => current;
export function setIdeasStore(next: IdeasStore): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}
export function subscribeIdeasStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const useIdeasStore = () => useSyncExternalStore(subscribeIdeasStore, getIdeasStore);
let sequence = 0;
export function requestIdeas(transport: MessageTransport): void {
  const requestId = `ideas-${++sequence}`;
  setIdeasStore({ ...current, requestId, snapshot: null });
  try {
    transport.send({ type: 'requestIdeas', requestId });
  } catch {
    setIdeasStore({
      ...current,
      snapshot: {
        type: 'ideasSnapshot',
        requestId,
        projectId: null,
        canSubmit: false,
        errorCode: 'unavailable',
        ideas: [],
      },
    });
  }
}
export function sendIdea(text: string, answers: IdeaAnswer[], transport: MessageTransport): void {
  if (transport.state !== 'connected') return;
  const requestId = `idea-submit-${++sequence}`;
  const next = beginIdeaSubmit(current, requestId);
  if (next === current || !next.pending) return;
  setIdeasStore(next);
  const message: SubmitIdea = { type: 'submitIdea', ...next.pending, text, answers };
  try {
    transport.send(message);
  } catch {
    setIdeasStore(invalidateIdeas(current));
  }
}
