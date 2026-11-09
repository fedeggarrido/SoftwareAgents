import { useSyncExternalStore } from 'react';

import { transport } from '../transport/index.js';
import { OfficeConnectionHelp } from './OfficeConnectionHelp.js';

const subscribe = (listener: () => void) => transport.onStateChange(listener);
const snapshot = () => transport.state;

export function ConnectionIndicator() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (state === 'connected') return null;
  return (
    <div className="connection-indicator pixel-panel p-10 text-xs">
      <OfficeConnectionHelp />
    </div>
  );
}
