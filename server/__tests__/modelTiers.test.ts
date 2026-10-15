import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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
  resolveClaudeBinary,
  selectModelTier,
  validateModelTiers,
  validateModelTierSupport,
  validateTierRule,
} from '../src/modelTiers.js';
import { quotaGate } from '../src/quotaGate.js';

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

it('explicit eval selection keeps executor/tier exact under quota and never falls back', () => {
  const input = { evaluation: { executor: 'claude' as const, tier: 'deep' as const } };
  expect(selectModelTier(spec('standard_coding'), rule, policy, input, snapshot())).toMatchObject({
    tier: 'deep',
    choice: { executor: 'claude' },
    downgrades: [],
  });
  expect(
    selectModelTier(spec('standard_coding'), rule, policy, input, snapshot(true)),
  ).toMatchObject({
    tier: 'deep',
    choice: null,
    gate: { status: 'wait', cause: 'quota' },
    downgrades: [],
  });
  expect(() =>
    selectModelTier(
      spec('standard_coding'),
      rule,
      { ...policy, maxTier: 'economy' },
      input,
      snapshot(),
    ),
  ).toThrow('maxTier');
});
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
it('validates strict Operator default verifiers and safe related commands', () => {
  const cascade = {
    enabled: true,
    startTier: 'economy',
    maxEscalations: 1,
    verifiers: {},
    defaultVerifier: { commands: [{ vitestRelated: true, timeoutMs: 60000 }] },
  };
  expect(validateModelTiers({ ...policy, cascade }).cascade).toEqual(cascade);
  for (const defaultVerifier of [
    { ...cascade.defaultVerifier, allowedPaths: ['server/src/example.ts'] },
    { commands: [] },
    { commands: [{ vitestRelated: false, timeoutMs: 1000 }] },
    { commands: [{ vitestRelated: true, argv: ['node'], timeoutMs: 1000 }] },
    { commands: [{ vitestRelated: true, files: ['from-board.ts'], timeoutMs: 1000 }] },
    { commands: [{ vitestRelated: true, timeoutMs: 60001 }] },
    { commands: [{ argv: ['node'], timeoutMs: 0 }] },
    { commands: [{ argv: ['node'] }] },
    { commands: [{ argv: ['node', 'bad\nargument'], timeoutMs: 1000 }] },
  ])
    expect(() =>
      validateModelTiers({ ...policy, cascade: { ...cascade, defaultVerifier } }),
    ).toThrow();
});
it('cascade attempts wait at the exact tier under quota, never downgrade or exceed maxTier', () => {
  expect(
    selectModelTier(spec('standard_coding'), rule, policy, { cascadeTier: 'deep' }, snapshot(true)),
  ).toMatchObject({
    tier: 'deep',
    choice: null,
    gate: { status: 'wait', cause: 'quota' },
    downgrades: [],
  });
  expect(() =>
    selectModelTier(
      spec('standard_coding'),
      rule,
      { ...policy, maxTier: 'standard' },
      { cascadeTier: 'deep' },
      snapshot(),
    ),
  ).toThrow('maxTier');
  const excluded = snapshot();
  excluded.executorLevels = { claude: [] };
  expect(
    selectModelTier(spec('standard_coding'), rule, policy, { cascadeTier: 'deep' }, excluded),
  ).toMatchObject({ choice: null, block: { code: 'no_allowed_level' }, downgrades: [] });
});
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
// Expectations use the real repository policy above, with independent calibrated outcomes.
const typeSizes: [WorkType, string[], string[], string[], string[]][] = [
  [
    'summary',
    ['economy', 'economy', 'economy'],
    ['economy', 'standard', 'standard'],
    ['economy', 'economy', 'standard'],
    ['standard', 'standard', 'deep'],
  ],
  [
    'classification',
    ['economy', 'economy', 'economy'],
    ['economy', 'standard', 'standard'],
    ['economy', 'economy', 'standard'],
    ['standard', 'standard', 'deep'],
  ],
  [
    'docs',
    ['economy', 'economy', 'economy'],
    ['economy', 'standard', 'standard'],
    ['economy', 'economy', 'standard'],
    ['standard', 'standard', 'deep'],
  ],
  [
    'implementation',
    ['economy', 'economy', 'standard'],
    ['standard', 'standard', 'standard'],
    ['economy', 'standard', 'standard'],
    ['standard', 'deep', 'deep'],
  ],
  [
    'review',
    ['economy', 'economy', 'standard'],
    ['standard', 'standard', 'standard'],
    ['economy', 'standard', 'standard'],
    ['standard', 'deep', 'deep'],
  ],
  [
    'qa',
    ['economy', 'economy', 'standard'],
    ['standard', 'standard', 'standard'],
    ['economy', 'standard', 'standard'],
    ['standard', 'deep', 'deep'],
  ],
  [
    'architecture',
    ['standard', 'standard', 'standard'],
    ['standard', 'deep', 'deep'],
    ['standard', 'standard', 'deep'],
    ['deep', 'deep', 'deep'],
  ],
];
describe('type × size × capabilityClass × quota table', () => {
  for (const [type, cheap, coding, qa, reasoning] of typeSizes)
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
                  ? reasoning[i]
                  : capability === 'test_analysis'
                    ? qa[i]
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
  expect(() => selectModelTier(spec('unknown'), rule, policy, {}, snapshot())).toThrow(
    'missing capabilityClass unknown',
  );
});
it('missing either input replaces both with declarative fallback and records it', () => {
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
  expect(validateModelTiers(policy)).toEqual(policy);
  for (const effort of ['high"\nfeatures.apps=true', 'bad', 'max']) {
    const invalid = structuredClone(policy);
    invalid.tiers.economy!.candidates[0].effort = effort;
    expect(() => validateModelTiers(invalid)).toThrow();
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
    expect(() => validateModelTiers(invalid)).toThrow();
  }
  expect(() => validateModelTierSupport(policy, 'no-effort-cli')).toThrow(
    'unsupported claude effort',
  );
  expect(() => validateModelTiers({ ...policy, maxTier: 'absent' })).toThrow();
  const invalid = structuredClone(policy);
  invalid.tiers.standard!.fallbackTo = 'deep';
  expect(() => validateModelTiers(invalid)).toThrow('lower tier');
  delete invalid.tiers.economy;
  invalid.tiers.standard!.fallbackTo = 'economy';
  expect(() => validateModelTiers(invalid)).toThrow('lower tier');
  expect(() =>
    validateTierRule({ ...rule, thresholds: { economy: 0, standard: 4, deep: 2 } }),
  ).toThrow();
  expect(
    parseProjects({
      test: {
        autonomyLevel: 'A1',
        allowedExecutors: ['codex'],
        modelTiers: { ...policy, maxTier: 'undefined' },
      },
    }),
  ).toEqual({});
});

it('detects installed Claude effort support with bounded help only; missing flag or failed probe rejects', () => {
  vi.mocked(execFileSync).mockReturnValue(
    '--effort <level> Effort level (low, medium, high, xhigh, max)',
  );
  expect(claudeEffortSupported('test-cli')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  const calls = vi.mocked(execFileSync).mock.calls.length;
  expect(claudeEffortSupported('test-cli')).toContain('high');
  expect(vi.mocked(execFileSync).mock.calls.length).toBe(calls);
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
  expect(claudeEffortSupported('no-effort-cli-2')).toEqual([]);
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('test timeout');
  });
  expect(claudeEffortSupported('failed-cli')).toEqual([]);
});

it('defaults absent fallback to implementation/M and validates declared fallback', () => {
  const { fallback, ...oldRule } = rule;
  expect(validateTierRule(oldRule)).toEqual(oldRule);
  for (const [capability, tier] of [
    ['standard_coding', 'standard'],
    ['test_analysis', 'standard'],
    ['high_reasoning', 'deep'],
  ]) {
    expect(selectModelTier(spec(capability), oldRule, policy, {}, snapshot()).tier).toBe(tier);
  }
  const override = { ...rule, fallback: { workType: 'docs' as const, size: 'S' as const } };
  expect(
    selectModelTier(spec('standard_coding'), override, policy, { size: 'L' }, snapshot()),
  ).toMatchObject({
    tier: 'economy',
    reason: expect.stringContaining('fallback: missing or invalid work type/size, docs/S'),
  });
  for (const fallback of [
    { workType: 'bad', size: 'M' },
    { workType: 'docs' },
    { workType: 'qa', size: 'XL' },
    { workType: 'qa', size: 'S', model: 'bad' },
  ])
    expect(() => validateTierRule({ ...rule, fallback })).toThrow();
});
it('parses Claude catalogues without a help probe, even with no PATH binary', () => {
  vi.mocked(execFileSync).mockClear();
  const parsed = parseProjects({
    test: {
      autonomyLevel: 'A1',
      allowedExecutors: ['claude'],
      binaryPaths: { claude: 'missing-cli' },
      modelTiers: policy,
    },
  });
  expect(parsed.test.modelTiers).toEqual(policy);
  expect(execFileSync).not.toHaveBeenCalled();
});
it('quota gate distinguishes quota from concurrency and invalid observations structurally', () => {
  const s = snapshot(true);
  expect(quotaGate('claude', s.machinePolicy, s.capacities.claude, 0, 100)).toMatchObject({
    status: 'wait',
    cause: 'quota',
  });
  expect(quotaGate('claude', s.machinePolicy, s.capacities.claude, 1, 100)).toMatchObject({
    status: 'wait',
    cause: 'concurrency',
  });
  expect(quotaGate('claude', undefined, undefined, 0, 100)).toMatchObject({
    status: 'wait',
    cause: 'configuration',
  });
});
it('default PATH resolution and explicit paths share one support probe for the same binary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-binary-'));
  const binary = path.join(
    directory,
    process.platform === 'win32' ? 'tier-claude.exe' : 'tier-claude',
  );
  const originalPath = process.env.PATH;
  try {
    fs.writeFileSync(binary, 'synthetic executable', { mode: 0o700 });
    if (process.platform === 'win32')
      fs.writeFileSync(path.join(directory, 'tier-claude'), 'npm shell shim');
    process.env.PATH = process.platform === 'win32' ? `"${directory}"` : directory;
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockReturnValue('--effort <level> Effort (high)');
    expect(resolveClaudeBinary('tier-claude')).toBe(fs.realpathSync.native(binary));
    expect(claudeEffortSupported('tier-claude')).toEqual(['high']);
    expect(claudeEffortSupported(binary)).toEqual(['high']);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      fs.realpathSync.native(binary),
      ['--help'],
      expect.any(Object),
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('probes only reachable and allowed Claude tiers, including explicit fallback edges', () => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('synthetic unavailable CLI');
  });
  const capped = { ...policy, maxTier: 'standard' as const };
  expect(() =>
    validateModelTierSupport(capped, 'unreachable-cli', spec('standard_coding'), rule, {}, [
      'codex',
    ]),
  ).not.toThrow();
  expect(() =>
    validateModelTierSupport(policy, 'unreachable-cli', spec('standard_coding'), rule, {}, [
      'claude',
      'codex',
    ]),
  ).not.toThrow();
  expect(execFileSync).not.toHaveBeenCalled();
  expect(() =>
    validateModelTierSupport(policy, 'reachable-cli', spec('high_reasoning'), rule, {}, [
      'claude',
      'codex',
    ]),
  ).toThrow('unsupported claude effort');
  const viaFallback = structuredClone(policy);
  viaFallback.tiers.economy!.candidates = [
    { executor: 'claude', model: 'test-small-model', effort: 'high' },
  ];
  expect(() =>
    validateModelTierSupport(viaFallback, 'fallback-cli', spec('standard_coding'), rule, {}, [
      'claude',
      'codex',
    ]),
  ).toThrow('unsupported claude effort');
  expect(() =>
    validateModelTierSupport(
      viaFallback,
      'unused-fallback-cli',
      spec('standard_coding', false),
      rule,
      {},
      ['claude', 'codex'],
    ),
  ).not.toThrow();
});
it.each([0, 1])('total limit %s blocks all executors without quota downgrade', (maxExecutions) => {
  const state = snapshot(true, false);
  state.machinePolicy!.maxExecutions = maxExecutions;
  state.active.claude = maxExecutions;
  expect(selectModelTier(spec('high_reasoning'), rule, policy, {}, state)).toMatchObject({
    choice: null,
    downgrades: [],
    gate: { status: 'wait', cause: 'concurrency' },
  });
});

it.each([{ levels: [] }, { levels: ['economy'] }] as const)(
  'skips effort validation for Claude levels $levels but validates an allowed tier',
  ({ levels }) => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockReturnValue('--model <model>');
    const candidates: ModelTierPolicy = {
      maxTier: 'standard',
      tiers: {
        standard: {
          candidates: [
            { executor: 'claude', model: 'test-claude', effort: 'high' },
            { executor: 'codex', model: 'test-codex', effort: 'medium' },
          ],
        },
      },
    };
    const state = snapshot();
    state.executorLevels = { claude: levels };
    const validate = () =>
      validateModelTierSupport(
        candidates,
        'level-filtered-cli',
        spec('standard_coding'),
        rule,
        {},
        state.allowedExecutors,
        state.executorLevels,
      );
    expect(validate).not.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(selectModelTier(spec('standard_coding'), rule, candidates, {}, state)).toMatchObject({
      choice: { executor: 'codex' },
      tier: 'standard',
      downgrades: [],
    });
    state.executorLevels.codex = [];
    expect(validate).not.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(selectModelTier(spec('standard_coding'), rule, candidates, {}, state)).toMatchObject({
      choice: null,
      block: { code: 'no_allowed_level' },
      downgrades: [],
    });
    state.executorLevels.claude = ['standard'];
    expect(validate).toThrow('unsupported claude effort');
  },
);
