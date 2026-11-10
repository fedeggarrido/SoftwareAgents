import { useRef, useState } from 'react';

import { OFFICE_HELP_Z_INDEX } from '../constants.js';
import { useDismissibleLayer } from '../hooks/useDismissibleLayer.js';
import { useOfficeHelpPlacement } from '../hooks/useOfficeHelpPlacement.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { useConnectionStatus } from '../office/connectionStatus.js';
import { isBrowserRuntime } from '../runtime.js';
import { OfficeConnectionHelp } from './OfficeConnectionHelp.js';
import { OfficeRecoveryActions } from './OfficeRecoveryActions.js';
import { Button } from './ui/Button.js';

export function OfficeModeIndicator() {
  const access = useOfficeAccess();
  const view = officeAccessView(access, !isBrowserRuntime);
  const connection = useConnectionStatus();
  const offline = isBrowserRuntime && connection.state && connection.state !== 'connected';
  const explanation = view.explanation;
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  useOfficeHelpPlacement(expanded && !offline, popupRef);
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
      {offline ? (
        <OfficeConnectionHelp />
      ) : (
        <>
          <Button
            size="sm"
            title={explanation}
            aria-expanded={expanded}
            aria-controls="office-mode-explanation"
            onClick={() => setExpanded(!expanded)}
          >
            {view.label}
          </Button>
          {expanded && (
            <div
              ref={popupRef}
              id="office-mode-explanation"
              role="status"
              className="pixel-panel p-10 w-256 max-w-full text-sm overflow-y-auto"
            >
              <p>{explanation}</p>
              {view.details && <p>Detalles: {view.details}</p>}
              <OfficeRecoveryActions />
            </div>
          )}
        </>
      )}
    </div>
  );
}
