import { TEXT_SIZE_STORAGE_KEY } from '../constants.js';

export type TextSize = 'normal' | 'large';
interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage may be blocked by the viewer's browser. The preference still works in memory. */
export function readTextSize(storage: PreferenceStorage | undefined): TextSize {
  try {
    return storage?.getItem(TEXT_SIZE_STORAGE_KEY) === 'large' ? 'large' : 'normal';
  } catch {
    return 'normal';
  }
}

export function saveTextSize(size: TextSize, storage: PreferenceStorage | undefined): void {
  try {
    storage?.setItem(TEXT_SIZE_STORAGE_KEY, size);
  } catch {
    // A blocked or full store must not prevent changing the current viewer's text size.
  }
}
