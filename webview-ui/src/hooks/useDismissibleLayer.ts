import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';

interface Layer {
  priority: number;
  close: () => void;
  element: RefObject<HTMLElement | null>;
  modal: boolean;
}

const layers: Layer[] = [];
let subscriptionGeneration = 0;
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
  scope: RefObject<HTMLElement | null> = element,
) {
  const close = useRef(onClose);
  const focusSession = useRef({ opener: null as HTMLElement | null, token: 0 });
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useLayoutEffect(() => {
    if (!isOpen) return;
    // Re-subscribing the same layer (including StrictMode) cancels its queued restore
    // while preserving the original opener for the eventual real close.
    const session = focusSession.current;
    const token = ++session.token;
    session.opener ??=
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    subscriptionGeneration++;
    const layer: Layer = { priority, close: () => close.current(), element: scope, modal };
    if (layers.length === 0) window.addEventListener('keydown', handleKeyDown, true);
    layers.push(layer);
    element.current?.focus();
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (layers.length === 0) window.removeEventListener('keydown', handleKeyDown, true);
      const generation = subscriptionGeneration;
      // React restores pre-commit focus; defer ours until its commit has finished.
      queueMicrotask(() => {
        if (token !== session.token) return;
        const target = session.opener;
        session.opener = null;
        if (generation !== subscriptionGeneration) return;
        if (layers.some((open) => open.element.current?.contains(document.activeElement))) return;
        if (target?.isConnected) target.focus();
      });
    };
  }, [isOpen, priority, element, modal, scope]);
}
