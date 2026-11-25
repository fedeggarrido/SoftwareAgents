import { useSyncExternalStore } from 'react';

import type { TransportState } from '../../../core/src/transport.js';
import {
  OFFICE_HANDSHAKE_TEXT,
  OFFICE_INVALID_ACCESS_TEXT,
  OFFICE_OFFLINE_HELP,
  OFFICE_OFFLINE_TEXT,
  OFFICE_ORIGIN_TEXT,
  RELATIVE_SECOND_MS,
} from '../constants.js';
import { es } from '../i18n/es.js';

export interface ConnectionStatus {
  state?: TransportState;
  cause: 'unavailable' | 'unauthorized' | 'origin';
  attempt: number;
  retryAt: number | null;
  /** Last message received from the office; null until the first one. */
  lastContactAt?: number | null;
  /** A refused action: its notice outlives the reconnection until dismissed. */
  unsentAction?: boolean;
  /** A layout save waiting for the reconnection. */
  unsentSave?: boolean;
}
const empty: ConnectionStatus = { cause: 'unavailable', attempt: 0, retryAt: null };
let current = empty;
const listeners = new Set<() => void>();
export const getConnectionStatus = () => current;
export function setConnectionStatus(status: ConnectionStatus): void {
  current = status;
  for (const listener of listeners) listener();
}
export function setUnsent(change: Pick<ConnectionStatus, 'unsentAction' | 'unsentSave'>): void {
  setConnectionStatus({ ...current, ...change });
}
export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getConnectionStatus,
    getConnectionStatus,
  );
}

export function staleDataText(lastContactAt: number | null | undefined): string | null {
  if (!lastContactAt) return null;
  return es.connection.staleSince(
    new Date(lastContactAt).toLocaleTimeString('es-ES', { timeStyle: 'medium' }),
  );
}

/** No close reasons or URLs are interpolated, so credentials cannot enter copy. */
export function connectionCopy(state: TransportState, status = current, now = Date.now()) {
  const explanation =
    status.cause === 'unauthorized'
      ? OFFICE_INVALID_ACCESS_TEXT
      : status.cause === 'origin'
        ? OFFICE_ORIGIN_TEXT
        : `${OFFICE_OFFLINE_TEXT} ${OFFICE_OFFLINE_HELP}`;
  if (state === 'connecting')
    return { label: 'Conectando con la oficina…', explanation: OFFICE_HANDSHAKE_TEXT };
  // Every phase of a retry is visible: in progress, failed attempt N and the countdown.
  const failed = status.attempt ? ` · intento ${status.attempt} sin respuesta` : '';
  const retry =
    status.retryAt === null
      ? status.attempt
        ? ' · reintentando ahora…'
        : ''
      : `${failed} · reintentando en ${Math.max(0, Math.ceil((status.retryAt - now) / RELATIVE_SECOND_MS))} s`;
  return {
    label: `Sin conexión${retry}`,
    explanation,
  };
}
