import { describe, expect, it } from 'vitest';

import type { FeatureRow, FeaturesSnapshot } from '../../core/src/messages.js';
import {
  applyFeaturesSnapshot,
  beginFeaturesRequest,
  emptyFeaturesStore,
  featureCacheRateLabel,
  featureCostLabel,
  featureCostPerDoneLabel,
  featureCoverageLabel,
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
  cost: { executions: 3, costKnown: 3, costUsd: 0.6, costPerDoneTaskUsd: 0.3, cacheHitRate: 0.5 },
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
  it('FEAT-003 AC-001/002 formats full and partial known cost', () => {
    expect(featureCostLabel(row.cost)).toBe('0.60 USD');
    expect(featureCoverageLabel(row.cost)).toBe('3 de 3');
    expect(featureCostPerDoneLabel(row.cost)).toBe('0.30 USD');
    expect(featureCacheRateLabel(row.cost)).toBe('50 %');
    const partial = { ...row.cost, executions: 5, costUsd: 0.9 };
    expect(featureCostLabel(partial)).toBe('0.90 USD (parcial)');
    expect(featureCoverageLabel(partial)).toBe('3 de 5');
  });

  it('FEAT-003 AC-003/004 distinguishes unknown, absent DONE tasks and known zero', () => {
    for (const executions of [0, 4]) {
      const cost = {
        executions,
        costKnown: 0,
        costUsd: null,
        costPerDoneTaskUsd: null,
        cacheHitRate: null,
      };
      expect(featureCostLabel(cost)).toBe('sin datos');
      expect(featureCoverageLabel(cost)).toBe(`0 de ${executions}`);
      expect(featureCostPerDoneLabel(cost)).toBe('sin datos');
      expect(featureCacheRateLabel(cost)).toBe('sin datos');
    }
    expect(featureCostLabel({ ...row.cost, costUsd: 0.5 })).toBe('0.50 USD');
    expect(featureCostPerDoneLabel({ ...row.cost, costPerDoneTaskUsd: null })).toBe('sin datos');
    for (const [value, label] of [
      [0, '0.00 USD'],
      [0.004, '<0.01 USD'],
      [0.005, '0.01 USD'],
    ] as const) {
      expect(featureCostLabel({ ...row.cost, costUsd: value })).toBe(label);
      expect(featureCostPerDoneLabel({ ...row.cost, costPerDoneTaskUsd: value })).toBe(label);
    }
    expect(featureCacheRateLabel({ ...row.cost, cacheHitRate: 0 })).toBe('0 %');
    expect(featureCacheRateLabel({ ...row.cost, cacheHitRate: 0.666 })).toBe('67 %');
    for (const value of [null, NaN, Infinity, -Infinity]) {
      expect(featureCostLabel({ ...row.cost, costUsd: value })).toBe('sin datos');
      expect(featureCostPerDoneLabel({ ...row.cost, costPerDoneTaskUsd: value })).toBe('sin datos');
      expect(featureCacheRateLabel({ ...row.cost, cacheHitRate: value })).toBe('sin datos');
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(featureCoverageLabel({ ...row.cost, executions: value })).toBe('sin datos');
      expect(featureCoverageLabel({ ...row.cost, costKnown: value })).toBe('sin datos');
    }
  });
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
    expect(featureStateLabel(row)).toBe('En desarrollo');
    expect(featureStateLabel({ ...row, state: 'in_review' })).toBe('Requisitos en revisión');
    expect(featureStateLabel({ ...row, state: 'in_design' })).toBe('En diseño');
    expect(featureStateLabel({ ...row, state: 'ready_to_merge' })).toBe('Lista para integrar');
    expect(featureStateLabel({ ...row, state: 'unknown', rawStatus: 'legacy' })).toBe(
      'Sin estado registrado',
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

  it('labels every state from the AsyncAPI enum without exposing raw values', () => {
    const contract = readFileSync(new URL('../../core/asyncapi.yaml', import.meta.url), 'utf8');
    const states = /FeatureState:\s+type: string\s+enum: \[([^\]]+)\]/
      .exec(contract)![1]
      .split(',')
      .map((state) => state.trim());
    const labels: Record<FeatureRow['state'], string> = {
      merged: 'Integrada',
      ready_to_merge: 'Lista para integrar',
      in_review: 'Requisitos en revisión',
      in_design: 'En diseño',
      in_development: 'En desarrollo',
      unknown: 'Sin estado registrado',
    };
    expect(states.sort()).toEqual(Object.keys(labels).sort());
    for (const state of states) {
      expect(
        featureStateLabel({ state: state as FeatureRow['state'], rawStatus: 'private_state' }),
      ).toBe(labels[state as FeatureRow['state']]);
    }
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
import { readFileSync } from 'node:fs';
