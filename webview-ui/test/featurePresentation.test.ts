import { describe, expect, it } from 'vitest';

import type { FeatureRow } from '../../core/src/messages.js';
import { es } from '../src/i18n/es.js';
import { featurePresentation } from '../src/office/featurePresentation.js';

const feature: Pick<FeatureRow, 'state' | 'progress' | 'gates' | 'currentTask'> = {
  state: 'in_development',
  progress: { done: 5, failed: 0, total: 5 },
  gates: [],
  currentTask: null,
};
describe('SA-123 visible feature state', () => {
  it.each([
    [null, es.features.noTasks],
    [{ done: 1, failed: 2, total: 5 }, es.features.failedTasks(2)],
    [{ done: 1, failed: 1, total: 5 }, es.features.failedTasks(1)],
    [{ done: 1, failed: 0, total: 5 }, es.features.queued],
  ])('tells queued, failed and missing tasks apart: %j', (progress, nextAction) => {
    expect(featurePresentation({ ...feature, progress }).nextAction).toBe(nextAction);
  });
  it('reports failures before a running task and keeps a review state with every task done', () => {
    expect(
      featurePresentation({
        ...feature,
        progress: { done: 1, failed: 1, total: 5 },
        currentTask: { key: 'T1', step: 'develop', others: 0 },
      }).nextAction,
    ).toBe(es.features.failedTasks(1));
    expect(featurePresentation({ ...feature, state: 'in_review' }).state).toBe('in_review');
    expect(featurePresentation({ ...feature, state: 'in_design' }).state).toBe(
      'feature_tasks_complete',
    );
  });
  it('does not infer closure or integration from 5/5 done tasks', () => {
    expect(featurePresentation(feature)).toEqual({
      state: 'feature_tasks_complete',
      nextAction: es.features.verifyClosure,
    });
    expect(feature.state).toBe('in_development');
  });
  it.each([null, { done: 0, failed: 0, total: 0 }, { done: 4, failed: 0, total: 5 }])(
    'keeps development without complete task evidence: %j',
    (progress) => {
      expect(featurePresentation({ ...feature, progress }).state).toBe('in_development');
    },
  );
  it.each(['merged', 'ready_to_merge'] satisfies FeatureRow['state'][])(
    'preserves the recorded %s state',
    (state) => {
      expect(featurePresentation({ ...feature, state }).state).toBe(state);
    },
  );
  it('keeps unresolved gates actionable after all tasks are done', () => {
    const gates: FeatureRow['gates'] = [
      {
        kind: 'human_decision',
        task: null,
        expired: false,
        command: 'pixel-agents feature show FEAT-001',
      },
    ];
    expect(featurePresentation({ ...feature, gates })).toEqual({
      state: 'feature_tasks_complete',
      nextAction: es.features.gates,
    });
  });
  it('points to the active task and retains design and review states', () => {
    expect(
      featurePresentation({
        ...feature,
        progress: null,
        currentTask: { key: 'T1', step: 'review', others: 0 },
      }).nextAction,
    ).toBe(es.features.followTask);
    expect(featurePresentation({ ...feature, progress: null, state: 'in_review' }).state).toBe(
      'in_review',
    );
    expect(featurePresentation({ ...feature, progress: null, state: 'in_design' }).state).toBe(
      'in_design',
    );
  });
});
