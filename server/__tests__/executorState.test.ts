import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { EXECUTOR_IDS, type ExecutorId } from '../../core/src/executorCatalog.js';
import type { ExecutorId as WireExecutorId } from '../../core/src/messages.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { configureCompanyControl } from '../src/companyControl.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import type { SelectionSnapshot } from '../src/executorSelection.js';
import {
  buildExecutorState,
  clientWantsExecutorControls,
  operatorRevision,
  parseRequestExecutorState,
  parseSetExecutorEnabled,
} from '../src/executorState.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

// Compile-time: the generated wire enum and the core catalog are the same set.
const sameIds: [ExecutorId] extends [WireExecutorId]
  ? [WireExecutorId] extends [ExecutorId]
    ? true
    : never
  : never = true;

const operator = (over: Partial<ProjectOperatorConfig> = {}): ProjectOperatorConfig => ({
  autonomyLevel: 'A1',
  allowedExecutors: ['codex'],
  quotaThresholds: { claude: 10, codex: 10 },
  concurrency: { maxExecutions: 2, perExecutor: { claude: 1, codex: 1 } },
  ...over,
});
const snapshot = (over: Partial<SelectionSnapshot> = {}): SelectionSnapshot => ({
  allowedExecutors: ['codex'],
  machinePolicy: {
    quotaThresholds: { claude: 10, codex: 10 },
    maxConcurrent: { claude: 1, codex: 1 },
    maxExecutions: 2,
  },
  capacities: {},
  active: { claude: 0, codex: 0 },
  nowS: 1000,
  ...over,
});
const valid = {
  type: 'setExecutorEnabled',
  projectId: 'test',
  executorId: 'claude',
  enabled: false,
  requestId: 'req-1',
  expectedRevision: 'r1',
};

describe('executor catalog and contract', () => {
  it('the AsyncAPI ExecutorId enum lists exactly the core catalog', () => {
    expect(sameIds).toBe(true);
    const yaml = parse(
      fs.readFileSync(path.resolve(__dirname, '../../core/asyncapi.yaml'), 'utf8'),
    ) as { components: { schemas: Record<string, { enum?: string[] }> } };
    expect(yaml.components.schemas.ExecutorId.enum).toEqual([...EXECUTOR_IDS]);
  });

  it('accepts only the exact setExecutorEnabled shape', () => {
    expect(parseSetExecutorEnabled(valid)).toEqual({ ok: true, msg: valid });
    for (const bad of [
      { ...valid, enabled: 'false' },
      { ...valid, enabled: undefined },
      { ...valid, extra: 1 },
      { ...valid, actor: 'human' },
      { ...valid, requestId: 'x'.repeat(129) },
      { ...valid, expectedRevision: '' },
      { ...valid, projectId: '../other' },
      { ...valid, projectId: 'Test' },
    ])
      expect(parseSetExecutorEnabled(bad as Record<string, unknown>)).toMatchObject({
        ok: false,
        errorCode: 'invalid_request',
      });
  });

  it('reflects only bounded, well-typed fields and names unknown executors', () => {
    expect(parseSetExecutorEnabled({ ...valid, executorId: 'codex-local' })).toEqual({
      ok: false,
      errorCode: 'unknown_executor',
      echo: { projectId: 'test', executorId: 'codex-local', requestId: 'req-1' },
    });
    expect(parseSetExecutorEnabled({ ...valid, requestId: 7 })).toEqual({
      ok: false,
      errorCode: 'invalid_request',
    });
    // Over-long ids are unknown executors too, but are never reflected back.
    expect(parseSetExecutorEnabled({ ...valid, executorId: 'x'.repeat(65) })).toEqual({
      ok: false,
      errorCode: 'unknown_executor',
    });
  });

  it('validates requestExecutorState and capability lists', () => {
    expect(parseRequestExecutorState({ type: 'requestExecutorState', projectId: 'test' })).toEqual({
      type: 'requestExecutorState',
      projectId: 'test',
    });
    expect(
      parseRequestExecutorState({ type: 'requestExecutorState', projectId: 'test', x: 1 }),
    ).toBeUndefined();
    expect(clientWantsExecutorControls({ capabilities: ['executorControls'] })).toBe(true);
    expect(clientWantsExecutorControls({})).toBe(false);
    expect(clientWantsExecutorControls({ capabilities: 'executorControls' })).toBe(false);
  });
});

describe('buildExecutorState', () => {
  it('projects Operator choice, limits and tiers, keeping unmade probes unknown', () => {
    const op = operator({
      modelTiers: {
        maxTier: 'standard',
        tiers: {
          economy: { candidates: [{ executor: 'codex', model: 'test-economy-model' }] },
          standard: { candidates: [{ executor: 'codex', model: 'test-standard-model' }] },
          deep: { candidates: [{ executor: 'claude', model: 'test-deep-model' }] },
        },
      },
    });
    const state = buildExecutorState({
      projectId: 'test',
      operator: op,
      snapshot: snapshot(),
      sequence: 3,
      canManage: false,
      nowS: 1000,
    });
    expect(state).toMatchObject({
      type: 'executorState',
      projectId: 'test',
      sequence: 3,
      canManage: false,
      configurationStatus: 'ready',
      revision: operatorRevision(op),
    });
    const [claude, codex] = state.executors;
    expect(claude).toMatchObject({
      executorId: 'claude',
      enabled: false,
      eligible: false,
      levels: [], // deep is above maxTier
      installation: 'unknown',
      authentication: 'unknown',
      checkedAt: null,
    });
    expect(claude.reasonCodes).toEqual(
      expect.arrayContaining(['operator_disabled', 'no_allowed_level', 'probe_unknown']),
    );
    expect(codex).toMatchObject({
      executorId: 'codex',
      enabled: true,
      eligible: true,
      levels: ['economy', 'standard'],
      quotaGate: 'unknown', // no capacity observation yet: a probe, never "allow"
      activeExecutions: 0,
      concurrencyLimit: 1,
    });
    expect(codex.reasonCodes).toEqual(['quota_unknown', 'probe_unknown']);
  });

  it('marks quota rejections and full concurrency as not eligible', () => {
    const rejected = {
      provider: 'codex' as const,
      status: 'rejected' as const,
      confidence: 'high' as const,
      source: 'codex_session_log' as const,
      observedAt: 990,
      windows: [{ kind: 'five_hour' as const, usedRatio: 1, resetsAt: 5000 }],
    };
    const blocked = buildExecutorState({
      projectId: 'test',
      operator: operator(),
      snapshot: snapshot({ capacities: { codex: rejected } }),
      sequence: 0,
      canManage: false,
      nowS: 1000,
    }).executors[1];
    expect(blocked).toMatchObject({ quotaGate: 'block', eligible: false });
    expect(blocked.reasonCodes).toContain('quota_blocked');
    const full = buildExecutorState({
      projectId: 'test',
      operator: operator(),
      snapshot: snapshot({ active: { claude: 0, codex: 1 } }),
      sequence: 0,
      canManage: false,
      nowS: 1000,
    }).executors[1];
    expect(full).toMatchObject({ eligible: false, activeExecutions: 1 });
    expect(full.reasonCodes).toContain('concurrency_full');
  });

  it('is not eligible when the quota gate would fail closed on the machine policy', () => {
    // quotaThresholds/concurrency are optional in Operator config; without them the
    // worker never launches, so the office must not call the executor eligible.
    const codex = buildExecutorState({
      projectId: 'test',
      operator: operator({ quotaThresholds: undefined }),
      snapshot: snapshot({
        machinePolicy: { quotaThresholds: {}, maxConcurrent: { codex: 1 }, maxExecutions: 2 },
      }),
      sequence: 0,
      canManage: false,
      nowS: 1000,
    }).executors[1];
    expect(codex).toMatchObject({ enabled: true, eligible: false, quotaGate: 'unknown' });
    expect(codex.reasonCodes).toContain('configuration_unavailable');
  });

  it('reports an unavailable configuration without inventing availability', () => {
    const state = buildExecutorState({
      projectId: 'test',
      operator: undefined,
      snapshot: undefined,
      sequence: 0,
      canManage: false,
      nowS: 1000,
    });
    expect(state.configurationStatus).toBe('invalid');
    for (const e of state.executors)
      expect(e).toMatchObject({
        enabled: false,
        eligible: false,
        reasonCodes: ['configuration_unavailable'],
      });
  });

  it('revision changes only with the Operator policy', () => {
    expect(operatorRevision(operator())).toBe(operatorRevision(operator()));
    expect(operatorRevision(operator())).not.toBe(
      operatorRevision(operator({ allowedExecutors: ['claude', 'codex'] })),
    );
    // Canonical: a rewrite that only reorders keys is not a policy change (SA-088 CAS).
    const { autonomyLevel, allowedExecutors, quotaThresholds, concurrency } = operator();
    expect(
      operatorRevision({
        concurrency: { perExecutor: { codex: 1, claude: 1 }, maxExecutions: 2 },
        quotaThresholds: { codex: 10, claude: 10 },
        allowedExecutors,
        autonomyLevel,
      }),
    ).toBe(operatorRevision({ autonomyLevel, allowedExecutors, quotaThresholds, concurrency }));
    // Arrays keep their order: at worst a reorder is a spurious conflict, never a missed one.
    expect(operatorRevision(operator({ allowedExecutors: ['codex', 'claude'] }))).not.toBe(
      operatorRevision(operator({ allowedExecutors: ['claude', 'codex'] })),
    );
  });
});

describe('executor messages over the wire', () => {
  let root: string;
  let workspace: string;
  const sent = () => vi.fn<(message: Record<string, unknown>) => void>();
  const ofType = (send: ReturnType<typeof sent>, type: string) =>
    send.mock.calls.map(([m]) => m).filter((m) => m.type === type);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-state-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.softwareagents'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.softwareagents/project.yaml'),
      'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
    );
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    const config = readConfig();
    config.projects.test = operator();
    writeConfig(config);
    configureCompanyControl(workspace);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ctx = (privileged: boolean) => ({ store: new AgentStateStore(), cache: null, privileged });

  it('sends executorState only to clients that announce executorControls, sequenced per connection', () => {
    const legacy = sent();
    handleClientMessage({ type: 'webviewReady' }, legacy, ctx(true));
    expect(ofType(legacy, 'executorState')).toEqual([]);

    const modern = sent();
    const c = ctx(true);
    handleClientMessage({ type: 'webviewReady', capabilities: ['executorControls'] }, modern, c);
    handleClientMessage({ type: 'requestExecutorState', projectId: 'test' }, modern, c);
    handleClientMessage({ type: 'requestExecutorState', projectId: 'other' }, modern, c);
    const states = ofType(modern, 'executorState');
    expect(states.map((s) => s.sequence)).toEqual([0, 1]);
    // Toggles cannot be applied before SA-088, so nobody may manage yet.
    expect(states[0]).toMatchObject({ projectId: 'test', canManage: false });
  });

  it('answers setExecutorEnabled honestly: unauthorized, unknown project, then not_supported', () => {
    const anonymous = sent();
    handleClientMessage(valid, anonymous, ctx(false));
    expect(ofType(anonymous, 'executorToggleResult')).toEqual([
      expect.objectContaining({ status: 'rejected', errorCode: 'unauthorized' }),
    ]);

    const operatorClient = sent();
    handleClientMessage({ ...valid, projectId: 'other' }, operatorClient, ctx(true));
    handleClientMessage(valid, operatorClient, ctx(true));
    handleClientMessage({ ...valid, enabled: 'no' }, operatorClient, ctx(true));
    handleClientMessage({ ...valid, requestId: undefined }, operatorClient, ctx(true));
    expect(ofType(operatorClient, 'executorToggleResult')).toEqual([
      expect.objectContaining({ projectId: 'other', errorCode: 'unknown_project' }),
      expect.objectContaining({
        requestId: 'req-1',
        status: 'rejected',
        errorCode: 'not_supported',
        revision: operatorRevision(readConfig().projects.test),
      }),
      expect.objectContaining({ errorCode: 'invalid_request' }),
      // No requestId: nothing safe to correlate, so nothing is sent.
    ]);
    // Nothing about availability changed.
    expect(readConfig().projects.test.allowedExecutors).toEqual(['codex']);
  });
});
