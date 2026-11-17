import { describe, expect, it } from 'vitest';

import { emptyFeaturesStore } from '../src/office/featuresStore.js';
import { officeEmptyState } from '../src/office/officeEmptyState.js';
import { emptyBoard, emptyFeatures } from './fixtures/officeStart.js';

describe('office empty state (SA-117)', () => {
  it('welcomes an empty legacy office and a confirmed empty managed project', () => {
    expect(officeEmptyState(emptyBoard(), emptyFeaturesStore(), [])).toBe('empty');
    expect(
      officeEmptyState(emptyBoard({ projectId: 'P', mode: 'project' }), emptyFeatures(), []),
    ).toBe('empty');
  });

  it('does not confuse loading, stale-project, denied or failed reads with empty work', () => {
    const board = emptyBoard({ projectId: 'P', mode: 'project' });
    for (const features of [
      emptyFeaturesStore(),
      { ...emptyFeatures(), projectId: 'other' },
      { ...emptyFeatures(), loading: true },
      emptyFeatures({ status: 'denied' }),
      emptyFeatures({ status: 'read_error' }),
    ])
      expect(officeEmptyState(board, features, [])).toBe('unavailable');
    expect(officeEmptyState(null, emptyFeaturesStore(), [])).toBe('unavailable');
    expect(officeEmptyState(emptyBoard({ mode: 'invalid' }), emptyFeaturesStore(), [])).toBe(
      'unavailable',
    );
  });

  it('hides for any session, task (including completed), or feature without tasks', () => {
    expect(officeEmptyState(null, emptyFeaturesStore(), [1])).toBe('used');
    expect(
      officeEmptyState(
        emptyBoard({ summary: { total: 1, byPhase: { DONE: 1 }, byEpic: {} } }),
        emptyFeaturesStore(),
        [],
      ),
    ).toBe('used');
    expect(
      officeEmptyState(
        emptyBoard({ projectId: 'P' }),
        emptyFeatures({
          status: 'ok',
          features: [
            {
              key: 'FEAT-001',
              title: 'Una funcionalidad',
              state: 'merged',
              rawStatus: null,
              progress: null,
              currentTask: null,
              gates: [],
              integration: null,
              lastActivityAt: null,
              cost: {
                executions: 0,
                costKnown: 0,
                costUsd: null,
                costPerDoneTaskUsd: null,
                cacheHitRate: null,
              },
            },
          ],
        }),
        [],
      ),
    ).toBe('used');
  });
});
