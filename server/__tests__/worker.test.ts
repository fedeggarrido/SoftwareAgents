import { execFileSync, spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { AgentStateStore } from '../src/agentStateStore.js';
import { AuditLog } from '../src/auditLog.js';
import { dispatchCli } from '../src/cli.js';
import { parseProjects } from '../src/configPersistence.js';
import { ExecutionRegistry } from '../src/executors/executionRegistry.js';
import { guardProtectedPaths } from '../src/executors/protectedPaths.js';
import { readExecutorSlots } from '../src/executorSlots.js';
import { HumanDecisions } from '../src/humanDecisions.js';
import { MachineCapacityPublisher } from '../src/machineCapacity.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { runQuotaCheck } from '../src/quotaCommand.js';
import { acquireTaskLock, parseWorkerArgs, runWorker, workerCommitSubject } from '../src/worker.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFileSync: vi.fn(actual.execFileSync) };
});

vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));

let root: string;
let repo: string;
const fake = path.join(__dirname, 'fixtures/fake-cli.cjs');
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('HOME', root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex-home'));
  vi.stubEnv('GIT_AUTHOR_NAME', 'Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.invalid');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.invalid');
  git(repo, 'init', '-b', 'main');
  fs.mkdirSync(path.join(repo, '.softwareagents'));
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(path.join(repo, 'brief.md'), 'Correct documentation.');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        test: {
          autonomyLevel: 'A1',
          allowedExecutors: ['claude'],
          binaryPaths: { claude: process.execPath },
          quotaThresholds: { claude: 5 },
          concurrency: { maxExecutions: 2, perExecutor: { claude: 2 } },
        },
      },
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
  vi.mocked(spawn).mockClear();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('supervised worker', () => {
  it('invalid catalogue rejects worker and quota before locks, storage or legacy argv', async () => {
    const file = path.join(root, '.pixel-agents/config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.projects.test.modelTiers = { maxTier: 'deep', tiers: {} };
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(loadProjectConfig(repo)?.operator.allowedExecutors).toEqual([]);
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, { cwd: repo })).rejects.toThrow(
      'Invalid Operator modelTiers',
    );
    for (const args of [
      { selectExecutor: true, role: 'developer', json: true },
      { executor: 'claude' as const, role: 'developer', json: true },
    ])
      expect(() => runQuotaCheck(args, repo)).toThrow('Invalid Operator modelTiers');
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
  });
  it('runtime support uses the configured Claude binary and fails closed before launch', async () => {
    const file = path.join(root, '.pixel-agents/config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const binary = path.join(root, 'missing-claude.exe');
    raw.projects.test.binaryPaths.claude = binary;
    raw.projects.test.modelTiers = {
      rule: parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
          'utf8',
        ),
      ).tierRule,
      maxTier: 'standard',
      tiers: {
        standard: { candidates: [{ executor: 'claude', model: 'test-model', effort: 'high' }] },
      },
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    vi.mocked(execFileSync).mockClear();
    expect(loadProjectConfig(repo)?.operator.modelTiers).toBeDefined();
    expect(execFileSync).not.toHaveBeenCalled();
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, { cwd: repo })).rejects.toThrow(
      'unsupported claude effort',
    );
    expect(() =>
      runQuotaCheck({ selectExecutor: true, role: 'developer', json: true }, repo),
    ).toThrow('unsupported claude effort');
    expect(
      vi.mocked(execFileSync).mock.calls.filter((call) => call[1]?.[0] === '--help'),
    ).toHaveLength(1);
    expect(execFileSync).toHaveBeenCalledWith(binary, ['--help'], expect.any(Object));
    expect(spawn).not.toHaveBeenCalled();
  });
  it('a missing capability weight is a configuration error for worker and quota', async () => {
    const file = path.join(root, '.pixel-agents/config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rule = parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
        'utf8',
      ),
    ).tierRule;
    delete rule.capabilityWeights.standard_coding;
    raw.projects.test.modelTiers = {
      maxTier: 'standard',
      rule,
      tiers: { standard: { candidates: [{ executor: 'codex', model: 'test-model' }] } },
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(() =>
      runQuotaCheck({ selectExecutor: true, role: 'developer', json: true }, repo),
    ).toThrow('missing capabilityClass standard_coding');
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, { cwd: repo })).rejects.toThrow(
      'missing capabilityClass standard_coding',
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, '.git/softwareagents/locks/SA-999.lock'))).toBe(false);
  });
  it.each(['claude', 'codex'] as const)(
    'operator tiers pass real argv to %s and persist the choice',
    async (selected) => {
      vi.mocked(execFileSync).mockClear();
      const execute = vi.mocked(execFileSync).getMockImplementation()!;
      vi.mocked(execFileSync).mockImplementation(((
        binary: string,
        args: string[],
        options: object,
      ) =>
        args[0] === '--help'
          ? '--effort <level> Effort (low, medium, high, xhigh, max)'
          : execute(binary, args, options)) as typeof execFileSync);
      const configFile = path.join(root, '.pixel-agents/config.json');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config.projects.test.allowedExecutors = [selected];
      config.projects.test.binaryPaths = { [selected]: process.execPath };
      config.projects.test.quotaThresholds = { [selected]: 5 };
      config.projects.test.concurrency.perExecutor = { [selected]: 1 };
      config.projects.test.modelTiers = {
        maxTier: 'standard',
        rule: parse(
          fs.readFileSync(
            path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
            'utf8',
          ),
        ).tierRule,
        tiers: {
          standard: {
            candidates: [{ executor: selected, model: 'test-standard-model', effort: 'medium' }],
          },
        },
      };
      fs.writeFileSync(configFile, JSON.stringify(config));
      const captured = path.join(root, 'argv.json');
      vi.stubEnv('SA_TEST_ARGV', captured);
      const result = await runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fake, selected], log: () => {} },
      );
      if (selected === 'claude')
        expect(
          vi.mocked(execFileSync).mock.calls.filter((call) => call[1]?.[0] === '--help'),
        ).toHaveLength(1);
      expect(result.commit).toBeNull();
      const argv = JSON.parse(fs.readFileSync(captured, 'utf8')) as string[];
      expect(
        argv.slice(
          argv.indexOf(selected === 'codex' ? '-m' : '--model'),
          argv.indexOf(selected === 'codex' ? '-m' : '--model') + 2,
        ),
      ).toEqual([selected === 'codex' ? '-m' : '--model', 'test-standard-model']);
      if (selected === 'codex') {
        expect(argv).toContain('model_reasoning_effort="medium"');
        expect(argv).toContain('features.apps=false');
      } else
        expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual([
          '--effort',
          'medium',
        ]);
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(store.getTask('SA-999')?.type).toBe('unknown');
        expect(store.listExecutions()).toMatchObject([
          {
            executor: selected,
            model_tier: 'standard',
            model_id: 'test-standard-model',
            model_effort: 'medium',
            selection_reason: expect.stringContaining('fallback:'),
            pid: null,
            session_id: selected === 'codex' ? 'fake-codex-session' : expect.any(String),
          },
        ]);
      } finally {
        store.close();
      }
      expect(new AuditLog().read('test').slice(0, 1)).toMatchObject([
        {
          entry: {
            outcome: {
              status: 'model_selected',
              tier: 'standard',
              executor: selected,
              model: 'test-standard-model',
              effort: 'medium',
              reason: expect.stringContaining('fallback:'),
            },
          },
        },
      ]);
      expect([...new ExecutionRegistry(repo).sessionMap().values()]).toMatchObject([
        { tier: 'standard', model: 'test-standard-model', effort: 'medium' },
      ]);
    },
  );
  it('no catalogue leaves model and effort absent from the real CLI argv', async () => {
    const captured = path.join(root, 'argv.json');
    vi.stubEnv('SA_TEST_ARGV', captured);
    await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, binaryArgs: [fake, 'claude'], log: () => {} },
    );
    const argv = JSON.parse(fs.readFileSync(captured, 'utf8'));
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--effort');
  });
  it('reads WorkStore type and the bound board size, applying the operator ceiling', async () => {
    const configFile = path.join(root, '.pixel-agents/config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.projects.test.modelTiers = {
      maxTier: 'standard',
      rule: parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
          'utf8',
        ),
      ).tierRule,
      tiers: { standard: { candidates: [{ executor: 'claude', model: 'test-standard-model' }] } },
    };
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.appendFileSync(
      path.join(repo, '.softwareagents/project.yaml'),
      'legacy:\n  boardFile: board.json\n',
    );
    fs.writeFileSync(
      path.join(repo, 'board.json'),
      JSON.stringify({ items: [{ id: 'SA-999', size: 'L' }] }),
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'board fixture');
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      store.createTask({ key: 'SA-999', type: 'architecture' });
    } finally {
      store.close();
    }
    await runWorker(
      { task: 'SA-999', brief: 'brief.md', selectExecutor: true },
      { cwd: repo, binaryArgs: [fake, 'claude'], log: () => {} },
    );
    const records = new AuditLog().read('test');
    expect(records.slice(0, 1)).toMatchObject([
      {
        entry: {
          outcome: {
            tier: 'standard',
            reason: expect.stringContaining(
              'architecture/L; score=7; requested=deep; maxTier=standard',
            ),
          },
        },
      },
    ]);
  });
  it('P2: failed slot update before lazy iteration releases slot and task lock', async () => {
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (
        String(target).endsWith('0.lock') &&
        JSON.parse(fs.readFileSync(String(source), 'utf8')).sessionId
      )
        throw Object.assign(new Error('synthetic persistent EPERM'), { code: 'EPERM' });
      return rename(source, target);
    });
    await expect(
      runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fake, 'claude'], log: () => {} },
      ),
    ).rejects.toThrow('EPERM');
    expect(readExecutorSlots('claude').count).toBe(0);
    expect(fs.existsSync(path.join(repo, '.git/softwareagents/locks/SA-999.lock'))).toBe(false);
  });

  it.each([false, true])(
    'P1: no-flag worker launches with interactive office session and legacy config=%s',
    async (legacy) => {
      const operator = {
        autonomyLevel: 'A1',
        allowedExecutors: ['claude'],
        binaryPaths: { claude: process.execPath },
        ...(legacy
          ? {}
          : {
              quotaThresholds: { claude: 5 },
              concurrency: { maxExecutions: 1, perExecutor: { claude: 1 } },
            }),
      };
      fs.writeFileSync(
        path.join(root, '.pixel-agents/config.json'),
        JSON.stringify({
          projects: {
            test: operator,
            unrelated: { autonomyLevel: 'A1', allowedExecutors: ['claude'] },
          },
        }),
      );
      const store = new AgentStateStore();
      store.set(1, {
        id: 1,
        sessionId: 'operator',
        providerId: 'claude',
      } as import('../src/types.js').AgentState);
      new MachineCapacityPublisher(
        store,
        () => ({}),
        Date.now,
        undefined,
        ['test'],
        () => true,
      ).publish();
      const log = vi.fn();
      const result = await runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fake, 'claude'], log },
      );
      expect(result.branch).toContain('SA-999');
      expect(result.commit).toBeNull();
      expect(log.mock.calls.some(([line]) => line.includes('"observedSessions":1'))).toBe(true);
      expect(readExecutorSlots('claude').count).toBe(0);
    },
  );

  it.each([false, true])(
    'two real worker processes with different tasks launch only one synthetic executor at limit 1 (tiers=%s)',
    async (tiers) => {
      fs.writeFileSync(
        path.join(root, '.pixel-agents/config.json'),
        JSON.stringify({
          projects: {
            test: {
              autonomyLevel: 'A1',
              allowedExecutors: ['claude'],
              binaryPaths: { claude: process.execPath },
              quotaThresholds: { claude: 5 },
              concurrency: { maxExecutions: 1, perExecutor: { claude: 1 } },
              ...(tiers
                ? {
                    modelTiers: {
                      maxTier: 'standard',
                      rule: parse(
                        fs.readFileSync(
                          path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
                          'utf8',
                        ),
                      ).tierRule,
                      tiers: {
                        standard: {
                          candidates: [{ executor: 'claude', model: 'test-standard-model' }],
                        },
                      },
                    },
                  }
                : {}),
            },
          },
        }),
      );
      const bundle = path.join(root, 'worker.cjs');
      buildSync({
        entryPoints: [path.resolve(__dirname, '../src/worker.ts')],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent',
      });
      fs.mkdirSync(path.join(root, 'agents/templates'), { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, '../../agents/templates/developer.yaml'),
        path.join(root, 'agents/templates/developer.yaml'),
      );
      const launches = path.join(root, 'launches');
      const release = path.join(root, 'release');
      const children = [0, 1].map(() =>
        spawn(
          process.execPath,
          [path.join(__dirname, 'fixtures/worker-slot-process.cjs'), bundle],
          {
            env: {
              ...process.env,
              HOME: root,
              SA_SLOT_TEST_LAUNCHES: launches,
              SA_SLOT_TEST_RELEASE: release,
            },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            windowsHide: true,
          },
        ),
      );
      const ready = children.map(
        (child) => new Promise<void>((resolve) => child.once('message', () => resolve())),
      );
      const done = children.map(
        (child) =>
          new Promise<{
            result?: { quotaDecision?: { status: string } };
            exitCode?: number;
            error?: string;
          }>((resolve, reject) => {
            child.on(
              'message',
              (message: {
                ready?: boolean;
                result?: { quotaDecision?: { status: string } };
                exitCode?: number;
                error?: string;
              }) => {
                if (!message.ready) resolve(message);
              },
            );
            child.on('error', reject);
          }),
      );
      const exited = children.map(
        (child) => new Promise<number | null>((resolve) => child.once('exit', resolve)),
      );
      try {
        await Promise.all(ready);
        children.forEach((child, i) => child.send({ task: `SA-${998 + i}`, repo, fake }));
        const loser = await Promise.race(done);
        expect(loser.error).toBeUndefined();
        expect(loser).toMatchObject({ exitCode: 3, result: { quotaDecision: { status: 'wait' } } });
        await vi.waitFor(() => expect(fs.existsSync(launches)).toBe(true), { timeout: 15000 });
        expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
        expect(readExecutorSlots('claude').count).toBe(1);
        fs.writeFileSync(release, 'release');
        const results = await Promise.all(done);
        expect(results.filter((r) => r.exitCode === 0)).toHaveLength(1);
        expect((await Promise.all(exited)).sort()).toEqual([0, 3]);
        expect(readExecutorSlots('claude').count).toBe(0);
      } finally {
        fs.writeFileSync(release, 'release');
        children.forEach((child) => {
          if (child.exitCode === null) child.kill();
        });
        await Promise.all(exited);
      }
    },
    30000,
  );
  it.each([false, true, 'mixed'] as const)(
    'two real workers across executors launch only one at total limit 1 (tiers=%s)',
    async (tiers) => {
      const codexRepo = path.join(root, 'repo-codex');
      git(root, 'clone', '--quiet', repo, codexRepo);
      const projects: Record<string, unknown> = {};
      for (const [executor, checkout] of [
        ['claude', repo],
        ['codex', codexRepo],
      ] as const) {
        const project = executor === 'claude' ? 'test' : 'test-codex';
        const manifest = path.join(checkout, '.softwareagents/project.yaml');
        fs.writeFileSync(
          manifest,
          fs.readFileSync(manifest, 'utf8').replace('id: test', 'id: ' + project),
        );
        fs.mkdirSync(path.join(checkout, '.softwareagents/agents'), { recursive: true });
        fs.writeFileSync(
          path.join(checkout, '.softwareagents/agents/model-policy.yaml'),
          'standard_coding:\n  - executor: ' + executor + '\n',
        );
        git(checkout, 'add', '.');
        git(checkout, 'commit', '--allow-empty', '-m', 'worker fixture');
        const useTiers = tiers === true || (tiers === 'mixed' && executor === 'codex');
        projects[project] = {
          autonomyLevel: 'A1',
          allowedExecutors: [executor],
          binaryPaths: { [executor]: process.execPath },
          quotaThresholds: { [executor]: 5 },
          concurrency: { maxExecutions: 1, perExecutor: { [executor]: 2 } },
          ...(useTiers
            ? {
                modelTiers: {
                  maxTier: 'standard',
                  rule: parse(
                    fs.readFileSync(
                      path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
                      'utf8',
                    ),
                  ).tierRule,
                  tiers: { standard: { candidates: [{ executor, model: 'test-model' }] } },
                },
              }
            : {}),
        };
      }
      fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), JSON.stringify({ projects }));
      const bundle = path.join(root, 'worker.cjs');
      buildSync({
        entryPoints: [path.resolve(__dirname, '../src/worker.ts')],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent',
      });
      fs.mkdirSync(path.join(root, 'agents/templates'), { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, '../../agents/templates/developer.yaml'),
        path.join(root, 'agents/templates/developer.yaml'),
      );
      const launches = path.join(root, 'launches');
      const release = path.join(root, 'release');
      const children = [0, 1].map(() =>
        spawn(
          process.execPath,
          [path.join(__dirname, 'fixtures/worker-slot-process.cjs'), bundle],
          {
            env: {
              ...process.env,
              HOME: root,
              USERPROFILE: root,
              SA_SLOT_TEST_LAUNCHES: launches,
              SA_SLOT_TEST_RELEASE: release,
            },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            windowsHide: true,
          },
        ),
      );
      const ready = children.map(
        (child) => new Promise<void>((resolve) => child.once('message', () => resolve())),
      );
      const done = children.map(
        (child) =>
          new Promise<{
            result?: { quotaDecision?: { status: string } };
            exitCode?: number;
            error?: string;
          }>((resolve, reject) => {
            child.on(
              'message',
              (message: {
                ready?: boolean;
                result?: { quotaDecision?: { status: string } };
                exitCode?: number;
                error?: string;
              }) => {
                if (!message.ready) resolve(message);
              },
            );
            child.on('error', reject);
          }),
      );
      const exited = children.map(
        (child) => new Promise<number | null>((resolve) => child.once('exit', resolve)),
      );
      try {
        await Promise.all(ready);
        children.forEach((child, i) =>
          child.send({
            task: `SA-${998 + i}`,
            repo: i ? codexRepo : repo,
            fake,
            executor: i ? 'codex' : 'claude',
            selectExecutor: i === 1 && tiers === false,
          }),
        );
        const loser = await Promise.race(done);
        expect(loser.error).toBeUndefined();
        expect(loser).toMatchObject({ exitCode: 3, result: { quotaDecision: { status: 'wait' } } });
        await Promise.race([
          vi.waitFor(() => expect(fs.existsSync(launches)).toBe(true), { timeout: 15000 }),
          Promise.all(done).then((results) => {
            throw new Error('Both workers ended before a held launch: ' + JSON.stringify(results));
          }),
        ]);
        expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
        expect(readExecutorSlots('claude').count + readExecutorSlots('codex').count).toBe(1);
        fs.writeFileSync(release, 'release');
        const results = await Promise.all(done);
        expect(results.filter((r) => r.exitCode === 0)).toHaveLength(1);
        expect((await Promise.all(exited)).sort()).toEqual([0, 3]);
        expect(readExecutorSlots('claude').count + readExecutorSlots('codex').count).toBe(0);
      } finally {
        fs.writeFileSync(release, 'release');
        children.forEach((child) => {
          if (child.exitCode === null) child.kill();
        });
        await Promise.all(exited);
      }
    },
    30000,
  );
  it.each(['claude', 'codex'])(
    'releases the task lock after synchronous %s spawn EINVAL',
    async (selected) => {
      fs.mkdirSync(path.join(repo, '.softwareagents/agents'));
      fs.writeFileSync(
        path.join(repo, '.softwareagents/agents/model-policy.yaml'),
        `standard_coding:\n  - executor: ${selected}\n`,
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'spawn fixture');
      fs.writeFileSync(
        path.join(root, '.pixel-agents/config.json'),
        JSON.stringify({
          projects: {
            test: {
              autonomyLevel: 'A1',
              allowedExecutors: [selected],
              binaryPaths: { [selected]: process.execPath },
              quotaThresholds: { [selected]: 5 },
              concurrency: { maxExecutions: 2, perExecutor: { [selected]: 2 } },
            },
          },
        }),
      );
      fs.writeFileSync(
        path.join(root, '.pixel-agents/machine-capacity.json'),
        JSON.stringify({ observedAt: Date.now() / 1000, active: { [selected]: 0 } }),
      );
      const log = vi.fn();
      for (let attempt = 0; attempt < 2; attempt++) {
        vi.mocked(spawn).mockImplementationOnce(() => {
          throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
        });
        await expect(
          runWorker(
            { task: 'SA-999', brief: 'brief.md', selectExecutor: true },
            { cwd: repo, binaryArgs: [fake, selected], log },
          ),
        ).rejects.toThrow('Execution failed');
        expect(fs.existsSync(path.join(repo, '.git/softwareagents/locks/SA-999.lock'))).toBe(false);
      }
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Task lock retained'));
      const runs = path.join(repo, '.git/softwareagents/runs');
      for (const file of fs.readdirSync(runs)) {
        const records = fs
          .readFileSync(path.join(runs, file), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(records).toEqual([{ type: 'finished', exitCode: 1, resultSummary: 'spawn EINVAL' }]);
      }
    },
  );
  it.each(['.codex', '.agents'])(
    'releases the task lock after Codex preflight rejects %s',
    async (shipped) => {
      fs.mkdirSync(path.join(repo, '.softwareagents/agents'));
      fs.writeFileSync(
        path.join(repo, '.softwareagents/agents/model-policy.yaml'),
        'standard_coding:\n  - executor: codex\n',
      );
      fs.mkdirSync(path.join(repo, shipped));
      fs.writeFileSync(path.join(repo, shipped, 'config'), 'untrusted');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'preflight fixture');
      fs.writeFileSync(
        path.join(root, '.pixel-agents/config.json'),
        JSON.stringify({
          projects: {
            test: {
              autonomyLevel: 'A1',
              allowedExecutors: ['codex'],
              binaryPaths: { codex: process.execPath },
              quotaThresholds: { codex: 5 },
              concurrency: { maxExecutions: 2, perExecutor: { codex: 2 } },
            },
          },
        }),
      );
      fs.writeFileSync(
        path.join(root, '.pixel-agents/machine-capacity.json'),
        JSON.stringify({ observedAt: Date.now() / 1000, active: { codex: 0 } }),
      );
      const args = { task: 'SA-999', brief: 'brief.md', selectExecutor: true };
      const options = { cwd: repo, binaryArgs: [fake, 'codex'], log: vi.fn() };
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(runWorker(args, options)).rejects.toThrow(`the worktree ships ${shipped}/`);
        expect(fs.existsSync(path.join(repo, '.git/softwareagents/locks/SA-999.lock'))).toBe(false);
      }
    },
  );
  it.each(['claude', 'codex'])(
    'optional selection launches %s as a single probe',
    async (selected) => {
      fs.mkdirSync(path.join(repo, '.softwareagents/agents'));
      fs.writeFileSync(
        path.join(repo, '.softwareagents/agents/model-policy.yaml'),
        `standard_coding:\n  - executor: ${selected === 'claude' ? 'codex' : 'claude'}\n  - executor: ${selected}\n`,
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'preferences');
      fs.writeFileSync(
        path.join(root, '.pixel-agents/config.json'),
        JSON.stringify({
          projects: {
            test: {
              autonomyLevel: 'A1',
              allowedExecutors: [selected],
              binaryPaths: { [selected]: process.execPath },
              quotaThresholds: { [selected]: 5 },
              concurrency: { maxExecutions: 2, perExecutor: { [selected]: 2 } },
            },
          },
        }),
      );
      const publisher = new MachineCapacityPublisher(
        new AgentStateStore(),
        () => ({}),
        Date.now,
        undefined,
        ['test'],
        () => true,
      );
      publisher.publish();
      expect(fs.existsSync(publisher.file)).toBe(true);
      const log = vi.fn();
      const result = await runWorker(
        { task: 'SA-999', brief: 'brief.md', selectExecutor: true },
        { cwd: repo, binaryArgs: [fake, selected], log },
      );
      expect(result.branch).toContain('SA-999');
      expect(result.commit).toBeNull();
      expect(log.mock.calls.some(([line]) => line.includes('probe'))).toBe(true);
      expect(log.mock.calls.some(([line]) => line.includes('office_store'))).toBe(true);
      const records = fs.readFileSync(
        path.join(repo, '.git/softwareagents/executions.jsonl'),
        'utf8',
      );
      expect(JSON.parse(records.trim().split('\n')[0])).toMatchObject({
        executor: selected,
        model: null,
      });
    },
  );
  it('optional selection waits before creating a worktree when policy is incomplete', async () => {
    fs.writeFileSync(
      path.join(root, '.pixel-agents/config.json'),
      JSON.stringify({
        projects: {
          test: { autonomyLevel: 'A1', allowedExecutors: ['claude'] },
        },
      }),
    );
    fs.mkdirSync(path.join(repo, '.softwareagents/agents'));
    fs.writeFileSync(
      path.join(repo, '.softwareagents/agents/model-policy.yaml'),
      'standard_coding:\n  - executor: claude\n',
    );
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md', selectExecutor: true },
      { cwd: repo, log: () => {} },
    );
    expect(result).toMatchObject({ commit: null, quotaDecision: { status: 'wait' } });
    expect(fs.existsSync(path.join(repo, '.worktrees/SA-999'))).toBe(false);
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
  });
  it.each([
    ['\n# SA-999 · HUD: mostrar Capacidad\nDetails', 'HUD: mostrar Capacidad'],
    ['# sa-999: HUD', 'HUD'],
    ['# SA-999 — HUD', 'HUD'],
    ['# SA-9999 · HUD', 'SA-9999 · HUD'],
    ['Correct documentation.', 'Correct documentation.'],
    ['# SA-999', 'implementar tarea supervisada'],
    ['', 'implementar tarea supervisada'],
  ])('formats the runtime subject from %s', (brief, summary) => {
    expect(workerCommitSubject('SA-999', brief)).toBe(`feat(SA-999): ${summary}`);
  });
  it('dispatches default and --port to the server, worker to its own handler', async () => {
    const server = vi.fn(async () => {});
    const worker = vi.fn(async () => ({ branch: '', commit: null, stat: '' }));
    await dispatchCli([], { server, worker });
    await dispatchCli(['--port', '8123'], { server, worker });
    await dispatchCli(['worker', 'run', '--task', 'SA-999', '--brief', 'brief.md'], {
      server,
      worker,
    });
    expect(server.mock.calls).toEqual([[[]], [['--port', '8123']]]);
    expect(worker).toHaveBeenCalledWith({ task: 'SA-999', brief: 'brief.md' });
  });
  it('rejects malformed arguments', () => {
    for (const args of [
      [],
      ['run'],
      ['run', '--task', '../main', '--brief', 'a'],
      ['run', '--task', 'SA-999', '--brief', 'a', '--push', 'yes'],
    ])
      expect(() => parseWorkerArgs(args)).toThrow();
  });
  it('retains live and crashed locks until verified manual recovery', () => {
    const common = path.join(repo, '.git');
    const release = acquireTaskLock(common, 'SA-999');
    const lock = path.join(common, 'softwareagents/locks/SA-999.lock');
    expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
    expect(() => acquireTaskLock(common, 'SA-999')).toThrow('Task locked');
    release();
    fs.writeFileSync(lock, '2147483647');
    expect(() => acquireTaskLock(common, 'SA-999')).toThrow('Verify owner PID');
    fs.unlinkSync(lock); // Operator verified owner and executor child are gone.
    acquireTaskLock(common, 'SA-999')();
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('runs fake CLI through runtime commit, registry and audit, keeps main intact and blocks agent pushes', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const log = vi.fn();
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude', '--write-doc'],
        log,
      },
    );
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.branch).toBe('sa/SA-999-worker');
    expect(result.stat).toContain('worker-result.md');
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    const tree = path.join(repo, '.worktrees/SA-999');
    // The supervised worker skips npm ci but keeps the per-worktree push block.
    expect(git(tree, 'config', '--worktree', 'remote.origin.pushurl')).toBe(
      'softwareagents-push-disabled://origin',
    );
    expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(git(tree, 'log', '-1', '--format=%s')).toBe('feat(SA-999): Correct documentation.');
    expect(git(tree, 'log', '-1', '--format=%B')).toContain('SoftwareAgents-Execution:');
    expect(new ExecutionRegistry(tree).sessionMap().values().next().value).toMatchObject({
      role: 'developer',
      taskKey: 'SA-999',
    });
    expect(new AuditLog().read('test')).toMatchObject([
      {
        corrupt: false,
        entry: {
          actorType: 'human',
          taskKey: 'SA-999',
          policyDecision: { outcome: 'allow' },
          outcome: { status: 'ready_for_review' },
        },
      },
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rama lista para revisión'));
  });
  it('blocks protected changes before commit and audits require_human', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude', '--write-protected'],
        log: vi.fn(),
      },
    );
    expect(result).toMatchObject({ commit: null, policyDecision: { outcome: 'require_human' } });
    const work = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      expect(work.getTask('SA-999')?.status).toBe('WAITING_HUMAN');
      expect(work.listDecisions()[0]).toMatchObject({ status: 'open', blocks: ['SA-999'] });
      expect(work.listDecisions()[0].context).toContain('.github/workflows/ci.yml');
    } finally {
      work.close();
    }
    expect(git(repo, 'rev-parse', result.branch)).toBe(base);
    expect(new AuditLog().read('test')).toMatchObject([
      {
        entry: {
          action: 'touch_protected_path',
          actorType: 'system',
          taskKey: 'SA-999',
          policyDecision: { outcome: 'require_human' },
          outcome: { status: 'require_human' },
        },
      },
    ]);
    const answered = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      await new HumanDecisions(answered).answer(
        answered.listDecisions()[0].id,
        'review',
        true,
        'fede',
        'A1',
      );
      expect(answered.getTask('SA-999')).toMatchObject({
        status: 'REVIEW',
        lease_owner: null,
        lease_expires_at: null,
        attempt: 0,
      });
      expect(answered.listExecutions()).toEqual([]);
      expect(git(repo, 'rev-parse', result.branch)).toBe(base);
      expect(
        git(path.join(repo, '.worktrees/SA-999'), 'diff', '--cached', '--name-only'),
      ).toContain('.github/workflows/ci.yml');
    } finally {
      answered.close();
    }
  });
  it('checks committed and staged changes, scripts and additive operator paths', () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const config = loadProjectConfig(repo)!;
    const check = (staged = true) =>
      guardProtectedPaths({
        cwd: repo,
        base,
        staged,
        operator: config.operator,
        projectId: 'test',
      });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'test' }));
    git(repo, 'add', '.');
    expect(check().decision.outcome).toBe('allow');
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'evil' } }),
    );
    git(repo, 'add', '.');
    expect(check().paths).toEqual(['package.json']);
    git(repo, 'commit', '-m', 'scripts');
    expect(check(false).decision.outcome).toBe('require_human');
    config.operator.protectedPaths = [];
    fs.writeFileSync(path.join(repo, '.softwareagents/project.yaml'), 'protectedPaths: []');
    git(repo, 'add', '.');
    expect(check().paths).toContain('.softwareagents/project.yaml');
    config.operator.protectedPaths = ['brief.md'];
    fs.writeFileSync(path.join(repo, 'brief.md'), 'changed');
    git(repo, 'add', '.');
    expect(check().paths).toContain('brief.md');
    expect(
      guardProtectedPaths({
        cwd: repo,
        base,
        staged: true,
        operator: config.operator,
        projectId: 'test',
        actor: 'human',
      }).decision.outcome,
    ).toBe('allow');
  });
  it('protects every default, renames out of protected paths, and fails closed on audit errors', () => {
    const files = [
      '.github/workflows/ci.yml',
      '.claude/settings.json',
      '.codex/config.toml',
      '.agents/skills/x/SKILL.md',
      '.mcp.json',
      'server/.mcp.json',
      'server/.codex/config.toml',
      'server/.agents/skills/x/SKILL.md',
      'nested/deep/.codex/config.toml',
      'AGENTS.md',
      'server/AGENTS.md',
      'CLAUDE.md',
      'webview-ui/CLAUDE.md',
      '.softwareagents/agents/developer.yaml',
      'agents/templates/developer.yaml',
      'CODEOWNERS',
      'esbuild.js',
      'scripts/run.js',
    ];
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), 'original');
    }
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'protected base');
    const base = git(repo, 'rev-parse', 'HEAD');
    for (const file of files) fs.writeFileSync(path.join(repo, file), 'changed');
    git(repo, 'mv', 'scripts/run.js', 'ordinary.js');
    git(repo, 'add', '.');
    const operator = loadProjectConfig(repo)!.operator;
    expect(
      parseProjects({ test: { ...operator, protectedPaths: ['extra/**'] } }).test.protectedPaths,
    ).toEqual(['extra/**']);
    const options = { cwd: repo, base, staged: true, operator, projectId: 'test' };
    expect(guardProtectedPaths(options).paths).toEqual(expect.arrayContaining(files));
    expect(() => guardProtectedPaths({ ...options, base: 'missing-base' })).toThrow();
    const append = vi.spyOn(AuditLog.prototype, 'append').mockImplementation(() => {
      throw new Error('audit unavailable');
    });
    try {
      expect(() => guardProtectedPaths(options)).toThrow('audit unavailable');
    } finally {
      append.mockRestore();
    }
  });
  it('does not commit an execution with no changes', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude'],
        log: vi.fn(),
      },
    );
    expect(result.commit).toBeNull();
    expect(git(repo, 'rev-parse', result.branch)).toBe(base);
    expect(new AuditLog().read('test')).toMatchObject([
      { entry: { outcome: { status: 'no_changes' } } },
    ]);
  });
  it('keeps failed execution edits uncommitted and refuses dirty retries', async () => {
    const options = { cwd: repo, binaryArgs: [fake, 'claude', '--write-doc', '--fail'] };
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, options)).rejects.toThrow(
      'Execution failed',
    );
    expect(git(repo, 'rev-parse', 'sa/SA-999-worker')).toBe(git(repo, 'rev-parse', 'main'));
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, options)).rejects.toThrow(
      'dirty',
    );
  });
  it('fails closed without operator executor authorization', async () => {
    fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), '{}');
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, { cwd: repo })).rejects.toThrow(
      'Operator config',
    );
    expect(fs.existsSync(path.join(repo, '.worktrees'))).toBe(false);
  });
});

function tierOperator(
  executor: 'claude' | 'codex' = 'codex',
  maxExecutions: number | undefined = 2,
) {
  const file = path.join(root, '.pixel-agents/config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.projects.test.allowedExecutors = [executor];
  raw.projects.test.binaryPaths = { [executor]: process.execPath };
  raw.projects.test.quotaThresholds = { [executor]: 5 };
  raw.projects.test.concurrency = { maxExecutions, perExecutor: { [executor]: 2 } };
  raw.projects.test.modelTiers = {
    rule: parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
        'utf8',
      ),
    ).tierRule,
    maxTier: 'standard',
    tiers: { standard: { candidates: [{ executor, model: 'test-model' }] } },
  };
  fs.writeFileSync(file, JSON.stringify(raw));
  return raw;
}
it.each(['start', 'prepare', 'cancel'] as const)(
  'retains admitted attempt when %s fails before start',
  async (failure) => {
    const raw = tierOperator();
    if (failure === 'start') {
      raw.projects.test.binaryPaths.codex = path.join(root, 'missing-codex.exe');
      fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), JSON.stringify(raw));
    } else {
      const { WorktreeManager } = await import('../src/executors/worktreeManager.js');
      const create = WorktreeManager.prototype.create;
      vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(async function (
        this: import('../src/executors/worktreeManager.js').WorktreeManager,
        ...args
      ) {
        if (failure === 'prepare') throw new Error('synthetic preparation failure');
        process.emit('SIGTERM');
        return create.apply(this, args);
      });
    }
    await expect(
      runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fake, 'codex'], log: () => {} },
      ),
    ).rejects.toThrow();
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      expect(store.getTask('SA-999')).toMatchObject({ type: 'unknown', status: 'DRAFT' });
      expect(store.listExecutions()).toMatchObject([
        { executor: 'codex', model_id: 'test-model', session_id: null, pid: null },
      ]);
      expect(store.listExecutions()).toHaveLength(1);
      expect(
        new AuditLog().read('test').map((r) => (!r.corrupt ? r.entry.outcome.status : 'corrupt')),
      ).toEqual(['model_selected', failure === 'cancel' ? 'interrupted' : 'failed']);
    } finally {
      store.close();
    }
    expect(readExecutorSlots('codex').count).toBe(0);
  },
);
it.each([false, true])('missing Git identity fails before admission (tiers=%s)', async (tiers) => {
  if (tiers) tierOperator();
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-global-config'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const key of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'EMAIL',
  ])
    vi.stubEnv(key, '');
  const { cliErrorOutput } = await import('../src/cliErrors.js');
  let error: unknown;
  try {
    await runWorker({ task: 'SA-999', brief: 'brief.md' }, { cwd: repo });
  } catch (caught) {
    error = caught;
  }
  expect(cliErrorOutput(error)).toBe(
    'worker run requires valid Git author and committer identity; configure it before launching',
  );
  expect(spawn).not.toHaveBeenCalled();
  expect(readExecutorSlots('claude').count + readExecutorSlots('codex').count).toBe(0);
  expect(fs.existsSync(path.join(repo, '.git/softwareagents/work.sqlite3'))).toBe(false);
  expect(fs.existsSync(path.join(repo, '.git/softwareagents/locks/SA-999.lock'))).toBe(false);
  // No admissions were created either.
  expect(fs.existsSync(path.join(root, '.pixel-agents/executor-slots'))).toBe(false);
});
it('runtime commit failure has no trace and retains staged changes', async () => {
  const execute = vi.mocked(execFileSync).getMockImplementation()!;
  vi.mocked(execFileSync).mockImplementation(((binary: string, args: string[], options: object) => {
    if (binary === 'git' && args.includes('core.hooksPath=') && args.includes('commit'))
      throw new Error('synthetic git commit failure with trace');
    return execute(binary, args, options);
  }) as typeof execFileSync);
  const { cliErrorOutput } = await import('../src/cliErrors.js');
  let error: unknown;
  try {
    await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, binaryArgs: [fake, 'claude', '--write-doc'], log: () => {} },
    );
  } catch (caught) {
    error = caught;
  }
  expect(cliErrorOutput(error)).toBe('Runtime Git commit failed; changes retained for review');
  expect(git(path.join(repo, '.worktrees/SA-999'), 'diff', '--cached', '--name-only')).toContain(
    'worker-result.md',
  );
});
it('unreachable Claude effort does not prevent a Codex worker or direct diagnosis', async () => {
  const raw = tierOperator();
  raw.projects.test.binaryPaths.claude = path.join(root, 'missing-claude.exe');
  raw.projects.test.modelTiers.tiers.deep = {
    candidates: [{ executor: 'claude', model: 'test-deep-model', effort: 'high' }],
  };
  fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), JSON.stringify(raw));
  expect(runQuotaCheck({ executor: 'codex', role: 'developer', json: true }, repo, () => {})).toBe(
    0,
  );
  await runWorker(
    { task: 'SA-999', brief: 'brief.md' },
    { cwd: repo, binaryArgs: [fake, 'codex'], log: () => {} },
  );
  expect(
    vi
      .mocked(execFileSync)
      .mock.calls.some(([binary]) => binary === raw.projects.test.binaryPaths.claude),
  ).toBe(false);
});
it.each([['L'], { size: 'L' }, 3, null, 'l', 'XL'])(
  'invalid board size %j uses and explains fallback',
  async (size) => {
    const raw = tierOperator();
    raw.projects.test.modelTiers.maxTier = 'deep';
    raw.projects.test.modelTiers.tiers.deep = {
      candidates: [{ executor: 'codex', model: 'test-deep-model' }],
    };
    fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), JSON.stringify(raw));
    fs.appendFileSync(
      path.join(repo, '.softwareagents/project.yaml'),
      'legacy:\n  boardFile: board.json\n',
    );
    fs.writeFileSync(
      path.join(repo, 'board.json'),
      JSON.stringify({ items: [{ id: 'SA-999', size }] }),
    );
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      store.createTask({ key: 'SA-999', type: 'architecture' });
      const task = store.getTask('SA-999');
      const { taskModelInputs } = await import('../src/taskModelInputs.js');
      const { selectModelTier } = await import('../src/modelTiers.js');
      const { loadTierRule } = await import('../src/modelPolicy.js');
      const spec = parse(
        fs.readFileSync(path.resolve(__dirname, '../../agents/templates/developer.yaml'), 'utf8'),
      );
      const config = loadProjectConfig(repo)!;
      const inputs = taskModelInputs(config, task, 'SA-999');
      expect(inputs).toEqual({ workType: 'architecture' });
      const { readSelectionSnapshot } = await import('../src/quotaCommand.js');
      expect(
        selectModelTier(
          spec,
          loadTierRule(path.resolve(__dirname, '../..')),
          config.operator.modelTiers!,
          inputs,
          readSelectionSnapshot(config.operator),
        ),
      ).toMatchObject({
        tier: 'standard',
        reason: expect.stringContaining(
          'fallback: missing or invalid work type/size, implementation/M',
        ),
      });
    } finally {
      store.close();
    }
  },
);
