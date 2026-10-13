import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { AuditLog } from '../src/auditLog.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { configureCompanyControl } from '../src/companyControl.js';
import { parseProjects, readConfig, writeConfig } from '../src/configPersistence.js';
import {
  type AvailabilityRequest,
  executorAuthorityBlock,
  hasPendingChange,
  type LevelsRequest,
  nextAllowlist,
  nextExecutorLevels,
  runExecutorsCommand,
  setExecutorAvailability,
  setExecutorLevels,
} from '../src/executorAvailability.js';
import {
  buildExecutorState,
  operatorRevision,
  parseSetExecutorLevels,
} from '../src/executorState.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));

let root: string;
const configFile = () => path.join(root, '.pixel-agents', 'config.json');
const rawFile = () => JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Record<string, any>;
const operator: ProjectOperatorConfig = {
  autonomyLevel: 'A2',
  allowedExecutors: ['claude', 'codex', 'legacy-x'],
  binaryPaths: { claude: '/opt/claude' },
  quotaThresholds: { claude: 10, codex: 10 },
  concurrency: { maxExecutions: 2, perExecutor: { claude: 1, codex: 1 } },
};
const ok = { privileged: true, boundProjectId: 'test' };
const request = (over: Partial<AvailabilityRequest> = {}): AvailabilityRequest => ({
  projectId: 'test',
  executorId: 'codex',
  enabled: false,
  requestId: 'req-1',
  expectedRevision: operatorRevision(operator),
  ...over,
});
const audit = (projectId: string | null) =>
  new AuditLog()
    .read(projectId)
    .flatMap((r) => (r.corrupt ? [] : [r.entry]))
    .filter((e) => e.action === 'change_executor_availability');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-availability-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  fs.mkdirSync(path.join(root, '.pixel-agents'), { recursive: true });
  // Hand-written file: a valid Project, a rejected one and unrelated keys.
  fs.writeFileSync(
    configFile(),
    JSON.stringify({
      hooksEnabled: { claude: false },
      standalone: { soundEnabled: false },
      projects: {
        test: operator,
        broken: { autonomyLevel: 'A9', allowedExecutors: ['claude'] },
      },
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('setExecutorAvailability', () => {
  it('applies, persists only the membership change and audits intent and result', () => {
    const outcome = setExecutorAvailability(request(), ok);
    const after = { ...operator, allowedExecutors: ['claude', 'legacy-x'] };
    expect(outcome).toEqual({ status: 'applied', revision: operatorRevision(after) });
    const raw = rawFile();
    expect(raw.projects.test).toEqual(after);
    // Everything else verbatim, including the rejected policy and settings keys.
    expect(raw.projects.broken).toEqual({ autonomyLevel: 'A9', allowedExecutors: ['claude'] });
    expect(raw.hooksEnabled).toEqual({ claude: false });
    expect(raw.standalone).toEqual({ soundEnabled: false });
    expect(audit('test').map((e) => e.outcome.status)).toEqual(['intent', 'applied']);
    expect(audit('test')[0]).toMatchObject({
      actorType: 'human',
      riskLevel: 'high',
      resourceId: 'codex',
      policyDecision: { outcome: 'allow' },
    });
    expect(JSON.parse(audit('test')[1].outcome.detail!)).toEqual({
      requestId: 'req-1',
      enabled: false,
      kind: 'availability',
      before: ['claude', 'codex', 'legacy-x'],
      after: ['claude', 'legacy-x'],
    });
    expect(hasPendingChange('test')).toBe(false);
    // Enabling appends; repeating an absolute command is unchanged, never an inversion.
    const again = setExecutorAvailability(
      request({ enabled: true, expectedRevision: outcome.revision }),
      ok,
    );
    expect(rawFile().projects.test.allowedExecutors).toEqual(['claude', 'legacy-x', 'codex']);
    expect(
      setExecutorAvailability(request({ enabled: true, expectedRevision: again.revision }), ok),
    ).toEqual({ status: 'unchanged', revision: again.revision });
  });

  it('keeps order and unknown legacy ids when changing membership', () => {
    expect(nextAllowlist(['codex', 'old'], 'claude', true)).toEqual(['codex', 'old', 'claude']);
    expect(nextAllowlist(['codex', 'old'], 'codex', false)).toEqual(['old']);
  });

  it('rejects without touching the config: privilege, binding, unknown Project, stale revision, invalid policy', () => {
    const before = fs.readFileSync(configFile(), 'utf8');
    expect(
      setExecutorAvailability(request(), { privileged: false, boundProjectId: 'test' }),
    ).toEqual({ status: 'rejected', errorCode: 'unauthorized' });
    // Unauthenticated rejections land in the machine log with an unknown actor, no Project.
    expect(audit(null)).toEqual([
      expect.objectContaining({ actorType: 'unknown', projectId: null, resourceId: 'codex' }),
    ]);
    expect(setExecutorAvailability(request({ projectId: 'other' }), ok)).toMatchObject({
      errorCode: 'unknown_project',
    });
    // Bound but not configured by the Operator: a toggle never creates a Project.
    expect(
      setExecutorAvailability(request({ projectId: 'fresh' }), {
        privileged: true,
        boundProjectId: 'fresh',
      }),
    ).toMatchObject({ errorCode: 'unknown_project' });
    expect(setExecutorAvailability(request({ expectedRevision: 'stale' }), ok)).toEqual({
      status: 'rejected',
      errorCode: 'revision_conflict',
      revision: operatorRevision(operator),
    });
    expect(
      setExecutorAvailability(request({ projectId: 'broken' }), {
        privileged: true,
        boundProjectId: 'broken',
      }),
    ).toMatchObject({ errorCode: 'policy_denied' });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(hasPendingChange('test')).toBe(false);
  });

  it('never replaces an unreadable config with defaults', () => {
    fs.writeFileSync(configFile(), '{ not json');
    expect(setExecutorAvailability(request(), ok)).toEqual({
      status: 'failed',
      errorCode: 'apply_failed',
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{ not json');
    expect(hasPendingChange('test')).toBe(false);
  });

  it('aborts before persisting when the intent cannot be audited', () => {
    fs.writeFileSync(path.join(root, '.pixel-agents', 'audit'), 'not a directory');
    const before = fs.readFileSync(configFile(), 'utf8');
    expect(setExecutorAvailability(request(), ok)).toEqual({
      status: 'failed',
      errorCode: 'audit_failed',
      revision: operatorRevision(operator),
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(hasPendingChange('test')).toBe(false);
  });

  it('reports persist_failed and audits the failure when the rename fails', () => {
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === configFile()) throw Object.assign(new Error('disk full'), { code: 'EIO' });
      return rename(from, to);
    });
    const before = fs.readFileSync(configFile(), 'utf8');
    expect(setExecutorAvailability(request(), ok)).toEqual({
      status: 'failed',
      errorCode: 'persist_failed',
      revision: operatorRevision(operator),
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(audit('test').map((e) => e.outcome.status)).toEqual(['intent', 'failed']);
    expect(hasPendingChange('test')).toBe(false);
    // No temporary is left behind.
    expect(fs.readdirSync(path.dirname(configFile())).filter((n) => n.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it('blocks launches until the operator recovers a change whose result was not audited', () => {
    const append = AuditLog.prototype.append;
    let calls = 0;
    vi.spyOn(AuditLog.prototype, 'append').mockImplementation(function (this: AuditLog, input) {
      if (++calls === 2) throw new Error('audit disk full');
      return append.call(this, input);
    });
    const outcome = setExecutorAvailability(request(), ok);
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'recovery_required' });
    // The change is on disk but not confirmed: never reported as applied.
    expect(rawFile().projects.test.allowedExecutors).toEqual(['claude', 'legacy-x']);
    expect(hasPendingChange('test')).toBe(true);
    vi.mocked(AuditLog.prototype.append).mockRestore();

    // Workers refuse, and further toggles are rejected, until recovery.
    expect(executorAuthorityBlock('test', readConfig().projects.test)).toMatch(
      /executors recover test/,
    );
    expect(
      setExecutorAvailability(request({ expectedRevision: outcome.revision ?? '' }), ok),
    ).toMatchObject({ errorCode: 'recovery_required' });

    const lines: string[] = [];
    runExecutorsCommand(['recover', 'test'], (line) => lines.push(line));
    expect(lines[0]).toMatch(/the change was persisted/);
    expect(hasPendingChange('test')).toBe(false);
    expect(audit('test').at(-1)).toMatchObject({ outcome: { status: 'recovered' } });
    expect(executorAuthorityBlock('test', readConfig().projects.test)).toBeUndefined();
    runExecutorsCommand(['recover', 'test'], (line) => lines.push(line));
    expect(lines[1]).toMatch(/No interrupted/);
    expect(() => runExecutorsCommand(['recover', '../x'])).toThrow(/Usage/);
  });
});

describe('cooperating writers', () => {
  it('a stale settings write does not revert an Operator change made meanwhile', () => {
    const stale = readConfig();
    expect(setExecutorAvailability(request(), ok).status).toBe('applied');
    stale.standalone.soundEnabled = true;
    writeConfig(stale);
    const raw = rawFile();
    expect(raw.projects.test.allowedExecutors).toEqual(['claude', 'legacy-x']);
    expect(raw.standalone.soundEnabled).toBe(true);
    expect(raw.projects.broken).toEqual({ autonomyLevel: 'A9', allowedExecutors: ['claude'] });
  });

  it('a legacy writer still persists the Projects it did change', () => {
    const config = readConfig();
    config.projects.added = { autonomyLevel: 'A1', allowedExecutors: [] };
    delete config.projects.test;
    writeConfig(config);
    expect(Object.keys(rawFile().projects).sort()).toEqual(['added', 'broken']);
  });

  it('a legacy writer refuses to write over a file it cannot parse', () => {
    const config = readConfig();
    fs.writeFileSync(configFile(), '{ broken');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeConfig(config);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{ broken');
  });
});

describe('worker authority re-check', () => {
  it('drops a run whose Operator policy changed after it started', () => {
    const atStart = readConfig().projects.test;
    expect(executorAuthorityBlock('test', atStart)).toBeUndefined();
    setExecutorAvailability(request(), ok);
    expect(executorAuthorityBlock('test', atStart)).toMatch(/changed since this run started/);
    expect(executorAuthorityBlock('missing', atStart)).toMatch(/missing or invalid/);
  });
});

describe('over the wire', () => {
  it('answers the privileged client and asks every connection to refresh its own snapshot', () => {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.softwareagents'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.softwareagents/project.yaml'),
      'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
    );
    configureCompanyControl(workspace);
    const store = new AgentStateStore();
    const changed = vi.fn();
    store.on('executorStateChanged', changed);
    const send = vi.fn<(m: Record<string, unknown>) => void>();
    const ctx = { store, cache: null, privileged: true };
    handleClientMessage({ type: 'webviewReady', capabilities: ['executorControls'] }, send, ctx);
    const state = send.mock.calls.map(([m]) => m).find((m) => m.type === 'executorState')!;
    expect(state).toMatchObject({ canManage: true, configurationStatus: 'ready' });
    handleClientMessage(
      {
        type: 'setExecutorEnabled',
        projectId: 'test',
        executorId: 'codex',
        enabled: false,
        requestId: 'req-9',
        expectedRevision: state.revision,
      },
      send,
      ctx,
    );
    expect(
      send.mock.calls.map(([m]) => m).filter((m) => m.type === 'executorToggleResult'),
    ).toEqual([expect.objectContaining({ requestId: 'req-9', status: 'applied' })]);
    expect(changed).toHaveBeenCalledWith('test');
    // An unprivileged connection sees the state but cannot manage it.
    const viewer = vi.fn<(m: Record<string, unknown>) => void>();
    handleClientMessage({ type: 'webviewReady', capabilities: ['executorControls'] }, viewer, {
      store,
      cache: null,
      privileged: false,
    });
    expect(viewer.mock.calls.map(([m]) => m).find((m) => m.type === 'executorState')).toMatchObject(
      { canManage: false },
    );
  });
});

describe('SA-092 executor levels', () => {
  const tiered: ProjectOperatorConfig = {
    ...operator,
    modelTiers: {
      maxTier: 'deep',
      tiers: {
        economy: { candidates: [{ executor: 'codex', model: 'test-economy-model' }] },
        standard: {
          candidates: [
            { executor: 'claude', model: 'test-standard-model' },
            { executor: 'codex', model: 'test-standard-alternative' },
          ],
          fallbackTo: 'economy',
        },
        deep: {
          candidates: [{ executor: 'claude', model: 'test-deep-model' }],
          fallbackTo: 'standard',
        },
      },
    },
  };
  const levels = (over: Partial<LevelsRequest> = {}): LevelsRequest => ({
    projectId: 'test',
    executorId: 'codex',
    levels: ['standard'],
    requestId: 'lvl-1',
    expectedRevision: operatorRevision(tiered),
    ...over,
  });
  beforeEach(() => {
    const raw = rawFile();
    raw.projects.test = tiered;
    fs.writeFileSync(configFile(), JSON.stringify(raw));
  });

  it('narrows one Executor through the same audited service, and all levels lift it', () => {
    const outcome = setExecutorLevels(levels(), ok);
    const narrowed: ProjectOperatorConfig = { ...tiered, executorLevels: { codex: ['standard'] } };
    expect(outcome).toEqual({ status: 'applied', revision: operatorRevision(narrowed) });
    expect(rawFile().projects.test).toEqual(narrowed);
    expect(audit('test').map((e) => e.outcome.status)).toEqual(['intent', 'applied']);
    expect(JSON.parse(audit('test')[1].outcome.detail!)).toEqual({
      requestId: 'lvl-1',
      levels: ['standard'],
      kind: 'levels',
      before: null,
      after: ['standard'],
    });
    // A level change is an authority change: runs started under the old policy drop.
    expect(executorAuthorityBlock('test', tiered)).toMatch(/changed since this run started/);
    // Listing every catalog level is "unrestricted": the key disappears, the policy is back.
    expect(
      setExecutorLevels(
        levels({ levels: ['economy', 'standard'], expectedRevision: outcome.revision }),
        ok,
      ),
    ).toEqual({ status: 'applied', revision: operatorRevision(tiered) });
    expect(rawFile().projects.test).toEqual(tiered);
    expect(
      setExecutorLevels(
        levels({ levels: ['standard', 'economy'], expectedRevision: operatorRevision(tiered) }),
        ok,
      ),
    ).toEqual({ status: 'unchanged', revision: operatorRevision(tiered) });
  });

  it('an empty list blocks the Executor at every level and the office says so', () => {
    expect(setExecutorLevels(levels({ levels: [] }), ok).status).toBe('applied');
    const current = readConfig().projects.test;
    expect(current.executorLevels).toEqual({ codex: [] });
    const state = buildExecutorState({
      projectId: 'test',
      operator: current,
      snapshot: {
        allowedExecutors: current.allowedExecutors,
        machinePolicy: { quotaThresholds: {}, maxConcurrent: { claude: 1, codex: 1 } },
        capacities: {},
        active: { claude: 0, codex: 0 },
        nowS: 100,
      },
      sequence: 0,
      canManage: true,
      nowS: 100,
    });
    const codex = state.executors.find((e) => e.executorId === 'codex')!;
    expect(codex).toMatchObject({
      enabled: true,
      eligible: false,
      levels: [],
      catalogLevels: ['economy', 'standard'],
    });
    expect(codex.reasonCodes).toContain('no_allowed_level');
    expect(state.executors.find((e) => e.executorId === 'claude')).toMatchObject({
      levels: ['standard', 'deep'],
      catalogLevels: ['standard', 'deep'],
    });
  });

  it('never widens the catalog: a level it does not offer, or no catalog, is invalid', () => {
    const before = fs.readFileSync(configFile(), 'utf8');
    expect(setExecutorLevels(levels({ levels: ['deep'] }), ok)).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_request',
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(nextExecutorLevels(operator, 'claude', [])).toBe('invalid_request');
    expect(setExecutorLevels(levels(), { privileged: false, boundProjectId: 'test' })).toEqual({
      status: 'rejected',
      errorCode: 'unauthorized',
    });
    // Other Executors' restrictions are kept verbatim.
    const both = nextExecutorLevels({ ...tiered, executorLevels: { claude: ['deep'] } }, 'codex', [
      'economy',
    ]);
    expect(both).toMatchObject({ executorLevels: { claude: ['deep'], codex: ['economy'] } });
  });

  it('the Operator schema accepts only known tiers per catalog Executor', () => {
    const parse = (executorLevels: unknown) =>
      parseProjects({ p: { ...tiered, executorLevels } }).p?.executorLevels;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parse({ claude: ['deep'], codex: [] })).toEqual({ claude: ['deep'], codex: [] });
    expect(parse({ claude: ['ultra'] })).toBeUndefined();
    expect(parse({ local: ['deep'] })).toBeUndefined();
    expect(parse({ claude: ['deep', 'deep'] })).toBeUndefined();
  });

  it('validates the wire message like setExecutorEnabled', () => {
    const msg = {
      type: 'setExecutorLevels',
      projectId: 'test',
      executorId: 'codex',
      levels: ['standard'],
      requestId: 'r',
      expectedRevision: 'x',
    };
    expect(parseSetExecutorLevels(msg)).toMatchObject({ ok: true });
    for (const bad of [
      { ...msg, levels: ['standard', 'standard'] },
      { ...msg, levels: ['ultra'] },
      { ...msg, levels: 'standard' },
      { ...msg, extra: 1 },
    ])
      expect(parseSetExecutorLevels(bad)).toMatchObject({
        ok: false,
        errorCode: 'invalid_request',
      });
    expect(parseSetExecutorLevels({ ...msg, executorId: 'local' })).toMatchObject({
      ok: false,
      errorCode: 'unknown_executor',
      echo: { requestId: 'r' },
    });
  });

  it('recovery reports the level restriction actually on disk', () => {
    const append = AuditLog.prototype.append;
    let calls = 0;
    vi.spyOn(AuditLog.prototype, 'append').mockImplementation(function (this: AuditLog, input) {
      if (++calls === 2) throw new Error('audit disk full');
      return append.call(this, input);
    });
    expect(setExecutorLevels(levels(), ok)).toMatchObject({ errorCode: 'recovery_required' });
    vi.mocked(AuditLog.prototype.append).mockRestore();
    const lines: string[] = [];
    runExecutorsCommand(['recover', 'test'], (line) => lines.push(line));
    expect(lines[0]).toMatch(
      /the change was persisted.*executorLevels = \{"codex":\["standard"\]\}/,
    );
    const recovered = audit('test').at(-1)!;
    expect(recovered.outcome.status).toBe('recovered');
    expect(JSON.parse(recovered.outcome.detail!)).toMatchObject({ kind: 'levels' });
  });
});
