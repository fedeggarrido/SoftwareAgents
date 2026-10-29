import { readFileSync } from 'node:fs';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { ClientMessage, FeatureRow, ServerMessage } from '../../../core/src/messages.js';

const contract = parse(
  readFileSync(new URL('../../../core/asyncapi.yaml', import.meta.url), 'utf8'),
);
const schemas = contract.components.schemas;
const validate = (name: string, value: unknown) =>
  new Ajv({ strict: false }).compile({ ...schemas[name], components: { schemas } })(value);
const row = {
  key: 'FEAT-002',
  title: '<b>Title</b>',
  state: 'in_review',
  rawStatus: null,
  progress: { done: 2, total: 5 },
  currentTask: { key: 'FEAT-002-T01', step: 'review', others: 0 },
  gates: [
    {
      kind: 'spec_approval',
      task: null,
      expired: false,
      command: 'pixel-agents feature approve FEAT-002',
    },
  ],
  integration: { branch: 'sa/FEAT-002-integration', sha: 'abcdef0' },
  lastActivityAt: null,
  cost: {
    executions: 0,
    costKnown: 0,
    costUsd: null,
    costPerDoneTaskUsd: null,
    cacheHitRate: null,
  },
};
const snapshot = {
  type: 'featuresSnapshot',
  projectId: 'P',
  requestId: '1',
  status: 'ok',
  reason: null,
  features: [row],
};

describe('FEAT-002 protocol (AC-012, AC-013)', () => {
  it('FEAT-003 AC-001/003/007 requires a closed aggregate cost contract', () => {
    expect(validate('FeatureRow', row)).toBe(true);
    const { cost, ...withoutCost } = row;
    expect(validate('FeatureRow', withoutCost)).toBe(false);
    expect(validate('FeatureCost', cost)).toBe(true);
    expect(
      validate('FeatureCost', { ...cost, costUsd: 0, costPerDoneTaskUsd: 0, cacheHitRate: 0 }),
    ).toBe(true);
    for (const field of Object.keys(cost)) {
      const missing = { ...cost } as Record<string, unknown>;
      delete missing[field];
      expect(validate('FeatureCost', missing)).toBe(false);
      expect(validate('FeatureCost', { ...cost, [field]: 'unknown' })).toBe(false);
    }
    expect(validate('FeatureCost', { ...cost, executions: -1 })).toBe(false);
    expect(validate('FeatureCost', { ...cost, costKnown: 0.5 })).toBe(false);
    expect(validate('FeatureCost', { ...cost, prompt: 'private' })).toBe(false);
  });
  it('registers a read-only correlated request without new authority fields (AC-012)', () => {
    expect(schemas.ClientMessage.oneOf).toContainEqual({
      $ref: '#/components/schemas/RequestFeatures',
    });
    expect(
      validate('RequestFeatures', { type: 'requestFeatures', projectId: 'P', requestId: '1' }),
    ).toBe(true);
    expect(validate('RequestFeatures', { type: 'requestFeatures', projectId: 'P' })).toBe(false);
    expect(
      validate('RequestFeatures', {
        type: 'requestFeatures',
        projectId: 'P',
        requestId: '1',
        privileged: true,
      }),
    ).toBe(false);
  });

  it('registers the display-only snapshot and fixed status/reason catalogs (AC-012, AC-013)', () => {
    expect(schemas.ServerMessage.oneOf).toContainEqual({
      $ref: '#/components/schemas/FeaturesSnapshot',
    });
    expect(validate('FeaturesSnapshot', snapshot)).toBe(true);
    for (const status of ['ok', 'empty', 'denied', 'unknown_project', 'read_error']) {
      expect(validate('FeaturesSnapshot', { ...snapshot, status, features: [] })).toBe(true);
    }
    for (const reason of [
      null,
      'unavailable',
      'schema_incompatible',
      'query_failed',
      'invalid_data',
    ]) {
      expect(validate('FeaturesSnapshot', { ...snapshot, reason })).toBe(true);
    }
    expect(validate('FeaturesSnapshot', { ...snapshot, status: 'failed' })).toBe(false);
    expect(validate('FeaturesSnapshot', { ...snapshot, reason: '/private/database' })).toBe(false);
  });

  it('preserves nullable generated types and closed display catalogs (AC-013)', () => {
    const feature: FeatureRow = {
      key: 'FEAT-002',
      title: null,
      state: 'unknown',
      rawStatus: 'legacy',
      progress: null,
      currentTask: null,
      gates: [],
      integration: null,
      lastActivityAt: null,
      cost: row.cost,
    };
    const request: ClientMessage = { type: 'requestFeatures', projectId: 'P', requestId: '2' };
    const response: ServerMessage = {
      ...request,
      type: 'featuresSnapshot',
      status: 'ok',
      reason: null,
      features: [feature],
    };
    expect(validate('FeaturesSnapshot', response)).toBe(true);
    for (const state of ['ready_to_merge', 'in_review', 'in_design', 'in_development', 'unknown']) {
      expect(validate('FeaturesSnapshot', { ...snapshot, features: [{ ...feature, state }] })).toBe(
        true,
      );
    }
    expect(
      validate('FeaturesSnapshot', { ...snapshot, features: [{ ...row, state: 'invented' }] }),
    ).toBe(false);
    expect(
      validate('FeaturesSnapshot', {
        ...snapshot,
        features: [{ ...row, currentTask: { ...row.currentTask, step: null } }],
      }),
    ).toBe(true);
    expect(
      validate('FeaturesSnapshot', {
        ...snapshot,
        features: [{ ...row, currentTask: { ...row.currentTask, step: 'execute' } }],
      }),
    ).toBe(false);
  });

  it('rejects additional sensitive fields throughout the projection (AC-013)', () => {
    for (const field of [
      'doc_path',
      'pid',
      'prompt',
      'message',
      'report',
      'answer',
      'stdout',
      'remoteUrl',
    ]) {
      expect(validate('FeaturesSnapshot', { ...snapshot, [field]: 'sensitive' })).toBe(false);
      expect(
        validate('FeaturesSnapshot', { ...snapshot, features: [{ ...row, [field]: 'sensitive' }] }),
      ).toBe(false);
      for (const nested of ['progress', 'currentTask', 'integration', 'cost'] as const) {
        expect(
          validate('FeaturesSnapshot', {
            ...snapshot,
            features: [{ ...row, [nested]: { ...row[nested], [field]: 'sensitive' } }],
          }),
        ).toBe(false);
      }
      expect(
        validate('FeaturesSnapshot', {
          ...snapshot,
          features: [{ ...row, gates: [{ ...row.gates[0], [field]: 'sensitive' }] }],
        }),
      ).toBe(false);
    }
  });
});
