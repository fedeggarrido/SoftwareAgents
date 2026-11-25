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
  const { unsent } = useConnectionStatus();
  return (
    <>
      {state !== 'connected' && (
        <div className="connection-indicator" data-testid="connection-notice">
          <OfficeConnectionHelp />
        </div>
      )}
      {unsent && (
        <div className="connection-unsent pixel-panel" data-testid="connection-unsent">
          <p role="alert">
            {unsent === 'action' ? es.connection.unsentAction : es.connection.unsentSave}
          </p>
          <Button size="sm" onClick={() => setUnsent(null)}>
            {es.connection.dismiss}
          </Button>
        </div>
      )}
    </>
  );
}
