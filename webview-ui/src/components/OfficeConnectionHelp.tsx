import { useEffect, useState, useSyncExternalStore } from 'react';

import { OFFICE_START_COMMAND, RELATIVE_SECOND_MS } from '../constants.js';
import { connectionCopy, useConnectionStatus } from '../office/connectionStatus.js';
import { transport } from '../transport/index.js';
import { OfficeRecoveryActions } from './OfficeRecoveryActions.js';
import { Button } from './ui/Button.js';

const subscribe = (listener: () => void) => transport.onStateChange(listener);
const snapshot = () => transport.state;

export function OfficeConnectionHelp() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const status = useConnectionStatus();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (state === 'connected') return;
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_SECOND_MS);
    return () => clearInterval(timer);
  }, [state]);
  if (state === 'connected') return null;
  const copy = connectionCopy(state, status, now);
  return (
    <div role="status" className="office-connection-help flex flex-col gap-4">
      <p>{copy.label}</p>
      <p>{copy.explanation}</p>
      <Button
        size="sm"
        onClick={() => {
          const retryable = transport as typeof transport & { reconnect?: () => void };
          retryable.reconnect?.();
        }}
      >
        Reintentar ahora
      </Button>
      {status.cause === 'unavailable' ? (
        <details>
          <summary>Detalles</summary>
          <code className="select-all">{OFFICE_START_COMMAND}</code>
        </details>
      ) : (
        <OfficeRecoveryActions />
      )}
    </div>
  );
}
