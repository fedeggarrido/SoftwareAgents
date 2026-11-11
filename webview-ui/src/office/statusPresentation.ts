import type { StatusDefinition } from '../constants.js';
import { STATUS_MAP } from '../constants.js';
import { knownText } from './displayText.js';

export function statusPresentation(state: string): StatusDefinition {
  return STATUS_MAP[state] ?? STATUS_MAP.unknown;
}

/** Human event text can contain protocol transitions; never display their raw state names. */
export function readableStateText(value: string | null | undefined): string | undefined {
  return knownText(value)?.replace(
    /\b[A-Z][A-Z_]+\b/g,
    (state) => STATUS_MAP[state]?.label ?? state,
  );
}
