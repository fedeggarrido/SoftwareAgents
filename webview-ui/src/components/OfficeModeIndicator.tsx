import { useRef, useState } from 'react';

import { OFFICE_HELP_Z_INDEX } from '../constants.js';
import { useDismissibleLayer } from '../hooks/useDismissibleLayer.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { connectionCopy, useConnectionStatus } from '../office/connectionStatus.js';
import { isBrowserRuntime } from '../runtime.js';
import { Button } from './ui/Button.js';

export function OfficeModeIndicator() {
  const access = useOfficeAccess();
  const view = officeAccessView(access, !isBrowserRuntime);
  const connection = useConnectionStatus();
  const copy =
    isBrowserRuntime && access === null && connection.state && connection.state !== 'connected'
      ? connectionCopy(connection.state, connection)
      : null;
  const explanation = copy?.explanation ?? view.explanation;
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer(
    expanded,
    () => {
      setExpanded(false);
      containerRef.current?.querySelector('button')?.focus();
    },
    OFFICE_HELP_Z_INDEX,
    containerRef,
  );
  return (
    <div
      ref={containerRef}
      className="office-mode-indicator flex flex-col items-end gap-4 max-w-full"
    >
      <Button
        size="sm"
        title={explanation}
        aria-expanded={expanded}
        aria-controls="office-mode-explanation"
        onClick={() => setExpanded(!expanded)}
      >
        {copy?.label ?? view.label}
      </Button>
      {expanded && (
        <p
          id="office-mode-explanation"
          role="status"
          className="pixel-panel p-10 w-256 max-w-full text-sm"
        >
          {explanation}
        </p>
      )}
    </div>
  );
}
