import { useSyncExternalStore } from 'react';

import type {
  ClientMessage,
  ExecutorState,
  ExecutorToggleResult,
  ModelTier,
} from '../../../core/src/messages.js';
import { EXECUTOR_TOGGLE_TIMEOUT_MS } from '../constants.js';

// ── Executor availability (server `executorState`, SA-087/088/089/091) ──────
// The server is the only source of truth. A toggle never changes `state`
// optimistically: the row shows "Guardando…" until the confirmed result and the
// fresh snapshot that follows it arrive. DOM-free so it can be unit-tested.

/** One in-flight command per Executor: availability (SA-091) or levels (SA-092). */
export interface PendingToggle {
  requestId: string;
  sentAt: number;
}

export interface ExecutorStore {
  state: ExecutorState | null;
  pending: Record<string, PendingToggle>;
  /** Last failed toggle per executor, cleared by the next snapshot that settles it. */
  errors: Record<string, string>;
}

export function emptyExecutorStore(): ExecutorStore {
  return { state: null, pending: {}, errors: {} };
}

/** Snapshots arrive in order per connection; a reconnect restarts the sequence at 0. */
export function applyExecutorState(store: ExecutorStore, next: ExecutorState): ExecutorStore {
  const prev = store.state;
  if (
    prev &&
    prev.projectId === next.projectId &&
    next.sequence !== 0 &&
    next.sequence <= prev.sequence
  )
    return store;
  return { ...store, state: next };
}

const ERROR_TEXT: Record<string, string> = {
  unauthorized: 'Solo el operador puede cambiar la disponibilidad.',
  invalid_request: 'Petición inválida (¿el catálogo de niveles cambió?).',
  unknown_project: 'Este servidor no gestiona ese proyecto.',
  unknown_executor: 'Executor desconocido.',
  policy_denied: 'La política del operador no permite este cambio.',
  revision_conflict: 'La configuración cambió en otro sitio; estado actualizado.',
  apply_failed: 'No se pudo aplicar ahora; inténtalo de nuevo.',
  persist_failed: 'No se pudo guardar; no se cambió nada.',
  audit_failed: 'No se pudo registrar en la auditoría; no se cambió nada.',
  recovery_required:
    'Cambio sin resultado verificado: lanzamientos bloqueados hasta «pixel-agents executors recover».',
  not_supported: 'Este servidor aún no permite cambiar la disponibilidad.',
};

export function toggleErrorText(result: Pick<ExecutorToggleResult, 'status' | 'errorCode'>) {
  return ERROR_TEXT[result.errorCode ?? ''] ?? `No aplicado (${result.status}).`;
}

/**
 * Settle a pending toggle by its requestId. Returns whether the client must ask for
 * a fresh snapshot: any non-applied answer means our view may be stale.
 */
export function applyToggleResult(
  store: ExecutorStore,
  result: ExecutorToggleResult,
): { store: ExecutorStore; resync: boolean } {
  const pending = store.pending[result.executorId];
  if (!pending || pending.requestId !== result.requestId) return { store, resync: false };
  const rest = { ...store.pending };
  delete rest[result.executorId];
  const ok = result.status === 'applied' || result.status === 'unchanged';
  const errors = { ...store.errors };
  if (ok) delete errors[result.executorId];
  else errors[result.executorId] = toggleErrorText(result);
  return { store: { ...store, pending: rest, errors }, resync: !ok };
}

type ExecutorCommand =
  | { type: 'setExecutorEnabled'; enabled: boolean }
  | { type: 'setExecutorLevels'; levels: ModelTier[] };

/** Build the command and mark the row pending. Nothing is sent while one is in flight. */
function beginCommand(
  store: ExecutorStore,
  executorId: string,
  command: ExecutorCommand,
  now: number,
  requestId: string,
): { store: ExecutorStore; message: ClientMessage } | null {
  const state = store.state;
  if (!state || !state.canManage || store.pending[executorId]) return null;
  if (state.configurationStatus === 'recovery_required') return null;
  const message = {
    ...command,
    projectId: state.projectId,
    executorId: executorId as 'claude' | 'codex',
    requestId,
    expectedRevision: state.revision,
  } as ClientMessage;
  return {
    store: {
      ...store,
      pending: { ...store.pending, [executorId]: { requestId, sentAt: now } },
    },
    message,
  };
}

export function beginToggle(
  store: ExecutorStore,
  executorId: string,
  enabled: boolean,
  now: number,
  requestId: string,
) {
  return beginCommand(store, executorId, { type: 'setExecutorEnabled', enabled }, now, requestId);
}

/**
 * SA-092: allow or disallow one level. The command carries the complete allowed set,
 * built from the levels the server last confirmed (never from a pending guess) and
 * kept in catalog order; nothing is sent for a level the catalog does not offer.
 */
export function beginLevelToggle(
  store: ExecutorStore,
  executorId: string,
  tier: ModelTier,
  allowed: boolean,
  now: number,
  requestId: string,
) {
  const row = store.state?.executors.find((e) => e.executorId === executorId);
  const catalog = row?.catalogLevels;
  if (!row || !catalog?.includes(tier)) return null;
  const levels = catalog.filter((t) => (t === tier ? allowed : row.levels.includes(t)));
  return beginCommand(store, executorId, { type: 'setExecutorLevels', levels }, now, requestId);
}

/** Pending toggles with no answer in time (lost or disconnected): drop them and resync. */
export function expirePending(
  store: ExecutorStore,
  now: number,
): { store: ExecutorStore; resync: boolean } {
  const expired = Object.entries(store.pending).filter(
    ([, p]) => now - p.sentAt >= EXECUTOR_TOGGLE_TIMEOUT_MS,
  );
  if (!expired.length) return { store, resync: false };
  const pending = { ...store.pending };
  const errors = { ...store.errors };
  for (const [id] of expired) {
    delete pending[id];
    errors[id] = 'Sin respuesta del servidor; estado actualizado.';
  }
  return { store: { ...store, pending, errors }, resync: true };
}

// ── React binding (module singleton, like boardStore) ──
let current = emptyExecutorStore();
const listeners = new Set<() => void>();

export function getExecutorStore(): ExecutorStore {
  return current;
}

export function setExecutorStore(next: ExecutorStore): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

export function subscribeExecutorStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useExecutorStore(): ExecutorStore {
  return useSyncExternalStore(subscribeExecutorStore, getExecutorStore);
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function commit(started: { store: ExecutorStore; message: ClientMessage } | null) {
  if (!started) return null;
  setExecutorStore(started.store);
  return started.message;
}

/** Event-handler entry point: marks the row pending and returns what to send. */
export function startToggle(executorId: string, enabled: boolean): ClientMessage | null {
  return commit(beginToggle(current, executorId, enabled, Date.now(), newRequestId()));
}

export function startLevelToggle(
  executorId: string,
  tier: ModelTier,
  allowed: boolean,
): ClientMessage | null {
  return commit(beginLevelToggle(current, executorId, tier, allowed, Date.now(), newRequestId()));
}
