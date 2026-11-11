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
  const [minimised, setMinimised] = useState(false);
  useEffect(() => {
    if (state === 'connected') return;
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_SECOND_MS);
    return () => clearInterval(timer);
  }, [state]);
  if (state === 'connected') return null;
  const copy = connectionCopy(state, status, now);
  if (minimised) {
    return (
      <Button
        className="connection-chip"
        size="sm"
        onClick={() => setMinimised(false)}
        aria-label="Mostrar aviso de conexión"
        title={copy.label}
      >
        Sin conexión
      </Button>
    );
  }
  return (
    <div className="office-connection-help pixel-panel">
      <p role="status">{copy.label}</p>
      <Button
        size="sm"
        onClick={() => {
          if ('reconnect' in transport && typeof transport.reconnect === 'function') {
            transport.reconnect();
          }
        }}
      >
        Reintentar ahora
      </Button>
      <details>
        <summary>Detalles</summary>
        <div className="connection-details pixel-panel">
          <p>{copy.explanation}</p>
          {status.cause === 'unavailable' ? (
            <code className="select-all">{OFFICE_START_COMMAND}</code>
          ) : (
            <OfficeRecoveryActions />
          )}
        </div>
      </details>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setMinimised(true)}
        aria-label="Minimizar aviso de conexión"
      >
        Minimizar
      </Button>
    </div>
  );
}
