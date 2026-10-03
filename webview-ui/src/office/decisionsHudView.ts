import type { BoardState } from '../../../core/src/messages.js';

/** Decisions come from WorkStore even when no legacy board is available. DOM-free. */
export function decisionsHudView(board: { decisions?: BoardState['decisions'] }) {
  const decisions = board.decisions ?? [];
  const open = decisions.filter((decision) => decision.status === 'open').length;
  return { visible: decisions.length > 0, open, label: `Decisiones (${open})` };
}
