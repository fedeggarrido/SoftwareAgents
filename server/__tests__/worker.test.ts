import { execFileSync, spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it as test, vi } from 'vitest';
import { parse } from 'yaml';

import { AgentStateStore } from '../src/agentStateStore.js';
import { AuditLog } from '../src/auditLog.js';
import { dispatchCli } from '../src/cli.js';
import { parseProjects } from '../src/configPersistence.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { ClaudeCliExecutor } from '../src/executors/claudeCliExecutor.js';
import { CodexCliExecutor } from '../src/executors/codexCliExecutor.js';
import { ExecutionRegistry } from '../src/executors/executionRegistry.js';
import type { ExecutionEvent, Executor } from '../src/executors/executor.js';
import { guardProtectedPaths } from '../src/executors/protectedPaths.js';
import * as executorSlots from '../src/executorSlots.js';
import { readExecutorSlots } from '../src/executorSlots.js';
import { HumanDecisions } from '../src/humanDecisions.js';
import { MachineCapacityPublisher } from '../src/machineCapacity.js';
import { validateModelTiers } from '../src/modelTiers.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { runQuotaCheck } from '../src/quotaCommand.js';
import { runTelemetryCommand, telemetrySummary } from '../src/telemetryCommand.js';
import { telemetryAttributes } from '../src/telemetryCommand.js';
import { acquireTaskLock, parseWorkerArgs, runWorker, workerCommitSubject } from '../src/worker.js';
import { processStartIdentity } from '../src/workstore/processRecovery.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import { readyProbeFor } from './helpers/readyProbe.js';

// These tests spawn real processes and Git; on Windows they take ~10 s each.
vi.setConfig({ testTimeout: 300_000 });

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFileSync: vi.fn(actual.execFileSync) };
});

vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));
// Launch-time availability probes (SA-090) answer as a supported, logged-in CLI
// unless a test overrides them; real CLIs are never run.
vi.mock('../src/executorProbes.js', async (original) => {
  const actual = await original<typeof import('../src/executorProbes.js')>();
  const { readyProbeFor } = await import('./helpers/readyProbe.js');
  return { ...actual, runProbe: readyProbeFor(actual.EXECUTOR_PROBE_CATALOG) };
});

const readyProbe = readyProbeFor(EXECUTOR_PROBE_CATALOG);
vi.mock('../src/constants.js', async (original) => ({
  ...(await original<typeof import('../src/constants.js')>()),
  CLAUDE_OAUTH_REFRESH_WAIT_MS: 1,
}));
// Normal runs require Windows recovery. Keep the POSIX refusal regression below
// active everywhere; the remaining integration cases exercise Windows launches.
const it = test.skipIf(process.platform !== 'win32');
let root: string;
let repo: string;
const fake = path.join(__dirname, 'fixtures/fake-cli.cjs');
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
// Existing regressions assert their original events; SA-039 step coverage is asserted separately.
function legacyAuditEntries() {
  const steps = [
    'lease_acquired',
    'lease_released',
    'task_transitioned',
    'policy_allowed',
    'quota_admitted',
    'worktree_prepared',
    'agent_compiled',
    'running',
    'executor_started',
    'commits_checked',
    'protected_paths_checked',
  ];
  return new AuditLog()
    .read('test')
    .filter((r) => r.corrupt || !steps.includes(r.entry.outcome.status));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex-home'));
  vi.stubEnv('SA_TEST_NO_RATE_LIMIT', '1');
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

describe('worker lifecycle SA-039', () => {
  test.each(['linux', 'darwin'])(
    'refuses %s before claiming work, preparing a worktree or spawning',
    async (platform) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      try {
        Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
        await expect(runWorker({ task: 'SA-999' }, { cwd: repo })).rejects.toThrow(
          'worker run requires Windows: POSIX process-tree recovery is not supported',
        );
        expect(spawn).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
        expect(fs.existsSync(path.join(repo, '.worktrees'))).toBe(false);
        expect(fs.existsSync(path.join(root, '.pixel-agents/executor-slots'))).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', descriptor);
      }
    },
  );

  it.each(['capacity', 'retryAfter'])(
    'keeps the latest known future reset across a subsequent rejection without a reset (%s)',
    async (source) => {
      const reset = Math.floor(Date.now() / 1000) + 3600;
      vi.spyOn(ClaudeCliExecutor.prototype, 'start').mockReturnValue({
        cancel: vi.fn(),
        events: (async function* (): AsyncGenerator<ExecutionEvent> {
          yield source === 'capacity'
            ? {
                type: 'rateLimit',
                message: 'rejected',
                retryAfterSec: 0,
                capacity: {
                  provider: 'claude',
                  status: 'rejected',
                  source: 'claude_stream_json',
                  confidence: 'exact',
                  observedAt: reset - 3600,
                  windows: [{ kind: 'five_hour', usedRatio: 1, resetsAt: reset }],
                },
              }
            : { type: 'rateLimit', message: 'rejected', retryAfterSec: 3600 };
          yield { type: 'rateLimit', message: 'rejected', retryAfterSec: 0 };
          yield { type: 'finished', exitCode: 1, resultSummary: 'quota' };
        })(),
      });
      const result = await runWorker({ task: 'SA-999' }, { cwd: repo, log: () => {} });
      expect(
        result.quotaDecision?.status === 'wait' && result.quotaDecision.resetsAt,
      ).toBeGreaterThanOrEqual(reset);
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(JSON.parse(store.getTask('SA-999')!.blocked_reason!).resetsAt).toBe(
          result.quotaDecision?.status === 'wait' ? result.quotaDecision.resetsAt : null,
        );
      } finally {
        store.close();
        process.exitCode = 0;
      }
    },
  );

  it.each([
    ['auth', 'Authentication failed'],
    ['spawn', 'spawn ENOENT'],
    ['containment', 'Policy violation: containment'],
    ['timeout', 'Timed out'],
  ])(
    'persists a bounded %s diagnostic without model output, paths or prompts',
    async (category, detail) => {
      const secret = `C:/private/prompt/MODEL_SECRET_${'x'.repeat(10000)}`;
      vi.spyOn(ClaudeCliExecutor.prototype, 'start').mockReturnValue({
        cancel: vi.fn(),
        events: (async function* (): AsyncGenerator<ExecutionEvent> {
          yield { type: 'finished', exitCode: 1, resultSummary: `${detail}: ${secret}` };
        })(),
      });
      await expect(runWorker({ task: 'SA-999' }, { cwd: repo, log: () => {} })).rejects.toThrow(
        `category=${category}; exit_code=1`,
      );
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        const task = store.getTask('SA-999')!;
        expect(task.status).toBe('FAILED_RETRYABLE');
        expect(task.blocked_reason).toContain(`category=${category}; exit_code=1`);
        expect(task.blocked_reason!.length).toBeLessThan(200);
        const persisted = JSON.stringify([
          task,
          store.listDomainEvents('SA-999'),
          new AuditLog().read('test'),
        ]);
        expect(persisted).not.toContain('MODEL_SECRET');
        expect(persisted).not.toContain('C:/private');
      } finally {
        store.close();
      }
    },
  );

  it.each([false, true])(
    'pins explicit Codex selection without bypassing Operator configuration (tiers=%s)',
    async (tiers) => {
      const raw = tierOperator('codex');
      raw.projects.test.allowedExecutors = ['claude', 'codex'];
      raw.projects.test.binaryPaths = { claude: process.execPath, codex: process.execPath };
      raw.projects.test.quotaThresholds = { claude: 5, codex: 5 };
      raw.projects.test.concurrency.perExecutor = { claude: 1, codex: 1 };
      raw.projects.test.modelTiers.tiers.standard.candidates.unshift({
        executor: 'claude',
        model: 'test-claude',
      });
      const config = JSON.parse(JSON.stringify(raw));
      if (!tiers) delete config.projects.test.modelTiers;
      fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), JSON.stringify(config));
      await runWorker(
        { task: 'SA-999', executor: 'codex' },
        { cwd: repo, binaryArgs: [fake, 'codex'], log: () => {} },
      );
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(store.listExecutions()).toMatchObject([{ executor: 'codex' }]);
      } finally {
        store.close();
      }
      config.projects.test.allowedExecutors = ['claude'];
      fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), JSON.stringify(config));
      const launches = vi.mocked(spawn).mock.calls.length;
      const denied = await runWorker(
        { task: 'SA-998', executor: 'codex' },
        { cwd: repo, binaryArgs: [fake, 'codex'], log: () => {} },
      );
      expect(denied.quotaDecision?.status).toBe('wait');
      expect(vi.mocked(spawn).mock.calls).toHaveLength(launches);
      process.exitCode = 0;
    },
  );

  it('honors an existing legacy task lock before acquiring a lease', async () => {
    const release = acquireTaskLock(path.join(repo, '.git'), 'SA-999');
    try {
      await expect(runWorker({ task: 'SA-999' }, { cwd: repo })).rejects.toThrow('Task locked');
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(repo, '.git/softwareagents/work.sqlite3'))).toBe(false);
    } finally {
      release();
    }
  });

  it('leases, runs, commits and enters REVIEW with durable execution and a complete audit', async () => {
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md', executor: 'claude' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude', '--write-doc'],
        log: () => {},
      },
    );
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      expect(store.listDomainEvents('SA-999').map((e) => e.to_status)).toEqual([
        'READY',
        'QUEUED',
        'LEASED',
        'RUNNING',
        'REVIEW',
      ]);
      expect(store.getTask('SA-999')).toMatchObject({
        status: 'REVIEW',
        lease_owner: null,
        lease_expires_at: null,
        branch: result.branch,
        worktree_ref: path.join(repo, '.worktrees/SA-999'),
      });
      expect(store.listExecutions()).toMatchObject([
        {
          executor: 'claude',
          pid: expect.any(Number),
          pid_started_at: expect.any(String),
          tree_closed_at: expect.any(String),
          system_prompt_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
      expect(result.commit).toBeTruthy();
      expect(fs.existsSync(path.join(repo, '.git/softwareagents/executions.jsonl'))).toBe(false);
      expect(
        new AuditLog().read('test').map((r) => (r.corrupt ? 'corrupt' : r.entry.outcome.status)),
      ).toEqual([
        'lease_acquired',
        'policy_allowed',
        'quota_admitted',
        'worktree_prepared',
        'agent_compiled',
        'running',
        'executor_started',
        'commits_checked',
        'protected_paths_checked',
        'ready_for_review',
        'task_transitioned',
        'lease_released',
      ]);
    } finally {
      store.close();
    }
  });

  it('compiles the task role and accepts task-only CLI input', async () => {
    expect(parseWorkerArgs(['run', '--task', 'SA-999', '--executor', 'claude'])).toEqual({
      task: 'SA-999',
      executor: 'claude',
    });
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    store.createTask({ key: 'SA-999', type: 'review', agent_role: 'reviewer', status: 'READY' });
    store.close();
    const argv = path.join(root, 'argv.json');
    vi.stubEnv('SA_TEST_ARGV', argv);
    await runWorker({ task: 'SA-999' }, { cwd: repo, binaryArgs: [fake, 'claude'], log: () => {} });
    const flags: string[] = JSON.parse(fs.readFileSync(argv, 'utf8'));
    expect(flags[flags.indexOf('--append-system-prompt') + 1]).toContain('Role: reviewer.');
    expect(flags[flags.indexOf('--allowedTools') + 1]).not.toContain('Write');
    expect([...new ExecutionRegistry(repo).sessionMap().values()]).toMatchObject([
      { role: 'reviewer' },
    ]);
  });

  it('records real quota rejection and reset, while ignoring historical reset observations', async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude', '--future-limit'],
        log: () => {},
      },
    );
    expect(result.quotaDecision).toMatchObject({
      status: 'wait',
      cause: 'quota',
      resetsAt: expect.any(Number),
    });
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      const task = store.getTask('SA-999')!;
      expect(task.status).toBe('WAITING_QUOTA');
      expect(JSON.parse(task.blocked_reason!)).toMatchObject({
        reason: 'rejected',
        resetsAt: expect.any(Number),
      });
      expect(JSON.parse(task.blocked_reason!).resetsAt).toBeGreaterThan(before);
      expect(task.lease_owner).toBeNull();
      expect(store.listExecutions()).toHaveLength(1);
    } finally {
      store.close();
      process.exitCode = 0;
    }
  });

  it('persists the failure reason and releases the lease', async () => {
    await expect(
      runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        {
          cwd: repo,
          binaryArgs: [fake, 'claude', '--fail'],
          log: () => {},
        },
      ),
    ).rejects.toThrow('Execution failed');
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      expect(store.getTask('SA-999')).toMatchObject({
        status: 'FAILED_RETRYABLE',
        lease_owner: null,
        blocked_reason: expect.stringContaining('Execution failed'),
      });
      expect(store.listDomainEvents('SA-999').at(-1)?.to_status).toBe('FAILED_RETRYABLE');
    } finally {
      store.close();
    }
  });

  it('reads historical JSONL sessions alongside SQLite sessions', async () => {
    const legacy = path.join(repo, '.git/softwareagents/executions.jsonl');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const content =
      JSON.stringify({ sessionId: 'legacy', executionId: 'old', role: 'qa', taskKey: 'SA-998' }) +
      '\n';
    fs.writeFileSync(legacy, content);
    await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, binaryArgs: [fake, 'claude'], log: () => {} },
    );
    const sessions = new ExecutionRegistry(repo).sessionMap();
    expect(sessions.get('legacy')).toMatchObject({ executionId: 'old', role: 'qa' });
    expect([...sessions.values()]).toHaveLength(2);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(content);
  });

  test.skipIf(process.platform !== 'win32').for(['before_launch', 'running'] as const)(
    'heartbeats and recovers a killed worker through SA-026 (%s)',
    { timeout: 30000 },
    async (phase, context) => {
      if (phase === 'running' && process.env.SA_SKIP_TASKKILL_TEST === '1') context.skip();
      const bundle = path.join(root, 'worker.cjs');
      buildSync({
        entryPoints: [path.resolve(__dirname, '../src/worker.ts')],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent',
      });
      fs.cpSync(path.resolve(__dirname, '../../agents'), path.join(root, 'agents'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(root, 'hooks'));
      fs.copyFileSync(
        path.resolve(__dirname, '../../dist/hooks/containment-hook.js'),
        path.join(root, 'hooks/containment-hook.js'),
      );
      const release = path.join(root, 'release');
      const launches = path.join(root, 'launches');
      const child = spawn(
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
      );
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      let rootProcess: { pid: number; identity: string } | undefined;
      let recovered = false;
      try {
        await new Promise((resolve) => child.once('message', resolve));
        const preparing = new Promise((resolve) => child.once('message', resolve));
        child.send({ task: 'SA-999', repo, fake, holdBeforeLaunch: phase === 'before_launch' });
        if (phase === 'before_launch') await preparing;
        else await vi.waitFor(() => expect(fs.existsSync(launches)).toBe(true), { timeout: 15000 });
        if (phase === 'running') {
          const execution = store.listExecutions()[0];
          rootProcess = { pid: execution.pid!, identity: execution.pid_started_at! };
        }
        const initial = store.getTask('SA-999')!.lease_expires_at!;
        expect(store.getTask('SA-999')?.status).toBe(phase === 'running' ? 'RUNNING' : 'LEASED');
        await vi.waitFor(
          () => expect(store.getTask('SA-999')!.lease_expires_at!).not.toBe(initial),
          { timeout: 10000 },
        );
        child.kill('SIGKILL');
        await exited;
        if (rootProcess)
          expect(await processStartIdentity(rootProcess.pid)).toBe(rootProcess.identity);
        // Advance only the expired lease in the isolated DB, avoiding a minute-long test.
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
        try {
          db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE key = ?').run(
            new Date(0).toISOString(),
            'SA-999',
          );
        } finally {
          db.close();
        }
        expect(await store.recoverExpiredLeases()).toMatchObject([
          { status: 'FAILED_RETRYABLE', lease_owner: null },
        ]);
        recovered = true;
        if (rootProcess) expect(await processStartIdentity(rootProcess.pid)).toBeNull();
        if (phase === 'running') expect(store.listExecutions()[0].tree_closed_at).toBeTruthy();
        else expect(store.listExecutions()).toEqual([]);
        expect(store.listDomainEvents('SA-999').at(-1)).toMatchObject({ reason: 'Lease expired' });
        expect(fs.existsSync(path.join(repo, '.git/softwareagents/locks/SA-999.lock'))).toBe(false);
      } finally {
        fs.writeFileSync(release, 'release');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        // Failed assertions/recovery must not strand the detached fixture. Only
        // touch its recorded PID when its creation identity still matches.
        if (
          !recovered &&
          rootProcess &&
          (await processStartIdentity(rootProcess.pid)) === rootProcess.identity
        )
          process.kill(rootProcess.pid, 'SIGKILL');
        store.close();
      }
    },
  );
});

describe('Operator verifier cascade SA-103', () => {
  const fixture = path.join(__dirname, 'fixtures/fake-cascade-cli.cjs');
  function configure() {
    const raw = tierOperator('claude');
    raw.projects.test.modelTiers = {
      ...raw.projects.test.modelTiers,
      maxTier: 'deep',
      tiers: Object.fromEntries(
        ['economy', 'standard', 'deep'].map((tier) => [
          tier,
          {
            candidates: [{ executor: 'claude', model: `test-${tier}` }],
          },
        ]),
      ),
      cascade: {
        enabled: true,
        startTier: 'economy',
        maxEscalations: 2,
        verifiers: {
          'SA-999': {
            allowedPaths: ['worker-result.md', 'failed.tmp', 'ignored.tmp'],
            commands: [{ argv: [process.execPath, fixture, 'verify'], timeoutMs: 5000 }],
          },
        },
      },
    };
    raw.projects.test.telemetry = {
      prices: { 'claude-test': { input: 1, output: 2, cacheRead: 0.1, cacheCreate: 1 } },
    };
    vi.stubEnv('SA_TEST_TELEMETRY', '1');
    vi.stubEnv('CASCADE_SECRET', 'must not reach verifier');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.tmp\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore test output');
    return raw;
  }
  function save(raw: unknown) {
    fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), JSON.stringify(raw));
  }
  const run = (solve = 'economy') =>
    runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fixture, 'claude', `--solve-at=${solve}`],
        log: () => {},
      },
    );
  function attempts() {
    return fs
      .readFileSync(path.join(repo, '.git/softwareagents/cascade-attempts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }
  function rootSpans() {
    return fs
      .readFileSync(path.join(repo, '.git/softwareagents/telemetry/test/spans.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).resourceSpans[0].scopeSpans[0].spans[0])
      .filter((s) => s.name === 'invoke_agent');
  }
  it('uses the default for an unbound Task and resets between attempts', async () => {
    const raw = configure();
    const cascade = raw.projects.test.modelTiers.cascade;
    cascade.defaultVerifier = { commands: cascade.verifiers['SA-999'].commands };
    cascade.verifiers = {};
    save(raw);
    await run('standard');
    expect(attempts().map((r) => [r.tier, r.verifiers])).toEqual([
      ['economy', ['fail']],
      ['standard', ['pass']],
    ]);
  });
  it('prefers the Task verifier over a failing default', async () => {
    const raw = configure();
    raw.projects.test.modelTiers.cascade.defaultVerifier = {
      commands: [{ argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 5000 }],
    };
    save(raw);
    await run();
    expect(attempts().map((r) => r.verifiers)).toEqual([['pass']]);
  });
  it.each(['prettier', 'eslint', 'tsc', 'tests'])(
    'supplies bounded failure detail and retries the correct tier for %s',
    async (kind) => {
      const raw = configure();
      const command = path.join(root, kind === 'tests' ? 'vitest.cjs' : `${kind}.js`);
      fs.writeFileSync(
        command,
        `console.error('worker-result.md:1 rule/example: expected value, token=private-value'); process.exit(1);`,
      );
      raw.projects.test.modelTiers.cascade.verifiers['SA-999'].commands = [
        { argv: [process.execPath, command], timeoutMs: 5000 },
      ];
      save(raw);
      const log = path.join(root, 'feedback.jsonl');
      await expect(
        runWorker(
          { task: 'SA-999', brief: 'brief.md' },
          {
            cwd: repo,
            binaryArgs: [fixture, 'claude', '--solve-at=economy', '--feedback-log', log],
            log: () => {},
          },
        ),
      ).rejects.toThrow(`verifier_failed: ${kind}`);
      const style = ['prettier', 'eslint'].includes(kind);
      expect(attempts().map((r) => r.tier)).toEqual(
        style ? ['economy', 'economy'] : ['economy', 'standard', 'deep'],
      );
      const feedback = fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(feedback[0]).toEqual([]);
      expect(feedback[1][0]).toMatchObject({
        verifier: kind,
        result: 'fail',
        files: ['worker-result.md'],
      });
      expect(feedback[1][0].detail).toContain('rule/example: expected value');
      expect(feedback[1][0].detail).not.toContain('private-value');
      expect(feedback[1][0].command[1]).toContain('<runtime>');
      expect(JSON.stringify(attempts())).not.toContain('rule/example');
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(store.getTask('SA-999')?.blocked_reason).toContain(`verifier_failed: ${kind}`);
      } finally {
        store.close();
      }
    },
  );
  it('skips vitestRelated without TS/JS changes and accepts the attempt', async () => {
    const raw = configure();
    raw.projects.test.modelTiers.cascade.verifiers = {};
    raw.projects.test.modelTiers.cascade.defaultVerifier = {
      commands: [{ vitestRelated: true, timeoutMs: 5000 }],
    };
    save(raw);
    await run();
    expect(attempts().map((r) => r.verifiers)).toEqual([['pass']]);
    expect(vi.mocked(spawn).mock.calls.some((call) => call[1]?.includes('related'))).toBe(false);
  });
  it('rejects protected changes with the default before running commands or escalating', async () => {
    const raw = configure();
    raw.projects.test.modelTiers.cascade.defaultVerifier = {
      commands: raw.projects.test.modelTiers.cascade.verifiers['SA-999'].commands,
    };
    raw.projects.test.modelTiers.cascade.verifiers = {};
    save(raw);
    await expect(
      runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fixture, 'claude', '--write-protected'], log: () => {} },
      ),
    ).rejects.toThrow('criteria_tampered');
    expect(attempts().map((r) => [r.result, r.verifiers])).toEqual([['criteria_tampered', []]]);
    expect(vi.mocked(spawn).mock.calls.some((call) => call[1]?.includes('verify'))).toBe(false);
  });
  it.each(['verifier_result', 'finally_fallback'])(
    'releases slots, task lock and listeners when the attempt registry is locked (%s)',
    async (mode) => {
      save(configure());
      const lock = path.join(repo, '.git/softwareagents/cascade-attempts.jsonl.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, 'another writer');
      const listeners = ['SIGINT', 'SIGTERM'].map((s) => process.listeners(s));
      const log = vi.fn();
      await expect(
        runWorker(
          { task: 'SA-999', brief: 'brief.md' },
          {
            cwd: repo,
            binaryArgs: [
              fixture,
              'claude',
              '--solve-at=economy',
              ...(mode === 'finally_fallback' ? ['--write-protected'] : []),
            ],
            log,
          },
        ),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readExecutorSlots('claude').count).toBe(0);
      expect(() => acquireTaskLock(path.join(repo, '.git'), 'SA-999')()).not.toThrow();
      expect(['SIGINT', 'SIGTERM'].map((s) => process.listeners(s))).toEqual(listeners);
      expect(fs.readFileSync(lock, 'utf8')).toBe('another writer');
      expect(log).toHaveBeenCalledWith('Cascade attempt persistence failed: EEXIST');
      expect(
        legacyAuditEntries().some(
          (r) =>
            !r.corrupt &&
            r.entry.outcome.status === 'cascade_attempt_persistence_error' &&
            r.entry.outcome.code === 'EEXIST',
        ),
      ).toBe(true);
      expect(rootSpans().map((s) => s.status.code)).toEqual([2]);
    },
  );
  it('retries transient contention on the attempt registry', async () => {
    save(configure());
    const open = fs.openSync;
    let collisions = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith('cascade-attempts.jsonl.lock') && collisions++ < 2)
        throw Object.assign(new Error('busy'), { code: 'EEXIST' });
      return open(...args);
    });
    await run();
    expect(collisions).toBe(3);
    expect(attempts().map((r) => r.result)).toEqual(['pass']);
  });
  it.each(['require_human', 'commit_error'])(
    'closes a verified attempt with its final %s outcome',
    async (mode) => {
      const raw = configure();
      if (mode === 'require_human') raw.projects.test.protectedPaths = ['worker-result.md'];
      save(raw);
      if (mode === 'commit_error') {
        const actual = await vi.importActual<typeof import('child_process')>('child_process');
        vi.mocked(execFileSync).mockImplementation((...args: Parameters<typeof execFileSync>) => {
          if (args[0] === 'git' && (args[1] as string[]).includes('commit'))
            throw new Error('synthetic commit failure');
          return actual.execFileSync(...args);
        });
      }
      const pending = runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        {
          cwd: repo,
          binaryArgs: [fixture, 'claude', '--solve-at=economy'],
          log: () => {},
        },
      );
      if (mode === 'commit_error')
        await expect(pending).rejects.toThrow('Runtime Git commit failed');
      else expect((await pending).policyDecision?.outcome).toBe('require_human');
      expect(attempts().map((r) => r.result)).toEqual(['pass']);
      const spans = rootSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].status.code).toBe(2);
      expect(telemetryAttributes(spans[0])['softwareagents.execution.status']).toBe(
        mode === 'require_human' ? mode : 'error',
      );
      expect(telemetryAttributes(spans[0])['gen_ai.usage.input_tokens']).toBe(33);
    },
  );
  it.each(['economy', 'standard', 'deep'])(
    'solves at %s with isolated attempts, audit, registry and spans',
    async (solve) => {
      save(configure());
      const result = await run(solve);
      expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
      const expected = ['economy', 'standard', 'deep'].slice(
        0,
        ['economy', 'standard', 'deep'].indexOf(solve) + 1,
      );
      const records = attempts();
      expect(records.map((r) => r.tier)).toEqual(expected);
      expect(records.map((r) => r.verifiers)).toEqual(
        expected.map((t) => [t === solve ? 'pass' : 'fail']),
      );
      expect(records[0].usage.input).toBe(33);
      expect(typeof records[0].usage.costUsd).toBe('number');
      expect(fs.existsSync(path.join(repo, '.worktrees/SA-999/failed.tmp'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.worktrees/SA-999/ignored.tmp'))).toBe(false);
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(store.listExecutions()).toHaveLength(expected.length);
      } finally {
        store.close();
      }
      const audit = new AuditLog()
        .read('test')
        .filter((r) => !r.corrupt && r.entry.outcome.status === 'cascade_attempt');
      expect(audit).toHaveLength(expected.length);
      expect(JSON.stringify(audit)).not.toContain('VERIFIER_OUTPUT_MUST_NOT_BE_STORED');
      const spans = fs
        .readFileSync(path.join(repo, '.git/softwareagents/telemetry/test/spans.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).resourceSpans[0].scopeSpans[0].spans[0])
        .filter((s) => s.name === 'invoke_agent');
      expect(spans.map((s) => telemetryAttributes(s)['softwareagents.cascade.attempt'])).toEqual(
        expected.map((_, i) => i + 1),
      );
      if (spans.length > 1)
        expect(telemetryAttributes(spans[1])['softwareagents.cascade.escalated_from']).toBe(
          'economy',
        );
    },
  );
  it.each(['maxEscalations', 'maxTier', 'zero'])(
    'stops at %s without committing failed work',
    async (limit) => {
      const raw = configure();
      if (limit === 'maxEscalations') raw.projects.test.modelTiers.cascade.maxEscalations = 1;
      else if (limit === 'zero') raw.projects.test.modelTiers.cascade.maxEscalations = 0;
      else raw.projects.test.modelTiers.maxTier = 'standard';
      save(raw);
      await expect(run('deep')).rejects.toThrow('Cascade failed');
      expect(attempts().map((r) => r.tier)).toEqual(
        limit === 'zero' ? ['economy'] : ['economy', 'standard'],
      );
      expect(readExecutorSlots('claude').count).toBe(0);
    },
  );
  it('skips a tier excluded by executorLevels', async () => {
    const raw = configure();
    raw.projects.test.executorLevels = { claude: ['economy', 'deep'] };
    save(raw);
    await run('deep');
    expect(attempts().map((r) => r.tier)).toEqual(['economy', 'deep']);
  });
  it.each(['absent', 'disabled', 'unbound', 'below-start', 'repo-board'])(
    'preserves normal selection when %s',
    async (mode) => {
      const raw = configure();
      if (mode === 'absent') delete raw.projects.test.modelTiers.cascade;
      if (mode === 'disabled') raw.projects.test.modelTiers.cascade.enabled = false;
      if (mode === 'unbound') raw.projects.test.modelTiers.cascade.verifiers = {};
      if (mode === 'below-start') raw.projects.test.modelTiers.cascade.startTier = 'deep';
      if (mode === 'repo-board' || mode === 'unbound') {
        const request = {
          enabled: true,
          startTier: 'economy',
          verifiers: { 'SA-999': { commands: [{ argv: ['untrusted-program'] }] } },
          defaultVerifier: { commands: [{ vitestRelated: true, timeoutMs: 1000 }] },
        };
        if (mode === 'repo-board') delete raw.projects.test.modelTiers.cascade;
        fs.appendFileSync(
          path.join(repo, '.softwareagents/project.yaml'),
          'legacy:\n  boardFile: board.json\n',
        );
        fs.writeFileSync(
          path.join(repo, 'board.json'),
          JSON.stringify({
            modelTiers: { cascade: request },
            items: [{ id: 'SA-999', size: 'M', cascade: request, verifiers: request.verifiers }],
          }),
        );
        fs.mkdirSync(path.join(repo, '.softwareagents/agents'), { recursive: true });
        fs.writeFileSync(
          path.join(repo, '.softwareagents/agents/model-policy.yaml'),
          'cascade: ' + JSON.stringify(request),
        );
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'untrusted cascade declarations');
      }
      save(raw);
      await run('standard');
      expect(fs.existsSync(path.join(repo, '.git/softwareagents/cascade-attempts.jsonl'))).toBe(
        false,
      );
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(store.listExecutions().map((r) => r.model_tier)).toEqual(['standard']);
      } finally {
        store.close();
      }
    },
  );
  it('waits for an unavailable next tier without falling back or trying deep', async () => {
    const raw = configure();
    raw.projects.test.allowedExecutors = ['claude', 'codex'];
    raw.projects.test.binaryPaths.codex = path.join(root, 'missing-codex.exe');
    raw.projects.test.modelTiers.tiers.standard.candidates = [
      { executor: 'codex', model: 'test-standard' },
    ];
    save(raw);
    const result = await run('deep');
    expect(result.availabilityBlock?.code).toBe('not_installed');
    expect(attempts().map((r) => r.tier)).toEqual(['economy']);
    process.exitCode = 0;
  });
  it('does not retry executor failures', async () => {
    save(configure());
    await expect(
      runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fixture, 'claude', '--fail'], log: () => {} },
      ),
    ).rejects.toThrow('Cascade failed');
    expect(attempts().map((r) => r.result)).toEqual(['executor_error']);
  });
  test.skipIf(process.platform !== 'win32' || process.env.SA_SKIP_TASKKILL_TEST === '1')(
    'stops on verifier timeout after closing its tree without escalating the agent',
    async () => {
      const raw = configure();
      const pids = path.join(root, 'verifier-pids.json');
      raw.projects.test.modelTiers.cascade.verifiers['SA-999'].commands = [
        { argv: [process.execPath, fixture, 'verify', 'timeout', pids], timeoutMs: 1000 },
      ];
      save(raw);
      try {
        await expect(run('standard')).rejects.toThrow('Verifier infrastructure: command timed out');
        expect(attempts().map((r) => r.tier)).toEqual(['economy']);
        expect(attempts().map((r) => r.result)).toEqual(['infrastructure_error']);
        const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
        try {
          expect(store.getTask('SA-999')).toMatchObject({ status: 'FAILED_RETRYABLE', attempt: 0 });
        } finally {
          store.close();
        }
        for (const pid of Object.values(JSON.parse(fs.readFileSync(pids, 'utf8'))) as number[])
          await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
      } finally {
        if (fs.existsSync(pids))
          for (const pid of Object.values(JSON.parse(fs.readFileSync(pids, 'utf8'))) as number[]) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* Already closed. Test-only fixture cleanup. */
            }
          }
      }
    },
    20000,
  );
  it('fails integrity before executing a verifier on forbidden changes', async () => {
    save(configure());
    await expect(
      runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fixture, 'claude', '--write-protected'], log: () => {} },
      ),
    ).rejects.toThrow('forbidden path');
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0].verifiers).toEqual([]);
  });
  it('rejects unknown authority fields, invalid bounds and repository verifier declarations', () => {
    const policy = configure().projects.test.modelTiers;
    for (const patch of [
      { startTier: 'unknown' },
      { maxEscalations: 3 },
      { shell: true },
      {
        verifiers: {
          'SA-999': {
            allowedPaths: ['package.json'],
            commands: [{ argv: ['node'], timeoutMs: 100 }],
          },
        },
      },
    ])
      expect(() =>
        validateModelTiers({ ...policy, cascade: { ...policy.cascade, ...patch } }),
      ).toThrow();
    const repoPolicy = path.join(repo, '.softwareagents/agents');
    fs.mkdirSync(repoPolicy, { recursive: true });
    fs.writeFileSync(
      path.join(repoPolicy, 'model-policy.yaml'),
      'cascade: { enabled: true, verifiers: {} }',
    );
    const raw = tierOperator('claude');
    save(raw);
    expect(loadProjectConfig(repo)?.operator.modelTiers?.cascade).toBeUndefined();
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
  vi.mocked(spawn).mockClear();
  vi.unstubAllEnvs();
  // A failed timeout test deliberately retains the verifier dependency junction.
  const unlinkLinks = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fs.unlinkSync(file);
      else if (stat.isDirectory()) unlinkLinks(file);
    }
  };
  unlinkLinks(root);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('supervised worker', () => {
  it('never retries OAuth output without confirmed executor closure', async () => {
    const start = vi.spyOn(ClaudeCliExecutor.prototype, 'start').mockReturnValue({
      cancel: vi.fn(),
      events: (async function* (): AsyncGenerator<ExecutionEvent> {
        yield {
          type: 'output',
          stream: 'stderr',
          text: 'another Claude Code process is refreshing it',
        };
      })(),
    });
    await expect(runWorker({ task: 'SA-999' }, { cwd: repo, log: () => {} })).rejects.toThrow(
      'Execution failed',
    );
    expect(start).toHaveBeenCalledTimes(1);
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      expect(store.getTask('SA-999')).toMatchObject({
        status: 'RUNNING',
        lease_owner: expect.any(String),
      });
      expect(readExecutorSlots('claude').count).toBe(1);
    } finally {
      store.close();
    }
  });
  it.each(['once', 'always', 'credentials', 'cancel'] as const)(
    'handles Claude OAuth refresh contention: %s',
    async (mode) => {
      const attempts = path.join(root, 'oauth-attempts');
      vi.stubEnv('SA_TEST_OAUTH_LOG', attempts);
      const probe = vi.fn(readyProbe);
      const run = () =>
        runWorker(
          { task: 'SA-999', brief: 'brief.md' },
          {
            cwd: repo,
            probe,
            binaryArgs: [
              fake,
              'claude',
              mode === 'credentials'
                ? '--credential-failure'
                : mode === 'always'
                  ? '--oauth-refresh-always'
                  : '--oauth-refresh-once',
              '--write-doc',
            ],
            log: (line) => {
              if (mode === 'cancel' && line.includes('OAuth refresh contention'))
                process.emit('SIGINT');
            },
          },
        );
      if (mode === 'once') expect((await run()).commit).toMatch(/^[a-f0-9]{40}$/);
      else
        await expect(run()).rejects.toThrow(
          mode === 'always'
            ? 'oauth_refresh_contention'
            : mode === 'cancel'
              ? 'interrupted'
              : 'Execution failed',
        );
      const expectedAttempts = mode === 'once' ? 2 : mode === 'always' ? 3 : 1;
      expect(fs.readFileSync(attempts, 'utf8')).toHaveLength(expectedAttempts);
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(store.listExecutions()).toHaveLength(expectedAttempts);
        expect(store.listExecutions().every((e) => e.tree_closed_at !== null)).toBe(true);
        expect(new Set(store.listExecutions().map((e) => e.key)).size).toBe(expectedAttempts);
        expect(store.getTask('SA-999')?.lease_owner).toBeNull();
        const entries = new AuditLog()
          .read('test')
          .filter((r) => !r.corrupt)
          .map((r) => r.entry);
        expect(entries.filter((r) => r.outcome.status === 'quota_admitted')).toHaveLength(
          expectedAttempts,
        );
        expect(entries.filter((r) => r.outcome.status === 'oauth_refresh_retry')).toHaveLength(
          expectedAttempts - 1,
        );
        expect(probe.mock.calls.length).toBeGreaterThanOrEqual(expectedAttempts * 2);
        expect(readExecutorSlots('claude').count).toBe(0);
      } finally {
        store.close();
      }
    },
    20000,
  );
  it('records all worker phases and summary is read-only even with an enabled, unreachable exporter', async () => {
    const file = path.join(root, '.pixel-agents/config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.projects.test.telemetry = {
      otlp: { enabled: true, endpoint: 'http://127.0.0.1:1/v1/traces' },
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude', '--write-doc'],
        log: () => {},
      },
    );
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    const summary = await telemetrySummary(path.join(repo, '.git'), 'test');
    expect(summary.total.executions).toBe(1);
    expect(summary.total.phasesMs.preparation).toBeGreaterThan(0);
    expect(summary.total.phasesMs.execution).toBeGreaterThan(0);
    expect(summary.total.phasesMs.commit_guards).toBeGreaterThan(0);
    vi.mocked(spawn).mockClear();
    const log = vi.fn();
    await runTelemetryCommand(['summary', '--task', 'SA-999', '--json'], repo, log);
    expect(JSON.parse(log.mock.calls[0][0]).total.executions).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });
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
    const binary = path.join(root, 'claude-without-effort.exe');
    fs.writeFileSync(binary, 'synthetic binary; availability probes are injected');
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
  it('removing the catalog after saving blocked levels rejects worker and quota legacy paths', async () => {
    const raw = tierOperator('claude');
    raw.projects.test.executorLevels = { claude: [] };
    const file = path.join(root, '.pixel-agents/config.json');
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(loadProjectConfig(repo)?.operator.executorLevels).toEqual({ claude: [] });
    delete raw.projects.test.modelTiers;
    fs.writeFileSync(file, JSON.stringify(raw));
    for (const selectExecutor of [false, true]) {
      await expect(
        runWorker({ task: 'SA-999', brief: 'brief.md', selectExecutor }, { cwd: repo }),
      ).rejects.toThrow('executorLevels: modelTiers catalog is required');
      expect(() =>
        runQuotaCheck(
          {
            selectExecutor,
            executor: selectExecutor ? undefined : 'claude',
            role: 'developer',
            json: true,
          },
          repo,
        ),
      ).toThrow('executorLevels: modelTiers catalog is required');
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
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
            pid: expect.any(Number),
            session_id: selected === 'codex' ? 'fake-codex-session' : expect.any(String),
          },
        ]);
      } finally {
        store.close();
      }
      expect(legacyAuditEntries().slice(0, 1)).toMatchObject([
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
    const records = legacyAuditEntries();
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

  it.each(['claude', 'codex'] as const)(
    '%s registration failure finishes once, releases worker locks and admits an immediate retry',
    async (selected) => {
      const config = tierOperator(selected, 1);
      config.projects.test.concurrency.perExecutor = { [selected]: 1 };
      fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), JSON.stringify(config));
      const marker = path.join(root, 'cli-launched.json');
      vi.stubEnv('SA_TEST_ARGV', marker);

      // Keep admission and the real slot; fail only the registration callback invoked
      // by the spawned supervisor, before it can ACK and launch the fake CLI.
      const acquire = executorSlots.acquireExecutorSlot;
      const register = vi.fn((_pid: number) => {
        throw new Error('Cannot verify launch process');
      });
      const admission = vi
        .spyOn(executorSlots, 'acquireExecutorSlot')
        .mockImplementationOnce((...args) => {
          const slot = acquire(...args);
          expect(slot).toBeDefined();
          vi.spyOn(slot!, 'setExecutionProcess').mockImplementation(register);
          return slot;
        });
      const prototype: Executor =
        selected === 'claude' ? ClaudeCliExecutor.prototype : CodexCliExecutor.prototype;
      const start = prototype.start;
      const events: ExecutionEvent[] = [];
      vi.spyOn(prototype, 'start').mockImplementation(function (this: Executor, request) {
        const handle = start.call(this, request);
        return {
          ...handle,
          events: (async function* () {
            for await (const event of handle.events) {
              events.push(event);
              yield event;
            }
          })(),
        };
      });
      const run = () =>
        runWorker(
          { task: 'SA-999', brief: 'brief.md' },
          { cwd: repo, binaryArgs: [fake, selected], log: () => {} },
        );
      const lock = path.join(repo, '.git/softwareagents/locks/SA-999.lock');

      await expect(run()).rejects.toThrow(
        'Execution failed or was interrupted; changes retained for review',
      );
      expect(register).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
      expect(register.mock.calls[0][0]).toBeGreaterThan(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(events.filter((event) => event.type === 'finished')).toEqual([
        { type: 'finished', exitCode: 1, resultSummary: 'Cannot verify launch process' },
      ]);
      expect(readExecutorSlots(selected).count).toBe(0);
      expect(fs.existsSync(lock)).toBe(false);

      // The one-shot fault is gone: this same task must acquire fresh locks and
      // reach the real CLI, proving the marker and admission checks are meaningful.
      events.length = 0;
      await expect(run()).resolves.toMatchObject({ branch: 'sa/SA-999-worker', commit: null });
      expect(admission).toHaveBeenCalledTimes(2);
      expect(register).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toContain(
        selected === 'claude' ? '-p' : 'exec',
      );
      expect(events.filter((event) => event.type === 'finished')).toMatchObject([
        { type: 'finished', exitCode: 0 },
      ]);
      expect(readExecutorSlots(selected).count).toBe(0);
      expect(fs.existsSync(lock)).toBe(false);
    },
  );

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
      // SA-062: the bundle needs the containment hook beside it, as in dist/.
      fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, '../../dist/hooks/containment-hook.js'),
        path.join(root, 'hooks/containment-hook.js'),
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
      // SA-062: the bundle needs the containment hook beside it, as in dist/.
      fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, '../../dist/hooks/containment-hook.js'),
        path.join(root, 'hooks/containment-hook.js'),
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
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(store.listExecutions()).toMatchObject([{ executor: selected, model_id: '' }]);
      } finally {
        store.close();
      }
      expect(fs.existsSync(path.join(repo, '.git/softwareagents/executions.jsonl'))).toBe(false);
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
    expect(legacyAuditEntries()).toMatchObject([
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
    expect(legacyAuditEntries()).toMatchObject([
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
      expect(answered.listExecutions()).toMatchObject([{ tree_closed_at: expect.any(String) }]);
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
    expect(legacyAuditEntries()).toMatchObject([{ entry: { outcome: { status: 'no_changes' } } }]);
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
// A binary missing at start is now caught by the SA-090 spawn probe (see below).
it.each(['prepare', 'cancel'] as const)(
  'retains admitted attempt when %s fails before start',
  async (failure) => {
    tierOperator();
    {
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
      expect(store.getTask('SA-999')).toMatchObject({
        type: 'unknown',
        status: 'FAILED_RETRYABLE',
      });
      expect(store.listExecutions()).toMatchObject([
        { executor: 'codex', model_id: 'test-model', session_id: null, pid: null },
      ]);
      expect(store.listExecutions()).toHaveLength(1);
      expect(
        legacyAuditEntries().map((r) => (!r.corrupt ? r.entry.outcome.status : 'corrupt')),
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

// SA-088: an availability change lands between the worker's config read and its
// admission (here: while it checks the Git identity). Admission must re-read the
// Operator authority and drop the stale selection instead of launching.
it.each(['legacy', 'tier'] as const)(
  '%s admission drops a run whose Operator policy changed after it started',
  async (mode) => {
    if (mode === 'tier') tierOperator('claude');
    const file = path.join(root, '.pixel-agents/config.json');
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'git' && args[0] === 'var' && args[1] === 'GIT_AUTHOR_IDENT') {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        raw.projects.test.allowedExecutors = [];
        fs.writeFileSync(file, JSON.stringify(raw));
      }
      return actual.execFileSync(cmd, args, opts as never);
    }) as typeof execFileSync);
    const log = vi.fn();
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, binaryArgs: [fake, 'claude', '--write-doc'], log },
    );
    expect(result.commit).toBeNull();
    expect(result.quotaDecision).toMatchObject({
      status: 'wait',
      reason: expect.stringContaining('changed since this run started'),
    });
    expect(fs.existsSync(path.join(repo, '.worktrees/SA-999'))).toBe(false);
    expect(readExecutorSlots('claude').count).toBe(0);
  },
);

// SA-090: availability is revalidated at the real spawn; no executor → one Human Decision.
describe('executor selection and drain (SA-090)', () => {
  const configFile = () => path.join(root, '.pixel-agents/config.json');
  const setAllowed = (allowed: string[]) => {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    raw.projects.test.allowedExecutors = allowed;
    fs.writeFileSync(configFile(), JSON.stringify(raw));
  };
  const statuses = () =>
    legacyAuditEntries().map((r) => (r.corrupt ? 'corrupt' : r.entry.outcome.status));
  afterEach(() => {
    process.exitCode = 0;
  });

  it.each([false, true])(
    'level-disabled unsupported Claude effort preserves normal selection (all excluded: %s)',
    async (allExcluded) => {
      const raw = tierOperator();
      raw.projects.test.allowedExecutors = ['claude', 'codex'];
      const binary = path.join(root, 'claude-with-disabled-effort.exe');
      fs.writeFileSync(binary, 'synthetic binary; availability probes are injected');
      raw.projects.test.binaryPaths.claude = binary;
      raw.projects.test.executorLevels = { claude: [], ...(allExcluded ? { codex: [] } : {}) };
      raw.projects.test.modelTiers.tiers.standard.candidates.unshift({
        executor: 'claude',
        model: 'test-claude',
        effort: 'high',
      });
      fs.writeFileSync(configFile(), JSON.stringify(raw));

      const log = vi.fn();
      expect(
        runQuotaCheck({ selectExecutor: true, role: 'developer', json: true }, repo, log),
      ).toBe(allExcluded ? 3 : 0);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
        executor: allExcluded ? null : 'codex',
        tier: 'standard',
        downgrades: [],
      });
      const result = await runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fake, 'codex'], log: () => {} },
      );
      expect(vi.mocked(execFileSync).mock.calls.some(([file]) => file === binary)).toBe(false);
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        if (allExcluded) {
          expect(result.availabilityBlock?.code).toBe('no_allowed_level');
          expect(process.exitCode).toBe(3);
          expect(store.getTask('SA-999')?.status).toBe('WAITING_HUMAN');
          expect(store.listExecutions()).toEqual([]);
          expect(spawn).not.toHaveBeenCalled();
          expect(fs.existsSync(path.join(repo, '.worktrees'))).toBe(false);
          expect(readExecutorSlots('claude').count + readExecutorSlots('codex').count).toBe(0);
        } else {
          expect(result.quotaDecision).toBeUndefined();
          expect(store.listExecutions()).toMatchObject([
            { executor: 'codex', model_id: 'test-model' },
          ]);
          expect(store.listDecisions()).toEqual([]);
        }
      } finally {
        store.close();
      }
    },
  );

  it('legacy worker with all executors OFF waits for a human with exit 3 and no probe', async () => {
    setAllowed([]);
    const probe = vi.fn(readyProbe);
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, log: () => {}, probe },
    );
    expect(result).toMatchObject({
      availabilityBlock: { code: 'no_enabled_executor', decisionId: expect.any(String) },
      quotaDecision: { status: 'wait', cause: 'disabled' },
    });
    expect(process.exitCode).toBe(3);
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, '.worktrees'))).toBe(false);
    expect(readExecutorSlots('claude').count + readExecutorSlots('codex').count).toBe(0);
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      expect(store.getTask('SA-999')?.status).toBe('WAITING_HUMAN');
      expect(store.listDecisions()).toHaveLength(1);
      expect(store.listExecutions()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('legacy worker still respects policy denial before escalating with all executors OFF', async () => {
    setAllowed([]);
    const policy = await import('../src/policy.js');
    vi.spyOn(policy, 'evaluatePolicy').mockReturnValue({
      outcome: 'deny',
      reason: 'synthetic autonomy denial',
    });
    const probe = vi.fn(readyProbe);
    await expect(
      runWorker({ task: 'SA-999', brief: 'brief.md' }, { cwd: repo, log: () => {}, probe }),
    ).rejects.toThrow('Operator config');
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, '.git/softwareagents/work.sqlite3'))).toBe(true);
    expect(statuses()).toEqual(['denied']);
  });

  it.each(['missing', 'unsupported', 'unknown'] as const)(
    'observes Claude %s before effort validation and admits eligible Codex',
    async (installation) => {
      const raw = tierOperator();
      raw.projects.test.allowedExecutors = ['claude', 'codex'];
      const binary = path.join(root, 'claude-with-unverified-effort.exe');
      // resolveExecutable verifies existence before the injected probe.
      fs.writeFileSync(binary, 'synthetic binary; availability probes are injected');
      raw.projects.test.binaryPaths.claude = binary;
      raw.projects.test.modelTiers.tiers.standard.candidates.unshift({
        executor: 'claude',
        model: 'test-claude',
        effort: 'high',
      });
      fs.writeFileSync(configFile(), JSON.stringify(raw));
      const probe = async (file: string, args: readonly string[]) =>
        file === fs.realpathSync(binary)
          ? installation === 'missing'
            ? { code: 'missing' as const, output: '' }
            : installation === 'unknown'
              ? { code: null, output: '' }
              : { code: 0, output: args.includes('--version') ? '0.0.1' : '' }
          : readyProbe(file, args);
      const result = await runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fake, 'codex'], log: () => {}, probe },
      );
      expect(vi.mocked(execFileSync).mock.calls.some(([file]) => file === binary)).toBe(false);
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(result.quotaDecision).toBeUndefined();
        expect(store.listExecutions()).toMatchObject([
          { executor: 'codex', model_id: 'test-model' },
        ]);
        expect(store.listDecisions()).toEqual([]);
      } finally {
        store.close();
      }
    },
  );

  it.each(['missing', 'unsupported'] as const)(
    'only unavailable Claude with effort follows WAITING_HUMAN (%s)',
    async (installation) => {
      const raw = tierOperator('claude');
      raw.projects.test.modelTiers.tiers.standard.candidates[0].effort = 'high';
      fs.writeFileSync(configFile(), JSON.stringify(raw));
      const result = await runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        {
          cwd: repo,
          log: () => {},
          probe: async () =>
            installation === 'missing'
              ? { code: 'missing', output: '' }
              : { code: 0, output: '0.0.1' },
        },
      );
      expect(result.availabilityBlock?.code).toBe(
        installation === 'missing' ? 'not_installed' : 'unsupported_version',
      );
      expect(process.exitCode).toBe(3);
      expect(fs.existsSync(path.join(repo, '.worktrees'))).toBe(false);
      const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
      try {
        expect(store.getTask('SA-999')?.status).toBe('WAITING_HUMAN');
      } finally {
        store.close();
      }
    },
  );

  it('all executors disabled waits for a human once, deduplicated, and reopens when enabled', async () => {
    tierOperator('claude');
    setAllowed([]);
    const argv = path.join(root, 'argv.json');
    vi.stubEnv('SA_TEST_ARGV', argv);
    const run = () =>
      runWorker(
        { task: 'SA-999', brief: 'brief.md' },
        { cwd: repo, binaryArgs: [fake, 'claude'], log: () => {} },
      );
    const first = await run();
    expect(process.exitCode).toBe(3);
    expect(first).toMatchObject({
      commit: null,
      quotaDecision: { status: 'wait', cause: 'disabled' },
      availabilityBlock: { code: 'no_enabled_executor', decisionId: expect.any(String) },
    });
    const second = await run();
    expect(second.availabilityBlock?.decisionId).toBe(first.availabilityBlock?.decisionId);
    expect(fs.existsSync(argv)).toBe(false);
    expect(readExecutorSlots('claude').count).toBe(0);
    let store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      expect(store.listDecisions()).toHaveLength(1);
      expect(store.listDecisions()[0]).toMatchObject({ status: 'open', blocks: ['SA-999'] });
      expect(store.getTask('SA-999')?.status).toBe('WAITING_HUMAN');
      expect(store.listExecutions()).toEqual([]);
    } finally {
      store.close();
    }
    setAllowed(['claude']);
    process.exitCode = 0;
    const third = await run();
    expect(process.exitCode).toBe(0);
    expect(third.commit).toBeNull();
    expect(fs.existsSync(argv)).toBe(true);
    store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      expect(store.listDecisions()[0]).toMatchObject({
        status: 'answered',
        answer: 'reevaluate',
        answeredBy: 'system',
      });
      expect(store.getTask('SA-999')?.status).toBe('REVIEW');
      expect(store.listExecutions()).toHaveLength(1);
    } finally {
      store.close();
    }
    expect(statuses()).toEqual([
      'availability_blocked',
      'availability_blocked',
      'availability_blocked',
      'availability_restored_pending',
      'availability_restored',
      'model_selected',
      'no_changes',
    ]);
  });

  it.each([
    ['missing', 'not_installed'],
    ['logged out', 'auth_required'],
  ] as const)('a CLI %s escalates instead of launching', async (_name, code) => {
    const probe = async (file: string, args: readonly string[]) =>
      code === 'not_installed' && args.includes('--version')
        ? { code: 'missing' as const, output: '' }
        : args[0] === 'auth'
          ? { code: 0, output: '{"loggedIn":false}' }
          : readyProbe(file, args);
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, binaryArgs: [fake, 'claude'], log: () => {}, probe },
    );
    expect(result.availabilityBlock?.code).toBe(code);
    expect(process.exitCode).toBe(3);
    expect(fs.existsSync(path.join(repo, '.worktrees/SA-999'))).toBe(false);
    expect(readExecutorSlots('claude').count).toBe(0);
  });

  it('an unproven installation waits for a new probe without a Human Decision', async () => {
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude'],
        log: () => {},
        probe: async () => ({ code: null, output: '' }),
      },
    );
    expect(result.quotaDecision).toMatchObject({ status: 'wait', cause: 'availability' });
    expect(result).not.toHaveProperty('availabilityBlock');
    expect(process.exitCode).toBe(3);
    expect(fs.existsSync(path.join(repo, '.git/softwareagents/work.sqlite3'))).toBe(true);
  });

  it('a toggle before the spawn invalidates the admitted selection: no CLI, slot released', async () => {
    const { setExecutorAvailability } = await import('../src/executorAvailability.js');
    const { operatorRevision } = await import('../src/executorState.js');
    const { WorktreeManager } = await import('../src/executors/worktreeManager.js');
    const create = WorktreeManager.prototype.create;
    vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(async function (
      this: import('../src/executors/worktreeManager.js').WorktreeManager,
      ...args
    ) {
      const tree = await create.apply(this, args);
      const operator = loadProjectConfig(repo)!.operator;
      expect(
        setExecutorAvailability(
          {
            projectId: 'test',
            executorId: 'codex',
            enabled: true,
            requestId: 'r1',
            expectedRevision: operatorRevision(operator),
          },
          { privileged: true, boundProjectId: 'test' },
        ).status,
      ).toBe('applied');
      return tree;
    });
    const argv = path.join(root, 'argv.json');
    vi.stubEnv('SA_TEST_ARGV', argv);
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, binaryArgs: [fake, 'claude', '--write-doc'], log: () => {} },
    );
    expect(result).toMatchObject({
      commit: null,
      quotaDecision: {
        status: 'wait',
        cause: 'selection',
        reason: expect.stringContaining('changed since this run started'),
      },
    });
    expect(process.exitCode).toBe(3);
    expect(fs.existsSync(argv)).toBe(false);
    expect(readExecutorSlots('claude').count).toBe(0);
    expect(fs.existsSync(path.join(repo, '.git/softwareagents/locks/SA-999.lock'))).toBe(false);
    expect(statuses()).toContain('selection_invalidated');
  });

  it('a binary gone after admission is caught by the spawn probe, before any start', async () => {
    tierOperator();
    let gone = false;
    const { WorktreeManager } = await import('../src/executors/worktreeManager.js');
    const create = WorktreeManager.prototype.create;
    vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(async function (
      this: import('../src/executors/worktreeManager.js').WorktreeManager,
      ...args
    ) {
      gone = true;
      return create.apply(this, args);
    });
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'codex'],
        log: () => {},
        probe: async (file, args) =>
          gone && args.includes('--version')
            ? { code: 'missing', output: '' }
            : readyProbe(file, args),
      },
    );
    expect(result.quotaDecision).toMatchObject({
      cause: 'selection',
      reason: 'codex: not_installed',
    });
    expect(spawn).not.toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['-e']),
      expect.anything(),
    );
    expect(readExecutorSlots('codex').count).toBe(0);
    const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      // The admitted attempt is retained, never reused; a new run selects again.
      expect(store.listExecutions()).toMatchObject([{ executor: 'codex', pid: null }]);
    } finally {
      store.close();
    }
    expect(statuses()).toEqual(['model_selected', 'selection_invalidated']);
    // Preparation is retained for retry, but the choice and Execution are fresh.
    const tree = path.join(repo, '.worktrees/SA-999');
    const base = git(tree, 'rev-parse', 'HEAD');
    expect(git(tree, 'symbolic-ref', '--short', 'HEAD')).toBe('sa/SA-999-worker');
    expect(git(tree, 'status', '--porcelain')).toBe('');
    const raw = tierOperator();
    raw.projects.test.modelTiers.tiers.standard.candidates[0].model = 'test-reselected-model';
    fs.writeFileSync(configFile(), JSON.stringify(raw));
    vi.mocked(WorktreeManager.prototype.create).mockImplementation(function (
      this: import('../src/executors/worktreeManager.js').WorktreeManager,
      ...args
    ) {
      return create.apply(this, args).then((result) => {
        expect(result.reused).toBe(true);
        return result;
      });
    });
    process.exitCode = 0;
    const retry = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, binaryArgs: [fake, 'codex'], log: () => {}, probe: readyProbe },
    );
    expect(retry).toMatchObject({ branch: 'sa/SA-999-worker', commit: null });
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(base);
    expect(process.exitCode).toBe(0);
    const retried = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
    try {
      const attempts = retried.listExecutions();
      expect(attempts).toHaveLength(2);
      expect(attempts.map((e) => e.model_id).sort()).toEqual([
        'test-model',
        'test-reselected-model',
      ]);
      expect(attempts.find((e) => e.model_id === 'test-model')?.session_id).toBeNull();
    } finally {
      retried.close();
    }
  });

  it('a toggle after the spawn frontier never cancels the running execution', async () => {
    const { setExecutorAvailability } = await import('../src/executorAvailability.js');
    const { operatorRevision } = await import('../src/executorState.js');
    const rename = fs.renameSync;
    let toggled: string | undefined;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      // The slot records the supervisor right after the spawn revalidation passed.
      if (
        !toggled &&
        String(target).endsWith('0.lock') &&
        JSON.parse(fs.readFileSync(String(source), 'utf8')).child
      ) {
        toggled = 'pending';
        rename(source, target);
        const operator = loadProjectConfig(repo)!.operator;
        toggled = setExecutorAvailability(
          {
            projectId: 'test',
            executorId: 'claude',
            enabled: false,
            requestId: 'r-off',
            expectedRevision: operatorRevision(operator),
          },
          { privileged: true, boundProjectId: 'test' },
        ).status;
        return;
      }
      return rename(source, target);
    });
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      { cwd: repo, binaryArgs: [fake, 'claude', '--write-doc'], log: () => {} },
    );
    expect(toggled).toBe('applied');
    expect(loadProjectConfig(repo)!.operator.allowedExecutors).toEqual([]);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(process.exitCode).not.toBe(3);
    expect(readExecutorSlots('claude').count).toBe(0);
  });
});
