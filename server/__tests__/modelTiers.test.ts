import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { ModelTierPolicy, TierRule, WorkSize, WorkType } from '../../core/src/modelTier.js';
import { parseProjects } from '../src/configPersistence.js';
import type { SelectionSnapshot } from '../src/executorSelection.js';
import {
  claudeEffortSupported,
  selectModelTier,
  validateModelTiers,
  validateTierRule,
} from '../src/modelTiers.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

export const rule: TierRule = parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
    'utf8',
  ),
).tierRule;
const policy: ModelTierPolicy = {
  maxTier: 'deep',
  tiers: {
    economy: { candidates: [{ executor: 'codex', model: 'test-economy-model', effort: 'low' }] },
    standard: {
      candidates: [{ executor: 'codex', model: 'test-standard-model', effort: 'medium' }],
      fallbackTo: 'economy',
    },
    deep: {
      candidates: [{ executor: 'claude', model: 'test-deep-model', effort: 'high' }],
      fallbackTo: 'standard',
    },
  },
};
const spec = (capabilityClass: string, fallbackAllowed = true): AgentSpec =>
  ({
    identity: {
      role:
        (
          {
            high_reasoning: 'architect',
            standard_coding: 'developer',
            review: 'reviewer',
            test_analysis: 'qa',
          } as Record<string, string>
        )[capabilityClass] ?? 'test-triager',
    },
    modelPolicy: { capabilityClass, fallbackAllowed },
  }) as AgentSpec;
function capacity(provider: 'claude' | 'codex', blocked: boolean): CapacitySnapshot {
  return {
    provider,
    status: 'allowed',
    source: provider === 'codex' ? 'codex_session_log' : 'claude_stream_json',
    confidence: 'high',
    observedAt: 100,
    windows: [
      {
        kind: 'five_hour',
        usedRatio: blocked ? 1 : 0.1,
        resetsAt: provider === 'claude' ? 300 : 200,
      },
    ],
  };
}
function snapshot(claudeLow = false, codexLow = false): SelectionSnapshot {
  return {
    allowedExecutors: ['claude', 'codex'],
    nowS: 100,
    active: { claude: 0, codex: 0 },
    machinePolicy: {
      quotaThresholds: { claude: 10, codex: 10 },
      maxConcurrent: { claude: 1, codex: 1 },
    },
    capacities: { claude: capacity('claude', claudeLow), codex: capacity('codex', codexLow) },
  };
}
const typeSizes: [WorkType, [string, string, string], [string, string, string]][] = [
  ['summary', ['economy', 'economy', 'standard'], ['standard', 'standard', 'deep']],
  ['classification', ['economy', 'economy', 'standard'], ['standard', 'standard', 'deep']],
  ['docs', ['economy', 'economy', 'standard'], ['standard', 'standard', 'deep']],
  ['implementation', ['economy', 'economy', 'standard'], ['standard', 'standard', 'deep']],
  ['review', ['economy', 'standard', 'standard'], ['standard', 'deep', 'deep']],
  ['qa', ['economy', 'standard', 'standard'], ['standard', 'deep', 'deep']],
  ['architecture', ['standard', 'standard', 'deep'], ['deep', 'deep', 'deep']],
];
describe('type × size × capabilityClass × quota table', () => {
  for (const [type, cheap, coding] of typeSizes)
    for (const [i, size] of (['S', 'M', 'L'] as WorkSize[]).entries())
      for (const capability of [
        'fast_cheap',
        'standard_coding',
        'review',
        'test_analysis',
        'high_reasoning',
      ])
        for (const state of ['healthy', 'claude-low', 'codex-low', 'both-low', 'unknown']) {
          it(`${type}/${size}/${capability}/${state}`, () => {
            const requested =
              capability === 'fast_cheap'
                ? cheap[i]
                : capability === 'high_reasoning'
                  ? 'deep'
                  : coding[i];
            const observation = snapshot(
              state === 'claude-low' || state === 'both-low',
              state === 'codex-low' || state === 'both-low',
            );
            if (state === 'unknown') observation.capacities = {};
            const expectedTier =
              requested === 'deep' && state === 'claude-low' ? 'standard' : requested;
            const waiting = state === 'both-low' || (state === 'codex-low' && requested !== 'deep');
            const selected = selectModelTier(
              spec(capability),
              rule,
              policy,
              { workType: type, size },
              observation,
            );
            expect(selected.requestedTier).toBe(requested);
            expect(selected.gate.status).toBe(
              waiting ? 'wait' : state === 'unknown' ? 'probe' : 'go',
            );
            if (waiting) expect(selected.choice).toBeNull();
            else {
              expect(selected.tier).toBe(expectedTier);
              expect(selected.choice).toEqual(
                policy.tiers[expectedTier as keyof typeof policy.tiers]!.candidates[0],
              );
            }
          });
        }
});
it('operator ceiling and override bound hostile repo weights; absent tiers do not exist', () => {
  const hostile = { ...rule, capabilityWeights: { standard_coding: 1000 } };
  expect(
    selectModelTier(
      spec('standard_coding'),
      hostile,
      { ...policy, maxTier: 'economy' },
      { workType: 'architecture', size: 'L' },
      snapshot(),
    ),
  ).toMatchObject({ tier: 'economy', choice: { model: 'test-economy-model' } });
  expect(
    selectModelTier(
      spec('standard_coding'),
      rule,
      { ...policy, tiers: { economy: policy.tiers.economy } },
      {},
      snapshot(),
    ).gate.status,
  ).toBe('wait');
  expect(selectModelTier(spec('unknown'), rule, policy, {}, snapshot()).gate.status).toBe('wait');
});
it('missing either input uses capability only and records fallback', () => {
  for (const inputs of [{}, { workType: 'architecture' as const }, { size: 'L' as const }])
    expect(
      selectModelTier(spec('standard_coding'), rule, policy, inputs, snapshot()),
    ).toMatchObject({ tier: 'standard', reason: expect.stringContaining('fallback:') });
});
it('does not downgrade without role permission or policy edge; returns earliest retry reset', () => {
  expect(
    selectModelTier(spec('high_reasoning', false), rule, policy, {}, snapshot(true, false)),
  ).toMatchObject({ choice: null, downgrades: [], gate: { resetsAt: 300 } });
  const noFallback = structuredClone(policy);
  delete noFallback.tiers.deep!.fallbackTo;
  expect(
    selectModelTier(spec('high_reasoning'), rule, noFallback, {}, snapshot(true, false)).choice,
  ).toBeNull();
  expect(
    selectModelTier(spec('high_reasoning'), rule, policy, {}, snapshot(true, true)),
  ).toMatchObject({ choice: null, downgrades: ['standard', 'economy'], gate: { resetsAt: 200 } });
  const occupied = snapshot();
  occupied.active.claude = 1;
  expect(selectModelTier(spec('high_reasoning'), rule, policy, {}, occupied).downgrades).toEqual(
    [],
  );
});
it('tries candidates in operator order under the same gate; never raises tier', () => {
  const candidates = structuredClone(policy);
  candidates.tiers.standard!.candidates.push({
    executor: 'claude',
    model: 'test-alternative-model',
  });
  expect(
    selectModelTier(spec('standard_coding'), rule, candidates, {}, snapshot(false, true)),
  ).toMatchObject({
    tier: 'standard',
    choice: { executor: 'claude', model: 'test-alternative-model' },
  });
  expect(
    selectModelTier(spec('standard_coding'), rule, policy, {}, snapshot(false, true)).choice,
  ).toBeNull();
});
it('strict config validation rejects unknown tiers, injection and unsupported effort', () => {
  expect(validateModelTiers(policy, () => ['high'])).toEqual(policy);
  for (const effort of ['high"\nfeatures.apps=true', 'bad', 'max']) {
    const invalid = structuredClone(policy);
    invalid.tiers.economy!.candidates[0].effort = effort;
    expect(() => validateModelTiers(invalid, () => ['high'])).toThrow();
  }
  for (const model of [
    '-option',
    'bad model',
    'bad\nmodel',
    'test"model',
    '',
    'test-model\n',
    'test-model\r',
  ]) {
    const invalid = structuredClone(policy);
    invalid.tiers.economy!.candidates[0].model = model;
    expect(() => validateModelTiers(invalid, () => ['high'])).toThrow();
  }
  expect(() => validateModelTiers(policy, () => [])).toThrow('unsupported claude effort');
  expect(() => validateModelTiers({ ...policy, maxTier: 'absent' })).toThrow();
  const invalid = structuredClone(policy);
  invalid.tiers.standard!.fallbackTo = 'deep';
  expect(() => validateModelTiers(invalid, () => ['high'])).toThrow('lower tier');
  delete invalid.tiers.economy;
  invalid.tiers.standard!.fallbackTo = 'economy';
  expect(() => validateModelTiers(invalid, () => ['high'])).toThrow('lower tier');
  expect(() =>
    validateTierRule({ ...rule, thresholds: { economy: 0, standard: 4, deep: 2 } }),
  ).toThrow();
  expect(() =>
    parseProjects({
      test: {
        autonomyLevel: 'A1',
        allowedExecutors: ['codex'],
        modelTiers: { ...policy, maxTier: 'undefined' },
      },
    }),
  ).toThrow('Operator modelTiers');
});

it('detects installed Claude effort support with bounded help only; missing flag or failed probe rejects', () => {
  vi.mocked(execFileSync).mockReturnValue(
    '--effort <level> Effort level (low, medium, high, xhigh, max)',
  );
  expect(claudeEffortSupported('test-cli')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(execFileSync).toHaveBeenCalledWith(
    'test-cli',
    ['--help'],
    expect.objectContaining({
      timeout: 3000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  vi.mocked(execFileSync).mockReturnValue('--model <model>');
  expect(claudeEffortSupported('test-cli')).toEqual([]);
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('test timeout');
  });
  expect(claudeEffortSupported('test-cli')).toEqual([]);
});
