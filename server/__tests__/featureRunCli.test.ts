import { DatabaseSync } from 'node:sqlite';

import { execFileSync, spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as architect from '../src/architect.js';
import { runFeatureCommand } from '../src/commands/feature.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { assertFeatureRunIngress, type FeatureRunSummary, runFeature } from '../src/featureRun.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { reviewerDecision } from '../src/reviewer.js';
import { taskBranchBaseFile } from '../src/taskBranchBase.js';
import { recoverFeatureTaskRebase } from '../src/taskRebase.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';
import { developerVerifierConfig } from './helpers/developerVerifierConfig.js';
import { readyProbeFor } from './helpers/readyProbe.js';

vi.setConfig({ testTimeout: 90_000 });
// Style is covered with real tools in developerCli/qaCli. Keep these scheduling cases
// within the 90 s budget while retaining real acceptance-test execution and Git.
vi.mock('../src/developer.js', async (original) => ({
  ...(await original<typeof import('../src/developer.js')>()),
  developerStyleCommands: () => [],
  developerVerifier: () => ({ commands: [] }),
}));
// The real Windows identity/termination boundary has its own suite and the separate
// kill/restart harness below. Avoid dozens of PowerShell startups in scheduler cases.
vi.mock('../src/workstore/processRecovery.js', async (original) => {
  const actual = await original<typeof import('../src/workstore/processRecovery.js')>();
  return {
    ...actual,
    processStartIdentity: async (pid: number) => {
      try {
        process.kill(pid, 0);
        return '123456789';
      } catch {
        return null;
      }
    },
    terminateExecutionTree: async (pid: number, identity: string) => {
      if (identity !== '123456789') return actual.terminateExecutionTree(pid, identity);
      // Only fixture supervisor roots registered under the synthetic identity.
      try {
        process.kill(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
  };
});
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
let root: string;
let repo: string;
let launches: string;
const feature = 'FEAT-001';
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
const storeFor = () => openWorkStore({ repositoryPath: repo, projectId: 'test' });
const options = (scenario = 'valid') => ({
  binaryArgs: [path.join(__dirname, 'fixtures/fake-feature-run-cli.cjs'), scenario, launches],
  probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
});
const run = async (scenario = 'valid', args: string[] = []) => {
  let summary!: FeatureRunSummary;
  await runFeatureCommand(
    ['run', feature, ...args, '--json'],
    repo,
    (line) => {
      summary = JSON.parse(line) as FeatureRunSummary;
    },
    options(scenario),
  );
  if (['failed', 'interrupted'].includes(summary.status)) {
    const store = await storeFor();
    try {
      // Include recovery evidence in assertion failures when Windows helpers are
      // denied by the sandbox. Never bypass process-closure checks to pass a test.
      summary.message += `; recovery diagnostics: ${JSON.stringify({
        leases: store.listLeaseRecoveries(),
        events: store.listTasks().flatMap((task) => store.listDomainEvents(task.key)),
        pending: store.listWorkerPublications(feature).map((p) => p.task),
      })}`;
    } finally {
      store.close();
    }
  }
  return summary;
};
const rows = () =>
  fs
    .readFileSync(launches, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(
      (row) =>
        JSON.parse(row) as { role: string; task?: string; data: { previousFailure?: unknown } },
    );
async function spec(approve = true) {
  await runFeatureCommand(['spec', feature, '--request', 'request.md'], repo, () => {}, options());
  if (approve) await runFeatureCommand(['approve', feature], repo, () => {});
}
beforeEach(async (context) => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-run-'));
  repo = path.join(root, 'repo');
  launches = path.join(root, 'launches.jsonl');
  fs.mkdirSync(path.join(repo, '.softwareagents/agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.softwareagents/brain'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('SA_TEST_NO_RATE_LIMIT', '1');
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  for (const role of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${role}_NAME`, 'Test');
    vi.stubEnv(`GIT_${role}_EMAIL`, 'test@example.invalid');
  }
  git('init', '-b', 'main');
  developerVerifierConfig(repo);
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(
    path.join(repo, '.softwareagents/agents/model-policy.yaml'),
    'high_reasoning:\n  - executor: claude\nstandard_coding:\n  - executor: claude\nreview:\n  - executor: codex\n  - executor: claude\n',
  );
  fs.writeFileSync(path.join(repo, 'request.md'), 'Audit view');
  fs.writeFileSync(
    path.join(repo, 'tsconfig.json'),
    '{"compilerOptions":{"noEmit":true},"include":["server/src/**/*.ts"]}',
  );
  git('add', '.');
  git('commit', '-m', 'fixture');
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        test: {
          autonomyLevel: 'A1',
          allowedExecutors: ['claude', 'codex'],
          binaryPaths: { claude: process.execPath, codex: process.execPath },
          quotaThresholds: { claude: 0, codex: 0 },
          concurrency: { maxExecutions: 1, perExecutor: { claude: 1, codex: 1 } },
        },
      },
    }),
  );
  if (context.task.name.startsWith('completes three dependent tasks')) {
    // Approved spec and design are durable fixtures, outside the task-execution budget.
    await spec();
    await runFeatureCommand(['design', feature], repo, () => {}, options());
  }
}, 90_000);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

// Exercise the scheduler without an Executor or Windows process helpers, so the
// distinction between a worker diagnostic and a runner signal is always tested.
describe('feature run interruption authority', () => {
  const publishSpec = (store: WorkStore) =>
    store.createFeature({
      key: feature,
      doc_path: '.softwareagents/brain/features/FEAT-001.yaml',
      git_sha: git('rev-parse', 'main'),
      status: 'in_review',
    });
  const claim = async (store: WorkStore) => {
    const task = await store.claim(feature, 'fixture-worker');
    return store.transition(feature, task.version, 'RUNNING', 'Fixture launch', 'fixture-worker');
  };
  it('retries a cancelled worker diagnostic without treating it as an operator signal', async () => {
    const store = await storeFor();
    try {
      store.createTask({ key: feature, type: 'unknown', status: 'READY' });
      const invoke = vi.fn(async () => {
        const task = await claim(store);
        if (invoke.mock.calls.length === 1) {
          await store.transition(
            feature,
            task.version,
            'FAILED_RETRYABLE',
            'Worker failed (category=cancelled; exit_code=unknown)',
            'fixture-worker',
          );
          throw new Error('injected publication interruption');
        }
        publishSpec(store);
        await store.transition(
          feature,
          task.version,
          'REVIEW',
          'Fixture persisted',
          'fixture-worker',
        );
      });
      const result = await runFeature(
        store,
        loadProjectConfig(repo, true)!,
        feature,
        'request.md',
        invoke,
        () => {},
      );
      expect(result).toMatchObject({ status: 'WAITING_HUMAN', exit_code: 3 });
      expect(result.message).toContain('Review the spec');
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });
  it.each([
    ['SIGINT', false],
    ['SIGTERM', false],
    ['SIGINT', true],
    ['SIGTERM', true],
  ] as const)(
    'stops on runner %s even if the worker succeeds=%s, then permits resume',
    async (signal, succeeds) => {
      const store = await storeFor();
      const listeners = process.listenerCount(signal);
      try {
        store.createTask({ key: feature, type: 'unknown', status: 'READY' });
        const invoke = vi.fn(async () => {
          const task = await claim(store);
          publishSpec(store);
          await store.transition(
            feature,
            task.version,
            succeeds ? 'REVIEW' : 'FAILED_RETRYABLE',
            'Fixture persisted; category=executor; exit_code=unknown',
            'fixture-worker',
          );
          process.emit(signal);
          if (!succeeds) throw new Error('publication failed without a cancellation diagnostic');
        });
        const config = loadProjectConfig(repo, true)!;
        expect(
          await runFeature(store, config, feature, 'request.md', invoke, () => {}),
        ).toMatchObject({
          status: 'interrupted',
          exit_code: 130,
        });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(store.getFeatureRun(feature)?.owner).toBeNull();
        expect(process.listenerCount(signal)).toBe(listeners);
        expect(await runFeature(store, config, feature, undefined, invoke, () => {})).toMatchObject(
          {
            status: 'WAITING_HUMAN',
            exit_code: 3,
          },
        );
        expect(invoke).toHaveBeenCalledTimes(1);
      } finally {
        store.close();
      }
    },
  );
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'stops on %s during recovery before launching a role',
    async (signal) => {
      const store = await storeFor();
      const listeners = process.listenerCount(signal);
      try {
        vi.spyOn(store, 'recoverExpiredLeases').mockImplementationOnce(async () => {
          process.emit(signal);
          return [];
        });
        const invoke = vi.fn();
        expect(
          await runFeature(
            store,
            loadProjectConfig(repo, true)!,
            feature,
            'request.md',
            invoke,
            () => {},
          ),
        ).toMatchObject({
          status: 'interrupted',
          exit_code: 130,
        });
        expect(invoke).not.toHaveBeenCalled();
        expect(process.listenerCount(signal)).toBe(listeners);
        expect(store.getFeatureRun(feature)?.owner).toBeNull();
      } finally {
        store.close();
      }
    },
  );
});

describe.skipIf(process.platform !== 'win32')(
  'feature run with fake CLIs and real WorkStore/Git/verifiers',
  () => {
    it('completes three dependent tasks including qa-author, preserves main and resumes without duplicate effects', async () => {
      const main = git('rev-parse', 'main');
      const result = await run();
      expect(result).toMatchObject({
        status: 'ready_to_merge',
        exit_code: 0,
        integration_branch: 'sa/FEAT-001-integration',
      });
      expect(result.tasks).toHaveLength(3);
      expect(result.tasks.every((t) => t.status === 'DONE' && t.integrated)).toBe(true);
      expect(git('rev-parse', 'main')).toBe(main);
      expect(git('show', `${result.integration_sha}:server/src/step1.ts`)).toContain('step1');
      expect(git('show', `${result.integration_sha}:server/src/step2.ts`)).toContain('step2');
      expect(git('show', `${result.integration_sha}:server/__tests__/step3.test.ts`)).toContain(
        'step2',
      );
      const store = await storeFor();
      try {
        expect(store.getFeature(feature)?.status).toBe('ready_to_merge');
        const tasks = result.tasks.map((t) => store.getTask(t.key)!);
        expect(tasks[1].review_ref!.base).toBe(tasks[0].review_ref!.sha);
        expect(tasks[2].review_ref!.base).toBe(tasks[1].review_ref!.sha);
      } finally {
        store.close();
      }
      expect(
        rows()
          .filter((r) => ['developer', 'reviewer', 'qa'].includes(r.role))
          .map((r) => r.task),
      ).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3].map((n) => `FEAT-001-T0${n}`));
      const before = rows().length;
      // Simulate a crash after Git published T03 but before the SQLite checkpoint committed.
      const replay = await storeFor();
      try {
        const state = replay.getFeatureRun(feature)!.state;
        const previous = replay.getTask('FEAT-001-T02')!.review_ref!.sha;
        state.head = previous;
        state.pending = { task: 'FEAT-001-T03', before: previous, after: result.integration_sha };
        state.status = 'running';
        delete state.integrated['FEAT-001-T03'];
        await replay.claimFeatureRun(feature, 'crash-fixture', state);
        await replay.saveFeatureRun(feature, 'crash-fixture', state);
        await replay.releaseFeatureRun(feature, 'crash-fixture');
      } finally {
        replay.close();
      }
      expect((await run()).integration_sha).toBe(result.integration_sha);
      expect(rows()).toHaveLength(before);
    });
    it('creates the spec, stops at human approval, and continues only after explicit approval', async () => {
      expect(await run('valid', ['--request', 'request.md'])).toMatchObject({
        status: 'WAITING_HUMAN',
        exit_code: 3,
      });
      expect(rows().map((r) => r.role)).toEqual(['requirements']);
      expect((await run()).status).toBe('WAITING_HUMAN');
      await runFeatureCommand(['approve', feature], repo, () => {});
      await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
      const store = await storeFor();
      try {
        const input = reviewerDecision('FEAT-001-T01', 'fixture');
        await store.openOrJoinIdleDecision(input);
        expect((await run()).status).toBe('WAITING_HUMAN');
        expect(store.listDecisions()[0].status).toBe('open');
        expect(rows().some((r) => r.role === 'developer')).toBe(false);
        await store.resolveDecision(input.id, 'inspect', 'operator', () => {});
      } finally {
        store.close();
      }
      expect((await run()).status).toBe('ready_to_merge');
    });
    it('performs bounded request_changes rework and finishes', async () => {
      await spec();
      expect((await run('rework')).status).toBe('ready_to_merge');
      expect(
        rows().filter((r) => r.role === 'developer' && r.task === 'FEAT-001-T01'),
      ).toHaveLength(2);
      const store = await storeFor();
      try {
        expect(store.getTask('FEAT-001-T01')!.review_reports!.map((r) => r.report.verdict)).toEqual(
          ['request_changes', 'approve'],
        );
      } finally {
        store.close();
      }
    });
    it('rebases a QA task onto the integration base and preserves an equivalent approval', async () => {
      await spec();
      await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
      await runFeatureCommand(['develop', feature], repo, () => {}, options('single'));
      await runFeatureCommand(['review', feature], repo, () => {}, options('single'));
      fs.writeFileSync(path.join(repo, 'base-update.txt'), 'An independent base update\n');
      git('add', 'base-update.txt');
      git('commit', '-m', 'fixture base update');
      const main = git('rev-parse', 'main');
      const result = await run('single');
      expect(result.status, result.message).toBe('ready_to_merge');
      expect(rows().filter((r) => r.role === 'reviewer')).toHaveLength(1);
      expect(git('rev-parse', 'main')).toBe(main);
      const store = await storeFor();
      try {
        expect(store.getTask('FEAT-001-T01')!.review_ref!.base).toBe(main);
        expect(
          store.listDomainEvents('FEAT-001-T01').some((e) => e.reason.startsWith('Task rebase ')),
        ).toBe(true);
        const event = store
          .listDomainEvents('FEAT-001-T01')
          .find((e) => e.reason.startsWith('Task rebase '))!;
        const journal = taskBranchBaseFile(repo, 'sa/FEAT-001-T01-developer') + '.rebase';
        fs.writeFileSync(journal, event.reason.slice('Task rebase '.length));
        const before = store.getTask('FEAT-001-T01')!.review_ref;
        await recoverFeatureTaskRebase(store, loadProjectConfig(repo, true)!, 'FEAT-001-T01');
        expect(fs.existsSync(journal)).toBe(false);
        expect(store.getTask('FEAT-001-T01')!.review_ref).toEqual(before);
      } finally {
        store.close();
      }
    });
    it.each(['retry', 'always-fail'])(
      'bounds retryable failures and forwards persisted context (%s)',
      async (scenario) => {
        await spec();
        const result = await run(scenario);
        expect(result.status, result.message).toBe(
          scenario === 'retry' ? 'ready_to_merge' : 'failed',
        );
        const attempts = rows().filter((r) => r.role === 'developer');
        expect(attempts).toHaveLength(scenario === 'retry' ? 2 : 3);
        expect(attempts[1].data.previousFailure).toBeTruthy();
        const before = rows().length;
        if (scenario === 'always-fail') {
          expect((await run(scenario)).status).toBe('failed');
          expect(rows()).toHaveLength(before);
        }
      },
    );
    it('stops on quota, does not exhaust retries while waiting, and reevaluates on the next run', async () => {
      const file = path.join(root, '.pixel-agents/config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.projects.test.concurrency.perExecutor.claude = 0;
      fs.writeFileSync(file, JSON.stringify(config));
      for (let n = 0; n < 4; n++)
        expect(await run('single', n ? [] : ['--request', 'request.md'])).toMatchObject({
          status: 'WAITING_QUOTA',
          exit_code: 3,
        });
      expect(fs.existsSync(launches)).toBe(false);
      config.projects.test.concurrency.perExecutor.claude = 1;
      fs.writeFileSync(file, JSON.stringify(config));
      expect((await run('single')).status).toBe('WAITING_HUMAN');
      expect(rows().map((r) => r.role)).toEqual(['requirements']);
    });
    it('recovers a partially written Architect artifact without rerunning Architect or duplicating ADRs', async () => {
      await spec();
      vi.spyOn(architect, 'writeArchitectArtifacts').mockImplementationOnce((tree, files) => {
        const [relative, content] = [...files][0];
        fs.mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true });
        fs.writeFileSync(
          path.join(tree, relative),
          content.slice(0, Math.floor(content.length / 2)),
        );
        throw new Error('injected interruption during runtime artifact write');
      });
      const result = await run('single');
      expect(result.status, result.message).toBe('ready_to_merge');
      expect(rows().filter((r) => r.role === 'architect')).toHaveLength(1);
      expect(
        fs.readdirSync(path.join(repo, '.worktrees/FEAT-001/.softwareagents/brain/adr')),
      ).toHaveLength(1);
    });
    it('recovers RUNNING before spawn and a dead runner lock, then resumes a commit published before review_ref registration', async () => {
      await spec();
      await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
      const store = await storeFor();
      try {
        const main = git('rev-parse', 'main');
        await store.claimFeatureRun(feature, 'crashed', {
          branch: 'sa/FEAT-001-integration',
          initial_main: main,
          head: main,
          request: 'request.md',
          integrated: {},
          attempts: {},
          status: 'running',
          active: { action: 'develop', task: 'FEAT-001-T01', version: 0 },
        });
        const task = await store.claim('FEAT-001-T01', 'dead-worker', 10_000);
        await store.transition(task.key, task.version, 'RUNNING', 'Executor launch', 'dead-worker');
        const deadPid = Number(
          execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
            encoding: 'utf8',
            windowsHide: true,
          }),
        );
        const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
        db.prepare('UPDATE feature_runs SET pid = ?').run(deadPid);
        db.prepare(
          "UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE key = 'FEAT-001-T01'",
        ).run();
        db.close();
        // Simulate the commit/ref success followed by a crash before its SQLite review_ref write.
        const prototype = Object.getPrototypeOf(store) as WorkStore;
        vi.spyOn(prototype, 'setTaskReview').mockRejectedValueOnce(
          new Error('injected publication interruption'),
        );
        const result = await run('single');
        expect(result.status, result.message).toBe('ready_to_merge');
        expect(rows().filter((r) => r.role === 'developer')).toHaveLength(1);
        expect(git('rev-list', '--count', `${main}..${result.integration_sha}`)).toBe('1');
        expect(store.getTask(task.key)!.review_reports).toHaveLength(1);
        expect(store.getTask(task.key)!.test_reports).toHaveLength(1);
        expect(store.listWorkerPublications(feature)).toEqual([]);
      } finally {
        store.close();
      }
    });
    it('refuses a second runner under an atomic WorkStore lock and rejects managed ingress and parallel config', async () => {
      const store = await storeFor();
      try {
        const config = loadProjectConfig(repo, true)!;
        await store.claimFeatureRun(feature, 'first', {
          branch: 'sa/FEAT-001-integration',
          initial_main: git('rev-parse', 'main'),
          head: git('rev-parse', 'main'),
          request: 'request.md',
          integrated: {},
          attempts: {},
          status: 'running',
        });
        await expect(run()).rejects.toThrow('another orchestrator');
        await store.releaseFeatureRun(feature, 'first');
        vi.stubEnv('SA_MANAGED_EXECUTION', 'agent');
        await expect(run()).rejects.toThrow('human ingress');
        vi.stubEnv('SA_MANAGED_EXECUTION', undefined);
        config.operator.orchestrator = { maxConcurrentTasks: 2 };
        fs.writeFileSync(
          path.join(root, '.pixel-agents/config.json'),
          JSON.stringify({ projects: { test: config.operator } }),
        );
        await expect(run()).rejects.toThrow('SA-037');
      } finally {
        store.close();
      }
    });
    it('allows managed ingress only for the exact complete SA-003 Operator argv', () => {
      vi.stubEnv('SA_AUTOPILOT', '1');
      const previous = process.argv;
      const argv = [
        process.execPath,
        path.join(repo, 'dist/cli.js'),
        'feature',
        'run',
        feature,
        '--json',
      ];
      const file = path.join(root, '.pixel-agents/config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.companyAutopilot = { [repo]: { command: argv } };
      fs.writeFileSync(file, JSON.stringify(config));
      try {
        process.argv = argv;
        expect(() =>
          assertFeatureRunIngress(loadProjectConfig(repo, true)!, ['run', feature, '--json']),
        ).not.toThrow();
        process.argv = [...argv, '--request', 'request.md'];
        expect(() =>
          assertFeatureRunIngress(loadProjectConfig(repo, true)!, ['run', feature, '--json']),
        ).toThrow('exact Operator');
      } finally {
        process.argv = previous;
      }
    });
    it.skipIf(process.env.SA_SKIP_TASKKILL_TEST === '1')(
      'kills a runner in RUNNING, refuses a simultaneous runner, and resumes via SA-026 without duplicate commits/reports',
      async () => {
        await spec();
        await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
        const main = git('rev-parse', 'main');
        const harness = path.resolve(__dirname, '../../dist/feature-run-test.cjs');
        buildSync({
          entryPoints: [path.join(__dirname, 'fixtures/featureRunHarness.ts')],
          outfile: harness,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'node22',
        });
        const child = spawn(
          process.execPath,
          [harness, repo, path.join(__dirname, 'fixtures/fake-feature-run-cli.cjs'), launches],
          { env: { ...process.env }, windowsHide: true, stdio: 'ignore' },
        );
        try {
          const deadline = Date.now() + 25_000;
          while (!fs.existsSync(launches + '.running') && Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error(`Harness exited ${child.exitCode}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(fs.existsSync(launches + '.running')).toBe(true);
          await expect(run()).rejects.toThrow('another orchestrator');
          const closed = new Promise((resolve) => child.once('close', resolve));
          child.kill();
          await closed;
          const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
          db.prepare(
            "UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE key = 'FEAT-001-T01'",
          ).run();
          db.close();
          const result = await run();
          expect(result.status, result.message).toBe('ready_to_merge');
          expect(git('rev-parse', 'main')).toBe(main);
          expect(git('rev-list', '--count', `${main}..${result.integration_sha}`)).toBe('1');
          const store = await storeFor();
          try {
            for (const task of result.tasks) {
              expect(store.getTask(task.key)!.review_reports).toHaveLength(1);
              expect(store.getTask(task.key)!.test_reports).toHaveLength(1);
            }
          } finally {
            store.close();
          }
        } finally {
          fs.writeFileSync(launches + '.stop', 'stop');
          if (child.exitCode === null) child.kill();
          await new Promise((resolve) => setTimeout(resolve, 250));
          const cleanup = await storeFor();
          try {
            const actual = await vi.importActual<
              typeof import('../src/workstore/processRecovery.js')
            >('../src/workstore/processRecovery.js');
            for (const execution of cleanup.listExecutions())
              if (
                execution.pid &&
                execution.pid_started_at &&
                !execution.tree_closed_at &&
                (await actual.processStartIdentity(execution.pid)) === execution.pid_started_at
              )
                process.kill(execution.pid);
          } finally {
            cleanup.close();
          }
        }
      },
    );
  },
);
