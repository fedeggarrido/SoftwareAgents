import { useSyncExternalStore } from 'react';

import type { AuditLogSnapshot, AuditViewEntry } from '../../../core/src/messages.js';

export const NO_VALUE = 'sin valor';

/** Preserve empty strings: they are different from an absent optional value. */
export function auditValue(value: string | null | undefined): string {
  return value ?? NO_VALUE;
}

export interface AuditStore {
  projectId: string | null;
  requestId: string | null;
  snapshot: AuditLogSnapshot | null;
  loading: boolean;
  actionFilter: string | null;
  outcomeFilter: string | null;
}

export function emptyAuditStore(): AuditStore {
  return {
    projectId: null,
    requestId: null,
    snapshot: null,
    loading: false,
    actionFilter: null,
    outcomeFilter: null,
  };
}

/** Clear old data immediately; only a refresh of the same Project retains filters. */
export function beginAuditRequest(
  store: AuditStore,
  projectId: string,
  requestId: string,
): AuditStore {
  return {
    projectId,
    requestId,
    snapshot: null,
    loading: true,
    actionFilter: store.projectId === projectId ? store.actionFilter : null,
    outcomeFilter: store.projectId === projectId ? store.outcomeFilter : null,
  };
}

export function applyAuditLog(store: AuditStore, message: AuditLogSnapshot): AuditStore {
  if (message.projectId !== store.projectId || message.requestId !== store.requestId) return store;
  return { ...store, snapshot: message, loading: false };
}

/** Options come from the loaded window, independently of the active filters. */
export function filterValues(snapshot: AuditLogSnapshot | null): {
  actions: string[];
  outcomes: string[];
} {
  const entries = snapshot?.status === 'ok' ? snapshot.entries : [];
  return {
    actions: [...new Set(entries.map((entry) => entry.action))].sort(),
    outcomes: [...new Set(entries.map((entry) => entry.outcome.status))].sort(),
  };
}

/** The server owns ordering, limiting and redaction; filtering never changes them. */
export function visibleEntries(store: AuditStore): AuditViewEntry[] {
  if (store.loading || store.snapshot?.status !== 'ok') return [];
  return store.snapshot.entries.filter(
    (entry) =>
      (store.actionFilter === null || entry.action === store.actionFilter) &&
      (store.outcomeFilter === null || entry.outcome.status === store.outcomeFilter),
  );
}

export type AuditViewState = 'loading' | 'denied' | 'read_error' | 'empty' | 'no_matches' | 'list';

export function viewState(store: AuditStore): AuditViewState {
  if (store.loading) return 'loading';
  const snapshot = store.snapshot;
  if (!snapshot) return 'empty';
  switch (snapshot.status) {
    case 'denied':
    case 'unknown_project':
      return 'denied';
    case 'read_error':
      return 'read_error';
    case 'empty':
      return 'empty';
    case 'ok':
      // A successful read with only corrupt/excluded lines is a notice-only list.
      return snapshot.entries.length > 0 && visibleEntries(store).length === 0
        ? 'no_matches'
        : 'list';
  }
}

/** Whole-file metadata is never recomputed from the filtered window. */
export function auditNotices(
  store: AuditStore,
): Pick<AuditLogSnapshot, 'totalValid' | 'truncated' | 'corruptLines' | 'excludedCount'> {
  const snapshot = store.loading ? null : store.snapshot;
  return {
    totalValid: snapshot?.totalValid ?? 0,
    truncated: snapshot?.truncated ?? false,
    corruptLines: snapshot?.corruptLines ?? [],
    excludedCount: snapshot?.excludedCount ?? 0,
  };
}

function fixedDate(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** offsetMinutes is minutes east of UTC; production uses the instant's local offset. */
export function formatAuditDate(
  iso: string,
  offsetMinutes?: number,
): { local: string; utc: string } | null {
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  const offset = offsetMinutes ?? -date.getTimezoneOffset();
  const local = new Date(milliseconds + offset * 60_000);
  if (!Number.isFinite(local.getTime())) return null;
  return { local: fixedDate(local), utc: `${fixedDate(date)} UTC` };
}

// React binding follows executorStore; pure transitions above require no DOM.
let current = emptyAuditStore();
const listeners = new Set<() => void>();

export function getAuditStore(): AuditStore {
  return current;
}

export function setAuditStore(next: AuditStore): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeAuditStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAuditStore(): AuditStore {
  return useSyncExternalStore(subscribeAuditStore, getAuditStore);
}
