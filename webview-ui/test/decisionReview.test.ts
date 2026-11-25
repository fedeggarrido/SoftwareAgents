import { describe, expect, it } from 'vitest';

import type { BoardDecision, BoardState } from '../../core/src/messages.js';
import { reconcileDecisionReview, reviewDecision } from '../src/office/decisionReview.js';
import { decisionsHudView } from '../src/office/decisionsHudView.js';

const decision: BoardDecision = {
  id: 'review',
  question: '¿Esperar la revisión?',
  status: 'open',
  options: ['wait', 'continue'],
  urgency: 'critical',
  recommendation: 'Se recomienda esperar',
  structuredOptions: [
    { id: 'wait', label: 'Esperar', benefit: 'Revisar', cost: 'Tiempo', risk: 'Retraso' },
  ],
};
function board(): BoardState {
  return {
    type: 'boardState',
    project: 'Pedidos',
    projectId: 'pedidos',
    mode: 'project',
    items: [],
    recent: [],
    waiting: [],
    gate: [],
    decisions: [structuredClone(decision)],
    generatedAt: 0,
    sources: { board: false, claims: false, progress: false },
    summary: { total: 0, byPhase: {}, byEpic: {} },
    quota: {
      claude: {
        provider: 'claude',
        status: 'unknown',
        usedPercent: null,
        resetsAt: null,
        observedAt: null,
      },
      codex: {
        provider: 'codex',
        status: 'unknown',
        usedPercent: null,
        resetsAt: null,
        observedAt: null,
      },
    },
  };
}
describe('human decision review', () => {
  it('captures the original answer ID and immutable consequences without inferring recommendations', () => {
    const current = board();
    const review = reviewDecision(current, current.decisions[0], 'wait');
    expect(review).toMatchObject({ phase: 'reviewing', answer: 'wait', decision });
    current.decisions[0].structuredOptions![0].risk = 'Otro riesgo';
    expect(review).toMatchObject({ decision: { structuredOptions: [{ risk: 'Retraso' }] } });
    expect(reconcileDecisionReview(review, current)).toEqual({ phase: 'invalid' });
  });
  it('allows unrelated board refreshes', () => {
    const current = board();
    const review = reviewDecision(current, decision, 'wait');
    expect(reconcileDecisionReview(review, { ...current, generatedAt: 2 })).toEqual(review);
  });
  it.each(['question', 'context', 'recommendation', 'impact'])(
    'invalidates changed %s',
    (field) => {
      const current = board();
      const review = reviewDecision(current, decision, 'wait');
      current.decisions = [{ ...decision, [field]: 'Contenido cambiado' }];
      expect(reconcileDecisionReview(review, current).phase).toBe('invalid');
    },
  );
  it('rejects resolution by another person, missing decisions, changed projects and disconnection', () => {
    const current = board();
    const review = reviewDecision(current, decision, 'wait');
    for (const next of [
      null,
      { ...current, decisions: [] },
      { ...current, projectId: 'other' },
      { ...current, decisions: [{ ...decision, status: 'answered', answer: 'continue' }] },
    ]) {
      const invalid = reconcileDecisionReview(review, next);
      expect(invalid.phase).toBe('invalid');
      expect(reconcileDecisionReview(invalid, current).phase).toBe('invalid');
    }
  });
  it('rejects unknown options and closed decisions', () => {
    expect(reviewDecision(board(), decision, 'invented').phase).toBe('invalid');
    expect(reviewDecision(board(), { ...decision, status: 'answered' }, 'wait').phase).toBe(
      'invalid',
    );
  });
  it('counts only open urgent decisions and releases the send lock after resolution', () => {
    const current = board();
    expect(decisionsHudView(current)).toMatchObject({ open: 1, urgent: 1 });
    expect(reconcileDecisionReview({ phase: 'sent', decisionId: decision.id }, current).phase).toBe(
      'sent',
    );
    current.decisions[0].status = 'answered';
    expect(decisionsHudView(current)).toMatchObject({ open: 0, urgent: 0 });
    expect(reconcileDecisionReview({ phase: 'sent', decisionId: decision.id }, current).phase).toBe(
      'choosing',
    );
  });
});
