import { useState } from 'react';

import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { isBrowserRuntime } from '../runtime.js';
import { Button } from './ui/Button.js';

export function OfficeModeIndicator() {
  const view = officeAccessView(useOfficeAccess(), !isBrowserRuntime);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="relative">
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
          className="absolute bottom-full left-0 pixel-panel p-10 w-256 max-w-[80vw] text-sm"
        >
          {view.explanation}
        </p>
      )}
    </div>
  );
}
