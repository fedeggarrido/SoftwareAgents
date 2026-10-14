import type { MessageTransport } from '../../../core/src/transport.js';
import { expirePending, getExecutorStore, setExecutorStore } from '../office/executorStore.js';

/** Office-level lifetime: handshake and pending recovery also run with the HUD closed. */
export function bindExtensionTransportLifecycle(transport: MessageTransport): () => void {
  let connectedOnce = transport.state === 'connected';
  const invalidate = () => {
    setExecutorStore({ ...getExecutorStore(), needsSnapshot: true });
  };
  if (!connectedOnce) invalidate();
  const unsubscribe = transport.onStateChange((state) => {
    if (state !== 'connected') {
      invalidate();
      return;
    }
    if (connectedOnce) {
      // Each socket has its own capability subscription and complete state handshake.
      transport.send({ type: 'webviewReady', capabilities: ['executorControls'] });
    }
    connectedOnce = true;
  });
  // Retain initial queuing while connecting; the first open must not repeat it.
  transport.send({ type: 'webviewReady', capabilities: ['executorControls'] });
  const timer = setInterval(() => {
    const expired = expirePending(getExecutorStore(), Date.now());
    if (!expired.resync) return;
    setExecutorStore(expired.store);
    const projectId = expired.store.state?.projectId;
    if (projectId) transport.send({ type: 'requestExecutorState', projectId });
  }, 1000);
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
