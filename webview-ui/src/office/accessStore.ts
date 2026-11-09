import { useSyncExternalStore } from 'react';

import type { OfficeAccess } from '../../../core/src/messages.js';
import {
  OFFICE_ACCESS_INSTRUCTIONS,
  OFFICE_EMBEDDED_EXPLANATION,
  OFFICE_MANAGED_EXPLANATION,
  OFFICE_MANAGED_LABEL,
  OFFICE_OPERATOR_EXPLANATION,
  OFFICE_OPERATOR_LABEL,
  OFFICE_READ_ONLY_LABEL,
  OFFICE_RECONNECTING_EXPLANATION,
  OFFICE_RECONNECTING_LABEL,
} from '../../../core/src/officeAccess.js';

let current: OfficeAccess | null = null;
const listeners = new Set<() => void>();
export const getOfficeAccess = () => current;
export function setOfficeAccess(access: OfficeAccess | null): void {
  current = access;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const useOfficeAccess = () =>
  useSyncExternalStore(subscribe, getOfficeAccess, getOfficeAccess);

export function officeAccessView(access: OfficeAccess | null, embedded: boolean) {
  // A missing handshake says nothing about the next connection's permissions.
  if (!embedded && access === null)
    return {
      label: OFFICE_RECONNECTING_LABEL,
      explanation: OFFICE_RECONNECTING_EXPLANATION,
      blocked: false,
      pending: true,
    };
  const privileged = embedded || access?.privileged === true;
  const managed = access?.reason === 'managed_process';
  return {
    label: !privileged
      ? OFFICE_READ_ONLY_LABEL
      : managed
        ? OFFICE_MANAGED_LABEL
        : OFFICE_OPERATOR_LABEL,
    blocked: !privileged || managed,
    pending: false,
    explanation: managed
      ? OFFICE_MANAGED_EXPLANATION
      : embedded
        ? OFFICE_EMBEDDED_EXPLANATION
        : privileged
          ? OFFICE_OPERATOR_EXPLANATION
          : OFFICE_ACCESS_INSTRUCTIONS,
  };
}
