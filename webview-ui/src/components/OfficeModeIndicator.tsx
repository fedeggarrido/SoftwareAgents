import { useRef, useState } from 'react';

import { OFFICE_HELP_Z_INDEX } from '../constants.js';
import { useDismissibleLayer } from '../hooks/useDismissibleLayer.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { isBrowserRuntime } from '../runtime.js';
import { Button } from './ui/Button.js';

export function OfficeModeIndicator() {
  const view = officeAccessView(useOfficeAccess(), !isBrowserRuntime);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer(expanded, () => setExpanded(false), OFFICE_HELP_Z_INDEX, containerRef);
  return (
    <div
      ref={containerRef}
      className="office-mode-indicator flex flex-col items-end gap-4 max-w-full"
    >
      <Button
        size="sm"
        title={view.explanation}
        aria-expanded={expanded}
        aria-controls="office-mode-explanation"
        onClick={() => setExpanded(!expanded)}
      >
        {view.label}
      </Button>
      {expanded && (
        <p
          id="office-mode-explanation"
          role="status"
          className="pixel-panel p-10 w-256 max-w-full text-sm"
        >
          {view.explanation}
        </p>
      )}
    </div>
  );
}
