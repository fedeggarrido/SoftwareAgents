import type { ModelTier } from './modelTier.js';

/**
 * Executors this runtime can launch: the single source of executor ids for config
 * validation, selection, slots and the wire (AsyncAPI `ExecutorId` mirrors it).
 * Local models are absent on purpose: ADR-0004 rejected them for now; adding one
 * means a new entry here, its executor, and an enum value in the contract.
 */
export const EXECUTOR_CATALOG = [
  { id: 'claude', label: 'Claude Code', kind: 'cloud_cli' },
  { id: 'codex', label: 'Codex', kind: 'cloud_cli' },
] as const;

export type ExecutorId = (typeof EXECUTOR_CATALOG)[number]['id'];
export const EXECUTOR_IDS: readonly ExecutorId[] = EXECUTOR_CATALOG.map((e) => e.id);
export const MODEL_TIER_IDS: readonly ModelTier[] = ['economy', 'standard', 'deep'];

export function isExecutorId(value: unknown): value is ExecutorId {
  return typeof value === 'string' && (EXECUTOR_IDS as readonly string[]).includes(value);
}

/** Client features negotiated in `webviewReady`; servers only send what a client asked for. */
export const CLIENT_CAPABILITIES = ['executorControls'] as const;
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number];
