import type { BoardDecision, BoardState } from '../../../core/src/messages.js';

export type DecisionReview =
  | { phase: 'choosing' }
  | { phase: 'reviewing'; decision: BoardDecision; answer: string; project: string }
  | { phase: 'invalid' }
  | { phase: 'sent'; decisionId: string };

export function reviewDecision(
  board: BoardState,
  decision: BoardDecision,
  answer: string,
): DecisionReview {
  if (decision.status !== 'open' || !decision.options.includes(answer)) return { phase: 'invalid' };
  return {
    phase: 'reviewing',
    decision: structuredClone(decision),
    answer,
    project: projectKey(board),
  };
}

function projectKey(board: BoardState): string {
  return JSON.stringify([board.projectId, board.project, board.mode]);
}

/** A changed or missing snapshot invalidates the review permanently, even if it later reappears. */
export function reconcileDecisionReview(
  review: DecisionReview,
  board: BoardState | null,
): DecisionReview {
  if (review.phase === 'sent') {
    return board?.decisions.find((decision) => decision.id === review.decisionId)?.status === 'open'
      ? review
      : { phase: 'choosing' };
  }
  if (review.phase !== 'reviewing') return review;
  const current = board?.decisions.find((decision) => decision.id === review.decision.id);
  return board &&
    projectKey(board) === review.project &&
    current?.status === 'open' &&
    JSON.stringify(current) === JSON.stringify(review.decision)
    ? review
    : { phase: 'invalid' };
}
