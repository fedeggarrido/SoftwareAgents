import { useSyncExternalStore } from 'react';

import type {
  FeatureCost,
  FeatureProgress,
  FeatureRow,
  FeaturesReadError,
  FeaturesSnapshot,
} from '../../../core/src/messages.js';
import type { MessageTransport } from '../../../core/src/transport.js';
import { FEATURE_STEP_LABELS } from '../constants.js';
import { es } from '../i18n/es.js';
import { statusPresentation } from './statusPresentation.js';

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
  return statusPresentation(feature.state).label;
}

export function featureProgressLabel(progress: FeatureProgress | null): string {
  return progress === null ? 'sin tareas' : `${progress.done}/${progress.total}`;
}

function usdLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'sin datos';
  if (value > 0 && value < 0.005) return '<0.01 USD';
  return `${value.toFixed(2)} USD`;
}

export function featureCostLabel(
  cost: Pick<FeatureCost, 'costUsd' | 'costKnown' | 'executions'>,
): string {
  const label = usdLabel(cost.costUsd);
  return label !== 'sin datos' && cost.costKnown > 0 && cost.costKnown < cost.executions
    ? `${label} (parcial)`
    : label;
}

export function featureCoverageLabel(cost: FeatureCost): string {
  return Number.isFinite(cost.costKnown) && Number.isFinite(cost.executions)
    ? `${cost.costKnown} de ${cost.executions}`
    : 'sin datos';
}

export function featureCostPerDoneLabel(cost: FeatureCost): string {
  return usdLabel(cost.costPerDoneTaskUsd);
}

export function featureCacheRateLabel(cost: FeatureCost): string {
  return cost.cacheHitRate === null || !Number.isFinite(cost.cacheHitRate)
    ? 'sin datos'
    : `${Math.round(cost.cacheHitRate * 100)} %`;
}

/** Fixed allowlisted messages never interpolate server diagnostics or paths. */
export function featuresReasonText(reason: FeaturesReadError | null): string {
  switch (reason) {
    case 'unavailable':
      return es.vocabulary.storeUnavailable;
    case 'schema_incompatible':
      return es.vocabulary.storeIncompatible;
    case 'query_failed':
      return es.vocabulary.storeQueryFailed;
    case 'invalid_data':
      return es.vocabulary.storeInvalid;
    default:
      return es.vocabulary.featuresReadFailed;
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

let requestSequence = 0;
export function requestFeatures(sender: Pick<MessageTransport, 'send'>, projectId: string): void {
  const requestId = `features-${++requestSequence}`;
  setFeaturesStore(beginFeaturesRequest(getFeaturesStore(), projectId, requestId));
  sender.send({ type: 'requestFeatures', projectId, requestId });
}

export function subscribeFeaturesStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFeaturesStore(): FeaturesStore {
  return useSyncExternalStore(subscribeFeaturesStore, getFeaturesStore);
}

export function featureStepLabel(step: string | null): string {
  return step === null ? 'Paso pendiente' : (FEATURE_STEP_LABELS[step] ?? 'Paso pendiente');
}
