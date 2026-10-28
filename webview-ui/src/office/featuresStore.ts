import { useSyncExternalStore } from 'react';

import type {
  FeatureProgress,
  FeatureRow,
  FeaturesReadError,
  FeaturesSnapshot,
} from '../../../core/src/messages.js';

export interface FeaturesStore {
  projectId: string | null;
  requestId: string | null;
  snapshot: FeaturesSnapshot | null;
  loading: boolean;
}

export function emptyFeaturesStore(): FeaturesStore {
  return { projectId: null, requestId: null, snapshot: null, loading: false };
}

/** Every request clears previous rows, including refreshes of the same Project. */
export function beginFeaturesRequest(
  _store: FeaturesStore,
  projectId: string,
  requestId: string,
): FeaturesStore {
  return { projectId, requestId, snapshot: null, loading: true };
}

export function applyFeaturesSnapshot(
  store: FeaturesStore,
  message: FeaturesSnapshot,
): FeaturesStore {
  if (message.projectId !== store.projectId || message.requestId !== store.requestId) return store;
  return { ...store, snapshot: message, loading: false };
}

/** Ordering and projection belong to the server; expose rows only on success. */
export function visibleFeatures(store: FeaturesStore): FeatureRow[] {
  return !store.loading && store.snapshot?.status === 'ok' ? store.snapshot.features : [];
}

export type FeaturesViewState = 'loading' | 'denied' | 'read_error' | 'empty' | 'list';

export function viewState(store: FeaturesStore): FeaturesViewState {
  // Absence of a completed read must never imply a successful empty result.
  if (store.loading || !store.snapshot) return 'loading';
  switch (store.snapshot.status) {
    case 'denied':
    case 'unknown_project':
      return 'denied';
    case 'read_error':
      return 'read_error';
    case 'empty':
      return 'empty';
    case 'ok':
      return 'list';
  }
}

/** Labels are plain text; consumers must render them as text, never markup. */
export function featureStateLabel(feature: Pick<FeatureRow, 'state' | 'rawStatus'>): string {
  switch (feature.state) {
    case 'in_review':
      return 'spec en revisión';
    case 'in_design':
      return 'en diseño';
    case 'in_development':
      return 'en desarrollo';
    case 'ready_to_merge':
      return 'ready_to_merge';
    case 'unknown':
      return `desconocido: ${feature.rawStatus ?? ''}`;
  }
}

export function featureProgressLabel(progress: FeatureProgress | null): string {
  return progress === null ? 'sin tareas' : `${progress.done}/${progress.total}`;
}

/** Fixed allowlisted messages never interpolate server diagnostics or paths. */
export function featuresReasonText(reason: FeaturesReadError | null): string {
  switch (reason) {
    case 'unavailable':
      return 'WorkStore no disponible.';
    case 'schema_incompatible':
      return 'Versión del esquema de WorkStore incompatible.';
    case 'query_failed':
      return 'No se pudo consultar WorkStore.';
    case 'invalid_data':
      return 'Respuesta de WorkStore inválida.';
    default:
      return 'No se pudieron leer las features.';
  }
}

// React binding follows auditStore; transitions above require no DOM.
let current = emptyFeaturesStore();
const listeners = new Set<() => void>();

export function getFeaturesStore(): FeaturesStore {
  return current;
}

export function setFeaturesStore(next: FeaturesStore): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeFeaturesStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFeaturesStore(): FeaturesStore {
  return useSyncExternalStore(subscribeFeaturesStore, getFeaturesStore);
}
