import type { BoardState } from '../../../core/src/messages.js';

/** Decisions come from WorkStore even when no legacy board is available. DOM-free. */
export function decisionsHudView(board: { decisions?: BoardState['decisions'] }) {
  const decisions = board.decisions ?? [];
  const open = decisions.filter((decision) => decision.status === 'open').length;
  const urgent = decisions.filter(
    (decision) =>
      decision.status === 'open' &&
      (decision.urgency === 'high' || decision.urgency === 'critical'),
  ).length;
  return {
    visible: decisions.length > 0,
    open,
    urgent,
    label: `Decisiones · ${open}`,
    accessibleName: `Decisiones, ${open} pendientes`,
  };
}
