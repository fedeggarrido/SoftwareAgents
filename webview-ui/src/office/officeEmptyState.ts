import type { BoardState } from '../../../core/src/messages.js';
import type { FeaturesStore } from './featuresStore.js';

/** Missing or failed reads are not evidence of an empty office. Completed work counts too. */
export function officeEmptyState(
  board: BoardState | null,
  features: FeaturesStore,
  agents: readonly number[],
): 'unavailable' | 'empty' | 'used' {
  if (agents.length > 0) return 'used';
  if (!board || board.mode === 'invalid') return 'unavailable';
  if (board.items.length > 0 || board.summary.total > 0) return 'used';
  if (board.projectId) {
    const snapshot = features.snapshot;
    if (features.projectId !== board.projectId || !snapshot) return 'unavailable';
    if (snapshot.features.length > 0) return 'used';
    if (features.loading || (snapshot.status !== 'empty' && snapshot.status !== 'ok'))
      return 'unavailable';
  }
  return 'empty';
}
