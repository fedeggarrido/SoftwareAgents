import { useSyncExternalStore } from 'react';

import type { TextSize } from '../office/textSize.js';
import { readTextSize, saveTextSize } from '../office/textSize.js';

let current: TextSize = 'normal';
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initialiseTextSize(): void {
  try {
    current = readTextSize(window.localStorage);
  } catch {
    current = 'normal';
  }
  document.documentElement.dataset.textSize = current;
}

export function useTextSize() {
  const size = useSyncExternalStore(
    subscribe,
    () => current,
    () => 'normal' as const,
  );
  return [
    size,
    (next: TextSize) => {
      current = next;
      document.documentElement.dataset.textSize = next;
      try {
        saveTextSize(next, window.localStorage);
      } catch {
        // Access to localStorage itself may throw, before saveTextSize can guard it.
      }
      for (const listener of listeners) listener();
    },
  ] as const;
}
