import { useEffect, useSyncExternalStore } from 'react';

import { IDEA_REQUEST_TIMEOUT_MS } from '../constants.js';
import { transport } from '../transport/index.js';
import {
  getIdeasStore,
  invalidateIdeas,
  requestIdeas,
  setIdeasStore,
  useIdeasStore,
} from './ideasStore.js';

const subscribe = (listener: () => void) => transport.onStateChange(listener);
const connectionState = () => transport.state;

/** Shared by the dialog and list so reads, submissions and reconnects have deadlines. */
export function useIdeasConnection(active: boolean, projectId?: string | null) {
  const store = useIdeasStore();
  const connection = useSyncExternalStore(subscribe, connectionState, connectionState);
  useEffect(() => {
    if (!active) return;
    if (connection === 'connected') requestIdeas(transport);
    else setIdeasStore(invalidateIdeas(getIdeasStore()));
  }, [active, connection, projectId]);

  useEffect(() => {
    if (!active || !store.requestId || store.snapshot?.requestId === store.requestId) return;
    const requestId = store.requestId;
    const timer = setTimeout(() => {
      const current = getIdeasStore();
      if (current.requestId !== requestId || current.snapshot?.requestId === requestId) return;
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
    }, IDEA_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [active, store.requestId, store.snapshot?.requestId]);

  useEffect(() => {
    if (!active || !store.pending) return;
    const requestId = store.pending.requestId;
    const timer = setTimeout(() => {
      if (getIdeasStore().pending?.requestId === requestId)
        setIdeasStore(invalidateIdeas(getIdeasStore()));
    }, IDEA_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [active, store.pending]);

  return { store, connection };
}
