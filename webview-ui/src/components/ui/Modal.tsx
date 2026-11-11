import type { ReactNode } from 'react';
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { MODAL_Z_INDEX, UI_LAYERS } from '../../constants.js';
import { useDismissibleLayer } from '../../hooks/useDismissibleLayer.js';
import { Button } from './Button.js';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Modal({ isOpen, onClose, title, children, className = '' }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDismissibleLayer(isOpen, onClose, MODAL_Z_INDEX, dialogRef, true);
  if (!isOpen) return null;

  const content = (
    <>
      <div
        className="fixed inset-0 bg-black/50"
        style={{ zIndex: MODAL_Z_INDEX }}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => event.stopPropagation()}
        className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-bg border-2 border-border rounded-none shadow-pixel p-4 min-w-xs ${className}`}
        style={{ zIndex: UI_LAYERS.modalContent }}
      >
        <div className="flex items-center justify-between py-4 px-10 border-b border-border mb-4">
          <span id={titleId} className="pixel-title text-accent-bright text-2xl">
            {title}
          </span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar">
            x
          </Button>
        </div>
        {children}
      </div>
    </>
  );
  // Plans originate inside the floating window. A portal keeps them in the modal layer.
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
