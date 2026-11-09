import {
  RELATIVE_DAY_MS,
  RELATIVE_HOUR_MS,
  RELATIVE_MINUTE_MS,
  RELATIVE_SECOND_MS,
} from '../constants.js';

/** Identifiers for sessions/executions are never useful as user-facing names. */
export function knownText(value: string | null | undefined): string | undefined {
  if (!value?.trim() || /^(desconocido|unknown|unavailable|n\/a|—)$/i.test(value.trim())) return;
  return (
    value
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
      .trim() || undefined
  );
}

export function relativeTime(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at);
  if (delta < RELATIVE_MINUTE_MS) return `hace ${Math.floor(delta / RELATIVE_SECOND_MS)} s`;
  if (delta < RELATIVE_HOUR_MS) return `hace ${Math.floor(delta / RELATIVE_MINUTE_MS)} min`;
  if (delta < RELATIVE_DAY_MS) return `hace ${Math.floor(delta / RELATIVE_HOUR_MS)} h`;
  return `hace ${Math.floor(delta / RELATIVE_DAY_MS)} días`;
}
