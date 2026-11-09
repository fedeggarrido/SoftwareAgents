import type { ReactNode } from 'react';

import { Button } from './Button.js';

export function PanelHeading({
  title,
  onClose,
  children,
  hosted = false,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
  hosted?: boolean;
}) {
  if (hosted) {
    return (
      <div className="panel-toolbar flex flex-wrap items-center justify-between gap-8">
        <span className="ui-info text-text-muted">solo lectura</span>
        {children && <div className="panel-actions">{children}</div>}
      </div>
    );
  }
  return (
    <div className="panel-heading">
      <h2 className="text-lg">
        {title} <span className="panel-qualifier">solo lectura</span>
      </h2>
      <div className="panel-actions">
        {children}
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Cerrar" title="Cerrar">
          ✕
        </Button>
      </div>
    </div>
  );
}
