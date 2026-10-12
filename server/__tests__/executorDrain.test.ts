import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { ModelTierPolicy, TierRule } from '../../core/src/modelTier.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { AuditLog } from '../src/auditLog.js';
import {
  availabilityDecisionKey,
  closeAvailabilityDecisions,
  escalateUnavailable,
} from '../src/executorAvailability.js';
import {
  EXECUTOR_PROBE_CATALOG,
  type ExecutorObservation,
  observeExecutors,
} from '../src/executorProbes.js';
import {
  launchBlock,
  selectExecutor,
  selectionBlock,
  type SelectionSnapshot,
} from '../src/executorSelection.js';
import { buildExecutorState } from '../src/executorState.js';
import { selectModelTier } from '../src/modelTiers.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import { readyProbeFor } from './helpers/readyProbe.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

const rule: TierRule = parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
    'utf8',
  ),
).tierRule;
const ready = (over: Partial<ExecutorObservation> = {}): ExecutorObservation => ({
  installation: 'ready',
  version: '99.0.0',
  authentication: 'ready',
  checkedAt: 90,
  staleAfter: 210,
  ...over,
});
const snapshot = (over: Partial<SelectionSnapshot> = {}): SelectionSnapshot => ({
  allowedExecutors: ['claude', 'codex'],
  machinePolicy: {
    quotaThresholds: { claude: 10, codex: 10 },
    maxConcurrent: { claude: 1, codex: 1 },
  },
  capacities: {},
  active: { claude: 0, codex: 0 },
  nowS: 100,
  ...over,
});
const developer = {
  identity: { role: 'developer' },
  modelPolicy: { capabilityClass: 'standard_coding', fallbackAllowed: true },
} as AgentSpec;
const preferences = {
  standard_coding: [{ executor: 'claude' as const }, { executor: 'codex' as const }],
};

describe('launch rule (SA-090)', () => {
  it.each([
    ['not observed', undefined, 'probe_unknown', false],
    ['missing', ready({ installation: 'missing' }), 'not_installed', true],
    ['unsupported', ready({ installation: 'unsupported' }), 'unsupported_version', true],
    ['logged out', ready({ authentication: 'required' }), 'auth_required', true],
    ['installation unknown', ready({ installation: 'unknown' }), 'probe_unknown', false],
    ['stale', ready({ staleAfter: 99 }), 'probe_stale', false],
  ] as const)('%s → %s', (_name, observation, code, needsOperator) => {
    expect(launchBlock(observation, 100)).toEqual({ code, needsOperator });
  });
  it('verified binary with unknown authentication may launch; office reads ignore freshness', () => {
    expect(launchBlock(ready({ authentication: 'unknown' }), 100)).toBeUndefined();
    expect(launchBlock(ready({ staleAfter: 0 }))).toBeUndefined();
  });
  it('the worker probes only what it is given, through the same parsing as the monitor', async () => {
    const seen: string[] = [];
    const observed = await observeExecutors(
      ['claude', 'claude'],
      { binaryPaths: { claude: process.execPath } },
      async (file, args) => {
        seen.push([file, ...args].join(' '));
        return readyProbeFor(EXECUTOR_PROBE_CATALOG)(file, args);
      },
    );
    expect(Object.keys(observed)).toEqual(['claude']);
    expect(observed.claude).toMatchObject({ installation: 'ready', authentication: 'ready' });
    expect(seen.every((line) => line.startsWith(fs.realpathSync(process.execPath)))).toBe(true);
    expect(seen).toHaveLength(3); // version, help, auth status: one binary, once
  });
});

describe('SA-036 selector with availability', () => {
  it('without observations nothing is filtered (quota check, office)', () => {
    expect(selectExecutor(developer, preferences, snapshot()).choice?.executor).toBe('claude');
  });
  it('a proven problem excludes the candidate and the next preference is chosen', () => {
    const result = selectExecutor(
      developer,
      preferences,
      snapshot({ availability: { claude: ready({ installation: 'missing' }), codex: ready() } }),
    );
    expect(result.choice?.executor).toBe('codex');
    expect(result.exclusions).toEqual([{ executor: 'claude', code: 'not_installed' }]);
    expect(result.reason).toContain('excluded claude: not_installed');
  });
  it('an unproven installation waits on the first preference without falling back', () => {
    const result = selectExecutor(
      developer,
      preferences,
      snapshot({ availability: { claude: ready({ installation: 'unknown' }), codex: ready() } }),
    );
    expect(result.choice?.executor).toBe('claude');
    expect(result.gate).toMatchObject({ status: 'wait', cause: 'availability' });
    expect(result.block).toBeUndefined();
  });
  it('an Executor missing from present observations is unproven, never launched', () => {
    const result = selectExecutor(
      developer,
      { standard_coding: [{ executor: 'codex' as const }] },
      snapshot({ availability: {} }),
    );
    expect(result.gate).toMatchObject({ status: 'wait', cause: 'availability' });
  });
  it.each([
    ['all disabled', { allowedExecutors: [] }, preferences, 'no_enabled_executor'],
    ['no preference', {}, {}, 'no_allowed_level'],
    [
      'enabled one not installed',
      {
        allowedExecutors: ['codex'],
        availability: { codex: ready({ installation: 'missing' }) },
      },
      preferences,
      'not_installed',
    ],
  ] as const)('%s blocks with %s', (_name, over, prefs, code) => {
    const result = selectExecutor(developer, prefs, snapshot(over));
    expect(result.choice).toBeNull();
    expect(result.block?.code).toBe(code);
    expect(result.gate).toMatchObject({ status: 'wait', cause: 'disabled' });
  });
});

describe('SA-084 tiers with availability', () => {
  const tiers: ModelTierPolicy = {
    maxTier: 'standard',
    tiers: {
      economy: { candidates: [{ executor: 'codex', model: 'test-economy-model' }] },
      standard: {
        candidates: [
          { executor: 'claude', model: 'test-standard-model' },
          { executor: 'codex', model: 'test-standard-alternative' },
        ],
        fallbackTo: 'economy',
      },
    },
  };
  const select = (over: Partial<SelectionSnapshot>) =>
    selectModelTier(
      developer,
      rule,
      tiers,
      { workType: 'implementation', size: 'M' },
      snapshot(over),
    );
  it('skips a logged-out candidate for the next one in the same tier', () => {
    const result = select({
      availability: { claude: ready({ authentication: 'required' }), codex: ready() },
    });
    expect(result).toMatchObject({ tier: 'standard', choice: { executor: 'codex' } });
    expect(result.exclusions).toEqual([
      { executor: 'claude', tier: 'standard', code: 'auth_required' },
    ]);
  });
  it('an unproven candidate waits and never downgrades the tier', () => {
    const result = select({
      allowedExecutors: ['claude'],
      availability: { claude: ready({ installation: 'unknown' }) },
    });
    expect(result.choice).toBeNull();
    expect(result.downgrades).toEqual([]);
    expect(result.gate.cause).toBe('availability');
    expect(result.block).toBeUndefined();
  });
  it('every candidate excluded blocks; the technical cause wins over a disable', () => {
    expect(select({ allowedExecutors: [] }).block?.code).toBe('no_enabled_executor');
    expect(
      select({
        allowedExecutors: ['codex'],
        availability: { codex: ready({ installation: 'unsupported' }) },
      }).block,
    ).toMatchObject({ code: 'unsupported_version' });
  });
  it('quota and concurrency waits are never a block', () => {
    expect(select({ active: { claude: 1, codex: 1 } }).block).toBeUndefined();
    expect(selectionBlock(2, true, [{ executor: 'claude', code: 'operator_disabled' }])).toBe(
      undefined,
    );
  });
});

it('office eligibility follows the launch rule; unobserved and unknown auth only flag', () => {
  const operator: ProjectOperatorConfig = {
    autonomyLevel: 'A1',
    allowedExecutors: ['claude', 'codex'],
    quotaThresholds: { claude: 10, codex: 10 },
    concurrency: { maxExecutions: 2, perExecutor: { claude: 1, codex: 1 } },
  };
  const state = (claude: ExecutorObservation | undefined) =>
    buildExecutorState({
      projectId: 'test',
      operator,
      snapshot: snapshot(),
      sequence: 1,
      canManage: false,
      nowS: 100,
      observations: claude ? { claude } : {},
    }).executors.find((e) => e.executorId === 'claude')!;
  expect(state(undefined)).toMatchObject({
    eligible: true,
    reasonCodes: ['quota_unknown', 'probe_unknown'],
  });
  expect(state(ready({ authentication: 'unknown' })).eligible).toBe(true);
  expect(state(ready({ installation: 'unknown' }))).toMatchObject({
    eligible: false,
    reasonCodes: expect.arrayContaining(['probe_unknown']),
  });
  expect(state(ready({ installation: 'missing' })).eligible).toBe(false);
});

describe('deduplicated WAITING_HUMAN (SA-090)', () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    vi.stubEnv('HOME', root);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const block = { code: 'no_enabled_executor' as const, exclusions: [] };

  it('one decision per scope and cause; closing restores only its own Tasks', async () => {
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      store.createTask({ key: 'SA-100', type: 'implementation', status: 'READY' });
      const first = await escalateUnavailable(store, 'A1', 'SA-100', 'tier:standard', block, 'e1');
      const again = await escalateUnavailable(store, 'A1', 'SA-101', 'tier:standard', block, 'e2');
      expect(first.created).toBe(true);
      expect(again).toEqual({ decisionId: first.decisionId, created: false });
      expect(store.getTask('SA-100')?.status).toBe('WAITING_HUMAN');
      // The second Task is not invented as blocked: it keeps waiting through its run.
      expect(store.getTask('SA-101')).toBeUndefined();
      const other = await escalateUnavailable(store, 'A1', 'SA-102', 'tier:deep', block, 'e3');
      expect(other.created).toBe(true);
      expect(store.getTask('SA-102')).toMatchObject({ status: 'WAITING_HUMAN', type: 'unknown' });
      const decision = store.listDecisions().find((d) => d.id === first.decisionId)!;
      expect(decision.context.split('\n')[0]).toBe(
        availabilityDecisionKey('tier:standard', 'no_enabled_executor'),
      );
      expect(decision).toMatchObject({ requestedBy: 'system', blocks: ['SA-100'] });

      expect(await closeAvailabilityDecisions(store, 'tier:standard', 'e4')).toEqual([
        first.decisionId,
      ]);
      expect(store.getTask('SA-100')?.status).toBe('READY');
      expect(store.getTask('SA-102')?.status).toBe('WAITING_HUMAN');
      expect(await closeAvailabilityDecisions(store, 'tier:standard', 'e5')).toEqual([]);
      const statuses = new AuditLog()
        .read('test')
        .map((r) => (r.corrupt ? 'corrupt' : `${r.entry.actorType}:${r.entry.outcome.status}`));
      expect(statuses).toEqual([
        'system:availability_blocked',
        'system:availability_blocked',
        'system:availability_restored_pending',
        'system:availability_restored',
      ]);
    } finally {
      store.close();
    }
  });
  it('never closes Human Decisions it did not open', async () => {
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      store.createTask({ key: 'SA-200', type: 'implementation', status: 'READY' });
      await store.openDecision({
        id: 'other',
        context: 'executor-availability-like/tier:standard/no_enabled_executor',
        options: [{ id: 'ok', label: 'ok', benefit: 'b', cost: 'c', risk: 'r' }],
        recommendation: 'r',
        disagreement: [],
        impact: 'i',
        urgency: 'low',
        requestedBy: 'system',
        blocks: ['SA-200'],
      });
      expect(await closeAvailabilityDecisions(store, 'tier:standard', 'e1')).toEqual([]);
      expect(store.getTask('SA-200')?.status).toBe('WAITING_HUMAN');
    } finally {
      store.close();
    }
  });
});
