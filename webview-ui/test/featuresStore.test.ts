import { describe, expect, it } from 'vitest';

import type { FeatureRow, FeaturesSnapshot } from '../../core/src/messages.js';
import {
  applyFeaturesSnapshot,
  beginFeaturesRequest,
  emptyFeaturesStore,
  featureProgressLabel,
  featuresReasonText,
  featureStateLabel,
  getFeaturesStore,
  setFeaturesStore,
  subscribeFeaturesStore,
  viewState,
  visibleFeatures,
} from '../src/office/featuresStore.js';

const row: FeatureRow = {
  key: 'FEAT-020',
  title: null,
  state: 'in_development',
  rawStatus: null,
  progress: { done: 2, total: 5 },
  currentTask: null,
  gates: [],
  integration: null,
  lastActivityAt: null,
};
const snapshot = (over: Partial<FeaturesSnapshot> = {}): FeaturesSnapshot => ({
  type: 'featuresSnapshot',
  projectId: 'P',
  requestId: 'r1',
  status: 'ok',
  reason: null,
  features: [row],
  ...over,
});

describe('features store acceptance', () => {
  it('AC-002 formats server DAG progress and absent tasks', () => {
    expect(featureProgressLabel(row.progress)).toBe('2/5');
    expect(featureProgressLabel(null)).toBe('sin tareas');
  });

  it('AC-009/010 only explicit empty success means empty', () => {
    const pending = beginFeaturesRequest(emptyFeaturesStore(), 'P', 'r1');
    expect(viewState(emptyFeaturesStore())).toBe('loading');
    expect(viewState(pending)).toBe('loading');
    expect(
      viewState(applyFeaturesSnapshot(pending, snapshot({ status: 'empty', features: [] }))),
    ).toBe('empty');
    expect(viewState(applyFeaturesSnapshot(pending, snapshot({ features: [] })))).toBe('list');
    const failed = applyFeaturesSnapshot(
      pending,
      snapshot({ status: 'read_error', reason: 'unavailable' }),
    );
    expect(viewState(failed)).toBe('read_error');
    expect(visibleFeatures(failed)).toEqual([]);
    for (const status of ['denied', 'unknown_project'] as const) {
      expect(viewState(applyFeaturesSnapshot(pending, snapshot({ status })))).toBe('denied');
    }
  });

  it('AC-011 clears rows immediately and rejects late projects and requests', () => {
    const loaded = applyFeaturesSnapshot(
      beginFeaturesRequest(emptyFeaturesStore(), 'P', 'r1'),
      snapshot(),
    );
    const next = beginFeaturesRequest(loaded, 'Q', 'r2');
    expect(next.snapshot).toBeNull();
    expect(visibleFeatures(next)).toEqual([]);
    expect(applyFeaturesSnapshot(next, snapshot())).toBe(next);
    expect(applyFeaturesSnapshot(next, snapshot({ projectId: 'Q' }))).toBe(next);
  });

  it('AC-014 refresh replaces progress, current task and server ordering', () => {
    const loaded = applyFeaturesSnapshot(
      beginFeaturesRequest(emptyFeaturesStore(), 'P', 'r1'),
      snapshot(),
    );
    const pending = beginFeaturesRequest(loaded, 'P', 'r2');
    expect(visibleFeatures(pending)).toEqual([]);
    expect(applyFeaturesSnapshot(pending, snapshot())).toBe(pending);
    const rows = [
      {
        ...row,
        progress: { done: 3, total: 5 },
        currentTask: { key: 'FEAT-020-T03', step: 'develop' as const, others: 0 },
      },
      { ...row, key: 'FEAT-021' },
    ];
    expect(
      visibleFeatures(
        applyFeaturesSnapshot(pending, snapshot({ requestId: 'r2', features: rows })),
      ),
    ).toEqual(rows);
  });

  it('AC-010/011 keeps a new Project error when the old Project responds late', () => {
    const loaded = applyFeaturesSnapshot(
      beginFeaturesRequest(emptyFeaturesStore(), 'P', 'r1'),
      snapshot(),
    );
    const pending = beginFeaturesRequest(loaded, 'Q', 'r2');
    const failed = applyFeaturesSnapshot(
      pending,
      snapshot({
        projectId: 'Q',
        requestId: 'r2',
        status: 'read_error',
        reason: 'query_failed',
        features: [],
      }),
    );
    expect(viewState(failed)).toBe('read_error');
    expect(visibleFeatures(failed)).toEqual([]);
    expect(applyFeaturesSnapshot(failed, snapshot())).toBe(failed);
    expect(failed.projectId).toBe('Q');
  });

  it('formats states and uses fixed safe error text', () => {
    expect(featureStateLabel(row)).toBe('en desarrollo');
    expect(featureStateLabel({ ...row, state: 'in_review' })).toBe('spec en revisión');
    expect(featureStateLabel({ ...row, state: 'in_design' })).toBe('en diseño');
    expect(featureStateLabel({ ...row, state: 'ready_to_merge' })).toBe('ready_to_merge');
    expect(featureStateLabel({ ...row, state: 'unknown', rawStatus: 'legacy' })).toBe(
      'desconocido: legacy',
    );
    for (const reason of [
      'unavailable',
      'schema_incompatible',
      'query_failed',
      'invalid_data',
      null,
    ] as const) {
      expect(featuresReasonText(reason)).toBeTruthy();
    }
    expect(featuresReasonText('C:/secret/trace' as never)).toBe(featuresReasonText(null));
  });

  it('notifies subscribers only on changed references and supports unsubscribe', () => {
    setFeaturesStore(emptyFeaturesStore());
    let calls = 0;
    const unsubscribe = subscribeFeaturesStore(() => calls++);
    const current = getFeaturesStore();
    setFeaturesStore(current);
    expect(calls).toBe(0);
    setFeaturesStore(beginFeaturesRequest(current, 'P', 'r1'));
    expect(calls).toBe(1);
    unsubscribe();
    setFeaturesStore(emptyFeaturesStore());
    expect(calls).toBe(1);
  });
});
