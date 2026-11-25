import { useSyncExternalStore } from 'react';

import { es } from '../i18n/es.js';
import { setUnsent, useConnectionStatus } from '../office/connectionStatus.js';
import { transport } from '../transport/index.js';
import { OfficeConnectionHelp } from './OfficeConnectionHelp.js';
import { Button } from './ui/Button.js';

const subscribe = (listener: () => void) => transport.onStateChange(listener);
const snapshot = () => transport.state;

export function ConnectionIndicator() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { unsentAction, unsentSave } = useConnectionStatus();
  return (
    <>
      {state !== 'connected' && (
        <div className="connection-indicator" data-testid="connection-notice">
          <OfficeConnectionHelp />
        </div>
      )}
      {(unsentAction || unsentSave) && (
        <div className="connection-unsent pixel-panel" data-testid="connection-unsent">
          <p role="alert">{unsentAction ? es.connection.unsentAction : es.connection.unsentSave}</p>
          <Button
            size="sm"
            onClick={() =>
              setUnsent(unsentAction ? { unsentAction: false } : { unsentSave: false })
            }
          >
            {es.connection.dismiss}
          </Button>
        </div>
      )}
    </>
  );
}
