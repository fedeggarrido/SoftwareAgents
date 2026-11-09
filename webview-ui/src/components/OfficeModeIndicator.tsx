import { useEffect, useRef, useState } from 'react';

import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { isBrowserRuntime } from '../runtime.js';
import { Button } from './ui/Button.js';

export function OfficeModeIndicator() {
  const view = officeAccessView(useOfficeAccess(), !isBrowserRuntime);
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setExpanded(false);
      container.current?.querySelector('button')?.focus();
    };
    // Capture before the editor's window bubble listener, even if focus has moved away.
    window.addEventListener('keydown', dismiss, true);
    return () => window.removeEventListener('keydown', dismiss, true);
  }, [expanded]);
  return (
    <div ref={container} className="office-mode-indicator flex flex-col items-end gap-4 max-w-full">
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
