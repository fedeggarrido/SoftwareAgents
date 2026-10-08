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
  for (const name of ['executorSelection', 'quotaGate', 'modelPolicy', 'worker']) {
    const text = fs.readFileSync(path.resolve(__dirname, `../src/${name}.ts`), 'utf8');
    expect(text).not.toMatch(/\b(?:opus|sonnet|haiku|gpt-\d|o[134](?:-|\b)|claude-[123])/i);
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
