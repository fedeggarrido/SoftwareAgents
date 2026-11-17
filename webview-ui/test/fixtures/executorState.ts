import { EXECUTOR_CATALOG } from '../../../core/src/executorCatalog.js';
import type { ExecutorState } from '../../../core/src/messages.js';

export function executorSnapshot(overrides: Partial<ExecutorState> = {}): ExecutorState {
  return {
    type: 'executorState',
    projectId: 'demo',
    revision: 'r',
    sequence: 0,
    observedAt: 1,
    canManage: true,
    configurationStatus: 'ready',
    executors: EXECUTOR_CATALOG.map(({ id }) => ({
      executorId: id,
      enabled: false,
      eligible: false,
      reasonCodes: ['operator_disabled'],
      installation: 'unknown',
      version: null,
      authentication: 'unknown',
      levels: [],
      quotaGate: 'unknown',
      activeExecutions: 0,
      concurrencyLimit: null,
      checkedAt: null,
      staleAfter: null,
    })),
    ...overrides,
  };
}
