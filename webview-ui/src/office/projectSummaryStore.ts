import { useSyncExternalStore } from 'react';

import type { ProjectSummarySnapshot } from '../../../core/src/messages.js';
import type { MessageTransport } from '../../../core/src/transport.js';

export type SummaryStore =
  | { phase: 'idle' }
  | { phase: 'loading'; projectId: string; requestId: string }
  | { phase: 'settled'; projectId: string; snapshot: ProjectSummarySnapshot };

export function applyProjectSummary(
  store: SummaryStore,
  message: ProjectSummarySnapshot,
): SummaryStore {
  if (
    store.phase !== 'loading' ||
    store.projectId !== message.projectId ||
    store.requestId !== message.requestId
  )
    return store;
  return { phase: 'settled', projectId: store.projectId, snapshot: message };
}

let sequence = 0;
let current: SummaryStore = { phase: 'idle' };
const listeners = new Set<() => void>();

export function getProjectSummaryStore(): SummaryStore {
  return current;
}

export function setProjectSummaryStore(next: SummaryStore): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function requestProjectSummary(
  sender: Pick<MessageTransport, 'send'>,
  projectId: string,
): void {
  const requestId = `summary-${++sequence}`;
  setProjectSummaryStore({ phase: 'loading', projectId, requestId });
  sender.send({ type: 'requestProjectSummary', projectId, requestId });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProjectSummaryStore(): SummaryStore {
  return useSyncExternalStore(subscribe, getProjectSummaryStore, getProjectSummaryStore);
}
