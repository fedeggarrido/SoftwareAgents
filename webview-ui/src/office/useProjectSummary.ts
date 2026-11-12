import { useEffect, useSyncExternalStore } from 'react';

import {
  PROJECT_SUMMARY_EVENT_DELAY_MS,
  PROJECT_SUMMARY_REFRESH_MS,
  PROJECT_SUMMARY_REQUEST_TIMEOUT_MS,
} from '../constants.js';
import { transport } from '../transport/index.js';
import { useExecutorStore } from './executorStore.js';
import {
  applyProjectSummary,
  getProjectSummaryStore,
  requestProjectSummary,
  setProjectSummaryStore,
  useProjectSummaryStore,
} from './projectSummaryStore.js';

const subscribeConnection = (listener: () => void) => transport.onStateChange(listener);
const connectionState = () => transport.state;

/** Only the visible consumer owns reads. Reconnects always obtain a fresh snapshot. */
export function useProjectSummary(isOpen: boolean) {
  const executor = useExecutorStore();
  const projectId = executor.needsSnapshot ? null : (executor.state?.projectId ?? null);
  const connection = useSyncExternalStore(subscribeConnection, connectionState, connectionState);
  const store = useProjectSummaryStore();
  useEffect(() => {
    if (!isOpen) return;
    if (!projectId || connection !== 'connected') {
      setProjectSummaryStore({ phase: 'idle' });
      return;
    }
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const current = getProjectSummaryStore();
      if (current.phase !== 'loading')
        requestProjectSummary(
          transport,
          projectId,
          current.phase === 'settled' && current.projectId === projectId
            ? current.snapshot
            : undefined,
        );
    };
    const unsubscribe = transport.onMessage((message) => {
      if (message.type === 'projectSummarySnapshot')
        setProjectSummaryStore(applyProjectSummary(getProjectSummaryStore(), message));
      const changesProject =
        (message.type === 'domainEvent' && message.event.projectId === projectId) ||
        ([
          'boardState',
          'workSnapshot',
          'featuresSnapshot',
          'ideasSnapshot',
          'featureApprovalResult',
          'submitIdeaResult',
        ].includes(message.type) &&
          'projectId' in message &&
          message.projectId === projectId);
      if (changesProject) {
        clearTimeout(pending);
        pending = setTimeout(refresh, PROJECT_SUMMARY_EVENT_DELAY_MS);
      }
    });
    requestProjectSummary(transport, projectId);
    // Idea and plan files can change without a Task transition. Reconcile on the same read channel.
    const interval = setInterval(refresh, PROJECT_SUMMARY_REFRESH_MS);
    return () => {
      unsubscribe();
      clearTimeout(pending);
      clearInterval(interval);
      setProjectSummaryStore({ phase: 'idle' });
    };
  }, [isOpen, projectId, connection]);
  useEffect(() => {
    if (!isOpen || store.phase !== 'loading') return;
    const timer = setTimeout(() => {
      setProjectSummaryStore(
        applyProjectSummary(getProjectSummaryStore(), {
          type: 'projectSummarySnapshot',
          projectId: store.projectId,
          requestId: store.requestId,
          status: 'read_error',
          reason: 'unavailable',
          summary: null,
        }),
      );
    }, PROJECT_SUMMARY_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isOpen, store]);
  const snapshot =
    connection === 'connected' && store.phase !== 'idle' && store.projectId === projectId
      ? (store.snapshot ?? null)
      : null;
  const refresh = () => {
    if (projectId && connection === 'connected') requestProjectSummary(transport, projectId);
  };
  return { projectId, connection, store, snapshot, refresh };
}
