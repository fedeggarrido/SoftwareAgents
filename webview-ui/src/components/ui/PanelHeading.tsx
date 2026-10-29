import type { ReactNode } from 'react';

import { Button } from './Button.js';

export function PanelHeading({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
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
