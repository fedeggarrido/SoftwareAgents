import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';

interface Layer {
  priority: number;
  close: () => void;
  element: RefObject<HTMLElement | null>;
  modal: boolean;
}

const layers: Layer[] = [];
const focusableSelector =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

function handleKeyDown(event: KeyboardEvent) {
  const top = layers.reduce<Layer | undefined>(
    (current, layer) => (!current || layer.priority >= current.priority ? layer : current),
    undefined,
  );
  if (!top) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    top.close();
  } else if (event.key === 'Tab' && top.modal) {
    const root = top.element.current;
    const controls = [...(root?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter(
      (element) => element.getClientRects().length > 0,
    );
    const first = controls[0] ?? root;
    const last = controls[controls.length - 1] ?? root;
    if (
      !root?.contains(document.activeElement) ||
      document.activeElement === root ||
      (event.shiftKey ? document.activeElement === first : document.activeElement === last)
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }
}

/** One capture listener orders all participating overlays before editor shortcuts. */
export function useDismissibleLayer(
  isOpen: boolean,
  onClose: () => void,
  priority: number,
  element: RefObject<HTMLElement | null>,
  modal = false,
) {
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  // Capture the opener once per open session, so re-subscribing (deps change, another
  // layer stealing focus) never replaces it with whatever happens to be focused later.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // Layout cleanups run inside React's commit, which then restores the focus it saw
      // before committing. Restore after the commit so that does not undo ours.
      queueMicrotask(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, [isOpen]);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const layer: Layer = { priority, close: () => close.current(), element, modal };
    if (layers.length === 0) window.addEventListener('keydown', handleKeyDown, true);
    layers.push(layer);
    element.current?.focus();
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (layers.length === 0) window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen, priority, element, modal]);
}
