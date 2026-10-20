import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { CapacitySnapshot } from '../../core/src/capacity.js';
import { dispatchCli } from '../src/cli.js';
import { selectExecutor } from '../src/executorSelection.js';
import {
  machineCapacityDirectory,
  writeMachineCapacityObservation,
} from '../src/machineCapacity.js';
import { loadModelPolicy } from '../src/modelPolicy.js';
import { parseQuotaArgs, readSelectionSnapshot, runQuotaCheck } from '../src/quotaCommand.js';
import { quotaGate } from '../src/quotaGate.js';
import { parseWorkerArgs } from '../src/worker.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});
const policy = {
  quotaThresholds: { claude: 5, codex: 10 },
  maxConcurrent: { claude: 2, codex: 2 },
};
function capacity(usedRatio: number | null, resetsAt = 200): CapacitySnapshot {
  return {
    provider: 'codex',
    status: 'allowed',
    confidence: 'high',
    source: 'codex_session_log',
    observedAt: 100,
    windows: [{ kind: 'five_hour', usedRatio, resetsAt }],
  };
}
it.each([
  ['below threshold', capacity(0.91), 0, 'wait'],
  ['exact threshold', capacity(0.9), 0, 'go'],
  ['above threshold', capacity(0.89), 0, 'go'],
  ['machine cap', capacity(0.1), 2, 'wait'],
  ['unknown', undefined, 0, 'probe'],
  ['unknown in use', undefined, 1, 'wait'],
  ['unknown ratio', capacity(null), 0, 'probe'],
  ['reset', capacity(1, 100), 0, 'probe'],
  ['old rejected', { ...capacity(1, 5000), status: 'rejected', observedAt: 0 }, 0, 'wait'],
  ['old threshold', { ...capacity(0.99, 5000), observedAt: 0 }, 0, 'wait'],
  ['old favorable', { ...capacity(0.1), observedAt: 0 }, 0, 'probe'],
  ['low confidence', { ...capacity(0.1), confidence: 'low' }, 0, 'probe'],
  ['unknown confidence', { ...capacity(0.1), confidence: 'unknown' }, 0, 'probe'],
  ['low confidence in use', { ...capacity(0.1), confidence: 'low' }, 1, 'wait'],
  ['unknown count', undefined, NaN, 'wait'],
] as const)('%s', (_name, observation, active, status) => {
  expect(quotaGate('codex', policy, observation, active, 100).status).toBe(status);
});
it('reevaluates rejected against every live window instead of waiting for a healthy weekly reset', () => {
  const s = { ...capacity(1, 100), status: 'rejected' as const };
  s.windows.push({ kind: 'weekly', usedRatio: 0.1, resetsAt: 300 });
  expect(quotaGate('codex', policy, s, 0, 100).status).toBe('probe');
  s.windows[1].usedRatio = 1;
  expect(quotaGate('codex', policy, s, 0, 100)).toMatchObject({ status: 'wait', resetsAt: 300 });
});
it('keeps model identifiers out of selection and policy modules; Provider knowledge is allowed', () => {
  // Excluded: providers/hook/claude and its tests need real IDs for contextWindowForModel;
  // docs/research/local-llm.md and ADR-0004 preserve historical benchmark evidence.
  // AgentSpec rejection tests exercise recognition of forbidden families, not selection policy.
  const files = [
    'executorSelection',
    'quotaGate',
    'modelPolicy',
    'worker',
    'modelTiers',
    'modelTierAdmission',
    'taskModelInputs',
    'quotaCommand',
  ].map((name) => path.resolve(__dirname, `../src/${name}.ts`));
  files.push(
    ...fs
      .readdirSync(path.resolve(__dirname, '../src/executors'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.resolve(__dirname, '../src/executors', name)),
    path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
  );
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    expect(text, file).not.toMatch(/\b(?:opus|sonnet|haiku|gpt-\d|o[134](?:-|\b)|claude-[123])/i);
  }
});
it('waits until all blocked windows reset', () => {
  const snapshot = capacity(0.99);
  snapshot.windows.push({ kind: 'weekly', usedRatio: 1, resetsAt: 300 });
  expect(quotaGate('codex', policy, snapshot, 0, 100)).toMatchObject({
    status: 'wait',
    resetsAt: 300,
  });
});
it('rejects missing/invalid authority and mismatched capacity', () => {
  expect(quotaGate('codex', undefined, undefined, 0, 100).status).toBe('wait');
  expect(quotaGate('claude', policy, capacity(0.1), 0, 100).status).toBe('wait');
  expect(quotaGate('codex', policy, capacity(NaN), 0, 100).status).toBe('wait');
  expect(
    quotaGate('codex', { ...policy, maxConcurrent: { codex: 0 } }, undefined, 0, 100).status,
  ).toBe('wait');
});
it('Architect selects first allowed high_reasoning preference, without fallback on wait', () => {
  const agent = parse(
    fs.readFileSync(path.resolve(__dirname, '../../agents/templates/architect.yaml'), 'utf8'),
  ) as AgentSpec;
  const preferences = loadModelPolicy(path.resolve(__dirname, '../..'));
  expect(agent.modelPolicy.capabilityClass).toBe('high_reasoning');
  const snapshot = {
    allowedExecutors: ['codex'],
    machinePolicy: policy,
    capacities: {},
    active: { codex: 0 },
    nowS: 100,
  };
  expect(selectExecutor(agent, preferences, snapshot).choice?.executor).toBe('codex');
  const result = selectExecutor(agent, preferences, {
    ...snapshot,
    allowedExecutors: ['claude', 'codex'],
    active: { claude: 2 },
  });
  expect(result.choice?.executor).toBe('claude');
  expect(result.gate.status).toBe('wait');
  expect(result.alternatives.map((p) => p.executor)).toEqual(['codex']);
  expect(
    selectExecutor(agent, preferences, { ...snapshot, allowedExecutors: [] }).choice,
  ).toBeNull();
});
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-'));
  vi.stubEnv('HOME', root);
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  fs.mkdirSync(path.join(root, '.softwareagents/agents'), { recursive: true });
  fs.copyFileSync(
    path.resolve(__dirname, '../../.softwareagents/project.yaml'),
    path.join(root, '.softwareagents/project.yaml'),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function writeOperator() {
  const project = parse(
    fs.readFileSync(path.join(root, '.softwareagents/project.yaml'), 'utf8'),
  ) as { id: string };
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        [project.id]: {
          autonomyLevel: 'A1',
          allowedExecutors: ['codex'],
          quotaThresholds: policy.quotaThresholds,
          concurrency: { maxExecutions: 2, perExecutor: policy.maxConcurrent },
        },
        other: {
          autonomyLevel: 'A1',
          allowedExecutors: ['codex'],
          concurrency: { maxExecutions: 1, perExecutor: { codex: 1 } },
        },
      },
    }),
  );
}
let sequence = 0;
function observation(
  cap?: CapacitySnapshot,
  sessions: string[] = [],
  observedAt = Date.now() / 1000,
) {
  writeMachineCapacityObservation(
    {
      observedAt,
      publisher: { id: 'test', bootId: 'test', pid: process.pid, sequence: ++sequence },
      coverage: { scope: 'office', workspaces: [root], source: 'office_store' },
      sessions: { claude: [], codex: sessions },
      capacities: cap ? { codex: cap } : {},
    },
    path.join(machineCapacityDirectory(), 'test.json'),
  );
}
it('CLI returns 0 for probe and 3 for wait with a JSON reason; role grants nothing', () => {
  writeOperator();
  const args = parseQuotaArgs(['check', '--executor', 'codex', '--role', 'architect', '--json']);
  const log = vi.fn();
  expect(runQuotaCheck(args, root, log)).toBe(0);
  observation();
  expect(runQuotaCheck(args, root, log)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
    status: 'probe',
    concurrencyLimit: 1,
    reason: expect.any(String),
  });
  expect(runQuotaCheck({ ...args, executor: 'claude' }, root, log)).toBe(3);
  observation(undefined, ['observed']);
  expect(runQuotaCheck(args, root, log)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
    active: 0,
    coverage: { scope: 'runtime_slots', counts: { codex: { observedSessions: 1 } } },
  });
  observation(undefined, ['observed'], 0);
  expect(runQuotaCheck(args, root, log)).toBe(0);
});
it('uses the strictest machine executor cap across projects', () => {
  writeOperator();
  expect(
    readSelectionSnapshot({ autonomyLevel: 'A1', allowedExecutors: ['codex'] }).machinePolicy
      ?.maxConcurrent.codex,
  ).toBe(1);
});
it('dispatches quota to CLI exit codes and returns known quota go/wait', async () => {
  writeOperator();
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  try {
    const args = ['quota', 'check', '--executor', 'codex', '--role', 'developer', '--json'];
    const now = Date.now() / 1000;
    const snapshot = { ...capacity(0.5, now + 300), observedAt: now };
    observation(snapshot);
    await dispatchCli(args);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
      status: 'go',
      reason: expect.any(String),
    });
    snapshot.windows[0].usedRatio = 0.99;
    observation(snapshot);
    await dispatchCli(args);
    expect(process.exitCode).toBe(3);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
      status: 'wait',
      resetsAt: now + 300,
    });
    observation({ ...snapshot, status: 'rejected', observedAt: now - 61 });
    await dispatchCli(args);
    expect(process.exitCode).toBe(3);
    observation({ ...capacity(0.1, now + 300), observedAt: now - 61 });
    await dispatchCli(args);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).status).toBe('probe');
    observation({ ...capacity(0.1, now + 300), observedAt: now, confidence: 'low' });
    await dispatchCli(args);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).status).toBe('probe');
  } finally {
    process.exitCode = previousExitCode;
    cwd.mockRestore();
    log.mockRestore();
  }
});
it('rejects authority in model preferences and duplicate/invalid CLI options', () => {
  fs.writeFileSync(
    path.join(root, '.softwareagents/agents/model-policy.yaml'),
    'allowedExecutors: [codex]',
  );
  expect(() => loadModelPolicy(root)).toThrow();
  for (const args of [
    [],
    ['check'],
    ['check', '--executor', 'other', '--role', 'developer'],
    ['check', '--executor', 'codex', '--role', 'x', '--json', '--json'],
  ])
    expect(() => parseQuotaArgs(args)).toThrow();
  expect(
    parseWorkerArgs(['run', '--select-executor', '--task', 'SA-036', '--brief', 'brief.md']),
  ).toMatchObject({ selectExecutor: true });
});
it('explains tiers without launch, with SA-036 exit codes and operator override', () => {
  writeOperator();
  const configFile = path.join(root, '.pixel-agents/config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const rule = parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
      'utf8',
    ),
  ).tierRule;
  config.projects[Object.keys(config.projects)[0]].modelTiers = {
    maxTier: 'standard',
    rule,
    tiers: {
      standard: {
        candidates: [{ executor: 'codex', model: 'test-standard-model', effort: 'medium' }],
      },
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const args = parseQuotaArgs([
    'check',
    '--select-executor',
    '--role',
    'developer',
    '--work-type',
    'architecture',
    '--size',
    'L',
    '--json',
  ]);
  const log = vi.fn();
  expect(runQuotaCheck(args, root, log)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
    status: 'probe',
    tier: 'standard',
    requestedTier: 'deep',
    executor: 'codex',
    model: 'test-standard-model',
    effort: 'medium',
    downgrades: [],
  });
  const now = Date.now() / 1000;
  expect(runQuotaCheck({ ...args, role: 'qa', workType: 'qa', size: 'M' }, root, log)).toBe(3);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
    role: 'qa',
    tier: 'standard',
    status: 'wait',
    executor: null,
    model: null,
    effort: null,
    reason: expect.stringContaining('code_execution_not_mediated'),
  });
  observation({ ...capacity(1, now + 100), observedAt: now });
  expect(runQuotaCheck(args, root, log)).toBe(3);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
    status: 'wait',
    resetsAt: now + 100,
  });
  expect(fs.existsSync(path.join(root, '.worktrees'))).toBe(false);
  for (const extra of [
    ['--work-type', 'bad'],
    ['--size', 'XL'],
    ['--executor', 'codex'],
  ])
    expect(() =>
      parseQuotaArgs(['check', '--select-executor', '--role', 'developer', ...extra]),
    ).toThrow();
});

it('reports strict explicit total caps, with zero waiting and missing caps ignored', () => {
  writeOperator();
  const file = path.join(root, '.pixel-agents/config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete config.projects.other.concurrency.maxExecutions;
  const project = Object.keys(config.projects)[0];
  config.projects[project].concurrency.maxExecutions = 0;
  config.projects[project].modelTiers = {
    rule: parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
        'utf8',
      ),
    ).tierRule,
    maxTier: 'standard',
    tiers: {
      standard: { candidates: [{ executor: 'codex', model: 'test-model' }] },
      deep: {
        candidates: [{ executor: 'claude', model: 'test-unreachable-model', effort: 'high' }],
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config));
  const log = vi.fn();
  for (const args of [{ executor: 'codex' as const }, { selectExecutor: true }]) {
    expect(runQuotaCheck({ ...args, role: 'developer', json: true }, root, log)).toBe(3);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
      status: 'wait',
      maxExecutions: 0,
      activeTotal: 0,
      reason: expect.stringContaining('Total runtime concurrency limit 0'),
    });
  }
  delete config.projects[project].concurrency.maxExecutions;
  fs.writeFileSync(file, JSON.stringify(config));
  expect(runQuotaCheck({ executor: 'codex', role: 'developer', json: true }, root, log)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
    maxExecutions: null,
    activeTotal: 0,
  });
});

it('documents system behavior without stale integration status and explains manual Task fallback', () => {
  const selection = fs.readFileSync(
    path.resolve(__dirname, '../../docs/executor-selection.md'),
    'utf8',
  );
  expect(selection).not.toContain('siguen pendientes de Claude');
  expect(selection).not.toContain(
    'si alguno carece de tope expl' + String.fromCharCode(237) + 'cito, el gate espera',
  );
  for (const doc of ['executor-selection.md', 'worker-run.md']) {
    const text = fs.readFileSync(path.resolve(__dirname, '../../docs', doc), 'utf8');
    for (const term of ['maxExecutions', 'DRAFT', 'unknown', 'fallback'])
      expect(text).toContain(term);
  }
});
