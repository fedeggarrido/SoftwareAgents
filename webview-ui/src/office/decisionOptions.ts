import type { BoardDecision } from '../../../core/src/messages.js';

/** Keep legacy strings and structured IDs compatible on the same transport. */
export function decisionOptions(decision: BoardDecision) {
  return decision.options.map((id) => {
    const details = decision.structuredOptions?.find((option) => option.id === id);
    return { id, label: details?.label ?? id, details };
  });
}
